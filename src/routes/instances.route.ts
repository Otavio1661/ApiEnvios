// src/routes/instances.route.ts
// Ciclo de vida de instância (gestão por API key de conta) + QR Code + envio por token.
// Reaproveita os métodos já existentes dos providers (createInstance/getInstanceStatus/deleteInstance).
import type { FastifyInstance } from 'fastify'
import type { Instance } from '@prisma/client'
import { z } from 'zod'
import { authAccount, authInstance } from '../middlewares/auth.middleware'
import { prisma } from '../utils/prisma'
import { config } from '../config'
import { providers } from '../providers'
import { enqueueSend } from '../queues/send-message.queue'
import { normalizePhone } from '../utils/helpers'
import type { MessageType } from '../types'

// Tempo de validade do QR em segundos
const QR_TTL_SECONDS = 45

// ── Schemas Zod ───────────────────────────────────────────────
const createInstanceSchema = z.object({
  name: z.string().optional(),
  provider: z.enum(['EVOLUTION', 'WAHA', 'CLOUD_API']),
  priority: z.number().int().min(0).default(0),
})

const patchStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'WARMING', 'BANNED', 'SUSPENDED', 'RETIRED']),
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

// ── Helpers ───────────────────────────────────────────────────
// Monta a representação UltraMsg da instância, incluindo apiUrl pública.
function toInstanceResponse(instance: Instance) {
  return {
    ...instance,
    apiUrl: `${config.app.publicBaseUrl}/v1/instance/${instance.id}`,
  }
}

// Mapeia o status do provider para o connectionState do banco.
function mapConnectionState(
  status: string,
  current: Instance['connectionState'],
): Instance['connectionState'] {
  switch (status) {
    case 'connected':
      return 'CONNECTED'
    case 'disconnected':
      return 'DISCONNECTED'
    case 'qr_required':
      return 'QR_PENDING'
    case 'banned':
      return 'BANNED'
    default:
      return current // 'unknown' → mantém o estado atual
  }
}

// Cria a instância no provider na 1ª vez (persistindo instanceId) e renova o QR
// via connect(). Centraliza a lógica compartilhada entre connect e qr.
// Retorna a instância atualizada. Lança em caso de erro do provider.
async function refreshQr(instance: Instance): Promise<Instance> {
  const provider = providers[instance.provider]
  let providerInstanceId = instance.instanceId
  let qrCode: string | undefined

  if (!providerInstanceId) {
    // 1ª conexão: cria a instância no provider e persiste o instanceId
    const created = await provider.createInstance(`inst-${instance.id}`)
    providerInstanceId = created.instanceId
    qrCode = created.qrCode
  } else {
    // Já existe no provider: reconecta para obter o QR atual (sem recriar)
    const result = await provider.connect(providerInstanceId)
    qrCode = result.qrCode
  }

  return prisma.instance.update({
    where: { id: instance.id },
    data: {
      instanceId: providerInstanceId,
      qrCode: qrCode ?? null,
      qrExpiresAt: new Date(Date.now() + QR_TTL_SECONDS * 1000),
      connectionState: 'QR_PENDING',
    },
  })
}

// Registra a URL de webhook inbound no provider (best-effort).
// A URL aponta para o endpoint público desta API; o provider chamará nela a cada evento.
// Não lança: falha aqui não deve bloquear o connect (logamos e seguimos).
async function registerInboundWebhook(
  instance: Instance,
  log: FastifyInstance['log'],
): Promise<void> {
  try {
    const provider = providers[instance.provider]
    // Nome da instância no provider (mesma convenção do refreshQr na 1ª conexão).
    const providerInstanceId = instance.instanceId ?? `inst-${instance.id}`
    const url = `${config.app.publicBaseUrl}/v1/webhooks/inbound/${instance.provider.toLowerCase()}/${instance.id}`
    await provider.setWebhook(providerInstanceId, url)
    log.info(`[Instances] webhook inbound registrado (${instance.provider}): ${url}`)
  } catch (err: any) {
    log.warn(`[Instances] setWebhook falhou (${instance.provider}, best-effort): ${err.message}`)
  }
}

export async function instancesRoutes(app: FastifyInstance) {
  // ══════════════════════════════════════════════════════════════
  // GESTÃO (preHandler: authAccount, escopado por request.apiClient.id)
  // ══════════════════════════════════════════════════════════════

  // ── POST /instances — Cria registro de instância para o tenant ─
  app.post('/instances', {
    preHandler: authAccount,
    handler: async (request, reply) => {
      const body = createInstanceSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Payload inválido', details: body.error.flatten() })
      }

      const instance = await prisma.instance.create({
        data: {
          name: body.data.name,
          provider: body.data.provider,
          priority: body.data.priority,
          apiClientId: request.apiClient!.id,
        },
      })

      return reply.status(201).send(toInstanceResponse(instance))
    },
  })

  // ── GET /instances — Lista instâncias do tenant ───────────────
  app.get('/instances', {
    preHandler: authAccount,
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
    preHandler: authAccount,
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
    preHandler: authAccount,
    handler: async (request, reply) => {
      const instance = await prisma.instance.findFirst({
        where: { id: request.params.id, apiClientId: request.apiClient!.id },
      })
      if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' })
      return reply.send(toInstanceResponse(instance))
    },
  })

  // ── DELETE /instances/:id — Remove (best-effort no provider) ──
  app.delete<{ Params: { id: string } }>('/instances/:id', {
    preHandler: authAccount,
    handler: async (request, reply) => {
      const instance = await prisma.instance.findFirst({
        where: { id: request.params.id, apiClientId: request.apiClient!.id },
      })
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
    preHandler: authAccount,
    handler: async (request, reply) => {
      const instance = await prisma.instance.findFirst({
        where: { id: request.params.id, apiClientId: request.apiClient!.id },
      })
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
      // Para WAHA, deve vir ANTES do createInstance para entrar no config da sessão.
      await registerInboundWebhook(instance, request.log)

      try {
        const updated = await refreshQr(instance)
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
    preHandler: authAccount,
    handler: async (request, reply) => {
      const instance = await prisma.instance.findFirst({
        where: { id: request.params.id, apiClientId: request.apiClient!.id },
      })
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
    preHandler: authAccount,
    handler: async (request, reply) => {
      const instance = await prisma.instance.findFirst({
        where: { id: request.params.id, apiClientId: request.apiClient!.id },
      })
      if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' })

      const provider = providers[instance.provider]

      try {
        const providerStatus = await provider.getInstanceStatus(instance.instanceId ?? 'default')
        const connectionState = mapConnectionState(providerStatus, instance.connectionState)

        await prisma.instance.update({
          where: { id: instance.id },
          data: { connectionState },
        })

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
    preHandler: authAccount,
    handler: async (request, reply) => {
      const body = patchStatusSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Status inválido' })
      }

      const result = await prisma.instance.updateMany({
        where: { id: request.params.id, apiClientId: request.apiClient!.id },
        data: { status: body.data.status },
      })

      if (result.count === 0) {
        return reply.status(404).send({ error: 'Instância não encontrada' })
      }

      const instance = await prisma.instance.findUnique({ where: { id: request.params.id } })
      return reply.send(instance ? toInstanceResponse(instance) : null)
    },
  })

  // ── POST /instances/:id/rotate — Rotação manual ───────────────
  app.post<{ Params: { id: string } }>('/instances/:id/rotate', {
    preHandler: authAccount,
    handler: async (request, reply) => {
      const existing = await prisma.instance.findFirst({
        where: { id: request.params.id, apiClientId: request.apiClient!.id },
      })
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
