// src/utils/recipient-rate-limit.ts
// Limite anti-flood POR DESTINATÁRIO, contado POR CONTA (ApiClient).
//
// Problema: uma conta pode (acidentalmente — ex.: loop de requisições — ou de má-fé)
// bombardear o MESMO número de destino, gerando spam e risco de ban. O espaçamento
// anti-ban do rate-gate é por instância; o rate-limit do @fastify/rate-limit é por
// req/min da conta. Nenhum dos dois limita "quantas vezes a CONTA fala com o MESMO
// número por hora".
//
// Solução: contador de janela fixa de 1h no Redis, chave `rl:rcpt:<apiClientId>:<toPhone>`,
// somando todas as instâncias da conta. A contagem é atômica via Lua (mesmo padrão do
// rate-gate): INCR + PEXPIRE no primeiro acesso; se ultrapassar o teto, DECR de volta
// (o contador nunca excede o limite) e sinaliza bloqueio.
import { redis } from './redis'

const WINDOW_MS = 60 * 60 * 1000 // 1 hora (janela fixa)

// Incrementa de forma atômica e decide o bloqueio numa única ida ao Redis.
// Retorna o contador atual (>0) se permitido, ou -1 se o limite foi atingido.
const CHECK_LUA = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
if count > tonumber(ARGV[1]) then
  redis.call("DECR", KEYS[1])
  return -1
end
return count
`

export interface RecipientLimitResult {
  allowed: boolean
  limit: number
  count: number          // quantos já contam na janela (após esta tentativa, se permitida)
  retryAfterSec: number  // segundos até a janela liberar (0 quando permitido)
}

/**
 * Verifica e consome uma "vaga" do limite por destinatário da conta.
 * `limit <= 0` significa ilimitado: retorna allowed=true sem tocar o Redis.
 * Deve ser chamada UMA vez por mensagem imediata, ANTES de criar/enfileirar o envio.
 */
export async function checkRecipientHourlyLimit(
  apiClientId: string,
  toPhone: string,
  limit: number,
): Promise<RecipientLimitResult> {
  if (!limit || limit <= 0) {
    return { allowed: true, limit: 0, count: 0, retryAfterSec: 0 }
  }

  const key = `rl:rcpt:${apiClientId}:${toPhone}`
  const result = (await redis.eval(CHECK_LUA, 1, key, String(limit), String(WINDOW_MS))) as number

  if (result === -1) {
    // Bloqueado: lê o TTL restante para informar o Retry-After.
    const pttl = await redis.pttl(key)
    const retryAfterSec = pttl > 0 ? Math.ceil(pttl / 1000) : Math.ceil(WINDOW_MS / 1000)
    return { allowed: false, limit, count: limit, retryAfterSec }
  }

  return { allowed: true, limit, count: result, retryAfterSec: 0 }
}
