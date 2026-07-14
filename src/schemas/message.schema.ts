// src/schemas/message.schema.ts
// Schema zod de envio de mensagem, compartilhado pelas duas superfícies de envio:
//   - conta (x-api-key): POST /v1/messages           (src/routes/messages.route.ts)
//   - instância (Token):  POST /v1/instance/:id/messages/send (src/routes/instances.route.ts)
// Extraído pra um módulo único pra evitar duas cópias divergentes das regras de
// validação (aconteceu antes: o endpoint de instância ficou sem suporte a BUTTONS).
import { z } from 'zod'

// Botão interativo (type=BUTTONS). Discriminado por `type`: quickreply | url | call.
export const buttonSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('quickreply'), displayText: z.string().min(1).max(25) }),
  z.object({ type: z.literal('url'), displayText: z.string().min(1).max(25), url: z.string().url() }),
  z.object({ type: z.literal('call'), displayText: z.string().min(1).max(25), phoneNumber: z.string().min(8).max(20) }),
])

// Campos de todos os tipos possíveis. Cada tipo usa só o subconjunto relevante
// (validado pelo .refine abaixo) — mantém um único schema, mais simples que uma
// discriminated union completa dado quanto os tipos já existentes reaproveitam campos.
export const sendBodySchema = z.object({
  to: z.string().min(10).max(15),
  type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'STICKER', 'BUTTONS', 'LOCATION', 'CONTACT', 'POLL']).default('TEXT'),
  text: z.string().optional(),
  mediaUrl: z.string().url().optional(),
  caption: z.string().optional(),
  buttons: z.array(buttonSchema).min(1).max(5).optional(),
  footer: z.string().max(60).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  locationName: z.string().max(100).optional(),
  contactName: z.string().min(1).max(100).optional(),
  contactPhone: z.string().min(8).max(20).optional(),
  pollOptions: z.array(z.string().min(1).max(100)).min(2).max(12).optional(),
  externalId: z.string().optional(),
  instanceId: z.string().optional(),
  scheduledAt: z.string().datetime().optional(),
}).refine(
  (d) => {
    if (d.type !== 'BUTTONS') return true
    if (!d.text || !d.buttons?.length) return false
    return d.buttons.filter(b => b.type === 'quickreply').length <= 3
  },
  { message: 'type=BUTTONS exige "text" (corpo) e 1-3 botões quickreply (+ opcionalmente 1 url e 1 call).' },
).refine(
  (d) => d.type !== 'LOCATION' || (d.latitude !== undefined && d.longitude !== undefined),
  { message: 'type=LOCATION exige "latitude" e "longitude".' },
).refine(
  (d) => d.type !== 'CONTACT' || (!!d.contactName && !!d.contactPhone),
  { message: 'type=CONTACT exige "contactName" e "contactPhone".' },
).refine(
  (d) => d.type !== 'POLL' || (!!d.text && !!d.pollOptions?.length),
  { message: 'type=POLL exige "text" (pergunta) e "pollOptions" (2 a 12 opções).' },
).refine(
  (d) => !['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'STICKER'].includes(d.type) || !!d.mediaUrl,
  { message: 'Mensagens de mídia exigem "mediaUrl".' },
)

export type SendBody = z.infer<typeof sendBodySchema>
