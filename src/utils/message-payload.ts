// src/utils/message-payload.ts
// Traduz o corpo validado (SendBody) para os campos de `prisma.message.create`.
// Compartilhado pelas duas superfícies de envio (conta e instância) — mantém a
// regra de "onde cada tipo guarda seus dados" (content vs. campos Json) num só lugar.
import type { SendBody } from '../schemas/message.schema'

export function buildMessageCreateFields(payload: SendBody) {
  const content =
    payload.type === 'LOCATION' ? (payload.locationName ?? '') :
    payload.type === 'CONTACT'  ? (payload.contactName ?? '') :
    payload.type === 'POLL'     ? (payload.text ?? '') :
    (payload.text ?? payload.mediaUrl ?? '')

  return {
    type: payload.type,
    content,
    caption: payload.caption,
    buttons: payload.type === 'BUTTONS'
      ? { footer: payload.footer, buttons: payload.buttons }
      : undefined,
    location: payload.type === 'LOCATION'
      ? { latitude: payload.latitude, longitude: payload.longitude }
      : undefined,
    contact: payload.type === 'CONTACT'
      ? { phone: payload.contactPhone }
      : undefined,
    poll: payload.type === 'POLL'
      ? { options: payload.pollOptions }
      : undefined,
  }
}
