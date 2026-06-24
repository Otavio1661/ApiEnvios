// src/routes/webhooks.route.ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authManage } from '../middlewares/auth.middleware'
import { prisma } from '../utils/prisma'
import { redis } from '../utils/redis'
import { mapInboundStatus, normalizeProvider, isStatusAdvance } from '../services/inbound-status.service'
import { dispatchWebhook } from '../services/notification.service'
import { QR_TTL_SECONDS } from '../services/instance.service'
import type { MessageStatus } from '../types'

const webhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum([
    'BAN_DETECTED',
    'NUMBER_ROTATED',
    'MESSAGE_FAILED',
    'MESSAGE_DELIVERED',
    'PROVIDER_DOWN',
  ])).min(1),
  secret: z.string().optional(),
})

export async function webhooksRoutes(app: FastifyInstance) {
  // ── GET /webhooks — Lista webhooks do tenant ──────────────────
  app.get('/webhooks', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const webhooks = await prisma.webhook.findMany({
        where: { apiClientId: request.apiClient!.id },
      })
      return reply.send(webhooks)
    },
  })

  // ── POST /webhooks — Cadastra webhook do tenant ───────────────
  app.post('/webhooks', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const body = webhookSchema.safeParse(request.body)
      if (!body.success) return reply.status(400).send({ error: body.error.flatten() })
      const webhook = await prisma.webhook.create({
        data: { ...body.data, apiClientId: request.apiClient!.id },
      })
      return reply.status(201).send(webhook)
    },
  })

  // ── DELETE /webhooks/:id — Remove webhook do tenant ───────────
  app.delete<{ Params: { id: string } }>('/webhooks/:id', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const result = await prisma.webhook.deleteMany({
        where: { id: request.params.id, apiClientId: request.apiClient!.id },
      })
      if (result.count === 0) {
        return reply.status(404).send({ error: 'Webhook não encontrado' })
      }
      return reply.status(204).send()
    },
  })
}

// ══════════════════════════════════════════════════════════════
// WEBHOOKS INBOUND — callbacks dos providers (SEM auth por API key)
// ══════════════════════════════════════════════════════════════
// O provider (Evolution/WAHA/Cloud API) chama estes endpoints. Não há API key:
// o escopo de tenant é garantido casando a Message por providerId + instance.apiClientId.
// Respondemos sempre 200 rápido (exceto provider inválido) e processamos de forma
// resiliente (try/catch — nunca 500), pois providers re-tentam e podem floodar.

// Mapeia o connectionState do payload para o estado do banco (já vem normalizado).
export async function inboundWebhooksRoutes(app: FastifyInstance) {
  // ── Fase C2: inbound POR NÚMERO (InstanceNumber) ─────────────
  // ADITIVO ao inbound por instância (que segue intacto). Registrado ANTES da
  // rota genérica :instanceId para que o segmento literal "number" não seja
  // capturado como instanceId.
  // C3: tratamento de status de entrega por número (atualmente só conexão/QR);
  // o casamento de Message ainda é por instância no fluxo legado de envio.
  app.post<{ Params: { provider: string; numberId: string } }>(
    '/webhooks/inbound/:provider/number/:numberId',
    async (request, reply) => {
      const { provider: providerParam, numberId } = request.params

      const provider = normalizeProvider(providerParam)
      if (!provider) {
        request.log.warn(`[Inbound] Provider desconhecido: ${providerParam}`)
        return reply.status(404).send({ error: 'Provider desconhecido' })
      }

      // Resolve o InstanceNumber. 200 (não 404) se inexistente, para o provider
      // não re-tentar em loop por config de webhook órfã.
      const number = await prisma.instanceNumber.findUnique({ where: { id: numberId } })
      if (!number) {
        request.log.warn(`[Inbound] Número inexistente: ${numberId} (provider=${provider})`)
        return reply.status(200).send({ ignored: true, reason: 'number_not_found' })
      }

      try {
        const update = mapInboundStatus(provider, request.body)
        if (!update) {
          return reply.status(200).send({ ignored: true, reason: 'unparseable' })
        }

        // Eventos de conexão/QR → atualizam o próprio número.
        if (update.connectionState) {
          await prisma.instanceNumber.update({
            where: { id: number.id },
            data: { connectionState: update.connectionState },
          })
        }
        if (update.qrCode) {
          await prisma.instanceNumber.update({
            where: { id: number.id },
            data: {
              qrCode: update.qrCode,
              qrExpiresAt: new Date(Date.now() + QR_TTL_SECONDS * 1000),
              connectionState: 'QR_PENDING',
            },
          })
        }

        return reply.status(200).send({ ok: true })
      } catch (err: any) {
        request.log.error(`[Inbound] Erro ao processar callback de número (${provider}): ${err.message}`)
        return reply.status(200).send({ ok: false })
      }
    },
  )

  app.post<{ Params: { provider: string; instanceId: string } }>(
    '/webhooks/inbound/:provider/:instanceId',
    async (request, reply) => {
      const { provider: providerParam, instanceId } = request.params

      // 1. Valida o provider (case-insensitive). Inválido → 404 controlado.
      const provider = normalizeProvider(providerParam)
      if (!provider) {
        request.log.warn(`[Inbound] Provider desconhecido: ${providerParam}`)
        return reply.status(404).send({ error: 'Provider desconhecido' })
      }

      // 2. Resolve a Instance pelo Instance.id (param da rota).
      //    DECISÃO: respondemos 200 (e não 404) quando a instância não existe, para que o
      //    provider NÃO re-tente em loop infinito por uma config de webhook órfã/obsoleta.
      const instance = await prisma.instance.findUnique({ where: { id: instanceId } })
      if (!instance) {
        request.log.warn(`[Inbound] Instância inexistente: ${instanceId} (provider=${provider})`)
        return reply.status(200).send({ ignored: true, reason: 'instance_not_found' })
      }

      // 3. Processamento resiliente — qualquer erro é logado e respondemos 200.
      try {
        const update = mapInboundStatus(provider, request.body)

        if (!update) {
          request.log.debug(`[Inbound] Payload não interpretável (provider=${provider})`)
          return reply.status(200).send({ ignored: true, reason: 'unparseable' })
        }

        // 3a. Evento de conexão → atualiza connectionState da instância.
        if (update.connectionState) {
          await prisma.instance.update({
            where: { id: instance.id },
            data: { connectionState: update.connectionState },
          })
        }

        // 3b. Evento de QR → atualiza qrCode da instância (carimbando o TTL).
        if (update.qrCode) {
          await prisma.instance.update({
            where: { id: instance.id },
            data: {
              qrCode: update.qrCode,
              qrExpiresAt: new Date(Date.now() + QR_TTL_SECONDS * 1000),
              connectionState: 'QR_PENDING',
            },
          })
        }

        // 3c. Evento de status de entrega → atualiza a Message (casando por providerId + tenant).
        if (update.status && update.providerId) {
          await applyMessageStatus(instance.apiClientId, update.providerId, update.status, request.log)
        }

        return reply.status(200).send({ ok: true })
      } catch (err: any) {
        request.log.error(`[Inbound] Erro ao processar callback (${provider}): ${err.message}`)
        // NUNCA 500 — provider re-tentaria e poderia floodar.
        return reply.status(200).send({ ok: false })
      }
    },
  )
}

