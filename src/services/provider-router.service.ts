// src/services/provider-router.service.ts
// Orquestra qual provider usar, com fallback automático e rotação de números

import { EvolutionProvider } from '../providers/evolution.provider'
import { WahaProvider } from '../providers/waha.provider'
import { CloudApiProvider } from '../providers/cloudapi.provider'
import { config } from '../config'
import { prisma } from '../utils/prisma'
import { notifyBan } from './notification.service'
import { sleep, randomDelay } from '../utils/helpers'
import type { Provider, ProviderSendResult, SendMessagePayload } from '../types'
import type { WhatsappNumber } from '@prisma/client'

const providers = {
  EVOLUTION: new EvolutionProvider(),
  WAHA: new WahaProvider(),
  CLOUD_API: new CloudApiProvider(),
}

// ── Pega o melhor número disponível para um provider ──────────
async function getActiveNumber(provider: Provider): Promise<WhatsappNumber | null> {
  return prisma.whatsappNumber.findFirst({
    where: {
      provider,
      status: { in: ['ACTIVE', 'WARMING'] },
      sentToday: { lt: config.sending.maxMessagesPerNumberDay },
    },
    orderBy: [
      { priority: 'asc' },
      { sentToday: 'asc' },
    ],
  })
}

// ── Envia uma mensagem com fallback completo ──────────────────
export async function sendWithFallback(
  payload: SendMessagePayload
): Promise<{ success: boolean; provider?: Provider; providerId?: string; error?: string }> {
  const fallbackOrder = config.providerFallbackOrder

  for (const providerName of fallbackOrder) {
    const provider = providers[providerName]

    // Pula providers não configurados
    if (providerName === 'EVOLUTION' && !config.providers.evolution.enabled) continue
    if (providerName === 'WAHA' && !config.providers.waha.enabled) continue
    if (providerName === 'CLOUD_API' && !config.providers.cloudApi.enabled) continue

    const number = await getActiveNumber(providerName)
    if (!number && providerName !== 'CLOUD_API') {
      console.warn(`[Router] Nenhum número ativo para ${providerName}, tentando próximo provider`)
      continue
    }

    const instanceId = number?.instanceId ?? 'default'

    // Delay anti-ban (apenas para providers não-oficiais)
    if (providerName !== 'CLOUD_API') {
      await randomDelay(config.sending.delayMin, config.sending.delayMax)
    }

    let result: ProviderSendResult

    try {
      if (payload.type === 'TEXT') {
        result = await provider.sendText(instanceId, payload.to, payload.text ?? '')
      } else {
        result = await provider.sendMedia(
          instanceId,
          payload.to,
          payload.mediaUrl ?? '',
          payload.caption,
          payload.type
        )
      }
    } catch (err: any) {
      result = { success: false, error: err.message }
    }

    if (result.success) {
      // Atualiza contador do número
      if (number) {
        await prisma.whatsappNumber.update({
          where: { id: number.id },
          data: {
            sentToday: { increment: 1 },
            sentTotal: { increment: 1 },
            lastSentAt: new Date(),
          },
        })
      }

      return {
        success: true,
        provider: providerName,
        providerId: result.providerId,
      }
    }

    // Verifica se é ban
    const isBan =
      providerName !== 'CLOUD_API' &&
      number &&
      result.error &&
      (providers[providerName] as EvolutionProvider).isBanError?.(result.error)

    if (isBan && number) {
      await handleBannedNumber(number, result.error ?? '')
    }

    console.warn(`[Router] ${providerName} falhou: ${result.error} — tentando próximo...`)
  }

  return {
    success: false,
    error: 'Todos os providers falharam',
  }
}

// ── Marca número como banido e notifica ───────────────────────
async function handleBannedNumber(number: WhatsappNumber, reason: string) {
  await prisma.whatsappNumber.update({
    where: { id: number.id },
    data: {
      status: 'BANNED',
      bannedAt: new Date(),
      banReason: reason,
      bannedCount: { increment: 1 },
    },
  })

  await prisma.numberRotation.create({
    data: {
      numberId: number.id,
      reason: 'BAN',
      triggeredBy: 'auto',
    },
  })

  // Dispara notificação
  await notifyBan({
    phone: number.phone,
    provider: number.provider,
    reason,
    bannedAt: new Date().toISOString(),
  })

  console.error(`[BAN DETECTADO] Número ${number.phone} (${number.provider}) banido: ${reason}`)
}
