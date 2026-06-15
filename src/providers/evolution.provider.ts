// src/providers/evolution.provider.ts
import axios, { AxiosInstance } from 'axios'
import { config } from '../config'
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
    const response = await this.client.post('/instance/create', {
      instanceName: instanceId,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    })

    return {
      instanceId: response.data?.instance?.instanceName ?? instanceId,
      qrCode: response.data?.qrcode?.base64,
    }
  }

  async deleteInstance(instanceId: string): Promise<void> {
    await this.client.delete(`/instance/delete/${instanceId}`)
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
