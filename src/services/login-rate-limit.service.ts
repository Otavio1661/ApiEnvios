// src/services/login-rate-limit.service.ts
// Rate limit de login em 3 camadas — qualquer uma que estourar bloqueia a tentativa:
//   A) IP + conta   — mira numa conta específica sem travar o resto de uma rede
//                      compartilhada (NAT/escritório).
//   B) IP sozinho   — todas as contas, pega credential stuffing/scanner.
//   C) Dispositivo  — cookie opaco, independente do IP (atacante trocando de IP).
// Backend: Redis (já usado pelo rate-limit por-tenant em server.ts) — INCR+EXPIRE,
// multi-processo-safe, sem lib nova.
import type { FastifyReply, FastifyRequest } from 'fastify'
import { randomBytes } from 'node:crypto'
import { redis } from '../utils/redis'
import { config } from '../config'

const DEVICE_COOKIE_NAME = 'device_id'

interface Camada {
  chave: string
  max: number
  janelaSegundos: number
}

export interface ResultadoBloqueio {
  bloqueado: boolean
  segundosRestantes: number
}

function ipNaAllowlist(ip: string): boolean {
  return config.loginThrottle.ipAllowlist.includes(ip)
}

function montarCamadas(ip: string, identificador: string, dispositivoId: string): Camada[] {
  const lt = config.loginThrottle
  return [
    {
      chave: `login:conta:${ip}:${identificador.toLowerCase()}`,
      max: lt.conta.maxTentativas,
      janelaSegundos: lt.conta.janelaMin * 60,
    },
    {
      chave: `login:ip:${ip}`,
      max: lt.ip.maxTentativas,
      janelaSegundos: lt.ip.janelaMin * 60,
    },
    {
      chave: `login:dispositivo:${dispositivoId}`,
      max: lt.dispositivo.maxTentativas,
      janelaSegundos: lt.dispositivo.janelaMin * 60,
    },
  ]
}

// Garante um cookie de dispositivo opaco (httpOnly, sem JS, 1 ano) — gerado no
// primeiro acesso se ainda não existir. Não é uma "sessão", só um identificador
// estável de navegador pra Camada C.
export function getOrSetDeviceId(request: FastifyRequest, reply: FastifyReply): string {
  const existente = request.cookies?.[DEVICE_COOKIE_NAME]
  if (existente) return existente

  const id = randomBytes(32).toString('hex')
  reply.setCookie(DEVICE_COOKIE_NAME, id, {
    httpOnly: true,
    secure: !config.app.isDev,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  })
  return id
}

// Verifica SEM incrementar — chamar ANTES de checar a senha. Mensagem de erro deve
// ser genérica pras 3 camadas (não revelar qual bateu).
export async function verificarBloqueio(
  ip: string,
  identificador: string,
  dispositivoId: string,
): Promise<ResultadoBloqueio> {
  if (process.env.VITEST || ipNaAllowlist(ip)) {
    return { bloqueado: false, segundosRestantes: 0 }
  }

  for (const camada of montarCamadas(ip, identificador, dispositivoId)) {
    const tentativas = Number((await redis.get(camada.chave)) ?? 0)
    if (tentativas >= camada.max) {
      const ttl = await redis.ttl(camada.chave)
      return { bloqueado: true, segundosRestantes: ttl > 0 ? ttl : camada.janelaSegundos }
    }
  }
  return { bloqueado: false, segundosRestantes: 0 }
}

// Registra 1 tentativa falha nas 3 camadas. INCR seta o próprio TTL só na 1ª
// tentativa da janela (senão o contador nunca decai — cada falha renovaria o prazo).
export async function registrarTentativaFalha(
  ip: string,
  identificador: string,
  dispositivoId: string,
): Promise<void> {
  if (process.env.VITEST || ipNaAllowlist(ip)) return

  await Promise.all(
    montarCamadas(ip, identificador, dispositivoId).map(async (camada) => {
      const tentativas = await redis.incr(camada.chave)
      if (tentativas === 1) {
        await redis.expire(camada.chave, camada.janelaSegundos)
      }
    }),
  )
}

// Limpa só a Camada A (IP+conta) no sucesso. B/C são contadores compartilhados entre
// contas — limpá-los deixaria um atacante "resetar" a defesa só acertando 1 senha
// sua, mesmo continuando a atacar outras.
export async function limparAposSucesso(ip: string, identificador: string): Promise<void> {
  await redis.del(`login:conta:${ip}:${identificador.toLowerCase()}`)
}
