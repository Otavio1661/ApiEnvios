// src/utils/webhook-signature.test.ts
import { describe, it, expect } from 'vitest'
import { createHmac } from 'crypto'
import { webhookSignature } from './webhook-signature'

describe('webhookSignature', () => {
  const secret = 'segredo-do-webhook'
  const ts = '1717000000000'
  const body = JSON.stringify({ event: 'BAN_DETECTED', data: { x: 1 } })

  it('gera HMAC-SHA256 de "<ts>.<body>" no formato sha256=<hex>', () => {
    const esperado =
      'sha256=' + createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
    expect(webhookSignature(secret, ts, body)).toBe(esperado)
  })

  it('muda se o corpo mudar (integridade)', () => {
    const a = webhookSignature(secret, ts, body)
    const b = webhookSignature(secret, ts, body + ' ')
    expect(a).not.toBe(b)
  })

  it('muda se o timestamp mudar (anti-replay)', () => {
    const a = webhookSignature(secret, ts, body)
    const b = webhookSignature(secret, '1717000000001', body)
    expect(a).not.toBe(b)
  })

  it('muda se o segredo mudar', () => {
    expect(webhookSignature('outro', ts, body)).not.toBe(webhookSignature(secret, ts, body))
  })
})
