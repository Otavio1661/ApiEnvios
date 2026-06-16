// src/types/index.ts
// Tipos globais do ApiEnvios

import type { ApiClient, Instance } from '@prisma/client'

// ── Augmentação do Fastify: contexto de autenticação ─────────
declare module 'fastify' {
  interface FastifyRequest {
    apiClient?: ApiClient
    instance?: Instance
  }
}

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

export type MessageType = 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'STICKER'

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
