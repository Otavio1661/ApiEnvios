// src/services/provider-router.service.test.ts
// Testes unitários do roteador de envio: fallback opt-in, envio dedicado,
// detecção de ban e atualização de contadores. prisma + providers MOCKADOS.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Instance } from '@prisma/client'
import type { SendMessagePayload } from '../types'

// ── Mocks de infraestrutura ───────────────────────────────────
// vi.hoisted: o factory de vi.mock é içado ao topo; as variáveis que ele referencia
// também precisam ser içadas, senão dão "before initialization".
const prismaMock = vi.hoisted(() => ({
  apiClient: { findUnique: vi.fn() },
  instance: { findMany: vi.fn(), update: vi.fn() },
  numberRotation: { create: vi.fn() },
}))
vi.mock('../utils/prisma', () => ({ prisma: prismaMock }))

// providers: cada provider com sendText/sendMedia mockados + isBanError real-ish.
// isBanError simples: considera "banned"/"403"/"blocked" como ban (como o real).
const { evolutionSend, wahaSend, cloudSend, notifyBan, isBanError } = vi.hoisted(() => ({
  evolutionSend: vi.fn(),
  wahaSend: vi.fn(),
  cloudSend: vi.fn(),
  notifyBan: vi.fn(async () => {}),
  isBanError: (msg: string) => /banned|403|blocked/i.test(msg),
}))

vi.mock('../providers', () => ({
  providers: {
    EVOLUTION: { name: 'EVOLUTION', sendText: evolutionSend, sendMedia: evolutionSend, isBanError },
    WAHA: { name: 'WAHA', sendText: wahaSend, sendMedia: wahaSend, isBanError },
    CLOUD_API: { name: 'CLOUD_API', sendText: cloudSend, sendMedia: cloudSend },
  },
}))

// Gate anti-ban: no-op nos testes (retorna release vazio).
vi.mock('../utils/rate-gate', () => ({
  acquireInstanceSlot: vi.fn(async () => async () => {}),
}))

// Notificação de ban: espionada (notifyBan vem do vi.hoisted acima).
vi.mock('./notification.service', () => ({ notifyBan }))

// Logger silencioso.
vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// Config: habilita EVOLUTION e WAHA; CLOUD_API desabilitada por padrão
// (cada teste pode sobrescrever via spy se precisar).
vi.mock('../config', () => ({
  config: {
    providers: {
      evolution: { enabled: true },
      waha: { enabled: true },
      cloudApi: { enabled: false },
    },
    sending: { delayMin: 0, delayMax: 0, maxMessagesPerNumberDay: 200 },
  },
}))

import { sendWithFallback, sendViaInstance } from './provider-router.service'

// ── Fábrica de Instance mínima ────────────────────────────────
function makeInstance(over: Partial<Instance>): Instance {
  return {
    id: 'inst-1',
    apiClientId: 'tenant-1',
    provider: 'EVOLUTION',
    instanceId: 'evo-default',
    status: 'ACTIVE',
    priority: 0,
    sentToday: 0,
    phone: '5544999990000',
    createdAt: new Date(),
    ...over,
  } as Instance
}

const payload: SendMessagePayload = { to: '5544999990000', type: 'TEXT', text: 'oi' }

