// src/routes/webhooks.route.ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authMiddleware } from '../middlewares/auth.middleware'
import { prisma } from '../utils/prisma'

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
  app.get('/webhooks', {
    preHandler: authMiddleware,
    handler: async (_req, reply) => {
      const webhooks = await prisma.webhook.findMany()
      return reply.send(webhooks)
    },
  })

  app.post('/webhooks', {
    preHandler: authMiddleware,
    handler: async (request, reply) => {
      const body = webhookSchema.safeParse(request.body)
      if (!body.success) return reply.status(400).send({ error: body.error.flatten() })
      const webhook = await prisma.webhook.create({ data: body.data })
      return reply.status(201).send(webhook)
    },
  })

  app.delete<{ Params: { id: string } }>('/webhooks/:id', {
    preHandler: authMiddleware,
    handler: async (request, reply) => {
      await prisma.webhook.delete({ where: { id: request.params.id } })
      return reply.status(204).send()
    },
  })
}

// src/routes/health.route.ts (inline)
export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_req, reply) => {
    return reply.send({ status: 'ok', timestamp: new Date().toISOString() })
  })
}
