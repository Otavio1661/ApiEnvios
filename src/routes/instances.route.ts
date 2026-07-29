// src/routes/instances.route.ts
// Ciclo de vida de instância (gestão por API key de conta) + QR Code + envio por token.
// Reaproveita os métodos já existentes dos providers (createInstance/getInstanceStatus/deleteInstance).
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authManage, authInstance, authJwt, isSuperAdmin, requireOwner, memberScopeId } from '../middlewares/auth.middleware'
import { prisma } from '../utils/prisma'
import { enqueueSend } from '../queues/send-message.queue'
import { deleteInstanceCascade } from '../services/cascade-delete.service'
import { normalizePhone } from '../utils/helpers'
import type { MessageType, ChatPresenceState } from '../types'
import { providers } from '../providers'
import { sendBodySchema } from '../schemas/message.schema'
import { buildMessageCreateFields } from '../utils/message-payload'
import {
  toInstanceResponse,
  listInstancesWithConnection,
  deriveConnectionState,
  refreshQr,
  registerInboundWebhook,
  syncInstanceStatus,
  createInstance,
  assertInstanceQuota,
  findInstanceByIdOrSlug,
  updateInstance,
  assignInstanceOwner,
  InstanceError,
  listNumbers,
  addNumber,
  findNumberScoped,
  connectNumber,
  refreshQrNumber,
  syncNumberStatus,
  deleteNumber,
} from '../services/instance.service'
import { slugSchema } from '../utils/slug'

// ── Schemas Zod ───────────────────────────────────────────────
const createInstanceSchema = z.object({
  name: z.string().optional(),
  slug: slugSchema.optional(),
  provider: z.enum(['EVOLUTION', 'WUZAPI', 'CLOUD_API']),
  priority: z.number().int().min(0).default(0),
})

// Renomear: name e/ou slug; ao menos um deve ser informado.
const updateInstanceSchema = z
  .object({
    name: z.string().min(1).optional(),
    slug: slugSchema.optional(),
  })
  .refine((d) => d.name !== undefined || d.slug !== undefined, {
    message: 'Informe ao menos name ou slug.',
  })

const patchStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'WARMING', 'BANNED', 'SUSPENDED', 'RETIRED']),
})

// Reatribuição de dono (OWNER): ownerUserId = id do membro, ou null para remover o dono.
const patchOwnerSchema = z.object({
  ownerUserId: z.string().min(1).nullable(),
})

// Fase C2: adicionar número ao pool de uma instância.
const addNumberSchema = z.object({
  provider: z.enum(['EVOLUTION', 'WUZAPI', 'CLOUD_API']),
  label: z.string().optional(),
  priority: z.number().int().min(0).default(0),
})

const chatSchema = z.object({
  to: z.string().min(10).max(15),
  body: z.string().min(1),
})

const mediaSchema = z.object({
  to: z.string().min(10).max(15),
  mediaUrl: z.string().url(),
  caption: z.string().optional(),
  type: z.enum(['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT']).default('IMAGE'),
})

// ── Ações síncronas (exclusivas do WuzAPI) — não geram Message ─
const presenceSchema = z.object({
  to: z.string().min(10).max(15),
  state: z.enum(['typing', 'recording', 'paused']),
})

const reactSchema = z.object({
  to: z.string().min(10).max(15),
  messageId: z.string().min(1),
  emoji: z.string().max(8).optional(), // vazio/omitido = remove a reação
})

const readSchema = z.object({
  to: z.string().min(10).max(15),
  messageIds: z.array(z.string().min(1)).min(1).max(50),
})

const checkNumberSchema = z.object({
  phones: z.array(z.string().min(8).max(20)).min(1).max(50),
})

