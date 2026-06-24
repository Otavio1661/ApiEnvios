// src/routes/admin.route.ts
// Endpoints administrativos — provisionamento de contas (tenants) e usuários.
// Protegidos por authAccount + requireAdmin (somente ApiClient role ADMIN).
// NÃO há self-service: criar contas/usuários é exclusivo do admin da plataforma.
// A regra de negócio (transação atômica, unicidade de e-mail) vive em
// src/services/provisioning.service.ts e é compartilhada com o painel web admin.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authAccount, requireAdmin, authManage, requireSuperAdmin } from '../middlewares/auth.middleware'
import {
  ProvisioningError,
  createClientWithOwner,
  createUserForClient,
  listClients,
  listUsers,
  deleteUser,
  updateClient,
  updateUser,
} from '../services/provisioning.service'
import { deleteClientCascade, deleteInstanceCascade } from '../services/cascade-delete.service'
import { listAllInstances } from '../services/instance.service'

const createClientSchema = z.object({
  name: z.string().min(1),
  role: z.enum(['ADMIN', 'CLIENT']).default('CLIENT'),
  fallbackEnabled: z.boolean().default(false),
  rateLimit: z.number().int().positive().default(100),
  // Teto de mensagens/hora para o mesmo destino (anti-flood). 0 = ilimitado.
  maxPerRecipientPerHour: z.number().int().min(0).optional(),
  // Opcional: cria também o usuário OWNER vinculado à conta criada.
  ownerEmail: z.string().email().optional(),
  ownerPassword: z.string().min(8).optional(),
  ownerName: z.string().optional(),
})
  .refine(
    (d) => (d.ownerEmail ? Boolean(d.ownerPassword) : true),
    { message: 'ownerPassword é obrigatório quando ownerEmail é informado', path: ['ownerPassword'] },
  )

const createUserSchema = z.object({
  apiClientId: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
  role: z.enum(['OWNER', 'MEMBER']).default('OWNER'),
})

// Edição de conta (super admin): todos os campos opcionais; ao menos um obrigatório.
const updateClientSchema = z
  .object({
    name: z.string().min(1).optional(),
    role: z.enum(['ADMIN', 'CLIENT']).optional(),
    rateLimit: z.number().int().positive().optional(),
    maxInstances: z.number().int().min(0).optional(),
    maxPerRecipientPerHour: z.number().int().min(0).optional(),
    fallbackEnabled: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'Informe ao menos um campo para atualizar' })

// Edição de usuário (super admin): nome, papel e/ou redefinição de senha.
const updateUserSchema = z
  .object({
    name: z.string().min(1).optional(),
    role: z.enum(['OWNER', 'MEMBER', 'SUPER_ADMIN']).optional(),
    password: z.string().min(8).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'Informe ao menos um campo para atualizar' })

