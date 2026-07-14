// src/schemas/message.schema.test.ts
// Testes unitários da validação zod compartilhada pelas duas superfícies de envio.
import { describe, it, expect } from 'vitest'
import { sendBodySchema } from './message.schema'

const base = { to: '5544999990000' }

describe('sendBodySchema', () => {
  it('TEXT válido passa', () => {
    const r = sendBodySchema.safeParse({ ...base, type: 'TEXT', text: 'oi' })
    expect(r.success).toBe(true)
  })

  it('mídia sem mediaUrl falha', () => {
    const r = sendBodySchema.safeParse({ ...base, type: 'IMAGE' })
    expect(r.success).toBe(false)
  })

  it('mídia com mediaUrl passa (inclui STICKER)', () => {
    const r = sendBodySchema.safeParse({ ...base, type: 'STICKER', mediaUrl: 'https://exemplo.com/f.webp' })
    expect(r.success).toBe(true)
  })

  it('BUTTONS válido (1-3 quickreply + url + call) passa', () => {
    const r = sendBodySchema.safeParse({
      ...base, type: 'BUTTONS', text: 'Escolha uma opção',
      buttons: [
        { type: 'quickreply', displayText: 'Sim' },
        { type: 'quickreply', displayText: 'Não' },
        { type: 'url', displayText: 'Site', url: 'https://exemplo.com' },
        { type: 'call', displayText: 'Ligar', phoneNumber: '5544999990000' },
      ],
    })
    expect(r.success).toBe(true)
  })

  it('BUTTONS com 4 quickreply falha (máx 3)', () => {
    const r = sendBodySchema.safeParse({
      ...base, type: 'BUTTONS', text: 'oi',
      buttons: [
        { type: 'quickreply', displayText: 'A' },
        { type: 'quickreply', displayText: 'B' },
        { type: 'quickreply', displayText: 'C' },
        { type: 'quickreply', displayText: 'D' },
      ],
    })
    expect(r.success).toBe(false)
  })

  it('BUTTONS sem text falha', () => {
    const r = sendBodySchema.safeParse({ ...base, type: 'BUTTONS', buttons: [{ type: 'quickreply', displayText: 'Sim' }] })
    expect(r.success).toBe(false)
  })

  it('LOCATION com latitude/longitude passa', () => {
    const r = sendBodySchema.safeParse({ ...base, type: 'LOCATION', latitude: -23.5, longitude: -46.6 })
    expect(r.success).toBe(true)
  })

  it('LOCATION sem coordenadas falha', () => {
    const r = sendBodySchema.safeParse({ ...base, type: 'LOCATION', locationName: 'Escritório' })
    expect(r.success).toBe(false)
  })

  it('LOCATION com latitude fora do range falha', () => {
    const r = sendBodySchema.safeParse({ ...base, type: 'LOCATION', latitude: 200, longitude: -46.6 })
    expect(r.success).toBe(false)
  })

  it('CONTACT com nome e telefone passa', () => {
    const r = sendBodySchema.safeParse({ ...base, type: 'CONTACT', contactName: 'Fulano', contactPhone: '5544988880000' })
    expect(r.success).toBe(true)
  })

  it('CONTACT sem telefone falha', () => {
    const r = sendBodySchema.safeParse({ ...base, type: 'CONTACT', contactName: 'Fulano' })
    expect(r.success).toBe(false)
  })

  it('POLL com pergunta e 2+ opções passa', () => {
    const r = sendBodySchema.safeParse({ ...base, type: 'POLL', text: 'Qual sua cor favorita?', pollOptions: ['Azul', 'Verde'] })
    expect(r.success).toBe(true)
  })

  it('POLL com só 1 opção falha (mínimo 2)', () => {
    const r = sendBodySchema.safeParse({ ...base, type: 'POLL', text: 'Pergunta?', pollOptions: ['Única'] })
    expect(r.success).toBe(false)
  })

  it('POLL com 13 opções falha (máximo 12)', () => {
    const r = sendBodySchema.safeParse({ ...base, type: 'POLL', text: 'Pergunta?', pollOptions: Array.from({ length: 13 }, (_, i) => `Opção ${i}`) })
    expect(r.success).toBe(false)
  })

  it('POLL sem pergunta falha', () => {
    const r = sendBodySchema.safeParse({ ...base, type: 'POLL', pollOptions: ['A', 'B'] })
    expect(r.success).toBe(false)
  })
})
