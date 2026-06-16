// src/routes/admin.route.ts
// Endpoints administrativos — provisionamento de contas (tenants).
// Protegidos por authAccount + requireAdmin (somente ApiClient role ADMIN).
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authAccount, requireAdmin } from '../middlewares/auth.middleware'
import { prisma } from '../utils/prisma'

const createClientSchema = z.object({
  name: z.string().min(1),
  role: z.enum(['ADMIN', 'CLIENT']).default('CLIENT'),
  fallbackEnabled: z.boolean().default(false),
  rateLimit: z.number().int().positive().default(100),
})

export async function adminRoutes(app: FastifyInstance) {
  // ── POST /admin/clients — Cria um novo tenant (ApiClient) ─────
  app.post('/admin/clients', {
    preHandler: [authAccount, requireAdmin],
    handler: async (request, reply) => {
      const body = createClientSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
      }

      const client = await prisma.apiClient.create({
        data: body.data,
      })

      // Retorna incluindo a apiKey gerada (única vez exposta de forma clara)
      return reply.status(201).send({
        id: client.id,
        name: client.name,
        role: client.role,
        apiKey: client.apiKey,
        fallbackEnabled: client.fallbackEnabled,
        rateLimit: client.rateLimit,
        active: client.active,
        createdAt: client.createdAt,
      })
    },
  })

  // ── GET /admin/clients — Lista as contas ──────────────────────
  app.get('/admin/clients', {
    preHandler: [authAccount, requireAdmin],
    handler: async (_request, reply) => {
      const clients = await prisma.apiClient.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          role: true,
          active: true,
          fallbackEnabled: true,
          rateLimit: true,
          totalSent: true,
          createdAt: true,
          _count: { select: { instances: true } },
        },
      })
      return reply.send(clients)
    },
  })
}
