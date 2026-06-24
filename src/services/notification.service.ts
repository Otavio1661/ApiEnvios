// src/services/notification.service.ts
import axios from 'axios'
import { config } from '../config'
import { prisma } from '../utils/prisma'
import { logger } from '../utils/logger'
import { enqueueWebhookDelivery } from '../queues/webhook.queue'
import type { WebhookEvent, WebhookPayload } from '../types'

// ── Dispara webhooks cadastrados no banco ─────────────────────
// Quando `apiClientId` é informado (evento de um tenant específico, ex.: ban/message),
// dispara para os webhooks daquele tenant E para os webhooks globais do admin (apiClientId null).
// Quando omitido, dispara apenas para os webhooks globais (eventos de sistema).
//
// A entrega NÃO é mais inline: cada destino vira um job na fila webhook-delivery, com
// retry/backoff e DLQ (BullMQ) + assinatura HMAC no worker. Aqui só resolvemos os
// destinos e enfileiramos (rápido e resiliente a falhas do destino).
export async function dispatchWebhook(
  event: WebhookEvent,
  data: Record<string, unknown>,
  apiClientId?: string,
) {
  const webhooks = await prisma.webhook.findMany({
    where: {
      active: true,
      events: { has: event },
      // Tenant específico: pega webhooks do tenant + globais (null). Sem tenant: só globais.
      ...(apiClientId
        ? { OR: [{ apiClientId }, { apiClientId: null }] }
        : { apiClientId: null }),
    },
    select: { id: true },
  })

  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  }

  for (const webhook of webhooks) {
    await enqueueWebhookDelivery(webhook.id, event, payload)
  }
}

// ── Notificação específica de ban ─────────────────────────────
export async function notifyBan(data: {
  apiClientId?: string
  instanceId?: string
  phone: string
  provider: string
  reason: string
  bannedAt: string
}) {
  // 1. Webhooks cadastrados no banco (escopados ao tenant + globais do admin)
  await dispatchWebhook('BAN_DETECTED', data, data.apiClientId)

  // 2. Webhook de ban do .env (fallback simples)
  if (config.notifications.banWebhookUrl) {
    try {
      await axios.post(config.notifications.banWebhookUrl, {
        event: 'BAN_DETECTED',
        timestamp: data.bannedAt,
        ...data,
      })
    } catch (err: any) {
      logger.error(`[BanNotify] Falha no webhook de ban: ${err.message}`)
    }
  }
}
