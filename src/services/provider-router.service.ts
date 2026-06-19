// src/services/provider-router.service.ts
// Orquestra qual provider/NÚMERO usar, com fallback automático e rotação de números.
//
// Fase C3: o envio real passa a ser feito pelos NÚMEROS do pool (InstanceNumber),
// com rodízio "menos-usado" por número (anti-ban POR NÚMERO). A Instance vira o
// agrupador (pool); cada InstanceNumber é um número/sessão concreto de provider.
// Pool de 1 número CONNECTED se comporta como antes (sem regressão).

import { EvolutionProvider } from '../providers/evolution.provider'
import { providers } from '../providers'
import { config } from '../config'
import { prisma } from '../utils/prisma'
import { notifyBan } from './notification.service'
import { acquireInstanceSlot } from '../utils/rate-gate'
import { dailyLimitFor } from './warmup.service'
import { logger } from '../utils/logger'
import type { Provider, ProviderSendResult, SendMessagePayload } from '../types'
import type { Instance, InstanceNumber } from '@prisma/client'

// Resultado padronizado do dispatch (carrega o numberId que efetivou o envio).
export interface DispatchResult {
  success: boolean
  provider: Provider
  providerId?: string
  numberId?: string
  error?: string
}

// ── Verifica se um provider está configurado/habilitado ───────
function providerEnabled(providerName: Provider): boolean {
  if (providerName === 'EVOLUTION') return config.providers.evolution.enabled
  if (providerName === 'WAHA') return config.providers.waha.enabled
  return config.providers.cloudApi.enabled
}

// ── Seleção dos números elegíveis do pool (rodízio menos-usado) ─
// Retorna os InstanceNumber do pool da instância que estão aptos a enviar AGORA,
// ordenados do MENOS usado para o mais usado:
//   sentToday asc → lastSentAt asc (nulls first) → priority asc
// Critérios de elegibilidade:
//   - status in [ACTIVE, WARMING]
//   - connectionState = CONNECTED (sessão autenticada; Cloud fica CONNECTED ao conectar)
//   - provider habilitado na config
//   - sentToday < dailyLimitFor(number) (limite dinâmico de warm-up)
async function eligiblePoolNumbers(instanceId: string): Promise<InstanceNumber[]> {
  const candidates = await prisma.instanceNumber.findMany({
    where: {
      instanceId,
      status: { in: ['ACTIVE', 'WARMING'] },
      connectionState: 'CONNECTED',
    },
    // Ordena pelo menos-usado. nulls: 'first' garante que números que ainda não
    // enviaram (lastSentAt = null) entrem antes dos que já enviaram, com o mesmo
    // sentToday — ajuda a distribuir o 1º envio entre números novos.
    orderBy: [
      { sentToday: 'asc' },
      { lastSentAt: { sort: 'asc', nulls: 'first' } },
      { priority: 'asc' },
    ],
  })

  return candidates.filter(
    (n) => providerEnabled(n.provider) && n.sentToday < dailyLimitFor(n),
  )
}

// Retorna o melhor (menos usado) número elegível do pool, ou null se não houver.
export async function selectPoolNumber(instanceId: string): Promise<InstanceNumber | null> {
  const pool = await eligiblePoolNumbers(instanceId)
  return pool[0] ?? null
}

