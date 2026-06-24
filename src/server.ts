// src/server.ts
import 'dotenv/config'
import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import jwt from '@fastify/jwt'
import cookie from '@fastify/cookie'
import view from '@fastify/view'
import fastifyStatic from '@fastify/static'
import formbody from '@fastify/formbody'
import { Eta } from 'eta'
import path from 'node:path'
import { config } from './config'
import { resolveTenantContext } from './middlewares/auth.middleware'
import { messagesRoutes } from './routes/messages.route'
import { numbersRoutes } from './routes/numbers.route'
import { instancesRoutes } from './routes/instances.route'
import { adminRoutes } from './routes/admin.route'
import { authRoutes } from './routes/auth.route'
import { accountRoutes } from './routes/account.route'
import { metricsRoutes } from './routes/metrics.route'
import { panelRoutes } from './web/panel.route'
// Garante a augmentação de tipos do Fastify/@fastify/jwt (apiClient/authUser/payload)
import './types'
import { webhooksRoutes, healthRoutes, inboundWebhooksRoutes } from './routes/webhooks.route'
import { prisma } from './utils/prisma'
import { redis } from './utils/redis'
import { startSendMessageWorker, stopSendMessageWorker } from './queues/send-message.worker'
import { startWebhookWorker, stopWebhookWorker } from './queues/webhook.worker'
import { startScheduler, stopScheduler } from './queues/scheduler'

// ── Fábrica do app ────────────────────────────────────────────
// Cria a instância Fastify, registra TODOS os plugins e TODAS as rotas e devolve o
// `app` PRONTO — porém SEM `.listen()` e SEM conectar Prisma/Redis/workers. Isso
// permite que os testes (Vitest + app.inject) montem o app de forma isolada, sem
// depender de banco/Redis/processos de fundo. O bootstrap de runtime fica em start().
export function buildApp(): FastifyInstance {
  const app = Fastify({
    // Sob Vitest (process.env.VITEST), silencia o logger para não poluir a saída dos
    // testes. NÃO afeta runtime: `npm run dev`/produção mantêm o logger Pino normal.
    logger: process.env.VITEST
      ? false
      : {
          transport: config.app.isDev
            ? { target: 'pino-pretty', options: { colorize: true } }
            : undefined,
        },
  })

  // ── Plugins ───────────────────────────────────────────────────
  app.register(cors, { origin: true })
  // helmet: desativa CSP para o painel (Alpine via CDN + estilos inline do Eta).
  // A API REST não é afetada (continua respondendo JSON).
  app.register(helmet, { contentSecurityPolicy: false })

  // Cookies (sessão do painel via cookie httpOnly `token`). Deve vir ANTES do jwt
  // para que o @fastify/jwt consiga ler o cookie em request.jwtVerify().
  app.register(cookie)

  // JWT para login humano: aceita o header `Authorization: Bearer` (API REST) E o
  // cookie `token` (painel web). A API REST continua funcionando com Bearer/API key.
  app.register(jwt, {
    secret: config.app.jwtSecret,
    sign: { expiresIn: config.app.jwtExpiresIn },
    cookie: { cookieName: 'token', signed: false },
  })

  // Body parser para formulários HTML (application/x-www-form-urlencoded).
  app.register(formbody)

  // View engine (Eta) para o painel server-rendered.
  const eta = new Eta({ views: path.join(__dirname, 'web', 'views') })
  app.register(view, {
    engine: { eta },
    root: path.join(__dirname, 'web', 'views'),
  })

  // Estáticos do painel (CSS) em /admin/assets.
  app.register(fastifyStatic, {
    root: path.join(__dirname, 'web', 'public'),
    prefix: '/admin/assets/',
  })

  // Resolve o tenant ANTES do rate-limit (hook onRequest registrado primeiro,
  // portanto executado antes do hook do @fastify/rate-limit).
  app.addHook('onRequest', resolveTenantContext)

  // Rate limit POR TENANT: a chave é o id do ApiClient (cai p/ IP se anônimo) e o
  // teto é o `rateLimit` do próprio cliente. /health e os webhooks inbound dos
  // providers ficam de fora (alto volume legítimo).
  app.register(rateLimit, {
    global: true,
    timeWindow: '1 minute',
    // Store no Redis: a contagem é global entre réplicas (sem ele, o teto efetivo
    // de um tenant seria N × rateLimit com N processos).
    redis,
    max: (request) => request.apiClient?.rateLimit ?? config.app.defaultRateLimit,
    keyGenerator: (request) => request.apiClient?.id ?? request.ip,
    allowList: (request) =>
      request.url === '/health' ||
      request.url.includes('/webhooks/inbound/') ||
      request.url.startsWith('/admin'),
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Rate limit excedido para este cliente',
    }),
  })

  // ── Rotas ─────────────────────────────────────────────────────
  app.register(healthRoutes)
  app.register(authRoutes, { prefix: '/v1' })
  app.register(accountRoutes, { prefix: '/v1' })
  app.register(metricsRoutes, { prefix: '/v1' })
  app.register(messagesRoutes, { prefix: '/v1' })
  app.register(instancesRoutes, { prefix: '/v1' })
  app.register(adminRoutes, { prefix: '/v1' })
  // Rotas legadas /numbers* mantidas por compatibilidade (Fase 0/1)
  app.register(numbersRoutes, { prefix: '/v1' })
  app.register(webhooksRoutes, { prefix: '/v1' })
  // Webhooks inbound dos providers (sem auth por API key — escopo via providerId + instância)
  app.register(inboundWebhooksRoutes, { prefix: '/v1' })
  // Painel web server-rendered (estilo UltraMsg), sessão via cookie httpOnly.
  app.register(panelRoutes, { prefix: '/admin' })

  return app
}

