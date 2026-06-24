// src/routes/admin.route.ts
// Endpoints administrativos — provisionamento de contas (tenants) e usuários.
// Protegidos por authAccount + requireAdmin (somente ApiClient role ADMIN).
// NÃO há self-service: criar contas/usuários é exclusivo do admin da plataforma.
// A regra de negócio (transação atômica, unicidade de e-mail) vive em
// src/services/provisioning.service.ts e é compartilhada com o painel web admin.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authAccount, requireAdmin } from '../middlewares/auth.middleware'
import {
  ProvisioningError,
  createClientWithOwner,
  createUserForClient,
  listClients,
  listUsers,
  deleteUser,
} from '../services/provisioning.service'

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
}