describe('sendViaInstance (envio dedicado, sem fallback)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('envia com sucesso e incrementa contadores da instância', async () => {
    evolutionSend.mockResolvedValueOnce({ success: true, providerId: 'PID-1' })
    prismaMock.instance.update.mockResolvedValue({})

    const inst = makeInstance({})
    const res = await sendViaInstance(inst, payload)

    expect(res.success).toBe(true)
    expect(res.provider).toBe('EVOLUTION')
    expect(res.providerId).toBe('PID-1')
    // Contadores atualizados (sentToday/sentTotal/lastSentAt).
    expect(prismaMock.instance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inst-1' },
        data: expect.objectContaining({
          sentToday: { increment: 1 },
          sentTotal: { increment: 1 },
        }),
      }),
    )
  })

  it('detecta ban no erro, marca instância BANNED e notifica', async () => {
    evolutionSend.mockResolvedValueOnce({ success: false, error: 'account banned 403' })
    prismaMock.instance.update.mockResolvedValue({})
    prismaMock.numberRotation.create.mockResolvedValue({})

    const inst = makeInstance({})
    const res = await sendViaInstance(inst, payload)

    expect(res.success).toBe(false)
    // handleBannedNumber: update p/ status BANNED + rotação + notifyBan.
    expect(prismaMock.instance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'BANNED', connectionState: 'BANNED' }),
      }),
    )
    expect(prismaMock.numberRotation.create).toHaveBeenCalled()
    expect(notifyBan).toHaveBeenCalledTimes(1)
  })

  it('falha comum (não-ban) NÃO marca a instância como banida', async () => {
    evolutionSend.mockResolvedValueOnce({ success: false, error: 'timeout de rede' })

    const inst = makeInstance({})
    const res = await sendViaInstance(inst, payload)

    expect(res.success).toBe(false)
    expect(notifyBan).not.toHaveBeenCalled()
    expect(prismaMock.numberRotation.create).not.toHaveBeenCalled()
  })
})

describe('sendWithFallback (fallback opt-in por tenant)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('tenant não encontrado retorna erro controlado', async () => {
    prismaMock.apiClient.findUnique.mockResolvedValueOnce(null)
    const res = await sendWithFallback('tenant-x', payload)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/não encontrado/i)
  })

  it('SEM fallback: tenta só a 1ª instância e NÃO passa para a 2ª quando ela falha', async () => {
    prismaMock.apiClient.findUnique.mockResolvedValueOnce({ id: 'tenant-1', fallbackEnabled: false })
    prismaMock.instance.findMany.mockResolvedValueOnce([
      makeInstance({ id: 'A', provider: 'EVOLUTION' }),
      makeInstance({ id: 'B', provider: 'WAHA' }),
    ])
    // 1ª instância falha com erro comum.
    evolutionSend.mockResolvedValueOnce({ success: false, error: 'erro temporário' })

    const res = await sendWithFallback('tenant-1', payload)

    expect(res.success).toBe(false)
    // A WAHA (2ª) NUNCA é chamada quando fallback está desligado.
    expect(wahaSend).not.toHaveBeenCalled()
  })

  it('COM fallback: 1ª falha, cai para a 2ª instância do tenant e sucede', async () => {
    prismaMock.apiClient.findUnique.mockResolvedValueOnce({ id: 'tenant-1', fallbackEnabled: true })
    prismaMock.instance.findMany.mockResolvedValueOnce([
      makeInstance({ id: 'A', provider: 'EVOLUTION' }),
      makeInstance({ id: 'B', provider: 'WAHA' }),
    ])
    prismaMock.instance.update.mockResolvedValue({})

    evolutionSend.mockResolvedValueOnce({ success: false, error: 'erro temporário' })
    wahaSend.mockResolvedValueOnce({ success: true, providerId: 'PID-WAHA' })

    const res = await sendWithFallback('tenant-1', payload)

    expect(evolutionSend).toHaveBeenCalledTimes(1)
    expect(wahaSend).toHaveBeenCalledTimes(1)
    expect(res.success).toBe(true)
    expect(res.provider).toBe('WAHA')
    expect(res.providerId).toBe('PID-WAHA')
  })

  it('respeita o limite diário (warm-up): instância que já bateu o teto é descartada', async () => {
    prismaMock.apiClient.findUnique.mockResolvedValueOnce({ id: 'tenant-1', fallbackEnabled: false })
    // ACTIVE com sentToday no teto (200) → não-usável (dailyLimitFor real = 200).
    prismaMock.instance.findMany.mockResolvedValueOnce([
      makeInstance({ id: 'A', provider: 'EVOLUTION', status: 'ACTIVE', sentToday: 200 }),
    ])

    const res = await sendWithFallback('tenant-1', payload)

    // Nenhuma instância usável e Cloud API desabilitada → falha sem chamar provider.
    expect(evolutionSend).not.toHaveBeenCalled()
    expect(res.success).toBe(false)
  })
})
