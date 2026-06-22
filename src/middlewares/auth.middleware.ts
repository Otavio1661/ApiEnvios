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
  // Ignora rotas públicas (health e callbacks inbound dos providers) e o painel web
  // (autenticado por cookie httpOnly, resolvido no preHandler requirePanelAuth).
  if (
    request.url === '/health' ||
    request.url.includes('/webhooks/inbound/') ||
    request.url.startsWith('/admin')
  )
    return

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

// ── Auth por JWT (login humano) ───────────────────────────────
// Valida o JWT (header Authorization: Bearer), carrega o ApiClient da conta
// e o User do payload, e anexa request.apiClient (REUSA o escopo por tenant)
// + request.authUser. 401 se inválido/expirado ou conta inativa.
export async function authJwt(request: FastifyRequest, reply: FastifyReply) {
  let payload: { userId: string; apiClientId: string; accountRole: string }
  try {
    payload = await request.jwtVerify()
  } catch {
    return reply.status(401).send({ error: 'Token inválido ou expirado' })
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    include: { apiClient: true },
  })

  if (!user || !user.apiClient.active) {
    return reply.status(401).send({ error: 'Usuário ou conta inválidos/inativos' })
  }

  const { apiClient, passwordHash, ...userData } = user
  request.apiClient = apiClient
  request.authUser = {
    id: userData.id,
    email: userData.email,
    name: userData.name,
    role: userData.role,
  }
}

// ── Auth combinado: API key OU JWT (endpoints de gestão) ──────
// Mantém 100% de compatibilidade com a API key de conta. Estratégia:
// 1) Se houver header `x-api-key`, usa authAccount (API key explícita).
// 2) Caso contrário, se houver `Authorization: Bearer <valor>`, decide pelo
//    formato do valor: um JWT tem 3 segmentos separados por ponto → authJwt;
//    qualquer outro valor é tratado como API key de conta → authAccount.
// 3) Sem nenhum dos dois → 401 (delegado ao authAccount, que já responde 401).
export async function authManage(request: FastifyRequest, reply: FastifyReply) {
  const apiKeyHeader = request.headers['x-api-key'] as string | undefined
  if (apiKeyHeader) {
    return authAccount(request, reply)
  }

  const bearer = request.headers.authorization?.replace('Bearer ', '')
  // Heurística: 3 partes separadas por ponto ⇒ JWT (header.payload.signature).
  if (bearer && bearer.split('.').length === 3) {
    return authJwt(request, reply)
  }

  // Sem JWT detectável: trata como API key de conta (mantém compatibilidade).
  return authAccount(request, reply)
}

// ── Exige papel ADMIN (usar depois de authAccount) ────────────
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (request.apiClient?.role !== 'ADMIN') {
    return reply.status(403).send({ error: 'Acesso restrito a administradores' })
  }
}

// ── Super admin (controle global da plataforma) ───────────────
// Funciona nos dois modos de auth: via JWT (usuário com role SUPER_ADMIN) ou via
// API key da conta ADMIN (admin-key). Centraliza a regra usada para bypass de
// quota e visibilidade do provider WAHA.
export function isSuperAdmin(request: FastifyRequest): boolean {
  return request.authUser?.role === 'SUPER_ADMIN' || request.apiClient?.role === 'ADMIN'
}

// Guard: exige super admin (usar depois de authManage/authJwt).
export async function requireSuperAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!isSuperAdmin(request)) {
    return reply.status(403).send({ error: 'Acesso restrito ao super admin' })
  }
}

// Alias de compatibilidade com imports existentes
export const authMiddleware = authAccount
