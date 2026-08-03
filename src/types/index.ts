// src/types/index.ts
// Tipos globais do ApiEnvios

import type { ApiClient, Instance } from '@prisma/client'

// ── Payload do JWT de login humano ───────────────────────────
export interface JwtUserPayload {
  userId: string
  apiClientId: string
  accountRole: string   // papel de plataforma da conta (ClientRole: ADMIN | CLIENT)
  // ID único deste login — usado pra rastrear a sessão no Redis
  // (session-activity.service.ts), permitindo revogar/expirar por
  // inatividade ANTES do JWT em si vencer. Sem isso o logout só
  // conseguiria limpar o cookie, nunca invalidar o token de verdade.
  jti: string
}

// ── Dados do usuário autenticado anexados pelo guard authJwt ──
export interface AuthUser {
  id: string
  email: string
  name: string | null
  role: string          // papel dentro da conta (UserRole: OWNER | MEMBER)
}

// ── Augmentação do Fastify: contexto de autenticação ─────────
declare module 'fastify' {
  interface FastifyRequest {
    apiClient?: ApiClient
    instance?: Instance
    // Dados do usuário humano (login JWT). Mantido SEPARADO de `request.user`
    // (que o @fastify/jwt reserva para o payload do token) para evitar conflito.
    authUser?: AuthUser
  }
}

// ── Alinha o tipo de `request.user`/`jwtVerify()` do @fastify/jwt ──
// O @fastify/jwt declara `request.user` a partir de FastifyJWT['user'].
// Definimos o payload aqui para tipar com segurança jwt.sign/jwtVerify.
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtUserPayload
    user: JwtUserPayload
  }
}

export type Provider = 'EVOLUTION' | 'WUZAPI' | 'CLOUD_API'

export type MessageStatus = 
  | 'QUEUED' 
  | 'SENDING' 
  | 'SENT' 
  | 'DELIVERED' 
  | 'READ' 
  | 'FAILED'
  | 'SCHEDULED'
  | 'CANCELLED'

export type MessageType =
  | 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'STICKER' | 'BUTTONS'
  | 'LOCATION' | 'CONTACT' | 'POLL'

export type NumberStatus = 'ACTIVE' | 'WARMING' | 'BANNED' | 'SUSPENDED' | 'RETIRED'

// ── Botão interativo (type=BUTTONS) — só WuzAPI suporta ───────
export type WhatsappButton =
  | { displayText: string; type: 'quickreply' }
  | { displayText: string; type: 'url'; url: string }
  | { displayText: string; type: 'call'; phoneNumber: string }

// ── Payload de envio recebido pelos clientes ──────────────────
export interface SendMessagePayload {
  to: string              // número destino com DDI: "5544999990000"
  type: MessageType
  text?: string           // para tipo TEXT (ou corpo do BUTTONS)
  mediaUrl?: string       // para IMAGE, VIDEO, AUDIO, DOCUMENT, STICKER
  caption?: string        // legenda para mídia
  buttons?: WhatsappButton[]  // para type=BUTTONS
  footer?: string             // rodapé opcional do BUTTONS
  latitude?: number           // para type=LOCATION
  longitude?: number          // para type=LOCATION
  locationName?: string       // rótulo opcional do local (type=LOCATION)
  contactName?: string        // para type=CONTACT
  contactPhone?: string       // para type=CONTACT
  pollOptions?: string[]      // para type=POLL (a pergunta vai em `text`)
  externalId?: string     // ID do sistema cliente para idempotência
  scheduledAt?: string    // ISO 8601 para agendamento
}

// ── Estado de "digitando"/"gravando" (ação, não mensagem) ─────
export type ChatPresenceState = 'typing' | 'recording' | 'paused'

// ── Resultado de checagem de número no WhatsApp ────────────────
export interface CheckNumberResult {
  phone: string
  existsOnWhatsapp: boolean
  jid?: string
}

// ── Resultado de envio de um provider ────────────────────────
export interface ProviderSendResult {
  success: boolean
  providerId?: string     // ID da mensagem no provider
  error?: string
  errorCode?: string
  duration?: number       // ms
}

// ── Interface que todo provider deve implementar ──────────────
export interface IWhatsappProvider {
  name: Provider
  
