// src/services/notification.service.ts
import axios from 'axios'
import { config } from '../config'
import { prisma } from '../utils/prisma'
import { logger } from '../utils/logger'
import type { WebhookEvent, WebhookPayload } from '../types'

// ── Dispara webhooks cadastrados no banco ─────────────────────
// Quando `apiClientId` é informado (evento de um tenant específico, ex.: ban/message),
// dispara para os webhooks daquele tenant E para os webhooks globais do admin (apiClientId null).
// Quando omitido, dispara apenas para os webhooks globais (eventos de sistema).
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
  })

  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  }

  for (const webhook of webhooks) {
    try {
      await axios.post(webhook.url, payload, {
        timeout: 8000,
        headers: {
          'Content-Type': 'application/json',
          'X-ApiEnvios-Event': event,
        },
      })

      await prisma.webhook.update({
        where: { id: webhook.id },
        data: { lastCalledAt: new Date() },
      })
    } catch (err: any) {
      logger.error(`[Webhook] Falha ao chamar ${webhook.url}: ${err.message}`)
      await prisma.webhook.update({
        where: { id: webhook.id },
        data: { failCount: { increment: 1 } },
      })
    }
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
