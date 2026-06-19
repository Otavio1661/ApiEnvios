// src/providers/waha.provider.ts
import axios, { AxiosInstance } from 'axios'
import { config } from '../config'
import { logger } from '../utils/logger'
import type { IWhatsappProvider, ProviderSendResult, InstanceStatus, MessageType, Provider } from '../types'

export class WahaProvider implements IWhatsappProvider {
  readonly name: Provider = 'WAHA'
  private client: AxiosInstance

  constructor() {
    this.client = axios.create({
      baseURL: config.providers.waha.url.replace(/\/$/, '') + '/api',
      headers: {
        'Content-Type': 'application/json',
        ...(config.providers.waha.apiKey ? { 'X-Api-Key': config.providers.waha.apiKey } : {}),
      },
      timeout: 15000,
    })
    this.client.interceptors.response.use(undefined, (err) => {
      logger.debug(`[WAHA-ERR] ${err?.config?.method?.toUpperCase()} ${err?.config?.url} → ${err?.response?.status} | body: ${JSON.stringify(err?.response?.data)}`)
      return Promise.reject(err)
    })
  }

  async sendText(instanceId: string, to: string, text: string): Promise<ProviderSendResult> {
    const start = Date.now()
    try {
      // WAHA usa formato chatId: "5544999990000@c.us"
      const chatId = to.includes('@') ? to : `${to}@c.us`

      const response = await this.client.post(`/sendText`, {
        session: instanceId,
        chatId,
        text,
      })

      return {
        success: true,
        providerId: this.extractMessageId(response.data),
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
      const response = await this.client.post(`/sendImage`, {
        session: instanceId,
        chatId,
        file: { url: mediaUrl },
        caption: caption ?? '',
      })

      return {
        success: true,
        providerId: this.extractMessageId(response.data),
        duration: Date.now() - start,
      }
    } catch (err: any) {
      return this.handleError(err, Date.now() - start)
    }
  }

  // Extrai o ID externo da mensagem de forma robusta entre engines do WAHA.
  // A engine NOWEB (a usada aqui) retorna a chave em `data.key.id` — NÃO há `data.id`
  // de topo. Mantemos fallbacks para outras engines/formatos por robustez.
  private extractMessageId(data: any): string | undefined {
    const id = data?.id ?? data?.key?.id ?? data?.message?.key?.id
    return id != null ? String(id) : undefined
  }

  async getInstanceStatus(instanceId: string): Promise<InstanceStatus> {
    try {
      const response = await this.client.get(`/sessions/${instanceId}`)
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

  // URL de webhook a aplicar na próxima criação/atualização de sessão.
  // Definida via setWebhook antes do connect/createInstance.
  private pendingWebhookUrl?: string

  private webhookConfig(url?: string) {
    if (!url) return undefined
    return [{ url, events: ['message.ack', 'session.status', 'state.change'] }]
  }

  async createInstance(instanceId: string): Promise<{ instanceId: string; qrCode?: string }> {
    const webhooks = this.webhookConfig(this.pendingWebhookUrl)
    const response = await this.client.post('/sessions', {
      name: instanceId,
      config: {
        noweb: { store: { enabled: true } },
        ...(webhooks ? { webhooks } : {}),
      },
    })

    // Busca QR code logo após criar
    try {
      const qrResp = await this.client.get(`/${instanceId}/auth/qr`)
      return {
        instanceId,
        qrCode: qrResp.data?.value,
      }
    } catch {
      return { instanceId }
    }
  }

  // GET /{id}/auth/qr → { value: "<base64>" }
  async getQr(instanceId: string): Promise<{ qrCode?: string }> {
    try {
      const qrResp = await this.client.get(`/${instanceId}/auth/qr`)
      return { qrCode: qrResp.data?.value }
    } catch {
      return {}
    }
  }

  // Garante a sessão: tenta dar start; se não existir, cria. Depois devolve o QR.
  async connect(instanceId: string): Promise<{ qrCode?: string }> {
    try {
      await this.client.post(`/sessions/${instanceId}/start`)
    } catch (err: any) {
      // Sessão inexistente (404) → cria
      if (err?.response?.status === 404) {
        await this.createInstance(instanceId)
      }
      // demais erros (ex.: já iniciada) são ignorados — seguimos para buscar o QR
    }
    return this.getQr(instanceId)
  }

  async deleteInstance(instanceId: string): Promise<void> {
    await this.client.delete(`/sessions/${instanceId}`)
  }

  // Registra o webhook inbound no WAHA. Guarda a URL para aplicar na criação da sessão
  // (createInstance) e tenta atualizar a sessão existente via PUT /sessions/{name}.
  async setWebhook(instanceId: string, url: string): Promise<void> {
    this.pendingWebhookUrl = url
    const webhooks = this.webhookConfig(url)
    try {
      const resp = await this.client.put(`/sessions/${instanceId}`, {
        config: {
          noweb: { store: { enabled: true } },
          webhooks,
        },
      })
      logger.debug(`[WAHA] setWebhook ok (${instanceId}): ${JSON.stringify(resp.data?.status ?? resp.status)}`)
    } catch (err: any) {
      // Sessão ainda não existe (404) → será aplicado em createInstance via pendingWebhookUrl.
      if (err?.response?.status === 404) {
        logger.debug(`[WAHA] setWebhook adiado (sessão ${instanceId} inexistente) — aplicará na criação`)
        return
      }
      const detail = err?.response?.data ?? err?.message
      throw new Error(`WAHA setWebhook falhou: ${JSON.stringify(detail)}`)
    }
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
