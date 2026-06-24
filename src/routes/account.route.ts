// src/routes/account.route.ts
// Self-service do DONO da conta (OWNER): gerencia os usuários MEMBER da PRÓPRIA conta.
// Guard: authJwt + requireOwner. Escopo SEMPRE em request.apiClient.id (login humano),
// portanto sem acesso cross-tenant.
//
// Segurança (anti-escalonamento de privilégio): o OWNER NUNCA cria OWNER/SUPER_ADMIN
// (o papel é travado em MEMBER), e só edita/apaga usuários que sejam MEMBER da sua
// própria conta — qualquer alvo fora disso responde 404 (não vaza existência).
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authJwt, requireOwner } from '../middlewares/auth.middleware'
import { prisma } from '../utils/prisma'
import {
  ProvisioningError,
  createUserForClient,
  listUsers,
  updateUser,
  deleteUser,
} from '../services/provisioning.service'

const createMemberSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
})

const updateMemberSchema = z
  .object({
    name: z.string().min(1).optional(),
    password: z.string().min(8).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'Informe ao menos um campo para atualizar' })

// Confirma que o id-alvo é um MEMBER da própria conta do OWNER autenticado.
// Retorna o id quando válido, ou null (→ 404) — evita cross-tenant e edição de OWNER/SUPER_ADMIN.
async function findOwnMember(userId: string, apiClientId: string): Promise<string | null> {
  const target = await prisma.user.findFirst({
    where: { id: userId, apiClientId, role: 'MEMBER' },
    select: { id: true },
  })
  return target?.id ?? null
}

export async function accountRoutes(app: FastifyInstance) {
  // ── GET /account/users — Lista os usuários da própria conta ───
  app.get('/account/users', { preHandler: [authJwt, requireOwner] }, async (request, reply) => {
    return reply.send(await listUsers(request.apiClient!.id))
  })

  // ── POST /account/users — Cria um MEMBER na própria conta ─────
  app.post('/account/users', { preHandler: [authJwt, requireOwner] }, async (request, reply) => {
    const body = createMemberSchema.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
    }
    try {
      const user = await createUserForClient({
        apiClientId: request.apiClient!.id,
        email: body.data.email,
        password: body.data.password,
        name: body.data.name,
        role: 'MEMBER', // TRAVADO: OWNER não cria OWNER nem SUPER_ADMIN.
      })
      return reply.status(201).send({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        apiClientId: user.apiClientId,
        createdAt: user.createdAt,
      })
    } catch (err) {
      if (err instanceof ProvisioningError && err.code === 'EMAIL_TAKEN') {
        return reply.status(409).send({ error: 'E-mail já cadastrado' })
      }
      throw err
    }
  })

  // ── PATCH /account/users/:id — Edita um MEMBER (nome/senha; nunca papel) ─
  app.patch<{ Params: { id: string } }>(
    '/account/users/:id',
    { preHandler: [authJwt, requireOwner] },
    async (request, reply) => {
      const body = updateMemberSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
      }
      const targetId = await findOwnMember(request.params.id, request.apiClient!.id)
      if (!targetId) return reply.status(404).send({ error: 'Usuário não encontrado' })

      const user = await updateUser(targetId, { name: body.data.name, password: body.data.password })
      return reply.send({ id: user.id, email: user.email, name: user.name, role: user.role })
    },
  )

  // ── DELETE /account/users/:id — Apaga um MEMBER da própria conta ─
  app.delete<{ Params: { id: string } }>(
    '/account/users/:id',
    { preHandler: [authJwt, requireOwner] },
    async (request, reply) => {
      const targetId = await findOwnMember(request.params.id, request.apiClient!.id)
      if (!targetId) return reply.status(404).send({ error: 'Usuário não encontrado' })

      await deleteUser(targetId)
      return reply.status(204).send()
    },
  )
}