// Instância usada pelo runtime (dev/prod). Em testes, cada caso monta a sua via buildApp().
const app = buildApp()

// ── Inicialização ─────────────────────────────────────────────
async function start() {
  try {
    // Conecta ao banco
    await prisma.$connect()
    app.log.info('✅ PostgreSQL conectado')

    // Conecta ao Redis
    await redis.connect()
    app.log.info('✅ Redis conectado')

    // Worker de envio assíncrono (BullMQ)
    startSendMessageWorker()
    app.log.info('✅ Worker send-message iniciado')

    // Worker de entrega de webhooks (retry/backoff + DLQ + HMAC)
    startWebhookWorker()
    app.log.info('✅ Worker webhook-delivery iniciado')

    // Scheduler: repeatable jobs (reset-counters meia-noite + scheduled-messages a cada min)
    // Substitui o resetDailyCounters() que antes rodava só no boot dev.
    await startScheduler()
    app.log.info('✅ Scheduler (reset-counters + scheduled-messages) iniciado')

    // Inicia servidor
    await app.listen({ port: config.app.port, host: '0.0.0.0' })
    app.log.info(`🚀 ApiEnvios rodando em http://localhost:${config.app.port}`)
    app.log.info(`📋 Ambiente: ${config.app.env}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

// ── Graceful shutdown ─────────────────────────────────────────
async function shutdown(signal: string) {
  app.log.info(`Recebido ${signal}, encerrando...`)
  try {
    await app.close()
    await stopSendMessageWorker()
    await stopWebhookWorker()
    await stopScheduler()
    await prisma.$disconnect()
    redis.disconnect()
  } catch (err) {
    app.log.error(err)
  } finally {
    process.exit(0)
  }
}

// Só inicializa o runtime (listen + Prisma/Redis/workers/sinais) quando o módulo é
// EXECUTADO DIRETAMENTE (node/tsx src/server.ts). Na importação pelos testes, este
// guard evita abrir servidor, conexões e handlers de sinal.
if (require.main === module) {
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  start()
}
