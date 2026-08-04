// src/utils/ssrf-guard.ts
// Protege buscas de mídia server-side (mediaUrl) contra SSRF: bloqueia URLs
// que resolvem para faixas de IP privadas/reservadas/loopback/link-local
// (inclui o metadata da nuvem, 169.254.169.254/16) e permite fixar a conexão
// no IP já validado — fecha a janela de DNS rebinding entre a checagem e o
// fetch real (o hostname poderia resolver diferente entre as duas chamadas).
import dns from 'node:dns'
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'

function isBlockedIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  const [a, b] = parts
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 127) return true
  if (a === 169 && b === 254) return true // link-local, inclui o metadata da nuvem
  if (a === 0) return true
  return false
}

function isBlockedIpv6(address: string): boolean {
  const addr = address.toLowerCase()
  if (addr === '::1' || addr === '::') return true
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true // fc00::/7 (ULA)
  if (/^fe[89ab]/.test(addr)) return true // fe80::/10 (link-local)
  if (addr.startsWith('::ffff:')) {
    const v4 = addr.slice('::ffff:'.length)
    if (net.isIP(v4) === 4) return isBlockedIpv4(v4)
  }
  return false
}

function isBlockedIp(address: string, family: number): boolean {
  return family === 4 ? isBlockedIpv4(address) : isBlockedIpv6(address)
}

export interface PinnedUrlCheck {
  hostname: string
  pinnedIp: string
  family: number
}

// Valida o esquema (só http/https) e resolve TODOS os IPs do host, rejeitando
// se qualquer um cair em faixa privada/reservada. Retorna o IP resolvido para
// "pinning" — o chamador deve usar esse IP na conexão real (ver pinnedAgents),
// nunca deixar a lib HTTP re-resolver o hostname sozinha.
export async function assertPublicHttpUrl(rawUrl: string): Promise<PinnedUrlCheck> {
  const url = new URL(rawUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Esquema de URL não permitido: ${url.protocol}`)
  }

  // url.hostname mantém colchetes em endereços IPv6 literais (ex.: "[::1]") —
  // net.isIP não reconhece com colchetes, então normaliza antes de checar.
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const literalFamily = net.isIP(hostname)
  const results = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await dns.promises.lookup(hostname, { all: true })

  if (results.length === 0) {
    throw new Error('Não foi possível resolver o host da URL')
  }

  for (const r of results) {
    if (isBlockedIp(r.address, r.family)) {
      throw new Error(`URL aponta para endereço não permitido (${r.address})`)
    }
  }

  return { hostname: url.hostname, pinnedIp: results[0].address, family: results[0].family }
}

// Agents http/https que forçam a conexão pro IP já validado (pinned),
// mantendo o hostname original para SNI/Host header — usar junto de
// assertPublicHttpUrl() no mesmo fetch, nunca separado.
export function pinnedAgents(pinned: PinnedUrlCheck): { httpAgent: http.Agent; httpsAgent: https.Agent } {
  const lookup: net.LookupFunction = (_hostname, _options, callback) => {
    callback(null, pinned.pinnedIp, pinned.family)
  }
  return {
    httpAgent: new http.Agent({ lookup }),
    httpsAgent: new https.Agent({ lookup }),
  }
}
