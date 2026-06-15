// src/services/notification.service.ts
import axios from 'axios'
import { config } from '../config'
import { prisma } from '../utils/prisma'
import type { WebhookEvent, WebhookPayload } from '../types'

// ── Dispara webhooks cadastrados no banco ─────────────────────
export async function dispatchWebhook(event: WebhookEvent, data: Record<string, unknown>) {
  const webhooks = await prisma.webhook.findMany({
    where: {
      active: true,
      events: { has: event },
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
      console.error(`[Webhook] Falha ao chamar ${webhook.url}: ${err.message}`)
      await prisma.webhook.update({
        where: { id: webhook.id },
        data: { failCount: { increment: 1 } },
      })
    }
  }
}

// ── Notificação específica de ban ─────────────────────────────
export async function notifyBan(data: {
  phone: string
  provider: string
  reason: string
  bannedAt: string
}) {
  // 1. Webhooks cadastrados no banco
  await dispatchWebhook('BAN_DETECTED', data)

  // 2. Webhook de ban do .env (fallback simples)
  if (config.notifications.banWebhookUrl) {
    try {
      await axios.post(config.notifications.banWebhookUrl, {
        event: 'BAN_DETECTED',
        timestamp: data.bannedAt,
        ...data,
      })
    } catch (err: any) {
      console.error(`[BanNotify] Falha no webhook de ban: ${err.message}`)
    }
  }
}
