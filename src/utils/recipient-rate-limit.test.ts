// src/utils/recipient-rate-limit.test.ts
// Testes unitários do limite anti-flood por destinatário (checkRecipientHourlyLimit)
// com Redis MOCKADO — mesmo padrão do rate-gate.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const redisMock = vi.hoisted(() => ({
  eval: vi.fn(),
  pttl: vi.fn(),
}))

vi.mock('./redis', () => ({ redis: redisMock }))

import { checkRecipientHourlyLimit } from './recipient-rate-limit'

describe('checkRecipientHourlyLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('limit=0 ⇒ ilimitado: permite sem tocar o Redis', async () => {
    const r = await checkRecipientHourlyLimit('acc-1', '5544999990000', 0)
    expect(r.allowed).toBe(true)
    expect(r.limit).toBe(0)
    expect(redisMock.eval).not.toHaveBeenCalled()
  })

  it('limit negativo ⇒ tratado como ilimitado', async () => {
    const r = await checkRecipientHourlyLimit('acc-1', '5544999990000', -5)
    expect(r.allowed).toBe(true)
    expect(redisMock.eval).not.toHaveBeenCalled()
  })

  it('abaixo do teto ⇒ permite e devolve o contador atual', async () => {
    redisMock.eval.mockResolvedValueOnce(3) // 3ª mensagem na janela
    const r = await checkRecipientHourlyLimit('acc-1', '5544999990000', 10)
    expect(r.allowed).toBe(true)
    expect(r.count).toBe(3)
    expect(r.limit).toBe(10)
    // Chave e parâmetros corretos (chave por conta + telefone, limite e janela 1h).
    expect(redisMock.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'rl:rcpt:acc-1:5544999990000',
      '10',
      String(60 * 60 * 1000),
    )
  })

  it('no teto ⇒ bloqueia (eval=-1) e calcula Retry-After pelo TTL restante', async () => {
    redisMock.eval.mockResolvedValueOnce(-1)
    redisMock.pttl.mockResolvedValueOnce(120_000) // 2 min restantes
    const r = await checkRecipientHourlyLimit('acc-1', '5544999990000', 10)
    expect(r.allowed).toBe(false)
    expect(r.limit).toBe(10)
    expect(r.retryAfterSec).toBe(120)
  })

  it('bloqueado sem TTL legível ⇒ Retry-After cai para a janela cheia (3600s)', async () => {
    redisMock.eval.mockResolvedValueOnce(-1)
    redisMock.pttl.mockResolvedValueOnce(-1) // sem expiração detectável
    const r = await checkRecipientHourlyLimit('acc-1', '5544999990000', 10)
    expect(r.allowed).toBe(false)
    expect(r.retryAfterSec).toBe(3600)
  })
})
