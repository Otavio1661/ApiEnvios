// src/routes/metrics.route.ts
// Métricas de uso por tenant. Escopado por conta (request.apiClient.id); para MEMBER
// (login humano), restringe às instâncias dele via memberScopeId. Reusa o service.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authManage, memberScopeId } from '../middlewares/auth.middleware'
import { getTenantMetrics } from '../services/metrics.service'

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
})

export async function metricsRoutes(app: FastifyInstance) {
  // ── GET /metrics — Métricas do tenant (totais, série diária, por instância/número) ─
  app.get('/metrics', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const parsed = querySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Parâmetros inválidos', details: parsed.error.flatten() })
      }
      const metrics = await getTenantMetrics({
        apiClientId: request.apiClient!.id,
        ownerUserId: memberScopeId(request),
        days: parsed.data.days,
      })
      return reply.send(metrics)
    },
  })
}
