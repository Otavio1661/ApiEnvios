// src/routes/numbers.route.ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authAccount } from '../middlewares/auth.middleware'
import { prisma } from '../utils/prisma'
import { normalizePhone } from '../utils/helpers'

const createNumberSchema = z.object({
  phone: z.string().min(10).max(15),
  label: z.string().optional(),
  name: z.string().optional(),
  provider: z.enum(['EVOLUTION', 'WAHA', 'CLOUD_API']),
  instanceId: z.string().optional(),
  priority: z.number().int().min(0).default(0),
})

export async function numbersRoutes(app: FastifyInstance) {
  // ── GET /numbers — Lista as instâncias do tenant ─────────────
  app.get('/numbers', {
    preHandler: authAccount,
    handler: async (request, reply) => {
      const numbers = await prisma.instance.findMany({
        where: { apiClientId: request.apiClient!.id },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      })
      return reply.send(numbers)
    },
  })

  // ── POST /numbers — Cadastra nova instância ──────────────────
  app.post('/numbers', {
    preHandler: authAccount,
    handler: async (request, reply) => {
      const body = createNumberSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
      }

      const phone = normalizePhone(body.data.phone)
      const number = await prisma.instance.create({
        data: { ...body.data, phone, apiClientId: request.apiClient!.id },
      })

      return reply.status(201).send(number)
    },
  })

  // ── PATCH /numbers/:id/status — Atualiza status manualmente ─
  app.patch<{ Params: { id: string } }>('/numbers/:id/status', {
    preHandler: authAccount,
    handler: async (request, reply) => {
      const body = z
        .object({ status: z.enum(['ACTIVE', 'WARMING', 'BANNED', 'SUSPENDED', 'RETIRED']) })
        .safeParse(request.body)

      if (!body.success) {
        return reply.status(400).send({ error: 'Status inválido' })
      }

      const result = await prisma.instance.updateMany({
        where: { id: request.params.id, apiClientId: request.apiClient!.id },
        data: { status: body.data.status },
      })

      if (result.count === 0) {
        return reply.status(404).send({ error: 'Instância não encontrada' })
      }

      const number = await prisma.instance.findUnique({ where: { id: request.params.id } })
      return reply.send(number)
    },
  })

  // ── POST /numbers/:id/rotate — Rotaciona instância manualmente ─
  app.post<{ Params: { id: string } }>('/numbers/:id/rotate', {
    preHandler: authAccount,
    handler: async (request, reply) => {
      const existing = await prisma.instance.findFirst({
        where: { id: request.params.id, apiClientId: request.apiClient!.id },
      })

      if (!existing) {
        return reply.status(404).send({ error: 'Instância não encontrada' })
      }

      const number = await prisma.instance.update({
        where: { id: existing.id },
        data: { status: 'RETIRED' },
      })

      await prisma.numberRotation.create({
        data: {
          instanceId: number.id,
          reason: 'MANUAL',
          triggeredBy: 'api',
        },
      })

      return reply.send({ message: 'Instância rotacionada com sucesso', number })
    },
  })

  // ── GET /numbers/stats — Dashboard rápido (escopado) ────────
  app.get('/numbers/stats', {
    preHandler: authAccount,
    handler: async (request, reply) => {
      const apiClientId = request.apiClient!.id
      const [active, banned, total, sentToday] = await Promise.all([
        prisma.instance.count({ where: { apiClientId, status: 'ACTIVE' } }),
        prisma.instance.count({ where: { apiClientId, status: 'BANNED' } }),
        prisma.instance.count({ where: { apiClientId } }),
        prisma.instance.aggregate({ where: { apiClientId }, _sum: { sentToday: true } }),
      ])

      return reply.send({
        active,
        banned,
        total,
        sentToday: sentToday._sum.sentToday ?? 0,
      })
    },
  })
}
