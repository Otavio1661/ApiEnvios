// src/providers/evolution.provider.ts
import axios, { AxiosInstance } from 'axios'
import { config } from '../config'
import { logger } from '../utils/logger'
import type { IWhatsappProvider, ProviderSendResult, InstanceStatus, MessageType, Provider } from '../types'

export class EvolutionProvider implements IWhatsappProvider {
  readonly name: Provider = 'EVOLUTION'
  private client: AxiosInstance

  constructor() {
    this.client = axios.create({
      baseURL: config.providers.evolution.url,
      headers: {
        apikey: config.providers.evolution.apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    })
  }

  async sendText(instanceId: string, to: string, text: string): Promise<ProviderSendResult> {
    const start = Date.now()
    try {
      const response = await this.client.post(`/message/sendText/${instanceId}`, {
        number: to,
        text,
      })

      return {
        success: true,
        providerId: response.data?.key?.id,
        duration: Date.now() - start,
      }
    } catch (err: any) {
      return this.handleError(err, Date.now() - start)
    }
  }

  async sendMedia(
    instanceId: string,
    to: string,
    mediaUrl: string,
    caption?: string,
    type: MessageType = 'IMAGE'
  ): Promise<ProviderSendResult> {
    const start = Date.now()
    const typeMap: Record<string, string> = {
      IMAGE: 'sendMedia',
      VIDEO: 'sendMedia',
      AUDIO: 'sendWhatsAppAudio',
      DOCUMENT: 'sendMedia',
    }
    const endpoint = typeMap[type] ?? 'sendMedia'

    try {
      const response = await this.client.post(`/message/${endpoint}/${instanceId}`, {
        number: to,
        mediatype: type.toLowerCase(),
        media: mediaUrl,
        caption: caption ?? '',
      })

      return {
        success: true,
        providerId: response.data?.key?.id,
        duration: Date.now() - start,
      }
    } catch (err: any) {
      return this.handleError(err, Date.now() - start)
    }
  }

  async getInstanceStatus(instanceId: string): Promise<InstanceStatus> {
    try {
      const response = await this.client.get(`/instance/connectionState/${instanceId}`)
      const state = response.data?.instance?.state

      const stateMap: Record<string, InstanceStatus> = {
        open: 'connected',
        close: 'disconnected',
        connecting: 'qr_required',
      }

      return stateMap[state] ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }

  async createInstance(instanceId: string): Promise<{ instanceId: string; qrCode?: string }> {
    try {
      const response = await this.client.post('/instance/create', {
        instanceName: instanceId,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
      })

      return {
        instanceId: response.data?.instance?.instanceName ?? instanceId,
        // POST /instance/create devolve o QR aninhado em qrcode.base64
        qrCode: response.data?.qrcode?.base64 ?? response.data?.base64,
      }
    } catch (err: any) {
      // Instância já existe (conflito) → reconecta para obter o QR atual
      const status = err?.response?.status
      if (status === 403 || status === 409) {
        const { qrCode } = await this.connect(instanceId)
        return { instanceId, qrCode }
      }
      throw err
    }
  }

  // GET /instance/connect/{id} → { base64 } ou { qrcode: { base64 } }
  async connect(instanceId: string): Promise<{ qrCode?: string }> {
    const response = await this.client.get(`/instance/connect/${instanceId}`)
    return {
      qrCode: response.data?.base64 ?? response.data?.qrcode?.base64,
    }
  }

  // Busca o QR atual sem recriar — usa o mesmo endpoint connect (idempotente)
  async getQr(instanceId: string): Promise<{ qrCode?: string }> {
    return this.connect(instanceId)
  }

  async deleteInstance(instanceId: string): Promise<void> {
    await this.client.delete(`/instance/delete/${instanceId}`)
  }

  // Registra o webhook inbound na Evolution. O formato mudou entre versões;
  // tentamos o formato v2 ({ webhook: { ... } }) e caímos no formato plano se houver erro.
  async setWebhook(instanceId: string, url: string): Promise<void> {
    const events = ['MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED']
    try {
      const resp = await this.client.post(`/webhook/set/${instanceId}`, {
        webhook: { enabled: true, url, webhookByEvents: false, events },
      })
      logger.debug(`[Evolution] setWebhook ok (${instanceId}): ${JSON.stringify(resp.data)}`)
    } catch (err: any) {
      // Fallback para formato plano (algumas builds da v2.3.x)
      try {
        const resp = await this.client.post(`/webhook/set/${instanceId}`, {
          url,
          enabled: true,
          webhook_by_events: false,
          events,
        })
        logger.debug(`[Evolution] setWebhook ok (formato plano) (${instanceId}): ${JSON.stringify(resp.data)}`)
      } catch (err2: any) {
        const detail = err2?.response?.data ?? err2?.message
        throw new Error(`Evolution setWebhook falhou: ${JSON.stringify(detail)}`)
      }
    }
  }

  // ── Detecta se o erro indica banimento ───────────────────────
  isBanError(errorMsg: string): boolean {
    const banSignals = [
      'banned',
      'blocked',
      'unauthorized',
      '403',
      'Stream Errored',
      '515',
      'conflict',
    ]
    return banSignals.some(signal =>
      errorMsg.toLowerCase().includes(signal.toLowerCase())
    )
  }

  private handleError(err: any, duration: number): ProviderSendResult {
    const errorMsg = err?.response?.data?.message ?? err?.message ?? 'Unknown error'
    const errorCode = String(err?.response?.status ?? 'ERR')

    return {
      success: false,
      error: errorMsg,
      errorCode,
      duration,
    }
  }
}
