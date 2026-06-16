// src/utils/rate-gate.ts
// Serialização anti-ban POR INSTÂNCIA.
//
// Problema: o worker de envio roda com concurrency > 1; sem coordenação, a MESMA
// instância (mesmo número WhatsApp) poderia disparar várias mensagens quase
// simultâneas, perdendo o espaçamento anti-ban — justamente o risco que o produto
// tenta mitigar.
//
// Solução: um lock distribuído no Redis por instância (`lock:send:<id>`) garante que
// só um envio por instância ocorre por vez (vale também para múltiplas réplicas do
// worker, pois o estado vive no Redis); após obter o lock, espaçamos o envio em
// relação ao último (`lastsent:<id>`) por um atraso aleatório [min,max].
// Instâncias DIFERENTES continuam enviando em paralelo.
import { randomBytes } from 'crypto'
import { redis } from './redis'
import { logger } from './logger'

// TTL do lock: cobre o atraso anti-ban (até ~delayMax) + timeout do provider (~15s) + margem.
const LOCK_TTL_MS = 35_000
// Tempo máximo aguardando o lock liberar antes de desistir (deixa o BullMQ re-tentar).
const MAX_WAIT_MS = 40_000
const POLL_MS = 200

// Libera o lock SOMENTE se ainda for nosso (compara o token) — evita que um release
// atrasado apague o lock de outro detentor após a expiração do TTL.
const RELEASE_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Adquire o "slot" de envio de uma instância: garante exclusão mútua e o espaçamento
 * anti-ban. Retorna uma função `release()` que DEVE ser chamada ao final do envio
 * (idealmente em `finally`).
 *
 * Lança erro se não conseguir o lock dentro de MAX_WAIT_MS — o chamador deve tratar
 * isso como falha de envio (para re-tentativa com backoff), NUNCA prosseguindo sem o
 * lock, sob pena de furar a serialização anti-ban sob contenção.
 */
export async function acquireInstanceSlot(
  instanceId: string,
  minDelayMs: number,
  maxDelayMs: number,
): Promise<() => Promise<void>> {
  const lockKey = `lock:send:${instanceId}`
  const lastKey = `lastsent:${instanceId}`
  const token = randomBytes(12).toString('hex')

  // 1. Adquire o lock (com retry limitado).
  const deadline = Date.now() + MAX_WAIT_MS
  let locked = false
  while (Date.now() <= deadline) {
    const ok = await redis.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX')
    if (ok) {
      locked = true
      break
    }
    await sleep(POLL_MS)
  }
  if (!locked) {
    // Não furar a serialização: falha para o chamador re-tentar com backoff.
    throw new Error(`instância ${instanceId} ocupada (timeout ao obter slot de envio)`)
  }

  // 2. Espaça o envio em relação ao último desta instância.
  const last = Number(await redis.get(lastKey)) || 0
  const target = minDelayMs + Math.floor(Math.random() * Math.max(0, maxDelayMs - minDelayMs))
  const elapsed = Date.now() - last
  if (last > 0 && elapsed < target) {
    await sleep(target - elapsed)
  } else if (last === 0) {
    // 1º envio da instância nesta janela — aplica um atraso mínimo mesmo assim.
    await sleep(minDelayMs)
  }

  // 3. Retorna o release (marca lastsent e libera o lock com segurança).
  return async () => {
    try {
      await redis.set(lastKey, String(Date.now()), 'PX', 24 * 60 * 60 * 1000)
      await redis.eval(RELEASE_LUA, 1, lockKey, token)
    } catch (err: any) {
      logger.warn(`[RateGate] erro ao liberar slot da instância ${instanceId}: ${err.message}`)
    }
  }
}
