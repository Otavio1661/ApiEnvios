// src/services/provider-router.service.test.ts
// Testes unitários do roteador de envio (Fase C3): o envio real é feito pelos
// NÚMEROS do pool (InstanceNumber) com rodízio "menos-usado". Cobre: seleção do
// número menos usado CONNECTED, incremento dos contadores DO NÚMERO, detecção de
// ban marcando o NÚMERO + rotação com numberId, rotação p/ o próximo número quando
// o 1º falha, pool sem número elegível → falha controlada, e o fallback opt-in
// entre instâncias do tenant. prisma + providers MOCKADOS.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Instance, InstanceNumber } from '@prisma/client'
import type { SendMessagePayload } from '../types'

// ── Mocks de infraestrutura ───────────────────────────────────
// vi.hoisted: o factory de vi.mock é içado ao topo; as variáveis que ele referencia
// também precisam ser içadas, senão dão "before initialization".
const prismaMock = vi.hoisted(() => ({
  apiClient: { findUnique: vi.fn() },
  instance: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  instanceNumber: { findMany: vi.fn(), update: vi.fn() },
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

import { sendWithFallback, sendViaInstance, selectPoolNumber } from './provider-router.service'

// ── Fábricas mínimas ──────────────────────────────────────────
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

function makeNumber(over: Partial<InstanceNumber>): InstanceNumber {
  return {
    id: 'num-1',
    instanceId: 'inst-1',
    provider: 'EVOLUTION',
    providerInstanceId: 'evo-default',
    phone: '5544999990000',
    status: 'ACTIVE',
    priority: 0,
    connectionState: 'CONNECTED',
    sentToday: 0,
    sentTotal: 0,
    lastSentAt: null,
    createdAt: new Date(),
    ...over,
  } as InstanceNumber
}

const payload: SendMessagePayload = { to: '5544999990000', type: 'TEXT', text: 'oi' }

describe('selectPoolNumber (rodízio menos-usado)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('escolhe o número menos usado CONNECTED (1º da ordenação) e filtra por limite/provider', async () => {
    // O serviço delega a ordenação (sentToday/lastSentAt/priority) ao banco; aqui o
    // mock já devolve "ordenado". A função apenas filtra (limite + provider) e
    // retorna o 1º elegível.
    prismaMock.instanceNumber.findMany.mockResolvedValueOnce([
      makeNumber({ id: 'A', sentToday: 1 }),
      makeNumber({ id: 'B', sentToday: 3 }),
    ])

    const chosen = await selectPoolNumber('inst-1')
    expect(chosen?.id).toBe('A')

    // A query restringe a números ACTIVE/WARMING e CONNECTED.
    expect(prismaMock.instanceNumber.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          instanceId: 'inst-1',
          status: { in: ['ACTIVE', 'WARMING'] },
          connectionState: 'CONNECTED',
        }),
      }),
    )
  })

  it('descarta número que já bateu o limite diário (warm-up)', async () => {
    // ACTIVE com sentToday no teto (200) é descartado; sobra o B.
    prismaMock.instanceNumber.findMany.mockResolvedValueOnce([
      makeNumber({ id: 'A', sentToday: 200 }),
      makeNumber({ id: 'B', sentToday: 5 }),
    ])

    const chosen = await selectPoolNumber('inst-1')
    expect(chosen?.id).toBe('B')
  })

  it('retorna null quando não há número elegível', async () => {
    prismaMock.instanceNumber.findMany.mockResolvedValueOnce([])
    const chosen = await selectPoolNumber('inst-1')
    expect(chosen).toBeNull()
  })
})