// Aplica o novo status à Message, garantindo que só AVANÇA no funil (SENT→DELIVERED→READ).
async function applyMessageStatus(
  apiClientId: string,
  providerId: string,
  status: MessageStatus,
  log: FastifyInstance['log'],
) {
  // Escopo por tenant: casa providerId + apiClientId da instância.
  const message = await prisma.message.findFirst({
    where: { providerId, apiClientId },
  })

  if (!message) {
    log.warn(`[Inbound] Message não encontrada para providerId=${providerId} (tenant=${apiClientId})`)
    return
  }

  // Só avança no funil — nunca regride (ex.: READ não volta para DELIVERED).
  if (!isStatusAdvance(message.status as MessageStatus, status)) {
    log.debug(`[Inbound] Ignorado (não avança): ${message.status} → ${status} (msg=${message.id})`)
    return
  }

  const now = new Date()
  await prisma.message.update({
    where: { id: message.id },
    data: {
      status,
      ...(status === 'DELIVERED' ? { deliveredAt: now } : {}),
      ...(status === 'READ' ? { readAt: message.readAt ?? now, deliveredAt: message.deliveredAt ?? now } : {}),
    },
  })

  log.info(`[Inbound] Message ${message.id}: ${message.status} → ${status}`)

  // Ao entregar, repassa MESSAGE_DELIVERED ao webhook do tenant (best-effort).
  if (status === 'DELIVERED') {
    try {
      await dispatchWebhook(
        'MESSAGE_DELIVERED',
        {
          messageId: message.id,
          providerId,
          toPhone: message.toPhone,
          deliveredAt: now.toISOString(),
        },
        message.apiClientId,
      )
    } catch (err: any) {
      log.error(`[Inbound] Falha ao repassar MESSAGE_DELIVERED: ${err.message}`)
    }
  }
}

// src/routes/health.route.ts (inline)
export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_req, reply) => {
    // Checa as dependências críticas (DB + Redis) em paralelo. 200 se ambas ok,
    // 503 se alguma falhar — para health checks de orquestrador/uptime monitor.
    const [db, redisOk] = await Promise.all([
      prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      redis.ping().then((r) => r === 'PONG').catch(() => false),
    ])
    const healthy = db && redisOk
    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      version: process.env.npm_package_version ?? '1.0.0',
      uptimeSec: Math.round(process.uptime()),
      checks: { database: db ? 'up' : 'down', redis: redisOk ? 'up' : 'down' },
      timestamp: new Date().toISOString(),
    })
  })

  // Raiz → painel admin (evita 404 JSON feio para quem abre a URL no navegador).
  app.get('/', async (_req, reply) => {
    return reply.redirect('/admin')
  })
}
