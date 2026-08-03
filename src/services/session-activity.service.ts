// src/services/session-activity.service.ts
// Sessão "viva" para JWT — o JWT em si é stateless (não dá pra revogar antes
// da expiração natural), então guardamos 1 marcador por jti no Redis pra
// dar 2 coisas que o JWT sozinho não dá:
//   1) Logout de verdade — ao invés de só limpar o cookie no cliente, apagamos
//      o marcador: o MESMO token, mesmo com assinatura/expiração válidas,
//      passa a ser rejeitado em qualquer request seguinte.
//   2) Timeout por inatividade — o marcador tem TTL deslizante (renovado a
//      cada request autenticada); sem uso, expira sozinho no Redis, muito
//      antes do JWT_EXPIRES_IN (7d) absoluto.
import { redis } from '../utils/redis'
import { config } from '../config'

function chave(jti: string): string {
  return `session:ativa:${jti}`
}

// Chamado no login — cria o marcador com o TTL de inatividade configurado.
export async function marcarAtiva(jti: string): Promise<void> {
  await redis.set(chave(jti), '1', 'EX', config.app.sessionIdleTimeoutMin * 60)
}

// Chamado em toda request autenticada — true = sessão ainda viva.
export async function estaAtiva(jti: string): Promise<boolean> {
  const valor = await redis.get(chave(jti))
  return valor !== null
}

// Renova o TTL (sliding window) — só chamar depois de estaAtiva() confirmar
// true, senão recriaria uma sessão já encerrada.
export async function renovar(jti: string): Promise<void> {
  await redis.expire(chave(jti), config.app.sessionIdleTimeoutMin * 60)
}

// Chamado no logout — mata a sessão na hora, mesmo com o JWT ainda válido
// por dias.
export async function encerrarSessao(jti: string): Promise<void> {
  await redis.del(chave(jti))
}