describe('sendViaInstance (envio dedicado, via pool de números)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('envia pelo número menos usado e incrementa os contadores DO NÚMERO', async () => {
    prismaMock.instanceNumber.findMany.mockResolvedValueOnce([makeNumber({ id: 'num-A' })])
    evolutionSend.mockResolvedValueOnce({ success: true, providerId: 'PID-1' })
    prismaMock.instanceNumber.update.mockResolvedValue({})

    const res = await sendViaInstance(makeInstance({}), payload)

    expect(res.success).toBe(true)
    expect(res.provider).toBe('EVOLUTION')
    expect(res.providerId).toBe('PID-1')
    expect(res.numberId).toBe('num-A')
    // Contadores atualizados no NÚMERO (não na Instance).
    expect(prismaMock.instanceNumber.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'num-A' },
        data: expect.objectContaining({
          sentToday: { increment: 1 },
          sentTotal: { increment: 1 },
        }),
      }),
    )
  })

  it('pool de 1 número CONNECTED se comporta como antes (envia por ele)', async () => {
    prismaMock.instanceNumber.findMany.mockResolvedValueOnce([makeNumber({ id: 'só-um' })])
    evolutionSend.mockResolvedValueOnce({ success: true, providerId: 'PID-X' })
    prismaMock.instanceNumber.update.mockResolvedValue({})

    const res = await sendViaInstance(makeInstance({}), payload)

    expect(res.success).toBe(true)
    expect(res.numberId).toBe('só-um')
    expect(evolutionSend).toHaveBeenCalledTimes(1)
  })

  it('rotaciona para o próximo número quando o 1º falha (erro comum)', async () => {
    // Pool ordenado: A (menos usado) primeiro, B depois.
    prismaMock.instanceNumber.findMany.mockResolvedValueOnce([
      makeNumber({ id: 'A', providerInstanceId: 'sess-A' }),
      makeNumber({ id: 'B', providerInstanceId: 'sess-B' }),
    ])
    prismaMock.instanceNumber.update.mockResolvedValue({})
    // 1º envio falha (não-ban) → rotaciona; 2º sucede.
    evolutionSend
      .mockResolvedValueOnce({ success: false, error: 'timeout temporário' })
      .mockResolvedValueOnce({ success: true, providerId: 'PID-B' })

    const res = await sendViaInstance(makeInstance({}), payload)

    expect(evolutionSend).toHaveBeenCalledTimes(2)
    expect(res.success).toBe(true)
    expect(res.numberId).toBe('B')
    expect(res.providerId).toBe('PID-B')
  })

  it('detecta ban no erro, marca o NÚMERO BANNED, cria rotação com numberId e notifica', async () => {
    prismaMock.instanceNumber.findMany.mockResolvedValueOnce([makeNumber({ id: 'num-A' })])
    evolutionSend.mockResolvedValueOnce({ success: false, error: 'account banned 403' })
    prismaMock.instanceNumber.update.mockResolvedValue({})
    prismaMock.numberRotation.create.mockResolvedValue({})
    prismaMock.instance.findUnique.mockResolvedValueOnce({ apiClientId: 'tenant-1' })

    const res = await sendViaInstance(makeInstance({}), payload)

    expect(res.success).toBe(false)
    // handleBannedNumber: update do NÚMERO p/ BANNED.
    expect(prismaMock.instanceNumber.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'num-A' },
        data: expect.objectContaining({ status: 'BANNED', connectionState: 'BANNED' }),
      }),
    )
    // Rotação criada referenciando o NÚMERO (numberId) + instanceId pai.
    expect(prismaMock.numberRotation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ numberId: 'num-A', instanceId: 'inst-1', reason: 'BAN' }),
      }),
    )
    expect(notifyBan).toHaveBeenCalledTimes(1)
  })

  it('falha comum (não-ban) NÃO marca o número como banido', async () => {
    prismaMock.instanceNumber.findMany.mockResolvedValueOnce([makeNumber({ id: 'num-A' })])
    evolutionSend.mockResolvedValueOnce({ success: false, error: 'timeout de rede' })

    const res = await sendViaInstance(makeInstance({}), payload)

    expect(res.success).toBe(false)
    expect(notifyBan).not.toHaveBeenCalled()
    expect(prismaMock.numberRotation.create).not.toHaveBeenCalled()
  })

  it('pool sem número elegível → falha controlada (não chama provider)', async () => {
    prismaMock.instanceNumber.findMany.mockResolvedValueOnce([])

    const res = await sendViaInstance(makeInstance({}), payload)

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Nenhum número disponível no pool/i)
    expect(evolutionSend).not.toHaveBeenCalled()
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
    // Pool da 1ª instância: 1 número Evolution que falha (erro comum).
    prismaMock.instanceNumber.findMany.mockResolvedValueOnce([
      makeNumber({ id: 'numA', instanceId: 'A', provider: 'EVOLUTION' }),
    ])
    prismaMock.instanceNumber.update.mockResolvedValue({})
    evolutionSend.mockResolvedValueOnce({ success: false, error: 'erro temporário' })

    const res = await sendWithFallback('tenant-1', payload)

    expect(res.success).toBe(false)
    // A WAHA (2ª instância) NUNCA é consultada quando o fallback está desligado.
    expect(wahaSend).not.toHaveBeenCalled()
  })

  it('COM fallback: 1ª instância falha, cai para a 2ª do tenant e sucede', async () => {
    prismaMock.apiClient.findUnique.mockResolvedValueOnce({ id: 'tenant-1', fallbackEnabled: true })
    prismaMock.instance.findMany.mockResolvedValueOnce([
      makeInstance({ id: 'A', provider: 'EVOLUTION' }),
      makeInstance({ id: 'B', provider: 'WAHA' }),
    ])
    // Pool da instância A (Evolution, falha) e depois o da B (WAHA, sucesso).
    prismaMock.instanceNumber.findMany
      .mockResolvedValueOnce([makeNumber({ id: 'numA', instanceId: 'A', provider: 'EVOLUTION' })])
      .mockResolvedValueOnce([
        makeNumber({ id: 'numB', instanceId: 'B', provider: 'WAHA', providerInstanceId: 'waha-1' }),
      ])
    prismaMock.instanceNumber.update.mockResolvedValue({})

    evolutionSend.mockResolvedValueOnce({ success: false, error: 'erro temporário' })
    wahaSend.mockResolvedValueOnce({ success: true, providerId: 'PID-WAHA' })

    const res = await sendWithFallback('tenant-1', payload)

    expect(evolutionSend).toHaveBeenCalledTimes(1)
    expect(wahaSend).toHaveBeenCalledTimes(1)
    expect(res.success).toBe(true)
    expect(res.provider).toBe('WAHA')
    expect(res.providerId).toBe('PID-WAHA')
    expect(res.numberId).toBe('numB')
  })

  it('instância sem número elegível no pool → falha controlada (Cloud API desabilitada)', async () => {
    prismaMock.apiClient.findUnique.mockResolvedValueOnce({ id: 'tenant-1', fallbackEnabled: false })
    prismaMock.instance.findMany.mockResolvedValueOnce([makeInstance({ id: 'A', provider: 'EVOLUTION' })])
    // Pool vazio (nenhum CONNECTED/sob limite).
    prismaMock.instanceNumber.findMany.mockResolvedValueOnce([])

    const res = await sendWithFallback('tenant-1', payload)

    expect(evolutionSend).not.toHaveBeenCalled()
    expect(res.success).toBe(false)
  })
})
