// src/utils/rate-gate.test.ts
// Testes unitários do gate anti-ban (acquireInstanceSlot) com Redis MOCKADO.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock do cliente Redis: controlamos set/get/eval por teste.
// vi.hoisted: o factory de vi.mock é içado ao topo do módulo, então as variáveis
// usadas dentro dele também precisam ser içadas (senão dão "before initialization").
const redisMock = vi.hoisted(() => ({
  set: vi.fn(),
  get: vi.fn(),
  eval: vi.fn(),
}))

vi.mock('./redis', () => ({ redis: redisMock }))
// Silencia o logger (evita ruído e dependência de transporte).
vi.mock('./logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { acquireInstanceSlot } from './rate-gate'

describe('acquireInstanceSlot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('adquire o lock com SET NX e devolve uma função release', async () => {
    // SET NX bem-sucedido (retorna 'OK'); sem último envio (lastsent vazio).
    redisMock.set.mockResolvedValueOnce('OK')
    redisMock.get.mockResolvedValueOnce(null)
    redisMock.eval.mockResolvedValue(1)

    // Sem atraso real: min=0/max=0 evita o sleep de espaçamento.
    const release = await acquireInstanceSlot('inst-1', 0, 0)

    // A 1ª chamada de set deve ser o lock NX com TTL em PX.
    expect(redisMock.set).toHaveBeenCalledWith(
      'lock:send:inst-1',
      expect.any(String),
      'PX',
      expect.any(Number),
      'NX',
    )
    expect(typeof release).toBe('function')

    // release() deve marcar lastsent e liberar o lock via Lua (eval).
    await release()
    expect(redisMock.eval).toHaveBeenCalled()
    // O lastsent é gravado com a key correta.
    expect(redisMock.set).toHaveBeenCalledWith(
      'lastsent:inst-1',
      expect.any(String),
      'PX',
      expect.any(Number),
    )
  })

  it('lança erro (timeout) quando nunca consegue o lock', async () => {
    // SET NX sempre falha (lock ocupado) → estoura o MAX_WAIT e lança.
    // Usamos timers falsos para não esperar os ~40s reais do MAX_WAIT_MS:
    // avançamos o relógio artificialmente enquanto o gate faz polling.
    redisMock.set.mockResolvedValue(null)
    vi.useFakeTimers()
    try {
      const promise = acquireInstanceSlot('inst-busy', 0, 0)
      // Trava a rejeição esperada para evitar "unhandled rejection" durante o avanço.
      const assertion = expect(promise).rejects.toThrow(/ocupada/i)
      // Avança o tempo além do MAX_WAIT_MS (40s), processando os sleeps de polling.
      await vi.advanceTimersByTimeAsync(45_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('release usa o script Lua com a key do lock e o token', async () => {
    redisMock.set.mockResolvedValueOnce('OK')
    redisMock.get.mockResolvedValueOnce(null)
    redisMock.eval.mockResolvedValue(1)

    const release = await acquireInstanceSlot('inst-2', 0, 0)
    await release()

    // eval(script, numKeys=1, lockKey, token)
    const evalArgs = redisMock.eval.mock.calls[0]
    expect(evalArgs[1]).toBe(1)
    expect(evalArgs[2]).toBe('lock:send:inst-2')
    expect(typeof evalArgs[3]).toBe('string')
  })
})
