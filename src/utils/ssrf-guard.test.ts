// src/utils/ssrf-guard.test.ts
import { describe, it, expect, vi } from 'vitest'
import dns from 'node:dns'
import { assertPublicHttpUrl, pinnedAgents } from './ssrf-guard'

describe('assertPublicHttpUrl', () => {
  it('rejeita esquema diferente de http/https', async () => {
    await expect(assertPublicHttpUrl('ftp://exemplo.com/arquivo')).rejects.toThrow(/Esquema/)
  })

  it('rejeita IP literal em faixa privada (10/8)', async () => {
    await expect(assertPublicHttpUrl('http://10.0.0.5/x')).rejects.toThrow(/não permitido/)
  })

  it('rejeita IP literal em faixa privada (192.168/16)', async () => {
    await expect(assertPublicHttpUrl('http://192.168.1.1/x')).rejects.toThrow(/não permitido/)
  })

  it('rejeita loopback (127/8)', async () => {
    await expect(assertPublicHttpUrl('http://127.0.0.1:6379/')).rejects.toThrow(/não permitido/)
  })

  it('rejeita link-local / metadata da nuvem (169.254/16)', async () => {
    await expect(
      assertPublicHttpUrl('http://169.254.169.254/latest/meta-data/'),
    ).rejects.toThrow(/não permitido/)
  })

  it('rejeita IPv6 loopback (::1)', async () => {
    await expect(assertPublicHttpUrl('http://[::1]/x')).rejects.toThrow(/não permitido/)
  })

  it('aceita IP público literal e retorna o IP pra pinning', async () => {
    const pinned = await assertPublicHttpUrl('https://8.8.8.8/imagem.png')
    expect(pinned.pinnedIp).toBe('8.8.8.8')
    expect(pinned.hostname).toBe('8.8.8.8')
  })

  it('resolve hostname via DNS e rejeita se algum IP resolvido for privado', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValueOnce([
      { address: '10.0.0.1', family: 4 },
    ] as any)
    await expect(assertPublicHttpUrl('http://interno.exemplo.com/x')).rejects.toThrow(/não permitido/)
  })

  it('resolve hostname via DNS e aceita se todos os IPs forem públicos', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
    ] as any)
    const pinned = await assertPublicHttpUrl('https://publico.exemplo.com/x')
    expect(pinned.pinnedIp).toBe('93.184.216.34')
  })
})

describe('pinnedAgents', () => {
  it('cria agents http/https cujo lookup sempre resolve pro IP fixado', async () => {
    const pinned = { hostname: 'exemplo.com', pinnedIp: '93.184.216.34', family: 4 }
    const { httpAgent, httpsAgent } = pinnedAgents(pinned)
    const lookup = (httpAgent as any).options.lookup
    const resultado = await new Promise((resolve) => {
      lookup('qualquer-outro-host.com', {}, (_err: any, address: string, family: number) => {
        resolve({ address, family })
      })
    })
    expect(resultado).toEqual({ address: '93.184.216.34', family: 4 })
    expect((httpsAgent as any).options.lookup).toBeInstanceOf(Function)
  })
})
