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
    await this.client.post('/sessions', {
      name: instanceId,
      config: {
        noweb: { store: { enabled: true } },
        ...(webhooks ? { webhooks } : {}),
      },
    })

    // Busca QR code logo após criar (best-effort: a sessão pode estar em STARTING
    // e o QR só ficar disponível em SCAN_QR_CODE — nesse caso o polling /qr da view
    // renova a cada 5s).
    const { qrCode } = await this.getQr(instanceId)
    return { instanceId, qrCode }
  }

  // Obtém o QR da sessão do WAHA como data URI PNG (`data:image/png;base64,...`).
  //
  // Contrato real do WAHA 2026.x (engine NOWEB), verificado contra o servidor:
  //   GET /api/{session}/auth/qr                      → image/png BINÁRIO (PNG escaneável)
  //   GET /api/{session}/auth/qr?format=image         → image/png BINÁRIO (idem)
  //   GET /api/{session}/auth/qr (Accept: json)       → { mimetype, data: "<base64-png>" }
  //   GET /api/{session}/auth/qr?format=raw           → { value: "<string-bruta-do-QR>" } (NÃO é imagem)
  //
  // Por isso pedimos a IMAGEM binária (responseType arraybuffer) e convertemos para
  // base64 nós mesmos — determinístico e estável entre versões. Mantemos fallback
  // para os shapes JSON (`data`/`value` base64) por robustez. Se a sessão ainda não
  // está em SCAN_QR_CODE, o WAHA responde 422 e devolvemos vazio (a view faz polling).
  async getQr(instanceId: string): Promise<{ qrCode?: string }> {
    try {
      const qrResp = await this.client.get(`/${instanceId}/auth/qr`, {
        params: { format: 'image' },
        responseType: 'arraybuffer',
        headers: { Accept: 'image/png' },
      })

      const contentType = String(qrResp.headers?.['content-type'] ?? '')
      const buf = Buffer.from(qrResp.data)

      // Caminho principal: corpo é uma imagem binária → base64 + data URI.
      if (contentType.startsWith('image/')) {
        const mime = contentType.split(';')[0].trim() || 'image/png'
        return { qrCode: `data:${mime};base64,${buf.toString('base64')}` }
      }

      // Fallback: alguma versão respondeu JSON ({ data } base64 PNG, ou { value }).
      try {
        const json = JSON.parse(buf.toString('utf8'))
        const base64 = typeof json?.data === 'string' ? json.data : undefined
        if (base64) {
          const mime = typeof json?.mimetype === 'string' ? json.mimetype : 'image/png'
          return { qrCode: `data:${mime};base64,${base64}` }
        }
      } catch {
        // não era JSON — cai no retorno vazio abaixo
      }
      return {}
    } catch (err: any) {
      // 422 = sessão ainda não está em SCAN_QR_CODE (ex.: STARTING). Não é erro fatal:
      // a view renova via polling /qr a cada 5s.
      logger.debug(`[WAHA] getQr indisponível (${instanceId}): ${err?.response?.status ?? err?.message}`)
      return {}
    }
  }

  // Garante a sessão: tenta dar start; se não existir, cria. Depois devolve o QR.
  // Logo após o start a sessão fica em STARTING e o QR (SCAN_QR_CODE) pode não estar
  // pronto de imediato — fazemos um retry curto e não-bloqueante. Se ainda assim não
  // vier, a view renova via polling /qr a cada 5s.
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
    return this.getQrWithShortRetry(instanceId)
  }

  // Tenta obter o QR com algumas tentativas curtas (a sessão pode estar em STARTING).
  // Limite total ~2s para não segurar o request — o polling da view cobre o resto.
  private async getQrWithShortRetry(instanceId: string): Promise<{ qrCode?: string }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await this.getQr(instanceId)
      if (result.qrCode) return result
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 700))
    }
    return {}
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
