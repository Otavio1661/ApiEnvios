// src/utils/webhook-signature.ts
// Assinatura HMAC dos webhooks de saída. O receptor valida que o evento veio
// realmente do ApiEnvios (e não foi forjado/alterado) recomputando o HMAC com o
// mesmo segredo sobre `${timestamp}.${body}`.
//
// Headers enviados quando o webhook tem `secret`:
//   X-ApiEnvios-Timestamp: <epoch ms>            (instante do envio — janela anti-replay)
//   X-ApiEnvios-Signature: sha256=<hex>          (HMAC-SHA256 de "<ts>.<body>")
import { createHmac } from 'crypto'

// Calcula o cabeçalho de assinatura para um corpo já serializado (string).
// IMPORTANTE: assina exatamente os bytes enviados — o caller deve POSTar a MESMA string.
export function webhookSignature(secret: string, timestamp: string, body: string): string {
  const hex = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return `sha256=${hex}`
}
