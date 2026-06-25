// src/services/cascade-delete.service.ts
// Deleção em cascata (DESTRUTIVA) de instância e de conta, exclusiva do super admin.
//
// O schema tem FKs RESTRICT (Message→Instance, NumberRotation→Instance, MessageAttempt→
// Message, Message/User/Webhook→ApiClient), então `prisma.instance.delete` ou
// `prisma.apiClient.delete` diretos QUEBRAM por violação de FK quando há filhos. Aqui
// apagamos os filhos na ordem correta dentro de UMA $transaction (tudo ou nada — sem
// lixo órfão e sem SQL cru). InstanceNumber→Instance é Cascade no banco, então some
// junto com a instância; Message/NumberRotation por numberId são SetNull.
//
// Efeitos colaterais best-effort (FORA da transação, pois tocam sistemas externos):
//   - remoção da sessão no provider (WAHA/Evolution/CloudAPI)
//   - limpeza de chaves no Redis (contador anti-flood por destinatário + locks anti-ban)
import type { FastifyBaseLogger } from 'fastify'
import type { ApiClient, Instance, InstanceNumber } from '@prisma/client'
import { prisma } from '../utils/prisma'
import { providers } from '../providers'
import { redis } from '../utils/redis'

type InstanceWithNumbers = Instance & { numbers: InstanceNumber[] }

// Best-effort: remove a sessão da instância e de cada número no provider. Nunca lança.
async function cleanupProviders(instance: InstanceWithNumbers, log?: FastifyBaseLogger): Promise<void> {
  const targets: Array<{ provider: InstanceNumber['provider']; providerInstanceId: string }> = []
  if (instance.instanceId) targets.push({ provider: instance.provider, providerInstanceId: instance.instanceId })
  for (const n of instance.numbers) {
    if (n.providerInstanceId) targets.push({ provider: n.provider, providerInstanceId: n.providerInstanceId })
  }
  for (const t of targets) {
    try {
      await providers[t.provider].deleteInstance(t.providerInstanceId)
    } catch (err: any) {
      log?.warn(`[CascadeDelete] Falha ao remover sessão no provider (best-effort): ${err.message}`)
    }
  }
}

// Best-effort: remove chaves Redis ligadas à instância (locks/espaçamento anti-ban). Nunca lança.
async function cleanupInstanceRedis(instanceId: string, log?: FastifyBaseLogger): Promise<void> {
  try {
    await redis.del(`lastsent:${instanceId}`, `lock:send:${instanceId}`)
  } catch (err: any) {
    log?.warn(`[CascadeDelete] Falha ao limpar Redis da instância (best-effort): ${err.message}`)
  }
}

/**
 * Apaga DEFINITIVAMENTE uma instância e tudo que depende dela.
 * Retorna a instância removida, ou null se não existir (caller → 404).
 */
export async function deleteInstanceCascade(
  instanceId: string,
  log?: FastifyBaseLogger,
): Promise<Instance | null> {
  const instance = await prisma.instance.findUnique({
    where: { id: instanceId },
    include: { numbers: true },
  })
  if (!instance) return null

  await cleanupProviders(instance, log)
  await cleanupInstanceRedis(instance.id, log)

  // Ordem: tentativas → mensagens → rotações → instância (InstanceNumber cascateia).
  await prisma.$transaction([
    prisma.messageAttempt.deleteMany({ where: { message: { instanceId } } }),
    prisma.message.deleteMany({ where: { instanceId } }),
    prisma.numberRotation.deleteMany({ where: { instanceId } }),
    prisma.instance.delete({ where: { id: instanceId } }),
  ])

  return instance
}

/**
 * Apaga DEFINITIVAMENTE uma conta (ApiClient) e TUDO que for relacional:
 * instâncias (+ números), mensagens, tentativas, rotações, webhooks e usuários.
 * Retorna a conta removida, ou null se não existir (caller → 404).
 */
export async function deleteClientCascade(
  clientId: string,
  log?: FastifyBaseLogger,
): Promise<ApiClient | null> {
  const client = await prisma.apiClient.findUnique({
    where: { id: clientId },
    include: { instances: { include: { numbers: true } } },
  })
  if (!client) return null

  // Efeitos externos best-effort por instância (provider + locks Redis).
  for (const inst of client.instances) {
    await cleanupProviders(inst, log)
    await cleanupInstanceRedis(inst.id, log)
  }
  // Contadores anti-flood por destinatário desta conta.
  try {
    const keys = await redis.keys(`rl:rcpt:${clientId}:*`)
    if (keys.length) await redis.del(...keys)
  } catch (err: any) {
    log?.warn(`[CascadeDelete] Falha ao limpar contadores Redis da conta (best-effort): ${err.message}`)
  }

  // Ordem (por relação de FK): tentativas → mensagens → rotações → instâncias
  // (InstanceNumber cascateia) → webhooks → usuários → conta. Tudo atômico.
  await prisma.$transaction([
    prisma.messageAttempt.deleteMany({ where: { message: { apiClientId: clientId } } }),
    prisma.message.deleteMany({ where: { apiClientId: clientId } }),
    prisma.campaign.deleteMany({ where: { apiClientId: clientId } }),
    prisma.numberRotation.deleteMany({ where: { instance: { apiClientId: clientId } } }),
    prisma.instance.deleteMany({ where: { apiClientId: clientId } }),
    prisma.webhook.deleteMany({ where: { apiClientId: clientId } }),
    prisma.user.deleteMany({ where: { apiClientId: clientId } }),
    prisma.apiClient.delete({ where: { id: clientId } }),
  ])

  return client
}
