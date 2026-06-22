// src/routes/instances.route.ts
// Ciclo de vida de instância (gestão por API key de conta) + QR Code + envio por token.
// Reaproveita os métodos já existentes dos providers (createInstance/getInstanceStatus/deleteInstance).
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authManage, authInstance } from '../middlewares/auth.middleware'
import { prisma } from '../utils/prisma'
import { providers } from '../providers'
import { enqueueSend } from '../queues/send-message.queue'
import { normalizePhone } from '../utils/helpers'
import type { MessageType } from '../types'
import {
  toInstanceResponse,
  refreshQr,
  registerInboundWebhook,
  syncInstanceStatus,
  createInstance,
  findInstanceByIdOrSlug,
  updateInstance,
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
  provider: z.enum(['EVOLUTION', 'WAHA', 'CLOUD_API']),
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

// Fase C2: adicionar número ao pool de uma instância.
const addNumberSchema = z.object({
  provider: z.enum(['EVOLUTION', 'WAHA', 'CLOUD_API']),
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
        const instance = await createInstance({
          name: body.data.name,
          slug: body.data.slug,
          provider: body.data.provider,
          priority: body.data.priority,
          apiClientId: request.apiClient!.id,
        })
        return reply.status(201).send(toInstanceResponse(instance))
      } catch (err: any) {
        if (err instanceof InstanceError) {
          return reply.status(409).send({ error: err.message, code: err.code })
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

      const existing = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id)
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
          const status = err.code === 'NOT_FOUND' ? 404 : 409
          return reply.status(status).send({ error: err.message, code: err.code })
        }
        request.log.error(`[Instances] Falha ao renomear instância: ${err.message}`)
        return reply.status(500).send({ error: 'Falha ao atualizar a instância' })
      }
    },
  })

  // ── GET /instances — Lista instâncias do tenant ───────────────
  app.get('/instances', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const instances = await prisma.instance.findMany({
        where: { apiClientId: request.apiClient!.id },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      })
      return reply.send(instances.map(toInstanceResponse))
    },
  })

  // ── GET /instances/stats — Dashboard rápido (escopado) ────────
  app.get('/instances/stats', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const apiClientId = request.apiClient!.id
      const [active, banned, total, sentToday] = await Promise.all([
        prisma.instance.count({ where: { apiClientId, status: 'ACTIVE' } }),
        prisma.instance.count({ where: { apiClientId, status: 'BANNED' } }),
        prisma.instance.count({ where: { apiClientId } }),
        prisma.instance.aggregate({ where: { apiClientId }, _sum: { sentToday: true } }),
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
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id)
      if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' })
      return reply.send(toInstanceResponse(instance))
    },
  })

  // ── DELETE /instances/:id — Remove (best-effort no provider) ──
  app.delete<{ Params: { id: string } }>('/instances/:id', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id)
      if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' })

      // Remove a instância no provider (best-effort — não bloqueia a exclusão local)
      if (instance.instanceId) {
        try {
          await providers[instance.provider].deleteInstance(instance.instanceId)
        } catch (err: any) {
          request.log.warn(`[Instances] Falha ao remover instância no provider: ${err.message}`)
        }
      }

      await prisma.instance.delete({ where: { id: instance.id } })
      return reply.status(204).send()
    },
  })

  // ── POST /instances/:id/connect — Cria/conecta no provider, gera QR ─
  app.post<{ Params: { id: string } }>('/instances/:id/connect', {
    preHandler: authManage,
    handler: async (request, reply) => {
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id)
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
      // Para WAHA, deve vir ANTES do createInstance para entrar no config da sessão
      // (pendingWebhookUrl). Para Evolution, a sessão só existe após o refreshQr, então
      // re-registramos DEPOIS (a sessão inexistente faz o 1º setWebhook retornar 404).
      await registerInboundWebhook(instance, request.log)

      try {
        const updated = await refreshQr(instance)
        // Pós-registro: agora a sessão existe no provider (Evolution grava o webhook;
        // WAHA faz um PUT idempotente). Best-effort.
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
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id)
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
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id)
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

      const existing = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id)
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
      const existing = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id)
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

      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id)
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
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id)
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
        const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id)
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
        const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id)
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
        const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id)
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
        const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id)
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
}
