// src/middlewares/auth.middleware.ts
import type { FastifyRequest, FastifyReply } from 'fastify'
import { prisma } from '../utils/prisma'
import { config } from '../config'

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const apiKey =
    (request.headers['x-api-key'] as string) ??
    request.headers.authorization?.replace('Bearer ', '')

  if (!apiKey) {
    return reply.status(401).send({ error: 'API key obrigatória' })
  }

  // Em desenvolvimento, aceita o secret do .env diretamente
  if (config.app.isDev && apiKey === config.app.apiSecret) return

  const client = await prisma.apiClient.findUnique({
    where: { apiKey, active: true },
  })

  if (!client) {
    return reply.status(401).send({ error: 'API key inválida ou inativa' })
  }

  // Injeta client na request para uso nas rotas
  ;(request as any).apiClient = client
}
