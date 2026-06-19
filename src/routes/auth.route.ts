// src/routes/auth.route.ts
// Rotas de autenticação humana (login JWT). Prefixo /v1/auth.
// NÃO há cadastro público — usuários são criados SOMENTE pelo admin
// (ver src/routes/admin.route.ts). Aqui só: login, perfil e troca de senha.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authJwt } from '../middlewares/auth.middleware'
import { prisma } from '../utils/prisma'
import { hashPassword, verifyPassword } from '../utils/password'

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
})

export async function authRoutes(app: FastifyInstance) {
  // ── POST /auth/login — Autentica e devolve o JWT ──────────────
  app.post('/auth/login', async (request, reply) => {
    const body = loginSchema.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
    }

    const user = await prisma.user.findUnique({
      where: { email: body.data.email },
      include: { apiClient: true },
    })

    // Mensagem genérica (não revela se o e-mail existe).
    if (!user || !user.apiClient.active) {
      return reply.status(401).send({ error: 'Credenciais inválidas' })
    }

    const ok = await verifyPassword(body.data.password, user.passwordHash)
    if (!ok) {
      return reply.status(401).send({ error: 'Credenciais inválidas' })
    }

    const token = app.jwt.sign({
      userId: user.id,
      apiClientId: user.apiClientId,
      accountRole: user.apiClient.role,
    })

    return reply.send({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      account: { id: user.apiClient.id, name: user.apiClient.name },
    })
  })

  // ── GET /auth/me — Perfil do usuário autenticado ──────────────
  app.get('/auth/me', { preHandler: authJwt }, async (request, reply) => {
    return reply.send({
      user: request.authUser,
      account: {
        id: request.apiClient!.id,
        name: request.apiClient!.name,
        role: request.apiClient!.role,
      },
    })
  })

  // ── POST /auth/change-password — Troca a própria senha ────────
  app.post('/auth/change-password', { preHandler: authJwt }, async (request, reply) => {
    const body = changePasswordSchema.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
    }

    const user = await prisma.user.findUnique({ where: { id: request.authUser!.id } })
    if (!user) {
      return reply.status(401).send({ error: 'Usuário não encontrado' })
    }

    const ok = await verifyPassword(body.data.currentPassword, user.passwordHash)
    if (!ok) {
      return reply.status(401).send({ error: 'Senha atual incorreta' })
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(body.data.newPassword) },
    })

    return reply.send({ ok: true })
  })
}
