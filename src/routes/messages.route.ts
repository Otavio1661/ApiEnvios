// src/routes/messages.route.ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authAccount } from '../middlewares/auth.middleware'
import { prisma } from '../utils/prisma'
import { enqueueSend } from '../queues/send-message.queue'
import { normalizePhone } from '../utils/helpers'

const sendSchema = z.object({
  to: z.string().min(10).max(15),
  type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT']).default('TEXT'),
  text: z.string().optional(),
  mediaUrl: z.string().url().optional(),
  caption: z.string().optional(),
  externalId: z.string().optional(),
  instanceId: z.string().optional(),
  scheduledAt: z.string().datetime().optional(),
})

export async function messagesRoutes(app: FastifyInstance) {
  // ── POST /messages — Enviar mensagem ─────────────────────────
  app.post('/messages', {
    preHandler: authAccount,
    handler: async (request, reply) => {
      const body = sendSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
      }

      const apiClientId = request.apiClient!.id
      const payload = body.data
      const to = normalizePhone(payload.to)

      try {
        // Idempotência por tenant: verifica externalId no escopo do cliente
        if (payload.externalId) {
          const existing = await prisma.message.findUnique({
            where: { apiClientId_externalId: { apiClientId, externalId: payload.externalId } },
          })
          if (existing) {
            return reply.status(200).send({ id: existing.id, status: existing.status, duplicate: true })
          }
        }

        // Se instanceId informado, valida posse pelo tenant
        if (payload.instanceId) {
          const owned = await prisma.instance.findFirst({
            where: { id: payload.instanceId, apiClientId },
            select: { id: true },
          })
          if (!owned) {
            return reply.status(404).send({ error: 'Instância não encontrada' })
          }
        }

        const isScheduled = Boolean(payload.scheduledAt)

        // Cria registro no banco (QUEUED ou SCHEDULED)
        const message = await prisma.message.create({
          data: {
            apiClientId,
            externalId: payload.externalId,
            instanceId: payload.instanceId,
            toPhone: to,
            type: payload.type,
            content: payload.text ?? payload.mediaUrl ?? '',
            caption: payload.caption,
            scheduledAt: payload.scheduledAt ? new Date(payload.scheduledAt) : undefined,
            status: isScheduled ? 'SCHEDULED' : 'QUEUED',
          },
        })

        // Agendada: o job scheduled-messages enfileira no horário
        if (isScheduled) {
          return reply.status(202).send({ id: message.id, status: 'SCHEDULED' })
        }

        // Imediata: enfileira e responde 202 sem aguardar o envio
        await enqueueSend(message.id, message.maxRetries)
        return reply.status(202).send({ id: message.id, status: 'QUEUED' })
      } catch (err: any) {
        request.log.error(`[Messages] Falha ao criar/enfileirar mensagem: ${err.message}`)
        return reply.status(500).send({ error: 'Falha ao processar a mensagem' })
      }
    },
  })

  // ── GET /messages/:id — Status de uma mensagem (escopado) ────
  app.get<{ Params: { id: string } }>('/messages/:id', {
    preHandler: authAccount,
    handler: async (request, reply) => {
      const message = await prisma.message.findFirst({
        where: { id: request.params.id, apiClientId: request.apiClient!.id },
        include: { attempts: true },
      })

      if (!message) return reply.status(404).send({ error: 'Mensagem não encontrada' })
      return reply.send(message)
    },
  })

  // ── GET /messages — Lista mensagens do tenant com filtros ────
  app.get('/messages', {
    preHandler: authAccount,
    handler: async (request, reply) => {
      const query = request.query as { status?: string; page?: string; limit?: string }
      const page = Math.max(1, Number(query.page ?? 1))
      const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20)))

      const where = {
        apiClientId: request.apiClient!.id,
        ...(query.status ? { status: query.status as any } : {}),
      }

      const messages = await prisma.message.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      })

      const total = await prisma.message.count({ where })

      return reply.send({ data: messages, page, limit, total })
    },
  })
}
