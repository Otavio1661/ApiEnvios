// src/services/warmup.service.test.ts
// Testes unitários do limite diário dinâmico (warm-up).
import { describe, it, expect } from 'vitest'
import { dailyLimitFor } from './warmup.service'
import { config } from '../config'
import type { Instance } from '@prisma/client'

// Helper: monta uma Instance mínima com os campos relevantes para dailyLimitFor.
// Só status e createdAt importam aqui; o resto é preenchido com valores neutros.
function makeInstance(over: Partial<Instance>): Instance {
  return {
    status: 'ACTIVE',
    createdAt: new Date(),
    ...over,
  } as Instance
}

describe('dailyLimitFor', () => {
  const full = config.sending.maxMessagesPerNumberDay

  it('instância ACTIVE recebe o limite cheio', () => {
    const inst = makeInstance({ status: 'ACTIVE', createdAt: new Date('2020-01-01') })
    expect(dailyLimitFor(inst)).toBe(full)
  })

  it('instância WARMING recém-criada recebe o limite base (20)', () => {
    const inst = makeInstance({ status: 'WARMING', createdAt: new Date() })
    expect(dailyLimitFor(inst)).toBe(20)
  })

  it('instância WARMING cresce com a idade (base + dias*passo)', () => {
    // 3 dias atrás → 20 + 3*20 = 80 (abaixo do limite cheio).
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    const inst = makeInstance({ status: 'WARMING', createdAt: threeDaysAgo })
    expect(dailyLimitFor(inst)).toBe(80)
  })

  it('instância WARMING antiga é limitada (clamp) ao limite cheio', () => {
    // Criada há muito tempo → o cálculo passaria do full, mas é limitado a full.
    const old = new Date('2020-01-01')
    const inst = makeInstance({ status: 'WARMING', createdAt: old })
    expect(dailyLimitFor(inst)).toBe(full)
  })
})
