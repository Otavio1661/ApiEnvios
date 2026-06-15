// src/providers/waha.provider.ts
import axios, { AxiosInstance } from 'axios'
import { config } from '../config'
import type { IWhatsappProvider, ProviderSendResult, InstanceStatus, MessageType, Provider } from '../types'

export class WahaProvider implements IWhatsappProvider {
  readonly name: Provider = 'WAHA'
  private client: AxiosInstance

  constructor() {
    this.client = axios.create({
      baseURL: config.providers.waha.url,
      headers: {
        'Content-Type': 'application/json',
        ...(config.providers.waha.apiKey ? { 'X-Api-Key': config.providers.waha.apiKey } : {}),
      },
      timeout: 15000,
    })
  }

  async sendText(instanceId: string, to: string, text: string): Promise<ProviderSendResult> {
    const start = Date.now()
    try {
      // WAHA usa formato chatId: "5544999990000@c.us"
      const chatId = to.includes('@') ? to : `${to}@c.us`

      const response = await this.client.post(`/api/sendText`, {
        session: instanceId,
        chatId,
        text,
      })

      return {
        success: true,
        providerId: response.data?.id,
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
    const chatId = to.includes('@') ? to : `${to}@c.us`

    try {
      const response = await this.client.post(`/api/sendImage`, {
        session: instanceId,
        chatId,
        file: { url: mediaUrl },
        caption: caption ?? '',
      })

      return {
        success: true,
        providerId: response.data?.id,
        duration: Date.now() - start,
      }
    } catch (err: any) {
      return this.handleError(err, Date.now() - start)
    }
  }

  async getInstanceStatus(instanceId: string): Promise<InstanceStatus> {
    try {
      const response = await this.client.get(`/api/sessions/${instanceId}`)
      const status = response.data?.status

      const stateMap: Record<string, InstanceStatus> = {
        WORKING: 'connected',
        STOPPED: 'disconnected',
        STARTING: 'qr_required',
        SCAN_QR_CODE: 'qr_required',
        FAILED: 'unknown',
      }

      return stateMap[status] ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }

  async createInstance(instanceId: string): Promise<{ instanceId: string; qrCode?: string }> {
    const response = await this.client.post('/api/sessions', {
      name: instanceId,
      config: { noweb: { store: { enabled: true } } },
    })

    // Busca QR code logo após criar
    try {
      const qrResp = await this.client.get(`/api/${instanceId}/auth/qr`)
      return {
        instanceId,
        qrCode: qrResp.data?.value,
      }
    } catch {
      return { instanceId }
    }
  }

  async deleteInstance(instanceId: string): Promise<void> {
    await this.client.delete(`/api/sessions/${instanceId}`)
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
