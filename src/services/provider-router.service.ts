// src/services/provider-router.service.ts
// Orquestra qual provider usar, com fallback automático e rotação de números

import { EvolutionProvider } from '../providers/evolution.provider'
import { providers } from '../providers'
import { config } from '../config'
import { prisma } from '../utils/prisma'
import { notifyBan } from './notification.service'
import { acquireInstanceSlot } from '../utils/rate-gate'
import { dailyLimitFor } from './warmup.service'
import { logger } from '../utils/logger'
import type { Provider, ProviderSendResult, SendMessagePayload } from '../types'
import type { Instance } from '@prisma/client'

// ── Verifica se um provider está configurado/habilitado ───────
function providerEnabled(providerName: Provider): boolean {
  if (providerName === 'EVOLUTION') return config.providers.evolution.enabled
  if (providerName === 'WAHA') return config.providers.waha.enabled
  return config.providers.cloudApi.enabled
}

// ── Executa o envio numa instância concreta (sem escolher) ─────
// Atualiza contador em sucesso e trata ban em falha. NÃO faz fallback.
async function dispatchToInstance(
  instance: Instance,
  payload: SendMessagePayload,
): Promise<{ success: boolean; provider: Provider; providerId?: string; error?: string }> {
  const provider = providers[instance.provider]
  const providerInstanceId = instance.instanceId ?? 'default'

  // Gate anti-ban: serializa o envio POR INSTÂNCIA e espaça mensagens do mesmo
  // número (lock no Redis + atraso aleatório). Instâncias diferentes seguem em
  // paralelo. Cloud API (oficial) não precisa de espaçamento.
  // Se não conseguir o slot (instância ocupada), retorna falha controlada para o
  // worker re-tentar com backoff — nunca envia sem o lock (furaria o anti-ban).
  let release: (() => Promise<void>) | null = null
  if (instance.provider !== 'CLOUD_API') {
    try {
      release = await acquireInstanceSlot(instance.id, config.sending.delayMin, config.sending.delayMax)
    } catch (err: any) {
      return { success: false, provider: instance.provider, error: err.message }
    }
  }

  let result: ProviderSendResult
  try {
    if (payload.type === 'TEXT') {
      result = await provider.sendText(providerInstanceId, payload.to, payload.text ?? '')
    } else {
      result = await provider.sendMedia(
        providerInstanceId,
        payload.to,
        payload.mediaUrl ?? '',
        payload.caption,
        payload.type,
      )
    }
  } catch (err: any) {
    result = { success: false, error: err.message }
  } finally {
    if (release) await release()
  }

  if (result.success) {
    await prisma.instance.update({
      where: { id: instance.id },
      data: {
        sentToday: { increment: 1 },
        sentTotal: { increment: 1 },
        lastSentAt: new Date(),
      },
    })
    return { success: true, provider: instance.provider, providerId: result.providerId }
  }

  // Detecta ban e marca a instância (escopado ao tenant dono)
  const isBan =
    instance.provider !== 'CLOUD_API' &&
    result.error &&
    (provider as EvolutionProvider).isBanError?.(result.error)

  if (isBan) {
    await handleBannedNumber(instance, result.error ?? '')
  }

  return { success: false, provider: instance.provider, error: result.error }
}

// ── Envia uma mensagem respeitando o fallbackEnabled do tenant ─
// fallbackEnabled = false → usa só a instância ativa preferida do tenant
//   (1ª pela prioridade) e, no máximo, Cloud API se configurada.
// fallbackEnabled = true  → percorre a cadeia entre as instâncias DO TENANT.
export async function sendWithFallback(
  apiClientId: string,
  payload: SendMessagePayload,
): Promise<{ success: boolean; provider?: Provider; providerId?: string; error?: string }> {
  const apiClient = await prisma.apiClient.findUnique({ where: { id: apiClientId } })
  if (!apiClient) {
    return { success: false, error: 'Tenant não encontrado' }
  }

  // Instâncias elegíveis do tenant (não-Cloud), em ordem de prioridade
  const eligibleInstances = await prisma.instance.findMany({
    where: {
      apiClientId,
      provider: { not: 'CLOUD_API' },
      status: { in: ['ACTIVE', 'WARMING'] },
    },
    orderBy: [{ priority: 'asc' }, { sentToday: 'asc' }],
  })

  // Filtra por providers habilitados E pelo limite diário dinâmico (warm-up).
  const usableInstances = eligibleInstances.filter(
    (inst) => providerEnabled(inst.provider) && inst.sentToday < dailyLimitFor(inst),
  )

  // Sem fallback: só a 1ª instância preferida (depois cai p/ Cloud API se houver)
  const instancesToTry = apiClient.fallbackEnabled ? usableInstances : usableInstances.slice(0, 1)

  let lastError = 'Nenhuma instância disponível'

  for (const instance of instancesToTry) {
    const result = await dispatchToInstance(instance, payload)
    if (result.success) {
      return { success: true, provider: result.provider, providerId: result.providerId }
    }
    lastError = result.error ?? lastError
    logger.warn(`[Router] Instância ${instance.id} (${instance.provider}) falhou: ${result.error} — próxima...`)
  }

  // Último recurso: Cloud API oficial (sempre permitida quando configurada)
  if (providerEnabled('CLOUD_API')) {
    const provider = providers.CLOUD_API
    try {
      const result =
        payload.type === 'TEXT'
          ? await provider.sendText('default', payload.to, payload.text ?? '')
          : await provider.sendMedia('default', payload.to, payload.mediaUrl ?? '', payload.caption, payload.type)

      if (result.success) {
        return { success: true, provider: 'CLOUD_API', providerId: result.providerId }
      }
      lastError = result.error ?? lastError
    } catch (err: any) {
      lastError = err.message
    }
    logger.warn(`[Router] CLOUD_API falhou: ${lastError}`)
  }

  return { success: false, error: lastError }
}

// ── Envia direcionado a UMA instância específica (sem fallback) ──
// Usado pelos endpoints de envio por token de instância (estilo UltraMsg).
// Atualiza contadores em caso de sucesso e trata ban em caso de erro.
export async function sendViaInstance(
  instance: Instance,
  payload: SendMessagePayload,
): Promise<{ success: boolean; provider?: Provider; providerId?: string; error?: string }> {
  const result = await dispatchToInstance(instance, payload)
  return {
    success: result.success,
    provider: result.provider,
    providerId: result.providerId,
    error: result.success ? undefined : (result.error ?? 'Falha no envio pela instância'),
  }
}

// ── Marca instância como banida e notifica ────────────────────
async function handleBannedNumber(number: Instance, reason: string) {
  await prisma.instance.update({
    where: { id: number.id },
    data: {
      status: 'BANNED',
      connectionState: 'BANNED',
      bannedAt: new Date(),
      banReason: reason,
      bannedCount: { increment: 1 },
    },
  })

  await prisma.numberRotation.create({
    data: {
      instanceId: number.id,
      reason: 'BAN',
      triggeredBy: 'auto',
    },
  })

  // Dispara notificação (escopada ao tenant dono da instância)
  await notifyBan({
    apiClientId: number.apiClientId,
    instanceId: number.id,
    phone: number.phone ?? '(sem número)',
    provider: number.provider,
    reason,
    bannedAt: new Date().toISOString(),
  })

  logger.error(`[BAN DETECTADO] Instância ${number.phone ?? number.id} (${number.provider}) banida: ${reason}`)
}
