// src/providers/waha.provider.test.ts
// Testa a extração robusta do providerId no envio via WAHA.
// FOCO: a engine NOWEB retorna a chave da mensagem em `data.key.id` (NÃO em `data.id`).
// Regressão do bug em que providerId ficava null e quebrava o casamento do webhook inbound.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// axios é mockado: capturamos a instância e controlamos a resposta do POST.
const postMock = vi.hoisted(() => vi.fn())
vi.mock('axios', () => ({
  default: {
    create: () => ({
      post: postMock,
      get: vi.fn(),
      delete: vi.fn(),
      put: vi.fn(),
      interceptors: { response: { use: vi.fn() } },
    }),
  },
}))

// Config mínima para o provider (url/apiKey).
vi.mock('../config', () => ({
  config: { providers: { waha: { url: 'http://127.0.0.1:3078', apiKey: 'k' } } },
}))

vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { WahaProvider } from './waha.provider'

describe('WahaProvider — extração de providerId (engine NOWEB)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('extrai o id de data.key.id (shape real do NOWEB)', async () => {
    // Shape observado no WAHA NOWEB: { key: { id, remoteJid, fromMe }, ... }
    postMock.mockResolvedValueOnce({
      data: {
        key: { remoteJid: '554497341687@s.whatsapp.net', fromMe: true, id: '3EB0706DD77901D006B93E' },
        status: 'PENDING',
      },
    })

    const provider = new WahaProvider()
    const res = await provider.sendText('default', '554497341687', 'oi')

    expect(res.success).toBe(true)
    expect(res.providerId).toBe('3EB0706DD77901D006B93E')
  })

  it('prioriza data.id quando presente (outras engines)', async () => {
    postMock.mockResolvedValueOnce({ data: { id: 'TOP-LEVEL-ID', key: { id: 'KEY-ID' } } })

    const provider = new WahaProvider()
    const res = await provider.sendText('default', '554497341687', 'oi')

    expect(res.providerId).toBe('TOP-LEVEL-ID')
  })

  it('extrai id do sendImage via data.key.id', async () => {
    postMock.mockResolvedValueOnce({ data: { key: { id: 'IMG-KEY-ID' } } })

    const provider = new WahaProvider()
    const res = await provider.sendMedia('default', '554497341687', 'http://x/y.jpg', 'cap', 'IMAGE')

    expect(res.success).toBe(true)
    expect(res.providerId).toBe('IMG-KEY-ID')
  })
})
