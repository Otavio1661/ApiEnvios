// src/routes/campaigns.route.ts
// Envio em LOTE (campanha) para uma lista de destinos. Reusa TODA a infra existente:
//   - teto anti-flood por destinatário (checkRecipientHourlyLimit, Fase 1)
//   - fila send-message + worker (que já aplica o espaçamento anti-ban via rate-gate)
//   - idempotência por externalId (mesma da rota single)
// Cada lote vira um Campaign (acompanhamento) e cada destino uma Message (campaignId).
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authManage, memberScopeId } from '../middlewares/auth.middleware'
import { prisma } from '../utils/prisma'
import { enqueueSend } from '../queues/send-message.queue'
import { normalizePhone } from '../utils/helpers'
import { checkRecipientHourlyLimit } from '../utils/recipient-rate-limit'
import { getCampaignProgress } from '../services/monitor.service'

const SENT_STATUSES = ['SENT', 'DELIVERED', 'READ']
const QUEUED_STATUSES = ['QUEUED', 'SENDING', 'SCHEDULED']

const MAX_RECIPIENTS = 1000

const campaignSchema = z.object({
  to: z.array(z.string().min(10).max(15)).min(1).max(MAX_RECIPIENTS),
  type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT']).default('TEXT'),
  text: z.string().optional(),
  mediaUrl: z.string().url().optional(),
  caption: z.string().optional(),
  instanceId: z.string().optional(),
  // Rótulo opcional do lote (aparece no monitor).
  name: z.string().min(1).max(120).optional(),
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
      const queuedIds: string[] = []
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
        queuedIds.push(message.id)
        results.push({ to, status: 'QUEUED', id: message.id })
      }

      // Registra o lote (Campaign) só se houve envio — vincula as mensagens criadas.
      let campaignId: string | undefined
      if (queuedIds.length > 0) {
        const campaign = await prisma.campaign.create({
          data: {
            apiClientId,
            name: payload.name,
            instanceId: payload.instanceId,
            createdByUserId: request.authUser?.id,
            total: queuedIds.length,
          },
        })
        campaignId = campaign.id
        await prisma.message.updateMany({ where: { id: { in: queuedIds } }, data: { campaignId } })
      }

      const summary = {
        campaignId,
        total: phones.length,
        queued: queuedIds.length,
        rateLimited: results.filter((r) => r.status === 'RATE_LIMITED').length,
        duplicates: results.filter((r) => r.status === 'DUPLICATE').length,
      }
      return reply.status(202).send({ ...summary, results })
    },
  })

  // ── GET /campaigns — Lista lotes com progresso (escopo por papel) ─
  app.get('/campaigns', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const q = request.query as { limit?: string }
      const limit = Math.min(50, Math.max(1, Number(q.limit ?? 20)))
      const campaigns = await getCampaignProgress({
        apiClientId: request.apiClient!.id,
        ownerUserId: memberScopeId(request),
        limit,
      })
      return reply.send({ data: campaigns })
    },
  })

  // ── GET /campaigns/:id — Progresso de um lote (escopado) ─
  app.get<{ Params: { id: string } }>('/campaigns/:id', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const ownerUserId = memberScopeId(request)
      const campaign = await prisma.campaign.findFirst({
        where: {
          id: request.params.id,
          apiClientId: request.apiClient!.id,
          ...(ownerUserId ? { createdByUserId: ownerUserId } : {}),
        },
        select: { id: true, name: true, total: true, createdAt: true, instance: { select: { name: true, slug: true } } },
      })
      if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

      const grouped = await prisma.message.groupBy({
        by: ['status'],
        where: { campaignId: campaign.id },
        _count: { _all: true },
      })
      let sent = 0, failed = 0, queued = 0
      for (const g of grouped) {
        if (SENT_STATUSES.includes(g.status)) sent += g._count._all
        else if (g.status === 'FAILED') failed += g._count._all
        else if (QUEUED_STATUSES.includes(g.status)) queued += g._count._all
      }
      return reply.send({ ...campaign, sent, failed, queued })
    },
  })
}
