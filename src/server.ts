// src/server.ts
import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import { config } from './config'
import { messagesRoutes } from './routes/messages.route'
import { numbersRoutes } from './routes/numbers.route'
import { webhooksRoutes, healthRoutes } from './routes/webhooks.route'
import { prisma } from './utils/prisma'
import { redis } from './utils/redis'
import { resetDailyCounters } from './jobs/reset-counters.job'

const app = Fastify({
  logger: {
    transport: config.app.isDev
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
})

// ── Plugins ───────────────────────────────────────────────────
app.register(cors, { origin: true })
app.register(helmet)

// ── Rotas ─────────────────────────────────────────────────────
app.register(healthRoutes)
app.register(messagesRoutes, { prefix: '/v1' })
app.register(numbersRoutes, { prefix: '/v1' })
app.register(webhooksRoutes, { prefix: '/v1' })

// ── Inicialização ─────────────────────────────────────────────
async function start() {
  try {
    // Conecta ao banco
    await prisma.$connect()
    app.log.info('✅ PostgreSQL conectado')

    // Conecta ao Redis
    await redis.connect()
    app.log.info('✅ Redis conectado')

    // Job de reset diário — roda na inicialização em dev
    if (config.app.isDev) {
      await resetDailyCounters()
    }

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
process.on('SIGTERM', async () => {
  await app.close()
  await prisma.$disconnect()
  redis.disconnect()
  process.exit(0)
})

start()
