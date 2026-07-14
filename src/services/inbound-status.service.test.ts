// src/services/inbound-status.service.test.ts
// Testes unitários das funções puras de parse/avanço de status inbound.
import { describe, it, expect } from 'vitest'
import { mapInboundStatus, isStatusAdvance } from './inbound-status.service'

describe('mapInboundStatus', () => {
  // ── Evolution ───────────────────────────────────────────────
  it('mapeia ack de entrega da Evolution (DELIVERY_ACK → DELIVERED)', () => {
    const update = mapInboundStatus('EVOLUTION', {
      event: 'messages.update',
      data: { keyId: 'EVO-123', status: 'DELIVERY_ACK' },
    })
    expect(update).toEqual({ providerId: 'EVO-123', status: 'DELIVERED' })
  })

  it('mapeia READ da Evolution e extrai providerId de key.id', () => {
    const update = mapInboundStatus('EVOLUTION', {
      event: 'MESSAGES_UPDATE',
      data: { key: { id: 'EVO-READ' }, status: 'READ' },
    })
    expect(update).toEqual({ providerId: 'EVO-READ', status: 'READ' })
  })

  it('mapeia evento de conexão da Evolution (open → CONNECTED)', () => {
    const update = mapInboundStatus('EVOLUTION', {
      event: 'connection.update',
      data: { state: 'open' },
    })
    expect(update).toEqual({ providerId: '', connectionState: 'CONNECTED' })
  })

  it('retorna null quando não há providerId num messages.update', () => {
    const update = mapInboundStatus('EVOLUTION', {
      event: 'messages.update',
      data: { status: 'DELIVERY_ACK' },
    })
    expect(update).toBeNull()
  })

  // ── Cloud API ───────────────────────────────────────────────
  it('mapeia statuses[] da Cloud API (delivered → DELIVERED)', () => {
    const update = mapInboundStatus('CLOUD_API', {
      entry: [
        { changes: [{ value: { statuses: [{ id: 'WAMID-1', status: 'delivered' }] } }] },
      ],
    })
    expect(update).toEqual({ providerId: 'WAMID-1', status: 'DELIVERED' })
  })

  it('retorna null para Cloud API sem statuses', () => {
    const update = mapInboundStatus('CLOUD_API', { entry: [{ changes: [{ value: {} }] }] })
    expect(update).toBeNull()
  })

  // ── WuzAPI ──────────────────────────────────────────────────
  // Formato REAL (capturado): form-encoded com o evento dentro de `jsonData` (string).
  const wuz = (evt: object) => ({ instanceName: 'inst', jsonData: JSON.stringify(evt), userID: 'u1' })

  it('mapeia ReadReceipt Delivered da WuzAPI (event.MessageIDs[0])', () => {
    const update = mapInboundStatus('WUZAPI', wuz({
      type: 'ReadReceipt', state: 'Delivered', event: { MessageIDs: ['WUZ-1', 'WUZ-2'] },
    }))
    expect(update).toEqual({ providerId: 'WUZ-1', status: 'DELIVERED' })
  })

  it('mapeia ReadReceipt Read da WuzAPI (Read → READ)', () => {
    const update = mapInboundStatus('WUZAPI', wuz({
      type: 'ReadReceipt', state: 'Read', event: { MessageIDs: ['WUZ-3'] },
    }))
    expect(update).toEqual({ providerId: 'WUZ-3', status: 'READ' })
  })

  it('mapeia Connected da WuzAPI (→ CONNECTED)', () => {
    const update = mapInboundStatus('WUZAPI', wuz({ type: 'Connected', event: {} }))
    expect(update).toEqual({ providerId: '', connectionState: 'CONNECTED' })
  })

  it('mapeia LoggedOut da WuzAPI (→ DISCONNECTED)', () => {
    const update = mapInboundStatus('WUZAPI', wuz({ type: 'LoggedOut', event: {} }))
    expect(update).toEqual({ providerId: '', connectionState: 'DISCONNECTED' })
  })

  it('mapeia QR da WuzAPI (qrCodeBase64 → qrCode)', () => {
    const update = mapInboundStatus('WUZAPI', wuz({ type: 'QR', qrCodeBase64: 'data:image/png;base64,ABC' }))
    expect(update).toEqual({ providerId: '', qrCode: 'data:image/png;base64,ABC' })
  })

  it('retorna null para evento irrelevante da WuzAPI (Presence)', () => {
    const update = mapInboundStatus('WUZAPI', wuz({ type: 'Presence', event: {} }))
    expect(update).toBeNull()
  })

  it('retorna null para ReadReceipt da WuzAPI sem MessageIDs', () => {
    const update = mapInboundStatus('WUZAPI', wuz({ type: 'ReadReceipt', state: 'Delivered', event: {} }))
    expect(update).toBeNull()
  })

  // ── Provider inválido ───────────────────────────────────────
  it('retorna null para provider inválido', () => {
    // @ts-expect-error — força um provider fora do enum para validar o default.
    const update = mapInboundStatus('INVALIDO', { foo: 'bar' })
    expect(update).toBeNull()
  })

  it('retorna null (sem lançar) quando o payload quebra o parse', () => {
    // payload null não deve estourar exceção — o dispatcher tem try/catch.
    const update = mapInboundStatus('EVOLUTION', null)
    expect(update).toBeNull()
  })
})

describe('isStatusAdvance', () => {
  it('avança SENT → DELIVERED', () => {
    expect(isStatusAdvance('SENT', 'DELIVERED')).toBe(true)
  })

  it('avança DELIVERED → READ', () => {
    expect(isStatusAdvance('DELIVERED', 'READ')).toBe(true)
  })

  it('NÃO retrocede READ → DELIVERED', () => {
    expect(isStatusAdvance('READ', 'DELIVERED')).toBe(false)
  })

  it('NÃO retrocede DELIVERED → SENT', () => {
    expect(isStatusAdvance('DELIVERED', 'SENT')).toBe(false)
  })

  it('NÃO considera avanço para o mesmo status', () => {
    expect(isStatusAdvance('SENT', 'SENT')).toBe(false)
  })

  it('ignora status fora do funil (FAILED não sobrescreve)', () => {
    expect(isStatusAdvance('SENT', 'FAILED')).toBe(false)
    expect(isStatusAdvance('FAILED', 'READ')).toBe(false)
  })
})
