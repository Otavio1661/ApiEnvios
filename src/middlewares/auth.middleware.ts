// src/middlewares/auth.middleware.ts
import type { FastifyRequest, FastifyReply } from 'fastify'
import { prisma } from '../utils/prisma'
import { config } from '../config'

// ── Auth por API key de conta (gestão) ────────────────────────
// Resolve o ApiClient pela apiKey (header x-api-key ou Bearer) e o anexa
// em request.apiClient para escopar todas as queries por tenant.
export async function authAccount(request: FastifyRequest, reply: FastifyReply) {
  const apiKey =
    (request.headers['x-api-key'] as string) ??
    request.headers.authorization?.replace('Bearer ', '')

  if (!apiKey) {
    return reply.status(401).send({ error: 'API key obrigatória' })
  }

  // Em desenvolvimento, aceita o secret do .env diretamente.
  // Resolve um ApiClient admin do seed para que as queries escopadas funcionem.
  if (config.app.isDev && apiKey === config.app.apiSecret) {
    const admin = await prisma.apiClient.findFirst({
      where: { role: 'ADMIN', active: true },
    })
    if (admin) {
      request.apiClient = admin
      return
    }
    return reply.status(401).send({ error: 'Nenhum ApiClient admin disponível (rode o seed)' })
  }

  const client = await prisma.apiClient.findUnique({
    where: { apiKey, active: true },
  })

  if (!client) {
    return reply.status(401).send({ error: 'API key inválida ou inativa' })
  }

  // Injeta client na request para uso nas rotas
  request.apiClient = client
}

// ── Auth por token de instância (envio) ───────────────────────
// Lê o header `Token`, resolve a Instance por token (com apiClient incluído)
// e anexa request.instance + request.apiClient. Opcionalmente valida contra
// o :id da rota.
export async function authInstance(
  request: FastifyRequest<{ Params?: { id?: string } }>,
  reply: FastifyReply,
) {
  const token =
    (request.headers['token'] as string) ??
    (request.headers['x-token'] as string)

  if (!token) {
    return reply.status(401).send({ error: 'Token de instância obrigatório' })
  }

  const instance = await prisma.instance.findUnique({
    where: { token },
    include: { apiClient: true },
  })

  if (!instance || !instance.apiClient.active) {
    return reply.status(401).send({ error: 'Token de instância inválido' })
  }

  // Se a rota tiver :id, valida que bate com a instância do token
  const routeId = (request.params as { id?: string } | undefined)?.id
  if (routeId && routeId !== instance.id) {
    return reply.status(401).send({ error: 'Token não corresponde à instância informada' })
  }

  const { apiClient, ...instanceData } = instance
  request.instance = instanceData
  request.apiClient = apiClient
}

// ── Resolução leve de tenant para rate limit (onRequest) ──────
// NÃO rejeita: apenas tenta resolver o ApiClient (por API key OU token de instância)
// e o anexa em request.apiClient, para que o @fastify/rate-limit aplique o limite
// por tenant. A autenticação efetiva (e os 401/403) continua nos preHandlers
// authAccount/authInstance/requireAdmin. Rotas públicas são ignoradas.
export async function resolveTenantContext(request: FastifyRequest) {
  if (request.apiClient) return
  // Ignora rotas públicas (health e callbacks inbound dos providers).
  if (request.url === '/health' || request.url.includes('/webhooks/inbound/')) return

  try {
    const apiKey =
      (request.headers['x-api-key'] as string) ??
      request.headers.authorization?.replace('Bearer ', '')

    if (apiKey) {
      if (config.app.isDev && apiKey === config.app.apiSecret) {
        const admin = await prisma.apiClient.findFirst({ where: { role: 'ADMIN', active: true } })
        if (admin) request.apiClient = admin
        return
      }
      const client = await prisma.apiClient.findUnique({ where: { apiKey, active: true } })
      if (client) request.apiClient = client
      return
    }

    const token = (request.headers['token'] as string) ?? (request.headers['x-token'] as string)
    if (token) {
      const instance = await prisma.instance.findUnique({ where: { token }, include: { apiClient: true } })
      if (instance?.apiClient?.active) {
        const { apiClient, ...instanceData } = instance
        request.apiClient = apiClient
        request.instance = instanceData
      }
    }
  } catch {
    // Resolução é best-effort; falha aqui não bloqueia o request.
  }
}

// ── Exige papel ADMIN (usar depois de authAccount) ────────────
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (request.apiClient?.role !== 'ADMIN') {
    return reply.status(403).send({ error: 'Acesso restrito a administradores' })
  }
}

// Alias de compatibilidade com imports existentes
export const authMiddleware = authAccount
