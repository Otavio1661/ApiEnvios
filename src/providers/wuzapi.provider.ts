// src/providers/wuzapi.provider.ts
//
// Provider WuzAPI (https://github.com/asternic/wuzapi) — wrapper Go sobre a lib
// whatsmeow (fala direto com o WebSocket do WhatsApp). Suporta botões interativos
// nativos (explorado na Parte 2).
//
// DIFERENÇA DE MODELO vs Evolution: o WuzAPI autentica por TOKEN-POR-USUÁRIO,
// não por apikey global + instanceId na URL. Cada sessão é um "user" do WuzAPI com
// seu próprio token. Como o token é opaco e definido por nós na criação, guardamos
// esse token no campo Instance.instanceId — assim toda chamada seguinte recebe o
// token via o parâmetro `instanceId` da interface e o usa no header Authorization.
// Só a criação/remoção de usuário usa o adminToken.

import axios, { AxiosInstance } from 'axios'
import { randomBytes } from 'crypto'
import { config } from '../config'
import { logger } from '../utils/logger'
import type { IWhatsappProvider, ProviderSendResult, InstanceStatus, MessageType, Provider, WhatsappButton } from '../types'

interface WuzUser {
  id: string | number
  name: string
  token: string
}

export class WuzapiProvider implements IWhatsappProvider {
  readonly name: Provider = 'WUZAPI'
  private admin: AxiosInstance
  private baseUrl: string