export async function instancesRoutes(app: FastifyInstance) {
  // ══════════════════════════════════════════════════════════════
  // GESTÃO (preHandler: authManage, escopado por request.apiClient.id)
  // ══════════════════════════════════════════════════════════════

  // ── POST /instances — Cria registro de instância para o tenant ─
  app.post('/instances', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const body = createInstanceSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
      }


      try {
        // Quota por conta (super admin ignora).
        if (!isSuperAdmin(request)) {
          await assertInstanceQuota(request.apiClient!.id)
        }
        const instance = await createInstance({
          name: body.data.name,
          slug: body.data.slug,
          provider: body.data.provider,
          priority: body.data.priority,
          apiClientId: request.apiClient!.id,
          // O usuário humano que cria vira dono (MEMBER vê só as suas). API key
          // de máquina (sem authUser) cria instância de nível de conta (sem dono).
          ownerUserId: request.authUser?.id ?? null,
        })
        return reply.status(201).send(toInstanceResponse(instance))
      } catch (err: any) {
        if (err instanceof InstanceError) {
          const status =
            err.code === 'INVALID_SLUG' ? 400 : err.code === 'QUOTA_EXCEEDED' ? 403 : 409
          return reply.status(status).send({ error: err.message, code: err.code })
        }
        request.log.error(`[Instances] Falha ao criar instância: ${err.message}`)
        return reply.status(500).send({ error: 'Falha ao criar a instância' })
      }
    },
  })

  // ── PATCH /instances/:id — Renomeia (name/slug) ───────────────
  // Aceita id OU slug em :id. Valida unicidade (slug global, name por tenant).
  app.patch<{ Params: { id: string } }>('/instances/:id', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const body = updateInstanceSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
      }

      const existing = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!existing) return reply.status(404).send({ error: 'Instância não encontrada' })

      try {
        const instance = await updateInstance({
          id: existing.id,
          apiClientId: request.apiClient!.id,
          name: body.data.name,
          slug: body.data.slug,
        })
        return reply.send(toInstanceResponse(instance))
      } catch (err: any) {
        if (err instanceof InstanceError) {
          const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'INVALID_SLUG' ? 400 : 409
          return reply.status(status).send({ error: err.message, code: err.code })
        }
        request.log.error(`[Instances] Falha ao renomear instância: ${err.message}`)
        return reply.status(500).send({ error: 'Falha ao atualizar a instância' })
      }
    },
  })

  // ── PATCH /instances/:id/owner — (Re)atribui o dono (só OWNER) ─
  // OWNER da conta atribui a instância a um MEMBER (ou remove o dono com null).
  app.patch<{ Params: { id: string } }>('/instances/:id/owner', {
    preHandler: [authJwt, requireOwner],
    handler: async (request, reply) => {
      const body = patchOwnerSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
      }

      const existing = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id)
      if (!existing) return reply.status(404).send({ error: 'Instância não encontrada' })

      try {
        const instance = await assignInstanceOwner({
          instanceId: existing.id,
          apiClientId: request.apiClient!.id,
          ownerUserId: body.data.ownerUserId,
        })
        return reply.send(toInstanceResponse(instance))
      } catch (err: any) {
        if (err instanceof InstanceError) {
          return reply.status(err.code === 'NOT_FOUND' ? 404 : 409).send({ error: err.message, code: err.code })
        }
        request.log.error(`[Instances] Falha ao atribuir dono: ${err.message}`)
        return reply.status(500).send({ error: 'Falha ao atribuir o dono da instância' })
      }
    },
  })

  // ── GET /instances — Lista instâncias do tenant ───────────────
  app.get('/instances', {
    preHandler: authManage,
    handler: async (request, reply) => {
      // MEMBER vê só as suas; OWNER/admin/API key veem todas as da conta.
      // `connection` = status derivado do pool (fonte de verdade do envio); mantém
      // `connectionState` legado por compatibilidade.
      const instances = await listInstancesWithConnection(request.apiClient!.id, memberScopeId(request))
      return reply.send(instances.map((i) => ({ ...toInstanceResponse(i), connection: i.connection })))
    },
  })

  // ── GET /instances/stats — Dashboard rápido (escopado) ────────
  app.get('/instances/stats', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const apiClientId = request.apiClient!.id
      // MEMBER: estatísticas restritas às instâncias dele; demais: conta inteira.
      const ownerUserId = memberScopeId(request)
      const scope = { apiClientId, ...(ownerUserId ? { ownerUserId } : {}) }
      const [active, banned, total, sentToday] = await Promise.all([
        prisma.instance.count({ where: { ...scope, status: 'ACTIVE' } }),
        prisma.instance.count({ where: { ...scope, status: 'BANNED' } }),
        prisma.instance.count({ where: scope }),
        // Fase C3 moveu os contadores de envio para os NÚMEROS do pool
        // (InstanceNumber); Instance.sentToday não é mais incrementado. Somamos
        // pelos números das instâncias do escopo.
        prisma.instanceNumber.aggregate({
          where: { instance: scope },
          _sum: { sentToday: true },
        }),
      ])

      return reply.send({
        active,
        banned,
        total,
        sentToday: sentToday._sum.sentToday ?? 0,
      })
    },
  })

  // ── GET /instances/:id — Detalhe (404 se não for do tenant) ───
  app.get<{ Params: { id: string } }>('/instances/:id', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' })
      // Status derivado do pool (mesmo do painel); mantém o legado por compatibilidade.
      const numbers = await prisma.instanceNumber.findMany({
        where: { instanceId: instance.id },
        select: { connectionState: true },
      })
      return reply.send({ ...toInstanceResponse(instance), connection: deriveConnectionState(numbers) })
    },
  })

  // ── DELETE /instances/:id — Remove (best-effort no provider) ──
  app.delete<{ Params: { id: string } }>('/instances/:id', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' })

      // Cascata: remove sessão no provider (best-effort) + filhos (mensagens, tentativas,
      // rotações, números) numa transação. Evita o erro de FK do delete direto quando a
      // instância já enviou mensagens/teve rotações.
      await deleteInstanceCascade(instance.id, request.log)
      return reply.status(204).send()
    },
  })

  // ── POST /instances/:id/connect — Cria/conecta no provider, gera QR ─
  app.post<{ Params: { id: string } }>('/instances/:id/connect', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' })

      // Cloud API não tem fluxo de QR — já é considerada conectada
      if (instance.provider === 'CLOUD_API') {
        const updated = await prisma.instance.update({
          where: { id: instance.id },
          data: { connectionState: 'CONNECTED', qrCode: null, qrExpiresAt: null },
        })
        return reply.send({
          instanceId: updated.instanceId,
          qrCode: null,
          qrExpiresAt: null,
          connectionState: updated.connectionState,
        })
      }

      // Registra o webhook inbound no provider (best-effort — não falha o connect).
      // Alguns providers exigem o webhook ANTES do createInstance; outros (Evolution) só
      // (pendingWebhookUrl). Para Evolution, a sessão só existe após o refreshQr, então
      // re-registramos DEPOIS (a sessão inexistente faz o 1º setWebhook retornar 404).
      await registerInboundWebhook(instance, request.log)

      try {
        const updated = await refreshQr(instance)
        // Pós-registro: agora a sessão existe no provider (Evolution grava o webhook;
        // aceitam depois. registerInboundWebhook é best-effort/idempotente.
        await registerInboundWebhook(updated, request.log)
        return reply.send({
          instanceId: updated.instanceId,
          qrCode: updated.qrCode,
          qrExpiresAt: updated.qrExpiresAt,
          connectionState: updated.connectionState,
        })
      } catch (err: any) {
        // Provider externo indisponível/erro — resposta controlada (não 500)
        request.log.error(`[Instances] connect falhou (${instance.provider}): ${err.message}`)
        return reply.status(502).send({
          error: 'Falha ao conectar no provider',
          provider: instance.provider,
          detail: err?.response?.data?.message ?? err.message,
        })
      }
    },
  })

  // ── GET /instances/:id/qr — Retorna QR atual (renova se expirado) ─
  app.get<{ Params: { id: string } }>('/instances/:id/qr', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' })

      if (instance.provider === 'CLOUD_API') {
        return reply.status(400).send({ error: 'Cloud API não utiliza QR Code' })
      }

      const now = Date.now()
      const expired = !instance.qrExpiresAt || instance.qrExpiresAt.getTime() < now

      // QR válido em cache — retorna direto
      if (instance.qrCode && !expired) {
        return reply.send({
          qrCode: instance.qrCode,
          qrExpiresAt: instance.qrExpiresAt,
          connectionState: instance.connectionState,
        })
      }

      // Expirado (ou inexistente) — renova via connect (NÃO recria a instância)
      try {
        const updated = await refreshQr(instance)
        return reply.send({
          qrCode: updated.qrCode,
          qrExpiresAt: updated.qrExpiresAt,
          connectionState: updated.connectionState,
        })
      } catch (err: any) {
        request.log.error(`[Instances] qr refresh falhou (${instance.provider}): ${err.message}`)
        return reply.status(502).send({
          error: 'Falha ao renovar QR no provider',
          provider: instance.provider,
          detail: err?.response?.data?.message ?? err.message,
        })
      }
    },
  })

  // ── GET /instances/:id/status — Consulta status no provider ───
  app.get<{ Params: { id: string } }>('/instances/:id/status', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' })

      try {
        const connectionState = await syncInstanceStatus(instance)
        return reply.send({ connectionState })
      } catch (err: any) {
        request.log.error(`[Instances] status falhou (${instance.provider}): ${err.message}`)
        return reply.status(502).send({
          error: 'Falha ao consultar status no provider',
          provider: instance.provider,
          detail: err?.response?.data?.message ?? err.message,
        })
      }
    },
  })

  // ── PATCH /instances/:id/status — Muda status de ciclo de vida ─
  app.patch<{ Params: { id: string } }>('/instances/:id/status', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const body = patchStatusSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Status inválido' })
      }

      const existing = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!existing) {
        return reply.status(404).send({ error: 'Instância não encontrada' })
      }

      const instance = await prisma.instance.update({
        where: { id: existing.id },
        data: { status: body.data.status },
      })
      return reply.send(toInstanceResponse(instance))
    },
  })

  // ── POST /instances/:id/rotate — Rotação manual ───────────────
  app.post<{ Params: { id: string } }>('/instances/:id/rotate', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const existing = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!existing) return reply.status(404).send({ error: 'Instância não encontrada' })

      const instance = await prisma.instance.update({
        where: { id: existing.id },
        data: { status: 'RETIRED' },
      })

      await prisma.numberRotation.create({
        data: { instanceId: instance.id, reason: 'MANUAL', triggeredBy: 'api' },
      })

      return reply.send({
        message: 'Instância rotacionada com sucesso',
        instance: toInstanceResponse(instance),
      })
    },
  })

  // ══════════════════════════════════════════════════════════════
  // FASE C2 — GESTÃO DE NÚMEROS DO POOL (InstanceNumber)
  // Operações de conexão/QR/status POR NÚMERO, escopadas por tenant.
  // Aceita id OU slug da instância em :id (findInstanceByIdOrSlug).
  // ══════════════════════════════════════════════════════════════

  // ── POST /instances/:id/numbers — Adiciona número ao pool ─────
  app.post<{ Params: { id: string } }>('/instances/:id/numbers', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const body = addNumberSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
      }

      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' })

      try {
        const number = await addNumber({
          instanceId: instance.id,
          provider: body.data.provider,
          label: body.data.label,
          priority: body.data.priority,
          apiClientId: request.apiClient!.id,
        })
        return reply.status(201).send(number)
      } catch (err: any) {
        if (err instanceof InstanceError && err.code === 'NOT_FOUND') {
          return reply.status(404).send({ error: err.message })
        }
        request.log.error(`[Numbers] Falha ao adicionar número: ${err.message}`)
        return reply.status(500).send({ error: 'Falha ao adicionar o número' })
      }
    },
  })

  // ── GET /instances/:id/numbers — Lista números do pool ────────
  app.get<{ Params: { id: string } }>('/instances/:id/numbers', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' })

      const numbers = await listNumbers(instance.id)
      return reply.send(numbers)
    },
  })

  // ── POST /instances/:id/numbers/:numberId/connect — Conecta número ─
  app.post<{ Params: { id: string; numberId: string } }>(
    '/instances/:id/numbers/:numberId/connect',
    {
      preHandler: authManage,
      handler: async (request, reply) => {
        const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
        if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' })

        const number = await findNumberScoped(request.params.numberId, request.apiClient!.id)
        if (!number || number.instanceId !== instance.id) {
          return reply.status(404).send({ error: 'Número não encontrado' })
        }

        try {
          const result = await connectNumber(number, request.log)
          return reply.send(result)
        } catch (err: any) {
          request.log.error(`[Numbers] connect falhou (${number.provider}): ${err.message}`)
          return reply.status(502).send({
            error: 'Falha ao conectar no provider',
            provider: number.provider,
            detail: err?.response?.data?.message ?? err.message,
          })
        }
      },
    },
  )

  // ── GET /instances/:id/numbers/:numberId/qr — QR atual (renova se expirado) ─
  app.get<{ Params: { id: string; numberId: string } }>(
    '/instances/:id/numbers/:numberId/qr',
    {
      preHandler: authManage,
      handler: async (request, reply) => {
        const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
        if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' })

        const number = await findNumberScoped(request.params.numberId, request.apiClient!.id)
        if (!number || number.instanceId !== instance.id) {
          return reply.status(404).send({ error: 'Número não encontrado' })
        }

        if (number.provider === 'CLOUD_API') {
          return reply.status(400).send({ error: 'Cloud API não utiliza QR Code' })
        }

        const now = Date.now()
        const expired = !number.qrExpiresAt || number.qrExpiresAt.getTime() < now

        // QR válido em cache — retorna direto
        if (number.qrCode && !expired) {
          return reply.send({
            qrCode: number.qrCode,
            qrExpiresAt: number.qrExpiresAt,
            connectionState: number.connectionState,
          })
        }

        // Expirado (ou inexistente) — renova via connect (NÃO recria a sessão)
        try {
          const updated = await refreshQrNumber(number)
          return reply.send({
            qrCode: updated.qrCode,
            qrExpiresAt: updated.qrExpiresAt,
            connectionState: updated.connectionState,
          })
        } catch (err: any) {
          request.log.error(`[Numbers] qr refresh falhou (${number.provider}): ${err.message}`)
          return reply.status(502).send({
            error: 'Falha ao renovar QR no provider',
            provider: number.provider,
            detail: err?.response?.data?.message ?? err.message,
          })
        }
      },
    },
  )

  // ── GET /instances/:id/numbers/:numberId/status — Status no provider ─
  app.get<{ Params: { id: string; numberId: string } }>(
    '/instances/:id/numbers/:numberId/status',
    {
      preHandler: authManage,
      handler: async (request, reply) => {
        const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
        if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' })

        const number = await findNumberScoped(request.params.numberId, request.apiClient!.id)
        if (!number || number.instanceId !== instance.id) {
          return reply.status(404).send({ error: 'Número não encontrado' })
        }

        try {
          const connectionState = await syncNumberStatus(number)
          return reply.send({ connectionState })
        } catch (err: any) {
          request.log.error(`[Numbers] status falhou (${number.provider}): ${err.message}`)
          return reply.status(502).send({
            error: 'Falha ao consultar status no provider',
            provider: number.provider,
            detail: err?.response?.data?.message ?? err.message,
          })
        }
      },
    },
  )

  // ── DELETE /instances/:id/numbers/:numberId — Remove número do pool ─
  app.delete<{ Params: { id: string; numberId: string } }>(
    '/instances/:id/numbers/:numberId',
    {
      preHandler: authManage,
      handler: async (request, reply) => {
        const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
        if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' })

        const number = await findNumberScoped(request.params.numberId, request.apiClient!.id)
        if (!number || number.instanceId !== instance.id) {
          return reply.status(404).send({ error: 'Número não encontrado' })
        }

        await deleteNumber(number.id, request.apiClient!.id, request.log)
        return reply.status(204).send()
      },
    },
  )

  // ══════════════════════════════════════════════════════════════
  // ENVIO POR TOKEN DE INSTÂNCIA (preHandler: authInstance, header Token)
  // ══════════════════════════════════════════════════════════════

  // ── POST /instance/:id/messages/chat — Texto ──────────────────
  app.post<{ Params: { id: string } }>('/instance/:id/messages/chat', {
    preHandler: authInstance,
    handler: async (request, reply) => {
      const body = chatSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
      }

      const instance = request.instance!
      const to = normalizePhone(body.data.to)

      try {
        const message = await prisma.message.create({
          data: {
            apiClientId: request.apiClient!.id,
            instanceId: instance.id,
            toPhone: to,
            type: 'TEXT',
            content: body.data.body,
            status: 'QUEUED',
          },
        })

        await enqueueSend(message.id, message.maxRetries)
        return reply.status(202).send({ id: message.id, status: 'QUEUED' })
      } catch (err: any) {
        request.log.error(`[Instances] Falha ao enfileirar chat: ${err.message}`)
        return reply.status(500).send({ error: 'Falha ao processar a mensagem' })
      }
    },
  })

  // ── GET /instance/:id/messages/:messageId — Status de UMA mensagem ─
  // Existe porque QUEUED (o retorno de todo POST acima) só significa
  // "aceito na fila" — o envio de verdade acontece depois, num worker
  // assíncrono, com ATÉ 3 tentativas e backoff exponencial (5s/10s/20s).
  // Quem precisa saber o desfecho real ANTES de responder ao usuário final
  // (ex.: login esperando o código chegar) não pode esperar o ciclo
  // INTEIRO de retry (~20s+) — isso trava a tela por tempo longo demais.
  //
  // Por isso devolvemos `lastAttempt` além de `status`: `Message.status`
  // só vira FAILED na ÚLTIMA tentativa (ver send-message.worker.ts:124),
  // mas cada tentativa individual já grava um `MessageAttempt` na hora.
  // Quem está esperando pode decidir agir já na 1ª falha (ex.: numero com
  // restrição — normalmente as tentativas seguintes falham igual) em vez
  // de esperar o backoff inteiro só pra descobrir o que a 1ª tentativa já
  // sabia.
  //
  // Autenticado pelo MESMO token de instância dos envios — não pelo API
  // key de tenant (`authManage`), pra não obrigar quem só manda mensagem a
  // guardar uma segunda credencial só pra checar status.
  app.get<{ Params: { id: string; messageId: string } }>(
    '/instance/:id/messages/:messageId',
    {
      preHandler: authInstance,
      handler: async (request, reply) => {
        const instance = request.instance!
        const message = await prisma.message.findFirst({
          where: { id: request.params.messageId, instanceId: instance.id },
          include: { attempts: { orderBy: { attempt: 'desc' }, take: 1 } },
        })
        if (!message) return reply.status(404).send({ error: 'Mensagem não encontrada' })

        const ultimaTentativa = message.attempts[0]

        return reply.send({
          id: message.id,
          status: message.status,
          errorMessage: message.errorMessage,
          lastAttempt: ultimaTentativa
            ? { attempt: ultimaTentativa.attempt, success: ultimaTentativa.success, errorMsg: ultimaTentativa.errorMsg }
            : null,
        })
      },
    },
  )

  // ── POST /instance/:id/messages/media — Mídia ─────────────────
  app.post<{ Params: { id: string } }>('/instance/:id/messages/media', {
    preHandler: authInstance,
    handler: async (request, reply) => {
      const body = mediaSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
      }

      const instance = request.instance!
      const to = normalizePhone(body.data.to)
      const type = body.data.type as MessageType

      try {
        const message = await prisma.message.create({
          data: {
            apiClientId: request.apiClient!.id,
            instanceId: instance.id,
            toPhone: to,
            type,
            content: body.data.mediaUrl,
            caption: body.data.caption,
            status: 'QUEUED',
          },
        })

        await enqueueSend(message.id, message.maxRetries)
        return reply.status(202).send({ id: message.id, status: 'QUEUED' })
      } catch (err: any) {
        request.log.error(`[Instances] Falha ao enfileirar mídia: ${err.message}`)
        return reply.status(500).send({ error: 'Falha ao processar a mensagem' })
      }
    },
  })

  // ── POST /instance/:id/messages/send — Envio unificado ────────
  // Suporta TODOS os tipos (TEXT/mídia/STICKER/BUTTONS/LOCATION/CONTACT/POLL) —
  // /messages/chat e /messages/media acima continuam funcionando (compat), mas só
  // sabem TEXT e mídia básica. Este é o endpoint completo, espelhando POST /v1/messages.
  app.post<{ Params: { id: string } }>('/instance/:id/messages/send', {
    preHandler: authInstance,
    handler: async (request, reply) => {
      const body = sendBodySchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
      }

      const instance = request.instance!
      const payload = body.data
      const to = normalizePhone(payload.to)

      try {
        const message = await prisma.message.create({
          data: {
            apiClientId: request.apiClient!.id,
            instanceId: instance.id,
            toPhone: to,
            externalId: payload.externalId,
            ...buildMessageCreateFields(payload),
            status: 'QUEUED',
          },
        })

        await enqueueSend(message.id, message.maxRetries)
        return reply.status(202).send({ id: message.id, status: 'QUEUED' })
      } catch (err: any) {
        request.log.error(`[Instances] Falha ao enfileirar mensagem: ${err.message}`)
        return reply.status(500).send({ error: 'Falha ao processar a mensagem' })
      }
    },
  })

  // ══════════════════════════════════════════════════════════════
  // AÇÕES (exclusivas do WuzAPI) — chamadas síncronas ao provider,
  // não passam pela fila nem geram registro em Message.
  // ══════════════════════════════════════════════════════════════

  // ── POST /instance/:id/actions/presence — Digitando/gravando ──
  app.post<{ Params: { id: string } }>('/instance/:id/actions/presence', {
    preHandler: authInstance,
    handler: async (request, reply) => {
      const body = presenceSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
      }
      const instance = request.instance!
      const provider = providers[instance.provider]
      if (!provider.setPresence) {
        return reply.status(400).send({ error: `Provider ${instance.provider} não suporta indicador de digitando/gravando (use uma instância WuzAPI).`, errorCode: 'PRESENCE_UNSUPPORTED' })
      }
      try {
        await provider.setPresence(instance.instanceId ?? `inst-${instance.id}`, normalizePhone(body.data.to), body.data.state as ChatPresenceState)
        return reply.status(200).send({ ok: true })
      } catch (err: any) {
        return reply.status(502).send({ error: err.message ?? 'Falha ao definir presença' })
      }
    },
  })

  // ── POST /instance/:id/actions/react — Reagir a uma mensagem ──
  app.post<{ Params: { id: string } }>('/instance/:id/actions/react', {
    preHandler: authInstance,
    handler: async (request, reply) => {
      const body = reactSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
      }
      const instance = request.instance!
      const provider = providers[instance.provider]
      if (!provider.sendReaction) {
        return reply.status(400).send({ error: `Provider ${instance.provider} não suporta reações (use uma instância WuzAPI).`, errorCode: 'REACTION_UNSUPPORTED' })
      }
      const result = await provider.sendReaction(instance.instanceId ?? `inst-${instance.id}`, normalizePhone(body.data.to), body.data.messageId, body.data.emoji ?? '')
      if (!result.success) {
        return reply.status(502).send({ error: result.error ?? 'Falha ao reagir' })
      }
      return reply.status(200).send({ ok: true })
    },
  })

  // ── POST /instance/:id/actions/read — Marcar como lida ────────
  app.post<{ Params: { id: string } }>('/instance/:id/actions/read', {
    preHandler: authInstance,
    handler: async (request, reply) => {
      const body = readSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
      }
      const instance = request.instance!
      const provider = providers[instance.provider]
      if (!provider.markRead) {
        return reply.status(400).send({ error: `Provider ${instance.provider} não suporta confirmação de leitura (use uma instância WuzAPI).`, errorCode: 'READ_UNSUPPORTED' })
      }
      try {
        await provider.markRead(instance.instanceId ?? `inst-${instance.id}`, normalizePhone(body.data.to), body.data.messageIds)
        return reply.status(200).send({ ok: true })
      } catch (err: any) {
        return reply.status(502).send({ error: err.message ?? 'Falha ao marcar como lida' })
      }
    },
  })

  // ── POST /instance/:id/actions/check-number — Existe no WhatsApp? ─
  app.post<{ Params: { id: string } }>('/instance/:id/actions/check-number', {
    preHandler: authInstance,
    handler: async (request, reply) => {
      const body = checkNumberSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
      }
      const instance = request.instance!
      const provider = providers[instance.provider]
      if (!provider.checkNumber) {
        return reply.status(400).send({ error: `Provider ${instance.provider} não suporta verificação de número (use uma instância WuzAPI).`, errorCode: 'CHECK_NUMBER_UNSUPPORTED' })
      }
      try {
        const results = await provider.checkNumber(instance.instanceId ?? `inst-${instance.id}`, body.data.phones.map(normalizePhone))
        return reply.status(200).send({ results })
      } catch (err: any) {
        return reply.status(502).send({ error: err.message ?? 'Falha ao verificar número' })
      }
    },
  })
}