export async function adminRoutes(app: FastifyInstance) {
  // ── POST /admin/clients — Cria um tenant (e, opcionalmente, o OWNER) ─
  app.post('/admin/clients', {
    preHandler: [authAccount, requireAdmin],
    handler: async (request, reply) => {
      const body = createClientSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
      }

      try {
        const { client, owner } = await createClientWithOwner(body.data)
        return reply.status(201).send({
          id: client.id,
          name: client.name,
          role: client.role,
          apiKey: client.apiKey,
          fallbackEnabled: client.fallbackEnabled,
          rateLimit: client.rateLimit,
          maxPerRecipientPerHour: client.maxPerRecipientPerHour,
          active: client.active,
          createdAt: client.createdAt,
          ...(owner ? { owner } : {}),
        })
      } catch (err) {
        if (err instanceof ProvisioningError && err.code === 'EMAIL_TAKEN') {
          return reply.status(409).send({ error: 'E-mail de owner já cadastrado' })
        }
        throw err
      }
    },
  })

  // ── GET /admin/clients — Lista as contas ──────────────────────
  app.get('/admin/clients', {
    preHandler: [authAccount, requireAdmin],
    handler: async (_request, reply) => {
      return reply.send(await listClients())
    },
  })

  // ── POST /admin/users — Cria um usuário vinculado a uma conta ──
  app.post('/admin/users', {
    preHandler: [authAccount, requireAdmin],
    handler: async (request, reply) => {
      const body = createUserSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
      }

      try {
        const user = await createUserForClient(body.data)
        return reply.status(201).send({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          apiClientId: user.apiClientId,
          createdAt: user.createdAt,
        })
      } catch (err) {
        if (err instanceof ProvisioningError) {
          if (err.code === 'CLIENT_NOT_FOUND') {
            return reply.status(404).send({ error: 'Conta (apiClientId) não encontrada' })
          }
          if (err.code === 'EMAIL_TAKEN') {
            return reply.status(409).send({ error: 'E-mail já cadastrado' })
          }
        }
        throw err
      }
    },
  })

  // ── GET /admin/users — Lista usuários (filtrável por apiClientId) ─
  app.get('/admin/users', {
    preHandler: [authAccount, requireAdmin],
    handler: async (request, reply) => {
      const query = request.query as { apiClientId?: string }
      return reply.send(await listUsers(query.apiClientId))
    },
  })

  // ── DELETE /admin/users/:id — Remove um usuário ───────────────
  app.delete<{ Params: { id: string } }>('/admin/users/:id', {
    preHandler: [authAccount, requireAdmin],
    handler: async (request, reply) => {
      const removed = await deleteUser(request.params.id)
      if (!removed) {
        return reply.status(404).send({ error: 'Usuário não encontrado' })
      }
      return reply.status(204).send()
    },
  })

  // ══════════════════════════════════════════════════════════════
  // SUPER ADMIN — edição e deleção em cascata (controle global)
  // Guard: authManage (API key da conta ADMIN OU JWT) + requireSuperAdmin.
  // ══════════════════════════════════════════════════════════════

  // ── PATCH /admin/clients/:id — Edita uma conta (inclui ativar/desativar) ─
  app.patch<{ Params: { id: string } }>('/admin/clients/:id', {
    preHandler: [authManage, requireSuperAdmin],
    handler: async (request, reply) => {
      const body = updateClientSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
      }
      try {
        const client = await updateClient(request.params.id, body.data)
        return reply.send({
          id: client.id,
          name: client.name,
          role: client.role,
          active: client.active,
          fallbackEnabled: client.fallbackEnabled,
          rateLimit: client.rateLimit,
          maxInstances: client.maxInstances,
          maxPerRecipientPerHour: client.maxPerRecipientPerHour,
          updatedAt: client.updatedAt,
        })
      } catch (err) {
        if (err instanceof ProvisioningError && err.code === 'CLIENT_NOT_FOUND') {
          return reply.status(404).send({ error: 'Conta não encontrada' })
        }
        throw err
      }
    },
  })

  // ── DELETE /admin/clients/:id — Apaga DEFINITIVAMENTE a conta e tudo relacional ─
  app.delete<{ Params: { id: string } }>('/admin/clients/:id', {
    preHandler: [authManage, requireSuperAdmin],
    handler: async (request, reply) => {
      // Salvaguarda: a conta não pode apagar a si mesma (evita perder o acesso ADMIN).
      if (request.apiClient?.id === request.params.id) {
        return reply.status(409).send({ error: 'Não é possível apagar a própria conta autenticada' })
      }
      const removed = await deleteClientCascade(request.params.id, request.log)
      if (!removed) {
        return reply.status(404).send({ error: 'Conta não encontrada' })
      }
      return reply.status(204).send()
    },
  })

  // ── PATCH /admin/users/:id — Edita um usuário (nome/papel/senha) ─
  app.patch<{ Params: { id: string } }>('/admin/users/:id', {
    preHandler: [authManage, requireSuperAdmin],
    handler: async (request, reply) => {
      const body = updateUserSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
      }
      try {
        const user = await updateUser(request.params.id, body.data)
        return reply.send({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          apiClientId: user.apiClientId,
          updatedAt: user.updatedAt,
        })
      } catch (err) {
        if (err instanceof ProvisioningError && err.code === 'USER_NOT_FOUND') {
          return reply.status(404).send({ error: 'Usuário não encontrado' })
        }
        throw err
      }
    },
  })

  // ── GET /admin/instances — Lista TODAS as instâncias (visão global) ─
  app.get('/admin/instances', {
    preHandler: [authManage, requireSuperAdmin],
    handler: async (_request, reply) => {
      return reply.send(await listAllInstances())
    },
  })

  // ── DELETE /admin/instances/:id — Apaga DEFINITIVAMENTE qualquer instância ─
  app.delete<{ Params: { id: string } }>('/admin/instances/:id', {
    preHandler: [authManage, requireSuperAdmin],
    handler: async (request, reply) => {
      const removed = await deleteInstanceCascade(request.params.id, request.log)
      if (!removed) {
        return reply.status(404).send({ error: 'Instância não encontrada' })
      }
      return reply.status(204).send()
    },
  })
}