  sendText(instanceId: string, to: string, text: string): Promise<ProviderSendResult>
  sendMedia(instanceId: string, to: string, mediaUrl: string, caption?: string, type?: MessageType): Promise<ProviderSendResult>
  /** Mensagem interativa com botões. Opcional — só providers que suportam (WuzAPI) implementam. */
  sendButtons?(instanceId: string, to: string, body: string, buttons: WhatsappButton[], footer?: string): Promise<ProviderSendResult>
  /** Localização (pin no mapa). Opcional — só WuzAPI implementa. */
  sendLocation?(instanceId: string, to: string, latitude: number, longitude: number, name?: string): Promise<ProviderSendResult>
  /** Cartão de contato (vCard). Opcional — só WuzAPI implementa. */
  sendContact?(instanceId: string, to: string, name: string, phone: string): Promise<ProviderSendResult>
  /** Enquete com opções de resposta. Opcional — só WuzAPI implementa. */
  sendPoll?(instanceId: string, to: string, question: string, options: string[]): Promise<ProviderSendResult>
  /** Reage (emoji) a uma mensagem já trocada na conversa. targetId vazio = remove a reação. Opcional — só WuzAPI. */
  sendReaction?(instanceId: string, to: string, targetMessageId: string, emoji: string): Promise<ProviderSendResult>
  /** Indicador de "digitando…"/"gravando áudio…". Ação, não gera Message. Opcional — só WuzAPI. */
  setPresence?(instanceId: string, to: string, state: ChatPresenceState): Promise<void>
  /** Marca mensagens recebidas como lidas (double-check azul). Opcional — só WuzAPI. */
  markRead?(instanceId: string, chatPhone: string, messageIds: string[]): Promise<void>
  /** Verifica se números têm WhatsApp ativo. Opcional — só WuzAPI. */
  checkNumber?(instanceId: string, phones: string[]): Promise<CheckNumberResult[]>
  getInstanceStatus(instanceId: string): Promise<InstanceStatus>
  createInstance(instanceId: string): Promise<{ instanceId: string; qrCode?: string }>
  /** Conecta/reconecta uma instância JÁ criada e retorna o QR atual. */
  connect(instanceId: string): Promise<{ qrCode?: string }>
  /** Busca o QR atual sem recriar a instância. */
  getQr(instanceId: string): Promise<{ qrCode?: string }>
  /** Registra a URL de webhook inbound no provider (no-op na Cloud API). */
  setWebhook(instanceId: string, url: string): Promise<void>
  deleteInstance(instanceId: string): Promise<void>
}

// ── Resultado do parse de um callback inbound de provider ─────
export interface InboundStatusUpdate {
  providerId: string                  // ID da mensagem no provider
  status?: MessageStatus              // novo status de entrega mapeado
  connectionState?: InstanceConnState // novo estado de conexão (connection/session events)
  qrCode?: string                     // QR atualizado (qrcode.updated)
  inboundMessage?: InboundMessage      // mensagem de entrada (texto/clique de botão) do cliente final
}

// ── Mensagem de entrada (cliente final respondendo) ───────────
// Hoje só usado pra repassar clique de botão (quickreply) ao tenant via
// webhook MESSAGE_RECEIVED — texto livre de entrada continua sem consumidor.
export interface InboundMessage {
  from: string               // telefone (com DDI) de quem respondeu
  buttonText?: string        // texto do botão clicado (selectedDisplayText), quando aplicável
  text?: string               // corpo em texto livre, quando não for clique de botão
  providerMessageId?: string
}

export type InstanceConnState = 'DISCONNECTED' | 'QR_PENDING' | 'CONNECTED' | 'BANNED'

export type InstanceStatus = 
  | 'connected' 
  | 'disconnected' 
  | 'qr_required' 
  | 'banned' 
  | 'unknown'

// ── Eventos de webhook ────────────────────────────────────────
export type WebhookEvent =
  | 'BAN_DETECTED'
  | 'NUMBER_ROTATED'
  | 'NUMBER_DISCONNECTED'
  | 'MESSAGE_FAILED'
  | 'MESSAGE_DELIVERED'
  | 'MESSAGE_RECEIVED'
  | 'PROVIDER_DOWN'

export interface WebhookPayload {
  event: WebhookEvent
  timestamp: string
  data: Record<string, unknown>
}

// ── Job payloads (BullMQ) ─────────────────────────────────────
export interface SendMessageJobData {
  messageId: string
  attempt: number
  provider: Provider
}

export interface CheckBanJobData {
  numberId: string
}

export interface ResetDailyCountersJobData {
  date: string
}
