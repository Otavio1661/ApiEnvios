// src/types/index.ts
// Tipos globais do ApiEnvios

export type Provider = 'EVOLUTION' | 'WAHA' | 'CLOUD_API'

export type MessageStatus = 
  | 'QUEUED' 
  | 'SENDING' 
  | 'SENT' 
  | 'DELIVERED' 
  | 'READ' 
  | 'FAILED'
  | 'SCHEDULED'
  | 'CANCELLED'

export type MessageType = 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT'

export type NumberStatus = 'ACTIVE' | 'WARMING' | 'BANNED' | 'SUSPENDED' | 'RETIRED'

// ── Payload de envio recebido pelos clientes ──────────────────
export interface SendMessagePayload {
  to: string              // número destino com DDI: "5544999990000"
  type: MessageType
  text?: string           // para tipo TEXT
  mediaUrl?: string       // para IMAGE, VIDEO, AUDIO, DOCUMENT
  caption?: string        // legenda para mídia
  externalId?: string     // ID do sistema cliente para idempotência
  scheduledAt?: string    // ISO 8601 para agendamento
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
  getInstanceStatus(instanceId: string): Promise<InstanceStatus>
  createInstance(instanceId: string): Promise<{ instanceId: string; qrCode?: string }>
  deleteInstance(instanceId: string): Promise<void>
}

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
  | 'MESSAGE_FAILED'
  | 'MESSAGE_DELIVERED'
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
