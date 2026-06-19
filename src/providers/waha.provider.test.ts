// src/providers/waha.provider.test.ts
// Testa a extração robusta do providerId no envio via WAHA.
// FOCO: a engine NOWEB retorna a chave da mensagem em `data.key.id` (NÃO em `data.id`).
// Regressão do bug em que providerId ficava null e quebrava o casamento do webhook inbound.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// axios é mockado: capturamos a instância e controlamos a resposta do POST/GET.
const postMock = vi.hoisted(() => vi.fn())
const getMock = vi.hoisted(() => vi.fn())
vi.mock('axios', () => ({
  default: {
    create: () => ({
      post: postMock,
      get: getMock,
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

describe('WahaProvider — getQr (contrato real do WAHA 2026.x NOWEB)', () => {
  beforeEach(() => vi.clearAllMocks())

  // PNG mínimo válido (assinatura \x89PNG\r\n\x1a\n).
  const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])

  it('converte a imagem PNG binária (resposta padrão) em data URI base64', async () => {
    getMock.mockResolvedValueOnce({
      headers: { 'content-type': 'image/png' },
      data: pngBuf,
    })

    const provider = new WahaProvider()
    const { qrCode } = await provider.getQr('default')

    expect(qrCode).toBe(`data:image/png;base64,${pngBuf.toString('base64')}`)
    // Garante que pedimos a imagem como arraybuffer (não o JSON com { value } bruto).
    expect(getMock).toHaveBeenCalledWith(
      '/default/auth/qr',
      expect.objectContaining({ responseType: 'arraybuffer', params: { format: 'image' } }),
    )
  })

  it('fallback: aceita JSON { mimetype, data } com base64', async () => {
    const json = { mimetype: 'image/png', data: pngBuf.toString('base64') }
    getMock.mockResolvedValueOnce({
      headers: { 'content-type': 'application/json; charset=utf-8' },
      data: Buffer.from(JSON.stringify(json), 'utf8'),
    })

    const provider = new WahaProvider()
    const { qrCode } = await provider.getQr('default')

    expect(qrCode).toBe(`data:image/png;base64,${pngBuf.toString('base64')}`)
  })

  it('sessão ainda não pronta (422) → devolve vazio sem lançar', async () => {
    getMock.mockRejectedValueOnce({ response: { status: 422 } })

    const provider = new WahaProvider()
    const { qrCode } = await provider.getQr('default')

    expect(qrCode).toBeUndefined()
  })
})
