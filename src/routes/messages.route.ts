// src/routes/messages.route.ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authMiddleware } from '../middlewares/auth.middleware'
import { prisma } from '../utils/prisma'
import { sendWithFallback } from '../services/provider-router.service'
import { normalizePhone } from '../utils/helpers'

const sendSchema = z.object({
  to: z.string().min(10).max(15),
  type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT']).default('TEXT'),
  text: z.string().optional(),
  mediaUrl: z.string().url().optional(),
  caption: z.string().optional(),
  externalId: z.string().optional(),
  scheduledAt: z.string().datetime().optional(),
})

export async function messagesRoutes(app: FastifyInstance) {
  // ── POST /messages — Enviar mensagem ─────────────────────────
  app.post('/messages', {
    preHandler: authMiddleware,
    handler: async (request, reply) => {
      const body = sendSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
      }

      const payload = body.data
      const to = normalizePhone(payload.to)

      // Idempotência: verifica se já existe mensagem com esse externalId
      if (payload.externalId) {
        const existing = await prisma.message.findUnique({
          where: { externalId: payload.externalId },
        })
        if (existing) {
          return reply.status(200).send({ id: existing.id, status: existing.status, duplicate: true })
        }
      }

      // Cria registro no banco com status QUEUED
      const message = await prisma.message.create({
        data: {
          externalId: payload.externalId,
          toPhone: to,
          type: payload.type,
          content: payload.text ?? payload.mediaUrl ?? '',
          caption: payload.caption,
          scheduledAt: payload.scheduledAt ? new Date(payload.scheduledAt) : undefined,
          status: payload.scheduledAt ? 'SCHEDULED' : 'QUEUED',
        },
      })

      // Se agendado, apenas confirma o agendamento
      if (payload.scheduledAt) {
        return reply.status(202).send({ id: message.id, status: 'SCHEDULED' })
      }

      // Envio imediato com fallback
      const result = await sendWithFallback({ ...payload, to })

      const updatedMessage = await prisma.message.update({
        where: { id: message.id },
        data: {
          status: result.success ? 'SENT' : 'FAILED',
          sentAt: result.success ? new Date() : undefined,
          failedAt: result.success ? undefined : new Date(),
          errorMessage: result.error,
          provider: result.provider,
          providerId: result.providerId,
        },
      })

      return reply.status(result.success ? 200 : 500).send({
        id: updatedMessage.id,
        status: updatedMessage.status,
        provider: result.provider,
        providerId: result.providerId,
        error: result.error,
      })
    },
  })

  // ── GET /messages/:id — Status de uma mensagem ───────────────
  app.get<{ Params: { id: string } }>('/messages/:id', {
    preHandler: authMiddleware,
    handler: async (request, reply) => {
      const message = await prisma.message.findUnique({
        where: { id: request.params.id },
        include: { attempts: true },
      })

      if (!message) return reply.status(404).send({ error: 'Mensagem não encontrada' })
      return reply.send(message)
    },
  })

  // ── GET /messages — Lista mensagens com filtros ──────────────
  app.get('/messages', {
    preHandler: authMiddleware,
    handler: async (request, reply) => {
      const query = request.query as { status?: string; page?: string; limit?: string }
      const page = Math.max(1, Number(query.page ?? 1))
      const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20)))

      const messages = await prisma.message.findMany({
        where: query.status ? { status: query.status as any } : {},
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      })

      const total = await prisma.message.count({
        where: query.status ? { status: query.status as any } : {},
      })

      return reply.send({ data: messages, page, limit, total })
    },
  })
}