  constructor() {
    this.baseUrl = config.providers.wuzapi.url
    // Cliente admin — só pra provisionar/apagar usuários (sessões).
    this.admin = axios.create({
      baseURL: this.baseUrl,
      headers: {
        Authorization: config.providers.wuzapi.adminToken,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    })
  }

  /**
   * Cliente autenticado como o USUÁRIO (token guardado em Instance.instanceId).
   * Auth de usuário no WuzAPI é pelo header `token` — o `Authorization` é só do
   * admin (retorna 401 se usado aqui).
   */
  private userClient(token: string): AxiosInstance {
    return axios.create({
      baseURL: this.baseUrl,
      headers: {
        token,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    })
  }

  // ── Envio ────────────────────────────────────────────────────

  async sendText(instanceId: string, to: string, text: string): Promise<ProviderSendResult> {
    const start = Date.now()
    try {
      const response = await this.userClient(instanceId).post('/chat/send/text', {
        Phone: to,
        Body: text,
      })
      return {
        success: true,
        providerId: response.data?.data?.Id,
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

    // WuzAPI recebe a mídia em base64 (data URI), não por URL — baixamos e convertemos.
    let dataUri: string
    try {
      const media = await axios.get<ArrayBuffer>(mediaUrl, { responseType: 'arraybuffer', timeout: 20000 })
      const mime = media.headers['content-type'] ?? this.defaultMime(type)
      dataUri = `data:${mime};base64,${Buffer.from(media.data).toString('base64')}`
    } catch (err: any) {
      return { success: false, error: `Falha ao baixar mídia: ${err?.message}`, errorCode: 'MEDIA_FETCH', duration: Date.now() - start }
    }

    // Endpoint e nome do campo mudam por tipo no WuzAPI.
    const map: Record<string, { endpoint: string; field: string }> = {
      IMAGE:    { endpoint: '/chat/send/image',    field: 'Image' },
      VIDEO:    { endpoint: '/chat/send/video',    field: 'Video' },
      AUDIO:    { endpoint: '/chat/send/audio',    field: 'Audio' },
      DOCUMENT: { endpoint: '/chat/send/document', field: 'Document' },
    }
    const cfg = map[type] ?? map.IMAGE

    try {
      const body: Record<string, unknown> = { Phone: to, [cfg.field]: dataUri }
      if (caption) body.Caption = caption
      const response = await this.userClient(instanceId).post(cfg.endpoint, body)
      return {
        success: true,
        providerId: response.data?.data?.Id,
        duration: Date.now() - start,
      }
    } catch (err: any) {
      return this.handleError(err, Date.now() - start)
    }
  }

  /**
   * Mensagem interativa com botões (quick-reply, link, call). Diferencial do
   * WuzAPI sobre os providers Baileys. Endpoint /chat/send/buttons.
   * Limite do WhatsApp: até 3 quick-reply + 1 link + 1 call.
   *
   * Mapeamento do nosso formato → WuzAPI (confirmado no source do handler):
   *   quickreply → { type: "reply",    title }
   *   url        → { type: "cta_url",  title, url }
   *   call       → { type: "cta_call", title, phone_number }
   */
  async sendButtons(
    instanceId: string,
    to: string,
    body: string,
    buttons: WhatsappButton[],
    footer?: string
  ): Promise<ProviderSendResult> {
    const start = Date.now()

    const wuzButtons = buttons.map(b => {
      if (b.type === 'url')  return { type: 'cta_url',  title: b.displayText, url: b.url }
      if (b.type === 'call') return { type: 'cta_call', title: b.displayText, phone_number: b.phoneNumber }
      return { type: 'reply', title: b.displayText }
    })

    try {
      const payload: Record<string, unknown> = { Phone: to, Body: body, Buttons: wuzButtons }
      if (footer) payload.Footer = footer
      const response = await this.userClient(instanceId).post('/chat/send/buttons', payload)
      return {
        success: true,
        providerId: response.data?.data?.Id,
        duration: Date.now() - start,
      }
    } catch (err: any) {
      return this.handleError(err, Date.now() - start)
    }
  }

  // ── Sessão / provisionamento ─────────────────────────────────

  async createInstance(name: string): Promise<{ instanceId: string; qrCode?: string }> {
    // `name` pode ser um nome novo ("inst-xxx") OU, na recuperação (404), o próprio
    // token já existente. Procura por qualquer um dos dois pra reaproveitar a sessão.
    const existing = await this.findUser(name)
    const token = existing?.token ?? this.generateToken()

    if (!existing) {
      await this.admin.post('/admin/users', {
        name,
        token,
        events: 'Message',
      })
    }

    await this.connect(token)
    const { qrCode } = await this.getQr(token)
    return { instanceId: token, qrCode }
  }

  async connect(instanceId: string): Promise<{ qrCode?: string }> {
    try {
      await this.userClient(instanceId).post('/session/connect', {
        Subscribe: ['Message'],
        Immediate: false,
      })
    } catch (err: any) {
      // "already connected" não é erro — segue pra buscar o QR/estado atual.
      if (err?.response?.status !== 500) throw err
    }
    return this.getQr(instanceId)
  }

  async getQr(instanceId: string): Promise<{ qrCode?: string }> {
    try {
      // O WuzAPI expõe o QR dentro do /session/status (campo `qrcode`, já em
      // data URI PNG) — não há endpoint /session/qr separado.
      const response = await this.userClient(instanceId).get('/session/status')
      const qr = response.data?.data?.qrcode
      return { qrCode: qr || undefined }
    } catch {
      return { qrCode: undefined }
    }
  }

  async getInstanceStatus(instanceId: string): Promise<InstanceStatus> {
    try {
      const response = await this.userClient(instanceId).get('/session/status')
      const data = response.data?.data ?? {}
      if (data.loggedIn && data.connected) return 'connected'
      if (data.connected && !data.loggedIn) return 'qr_required'
      return 'disconnected'
    } catch {
      return 'unknown'
    }
  }

  async setWebhook(instanceId: string, url: string): Promise<void> {
    await this.userClient(instanceId).post('/webhook', { webhookURL: url })
    logger.debug(`[WuzAPI] webhook definido (${url})`)
  }

  async deleteInstance(instanceId: string): Promise<void> {
    // `instanceId` aqui é o token do usuário — resolve o id pelo admin e apaga.
    const user = await this.findUser(instanceId)
    if (!user) {
      logger.debug(`[WuzAPI] deleteInstance: usuário não encontrado (já removido?)`)
      return
    }
    // Logout best-effort antes de apagar (encerra a sessão no whatsmeow).
    try {
      await this.userClient(instanceId).post('/session/logout', {})
    } catch { /* best-effort */ }
    await this.admin.delete(`/admin/users/${user.id}`)
  }

  // ── Helpers ──────────────────────────────────────────────────

  /** Lista usuários no admin e casa por nome OU por token (recuperação). */
  private async findUser(nameOrToken: string): Promise<WuzUser | null> {
    try {
      const response = await this.admin.get('/admin/users')
      const users: WuzUser[] = response.data?.data ?? response.data ?? []
      return users.find(u => u.name === nameOrToken || u.token === nameOrToken) ?? null
    } catch {
      return null
    }
  }

  private generateToken(): string {
    return randomBytes(16).toString('hex')
  }

  private defaultMime(type: MessageType): string {
    const map: Record<string, string> = {
      IMAGE: 'image/jpeg',
      VIDEO: 'video/mp4',
      AUDIO: 'audio/ogg',
      DOCUMENT: 'application/pdf',
    }
    return map[type] ?? 'application/octet-stream'
  }

  isBanError(errorMsg: string): boolean {
    const banSignals = ['banned', 'blocked', 'unauthorized', '403', 'logged out', 'not logged in']
    return banSignals.some(s => errorMsg.toLowerCase().includes(s.toLowerCase()))
  }

  private handleError(err: any, duration: number): ProviderSendResult {
    const errorMsg = err?.response?.data?.error ?? err?.response?.data?.message ?? err?.message ?? 'Unknown error'
    const errorCode = String(err?.response?.status ?? 'ERR')
    return { success: false, error: errorMsg, errorCode, duration }
  }
}
