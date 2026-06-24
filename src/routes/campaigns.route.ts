// src/routes/campaigns.route.ts
// Envio em LOTE (campanha) para uma lista de destinos. Reusa TODA a infra existente:
//   - teto anti-flood por destinatário (checkRecipientHourlyLimit, Fase 1)
//   - fila send-message + worker (que já aplica o espaçamento anti-ban via rate-gate)
//   - idempotência por externalId (mesma da rota single)
// Não cria tabela nova: cada destino vira uma Message (entra nas métricas).
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authManage } from '../middlewares/auth.middleware'
import { prisma } from '../utils/prisma'
import { enqueueSend } from '../queues/send-message.queue'
import { normalizePhone } from '../utils/helpers'
import { checkRecipientHourlyLimit } from '../utils/recipient-rate-limit'

const MAX_RECIPIENTS = 1000

const campaignSchema = z.object({
  to: z.array(z.string().min(10).max(15)).min(1).max(MAX_RECIPIENTS),
  type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT']).default('TEXT'),
  text: z.string().optional(),
  mediaUrl: z.string().url().optional(),
  caption: z.string().optional(),
  instanceId: z.string().optional(),
  // Prefixo opcional para idempotência por destino: externalId = `${prefix}:${telefone}`.
  externalIdPrefix: z.string().min(1).max(80).optional(),
})

interface RecipientResult {
  to: string
  status: 'QUEUED' | 'RATE_LIMITED' | 'DUPLICATE'
  id?: string
  retryAfterSec?: number
}

export async function campaignsRoutes(app: FastifyInstance) {
  // ── POST /campaigns — Dispara uma mensagem para uma lista de destinos ─
  app.post('/campaigns', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const body = campaignSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
      }
      const apiClientId = request.apiClient!.id
      const payload = body.data
      const content = payload.text ?? payload.mediaUrl ?? ''

      // Valida posse da instância (se informada) — escopo da conta.
      if (payload.instanceId) {
        const owned = await prisma.instance.findFirst({
          where: { id: payload.instanceId, apiClientId },
          select: { id: true },
        })
        if (!owned) return reply.status(404).send({ error: 'Instância não encontrada' })
      }

      // Dedupe dos destinos já normalizados (evita disparar 2x pro mesmo número no lote).
      const phones = [...new Set(payload.to.map(normalizePhone))]
      const limit = request.apiClient!.maxPerRecipientPerHour

      const results: RecipientResult[] = []
      for (const to of phones) {
        // Idempotência opcional por destino.
        const externalId = payload.externalIdPrefix ? `${payload.externalIdPrefix}:${to}` : undefined
        if (externalId) {
          const existing = await prisma.message.findUnique({
            where: { apiClientId_externalId: { apiClientId, externalId } },
            select: { id: true },
          })
          if (existing) {
            results.push({ to, status: 'DUPLICATE', id: existing.id })
            continue
          }
        }

        // Teto anti-flood por destinatário (mesma janela/contador da rota single).
        const rl = await checkRecipientHourlyLimit(apiClientId, to, limit)
        if (!rl.allowed) {
          results.push({ to, status: 'RATE_LIMITED', retryAfterSec: rl.retryAfterSec })
          continue
        }

        const message = await prisma.message.create({
          data: {
            apiClientId,
            externalId,
            instanceId: payload.instanceId,
            toPhone: to,
            type: payload.type,
            content,
            caption: payload.caption,
            status: 'QUEUED',
          },
        })
        await enqueueSend(message.id, message.maxRetries)
        results.push({ to, status: 'QUEUED', id: message.id })
      }

      const summary = {
        total: phones.length,
        queued: results.filter((r) => r.status === 'QUEUED').length,
        rateLimited: results.filter((r) => r.status === 'RATE_LIMITED').length,
        duplicates: results.filter((r) => r.status === 'DUPLICATE').length,
      }
      return reply.status(202).send({ ...summary, results })
    },
  })
}
