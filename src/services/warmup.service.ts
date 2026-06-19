// src/services/warmup.service.ts
// Warm-up de números novos: instâncias em WARMING têm um limite diário CRESCENTE
// (baseado na idade), em vez do limite cheio fixo — reduz risco de ban de chip novo.
import type { NumberStatus } from '@prisma/client'
import { config } from '../config'

// Limite no 1º dia e incremento diário durante o warm-up.
const WARMUP_BASE = 20
const WARMUP_STEP_PER_DAY = 20

// Fase C3: a assinatura é estrutural (status + createdAt) para servir tanto a uma
// Instance quanto a um InstanceNumber do pool — ambos têm esses campos.
type WarmupTarget = { status: NumberStatus; createdAt: Date }

/**
 * Limite diário de mensagens para um número (Instance OU InstanceNumber).
 * - ACTIVE (ou qualquer status != WARMING): limite cheio (config.sending.maxMessagesPerNumberDay).
 * - WARMING: base + (dias desde a criação) * passo, até o limite cheio.
 */
export function dailyLimitFor(target: WarmupTarget): number {
  const full = config.sending.maxMessagesPerNumberDay
  if (target.status !== 'WARMING') return full

  const ageDays = Math.floor(
    (Date.now() - new Date(target.createdAt).getTime()) / (24 * 60 * 60 * 1000),
  )
  const limit = WARMUP_BASE + ageDays * WARMUP_STEP_PER_DAY
  return Math.min(full, Math.max(WARMUP_BASE, limit))
}
