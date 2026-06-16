// src/services/warmup.service.ts
// Warm-up de números novos: instâncias em WARMING têm um limite diário CRESCENTE
// (baseado na idade), em vez do limite cheio fixo — reduz risco de ban de chip novo.
import type { Instance } from '@prisma/client'
import { config } from '../config'

// Limite no 1º dia e incremento diário durante o warm-up.
const WARMUP_BASE = 20
const WARMUP_STEP_PER_DAY = 20

/**
 * Limite diário de mensagens para uma instância.
 * - ACTIVE: limite cheio (config.sending.maxMessagesPerNumberDay).
 * - WARMING: base + (dias desde a criação) * passo, até o limite cheio.
 */
export function dailyLimitFor(instance: Instance): number {
  const full = config.sending.maxMessagesPerNumberDay
  if (instance.status !== 'WARMING') return full

  const ageDays = Math.floor(
    (Date.now() - new Date(instance.createdAt).getTime()) / (24 * 60 * 60 * 1000),
  )
  const limit = WARMUP_BASE + ageDays * WARMUP_STEP_PER_DAY
  return Math.min(full, Math.max(WARMUP_BASE, limit))
}
