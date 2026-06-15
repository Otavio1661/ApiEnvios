// src/providers/cloudapi.provider.ts
import axios, { AxiosInstance } from 'axios'
import { config } from '../config'
import type { IWhatsappProvider, ProviderSendResult, InstanceStatus, MessageType, Provider } from '../types'

export class CloudApiProvider implements IWhatsappProvider {
  readonly name: Provider = 'CLOUD_API'
  private client: AxiosInstance
  private phoneNumberId: string

  constructor() {
    this.phoneNumberId = config.providers.cloudApi.phoneNumberId
    this.client = axios.create({
      baseURL: 'https://graph.facebook.com/v20.0',
      headers: {
        Authorization: `Bearer ${config.providers.cloudApi.token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    })
  }

  async sendText(_instanceId: string, to: string, text: string): Promise<ProviderSendResult> {
    const start = Date.now()
    try {
      const response = await this.client.post(`/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      })

      return {
        success: true,
        providerId: response.data?.messages?.[0]?.id,
        duration: Date.now() - start,
      }
    } catch (err: any) {
      return this.handleError(err, Date.now() - start)
    }
  }

  async sendMedia(
    _instanceId: string,
    to: string,
    mediaUrl: string,
    caption?: string,
    type: MessageType = 'IMAGE'
  ): Promise<ProviderSendResult> {
    const start = Date.now()
    const typeKey = type.toLowerCase() as 'image' | 'video' | 'audio' | 'document'

    try {
      const response = await this.client.post(`/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        to,
        type: typeKey,
        [typeKey]: { link: mediaUrl, caption: caption ?? '' },
      })

      return {
        success: true,
        providerId: response.data?.messages?.[0]?.id,
        duration: Date.now() - start,
      }
    } catch (err: any) {
      return this.handleError(err, Date.now() - start)
    }
  }

  // A Cloud API não tem "instâncias" no mesmo sentido — esses métodos são no-ops
  async getInstanceStatus(_instanceId: string): Promise<InstanceStatus> {
    if (!config.providers.cloudApi.token) return 'unknown'
    return 'connected'
  }

  async createInstance(instanceId: string): Promise<{ instanceId: string }> {
    return { instanceId }
  }

  async deleteInstance(_instanceId: string): Promise<void> {
    // no-op
  }

  private handleError(err: any, duration: number): ProviderSendResult {
    const errorMsg =
      err?.response?.data?.error?.message ?? err?.message ?? 'Unknown error'
    const errorCode = String(
      err?.response?.data?.error?.code ?? err?.response?.status ?? 'ERR'
    )

    return {
      success: false,
      error: errorMsg,
      errorCode,
      duration,
    }
  }
}
