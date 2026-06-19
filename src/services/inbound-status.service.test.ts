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

  // ── WAHA ────────────────────────────────────────────────────
  it('mapeia message.ack da WAHA por ackName (DEVICE → DELIVERED)', () => {
    const update = mapInboundStatus('WAHA', {
      event: 'message.ack',
      payload: { id: 'WAHA-1', ackName: 'DEVICE' },
    })
    expect(update).toEqual({ providerId: 'WAHA-1', status: 'DELIVERED' })
  })

  it('mapeia message.ack da WAHA pelo fallback numérico (3 → READ)', () => {
    const update = mapInboundStatus('WAHA', {
      event: 'message.ack',
      payload: { id: 'WAHA-2', ack: 3 },
    })
    expect(update).toEqual({ providerId: 'WAHA-2', status: 'READ' })
  })

  it('mapeia session.status da WAHA (WORKING → CONNECTED)', () => {
    const update = mapInboundStatus('WAHA', {
      event: 'session.status',
      payload: { status: 'WORKING' },
    })
    expect(update).toEqual({ providerId: '', connectionState: 'CONNECTED' })
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
