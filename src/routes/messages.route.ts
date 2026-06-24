// src/routes/messages.route.ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authManage } from '../middlewares/auth.middleware'
import { prisma } from '../utils/prisma'
import { enqueueSend, requeueSend, removeSendJob } from '../queues/send-message.queue'
import { normalizePhone } from '../utils/helpers'
import { checkRecipientHourlyLimit } from '../utils/recipient-rate-limit'

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
    preHandler: authManage,
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

        // Limite anti-flood por destinatário (por conta, janela de 1h). Aplica só a
        // envios imediatos — agendados são contados quando forem efetivamente enviados.
        // Bloqueia ANTES de criar a Message e o job, para não entupir banco nem fila.
        if (!isScheduled) {
          const limit = await checkRecipientHourlyLimit(
            apiClientId,
            to,
            request.apiClient!.maxPerRecipientPerHour,
          )
          if (!limit.allowed) {
            request.log.warn(
              `[Messages] Limite por destinatário atingido: conta=${apiClientId} to=${to} limite=${limit.limit}/h`,
            )
            return reply
              .status(429)
              .header('Retry-After', String(limit.retryAfterSec))
              .send({
                error: `Limite de ${limit.limit} mensagem(ns) por hora para o mesmo número atingido`,
                to,
                limit: limit.limit,
                retryAfterSec: limit.retryAfterSec,
              })
          }
        }

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
    preHandler: authManage,
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
    preHandler: authManage,
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

  // ── POST /messages/:id/resend — Reenfileira uma mensagem com falha ─
  // Só permite reenviar mensagens em FAILED (reenviar uma já entregue duplicaria
  // o envio). Reseta o estado e re-enfileira reusando a fila/anti-ban existentes.
  app.post<{ Params: { id: string } }>('/messages/:id/resend', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const message = await prisma.message.findFirst({
        where: { id: request.params.id, apiClientId: request.apiClient!.id },
      })
      if (!message) return reply.status(404).send({ error: 'Mensagem não encontrada' })

      if (message.status !== 'FAILED') {
        return reply.status(409).send({
          error: 'Só é possível reenviar mensagens com falha (FAILED)',
          status: message.status,
        })
      }

      const updated = await prisma.message.update({
        where: { id: message.id },
        data: {
          status: 'QUEUED',
          retryCount: 0,
          errorMessage: null,
          failedAt: null,
        },
      })

      await requeueSend(updated.id, updated.maxRetries)
      return reply.status(202).send({ id: updated.id, status: updated.status })
    },
  })

  // ── DELETE /messages/:id — Remove a mensagem do histórico ─────
  // Escopado ao tenant. Remove as tentativas (sem onDelete cascade no schema) e a
  // mensagem numa transação, e tira o job da fila (best-effort).
  app.delete<{ Params: { id: string } }>('/messages/:id', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const message = await prisma.message.findFirst({
        where: { id: request.params.id, apiClientId: request.apiClient!.id },
        select: { id: true },
      })
      if (!message) return reply.status(404).send({ error: 'Mensagem não encontrada' })

      await prisma.$transaction([
        prisma.messageAttempt.deleteMany({ where: { messageId: message.id } }),
        prisma.message.delete({ where: { id: message.id } }),
      ])
      await removeSendJob(message.id)

      return reply.status(204).send()
    },
  })
}