// ── Executa o envio num NÚMERO concreto (sem escolher/rotacionar) ─
// Espelha o antigo dispatchToInstance, mas opera no InstanceNumber:
// faz o gate anti-ban por número, envia, atualiza contadores DO NÚMERO em sucesso
// e trata ban (marcando o NÚMERO) em falha. NÃO faz rodízio/fallback.
async function dispatchToNumber(
  number: InstanceNumber,
  payload: SendMessagePayload,
): Promise<DispatchResult> {
  const provider = providers[number.provider]
  const providerInstanceId = number.providerInstanceId ?? 'default'

  // Gate anti-ban: serializa e espaça os envios POR NÚMERO (lock no Redis pelo id
  // do número). Cloud API (oficial) não precisa de espaçamento. Se não conseguir o
  // slot, retorna falha controlada (o worker re-tenta com backoff) — nunca envia
  // sem o lock.
  let release: (() => Promise<void>) | null = null
  if (number.provider !== 'CLOUD_API') {
    try {
      release = await acquireInstanceSlot(number.id, config.sending.delayMin, config.sending.delayMax)
    } catch (err: any) {
      return { success: false, provider: number.provider, numberId: number.id, error: err.message }
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
    await prisma.instanceNumber.update({
      where: { id: number.id },
      data: {
        sentToday: { increment: 1 },
        sentTotal: { increment: 1 },
        lastSentAt: new Date(),
      },
    })
    return {
      success: true,
      provider: number.provider,
      providerId: result.providerId,
      numberId: number.id,
    }
  }

  // Detecta ban e marca o NÚMERO (a notificação é escopada ao tenant dono)
  const isBan =
    number.provider !== 'CLOUD_API' &&
    result.error &&
    (provider as EvolutionProvider).isBanError?.(result.error)

  if (isBan) {
    await handleBannedNumber(number, result.error ?? '')
  }

  return { success: false, provider: number.provider, numberId: number.id, error: result.error }
}

// ── Despacha por uma INSTÂNCIA (pool de números) com rodízio ───
// Seleciona os números elegíveis do pool (menos-usado primeiro) e tenta enviar.
// Se o melhor número falhar e houver outros elegíveis, ROTACIONA para o próximo.
// Pool de 1 número CONNECTED → comporta-se como antes (tenta só ele).
// Pool sem número elegível → falha controlada ('Nenhum número disponível no pool').
async function dispatchToInstance(
  instance: Instance,
  payload: SendMessagePayload,
): Promise<DispatchResult> {
  const pool = await eligiblePoolNumbers(instance.id)

  if (pool.length === 0) {
    return { success: false, provider: instance.provider, error: 'Nenhum número disponível no pool' }
  }

  let last: DispatchResult = {
    success: false,
    provider: instance.provider,
    error: 'Nenhum número disponível no pool',
  }

  for (const number of pool) {
    last = await dispatchToNumber(number, payload)
    if (last.success) return last
    logger.warn(
      `[Router] Número ${number.id} (${number.provider}) falhou: ${last.error} — próximo número do pool...`,
    )
  }

  return last
}

// ── Envia uma mensagem respeitando o fallbackEnabled do tenant ─
// fallbackEnabled = false → usa só a instância ativa preferida do tenant
//   (1ª pela prioridade) e, no máximo, Cloud API se configurada.
// fallbackEnabled = true  → percorre a cadeia entre as instâncias DO TENANT.
// Dentro de cada instância, o envio usa o POOL de números (rodízio menos-usado).
export async function sendWithFallback(
  apiClientId: string,
  payload: SendMessagePayload,
): Promise<{ success: boolean; provider?: Provider; providerId?: string; numberId?: string; error?: string }> {
  const apiClient = await prisma.apiClient.findUnique({ where: { id: apiClientId } })
  if (!apiClient) {
    return { success: false, error: 'Tenant não encontrado' }
  }

  // Instâncias elegíveis do tenant (não-Cloud), em ordem de prioridade.
  // A elegibilidade fina (CONNECTED/limite por número) é resolvida no pool.
  const eligibleInstances = await prisma.instance.findMany({
    where: {
      apiClientId,
      provider: { not: 'CLOUD_API' },
      status: { in: ['ACTIVE', 'WARMING'] },
    },
    orderBy: [{ priority: 'asc' }, { sentToday: 'asc' }],
  })

  // Sem fallback: só a 1ª instância preferida (depois cai p/ Cloud API se houver)
  const instancesToTry = apiClient.fallbackEnabled ? eligibleInstances : eligibleInstances.slice(0, 1)

  let lastError = 'Nenhuma instância disponível'

  for (const instance of instancesToTry) {
    const result = await dispatchToInstance(instance, payload)
    if (result.success) {
      return {
        success: true,
        provider: result.provider,
        providerId: result.providerId,
        numberId: result.numberId,
      }
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
// Internamente usa o POOL de números da instância (rodízio menos-usado), atualiza
// os contadores DO NÚMERO usado e trata ban no NÚMERO.
export async function sendViaInstance(
  instance: Instance,
  payload: SendMessagePayload,
): Promise<{ success: boolean; provider?: Provider; providerId?: string; numberId?: string; error?: string }> {
  const result = await dispatchToInstance(instance, payload)
  return {
    success: result.success,
    provider: result.provider,
    providerId: result.providerId,
    numberId: result.numberId,
    error: result.success ? undefined : (result.error ?? 'Falha no envio pela instância'),
  }
}

// ── Marca um NÚMERO do pool como banido e notifica ────────────
// Marca o InstanceNumber BANNED, cria a rotação referenciando o número (mantendo
// instanceId por compat) e dispara a notificação escopada ao tenant dono (derivado
// da instância pai).
async function handleBannedNumber(number: InstanceNumber, reason: string) {
  await prisma.instanceNumber.update({
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
      instanceId: number.instanceId,
      numberId: number.id,
      reason: 'BAN',
      triggeredBy: 'auto',
    },
  })

  // Deriva o tenant dono a partir da instância pai (escopo da notificação).
  const parent = await prisma.instance.findUnique({
    where: { id: number.instanceId },
    select: { apiClientId: true },
  })

  if (parent) {
    await notifyBan({
      apiClientId: parent.apiClientId,
      instanceId: number.instanceId,
      phone: number.phone ?? '(sem número)',
      provider: number.provider,
      reason,
      bannedAt: new Date().toISOString(),
    })
  }

  logger.error(
    `[BAN DETECTADO] Número ${number.phone ?? number.id} (${number.provider}) banido: ${reason}`,
  )
}
