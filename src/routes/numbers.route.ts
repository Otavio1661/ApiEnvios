// src/routes/numbers.route.ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authMiddleware } from '../middlewares/auth.middleware'
import { prisma } from '../utils/prisma'
import { normalizePhone } from '../utils/helpers'

const createNumberSchema = z.object({
  phone: z.string().min(10).max(15),
  label: z.string().optional(),
  provider: z.enum(['EVOLUTION', 'WAHA', 'CLOUD_API']),
  instanceId: z.string().optional(),
  priority: z.number().int().min(0).default(0),
})

export async function numbersRoutes(app: FastifyInstance) {
  // ── GET /numbers — Lista todos os números ────────────────────
  app.get('/numbers', {
    preHandler: authMiddleware,
    handler: async (_request, reply) => {
      const numbers = await prisma.whatsappNumber.findMany({
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      })
      return reply.send(numbers)
    },
  })

  // ── POST /numbers — Cadastra novo número ─────────────────────
  app.post('/numbers', {
    preHandler: authMiddleware,
    handler: async (request, reply) => {
      const body = createNumberSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
      }

      const phone = normalizePhone(body.data.phone)
      const number = await prisma.whatsappNumber.create({
        data: { ...body.data, phone },
      })

      return reply.status(201).send(number)
    },
  })

  // ── PATCH /numbers/:id/status — Atualiza status manualmente ─
  app.patch<{ Params: { id: string } }>('/numbers/:id/status', {
    preHandler: authMiddleware,
    handler: async (request, reply) => {
      const body = z
        .object({ status: z.enum(['ACTIVE', 'WARMING', 'BANNED', 'SUSPENDED', 'RETIRED']) })
        .safeParse(request.body)

      if (!body.success) {
        return reply.status(400).send({ error: 'Status inválido' })
      }

      const number = await prisma.whatsappNumber.update({
        where: { id: request.params.id },
        data: { status: body.data.status },
      })

      return reply.send(number)
    },
  })

  // ── POST /numbers/:id/rotate — Rotaciona número manualmente ─
  app.post<{ Params: { id: string } }>('/numbers/:id/rotate', {
    preHandler: authMiddleware,
    handler: async (request, reply) => {
      const number = await prisma.whatsappNumber.update({
        where: { id: request.params.id },
        data: { status: 'RETIRED' },
      })

      await prisma.numberRotation.create({
        data: {
          numberId: number.id,
          reason: 'MANUAL',
          triggeredBy: 'api',
        },
      })

      return reply.send({ message: 'Número rotacionado com sucesso', number })
    },
  })

  // ── GET /numbers/stats — Dashboard rápido ───────────────────
  app.get('/numbers/stats', {
    preHandler: authMiddleware,
    handler: async (_request, reply) => {
      const [active, banned, total, sentToday] = await Promise.all([
        prisma.whatsappNumber.count({ where: { status: 'ACTIVE' } }),
        prisma.whatsappNumber.count({ where: { status: 'BANNED' } }),
        prisma.whatsappNumber.count(),
        prisma.whatsappNumber.aggregate({ _sum: { sentToday: true } }),
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
