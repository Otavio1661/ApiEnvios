// src/services/inbound-status.service.ts
// Parse TOLERANTE dos callbacks inbound de cada provider.
// Cada provider tem um formato de payload diferente; extraímos o `providerId`
// (ID da mensagem no provider) e mapeamos o status de entrega para MessageStatus.
import type { Provider, MessageStatus, InboundStatusUpdate, InstanceConnState } from '../types'

// Ranking do funil de entrega — usado para garantir que o status só AVANÇA.
const STATUS_RANK: Record<string, number> = {
  QUEUED: 0,
  SENDING: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
}

// Retorna true se `next` é um avanço em relação a `current` no funil de entrega.
export function isStatusAdvance(current: MessageStatus, next: MessageStatus): boolean {
  const c = STATUS_RANK[current]
  const n = STATUS_RANK[next]
  // Se algum não estiver no funil (FAILED/CANCELLED/SCHEDULED), não sobrescreve.
  if (c === undefined || n === undefined) return false
  return n > c
}

// ── Evolution ─────────────────────────────────────────────────
// Eventos: messages.update / MESSAGES_UPDATE → status de entrega.
//          connection.update → connectionState. qrcode.updated → qrCode.
function mapEvolution(payload: any): InboundStatusUpdate | null {
  const event = String(payload?.event ?? payload?.type ?? '').toLowerCase()
  const data = payload?.data ?? payload

  // connection.update → estado de conexão
  if (event.includes('connection')) {
    const state = String(data?.state ?? data?.connection ?? '').toLowerCase()
    const connectionState = mapEvolutionConnState(state)
    return { providerId: '', connectionState }
  }

  // qrcode.updated → novo QR
  if (event.includes('qrcode')) {
    const qrCode = data?.qrcode?.base64 ?? data?.base64 ?? data?.qrcode
    return { providerId: '', qrCode: typeof qrCode === 'string' ? qrCode : undefined }
  }

  // messages.update (default) → status de entrega
  const providerId = data?.keyId ?? data?.key?.id ?? data?.id
  const rawStatus = String(data?.status ?? data?.update?.status ?? '').toUpperCase()
  const status = mapEvolutionAck(rawStatus)
  if (!providerId) return null
  return { providerId: String(providerId), status }
}

function mapEvolutionAck(raw: string): MessageStatus | undefined {
  switch (raw) {
    case 'DELIVERY_ACK':
      return 'DELIVERED'
    case 'READ':
    case 'PLAYED':
      return 'READ'
    case 'SERVER_ACK':
    case 'SENT':
      return 'SENT'
    default:
      return undefined
  }
}

function mapEvolutionConnState(state: string): InstanceConnState | undefined {
  switch (state) {
    case 'open':
      return 'CONNECTED'
    case 'close':
      return 'DISCONNECTED'
    case 'connecting':
      return 'QR_PENDING'
    default:
      return undefined
  }
}

// ── Cloud API ─────────────────────────────────────────────────
// Estrutura: entry[].changes[].value.statuses[] com { id, status: sent|delivered|read }.
function mapCloudApi(payload: any): InboundStatusUpdate | null {
  const statuses =
    payload?.entry?.[0]?.changes?.[0]?.value?.statuses ??
    payload?.statuses
  const st = Array.isArray(statuses) ? statuses[0] : undefined
  if (!st) return null
  const providerId = st?.id
  const status = mapCloudApiStatus(String(st?.status ?? '').toLowerCase())
  if (!providerId) return null
  return { providerId: String(providerId), status }
}

function mapCloudApiStatus(raw: string): MessageStatus | undefined {
  switch (raw) {
    case 'sent':
      return 'SENT'
    case 'delivered':
      return 'DELIVERED'
    case 'read':
      return 'READ'
    default:
      return undefined
  }
}

// ── WuzAPI ────────────────────────────────────────────────────
// PARTICULARIDADE (confirmado capturando webhook real + source wmiau.go): o WuzAPI
// entrega o webhook como form-urlencoded, não JSON. O corpo chega como
//   { instanceName, jsonData: '<string JSON do evento>', userID }
// e o evento de verdade está DENTRO de jsonData. Desembrulhamos aqui.
//
// Evento (jsonData): { type, ... }
//   - "QR"                       → qrCodeBase64 (data URI PNG) no topo do evento
//   - "Connected" / "PairSuccess"→ conexão estabelecida
//   - "Disconnected"/"LoggedOut" → desconectado
//   - "ReadReceipt"              → state ("Delivered"|"Read"|"ReadSelf") + event.MessageIDs[]
function mapWuzapi(payload: any): InboundStatusUpdate | null {
  // Desembrulha o wrapper form-encoded (jsonData string). Se já vier desembrulhado
  // (payload.type presente), usa direto — defensivo.
  let evt: any = payload
  if (typeof payload?.jsonData === 'string') {
    try {
      evt = JSON.parse(payload.jsonData)
    } catch {
      return null
    }
  }

  const type = String(evt?.type ?? '').toLowerCase()

  // Conexão / sessão
  if (type === 'connected' || type === 'pairsuccess') {
    return { providerId: '', connectionState: 'CONNECTED' }
  }
  if (type === 'disconnected' || type === 'loggedout') {
    return { providerId: '', connectionState: 'DISCONNECTED' }
  }

  // QR — já vem como data URI PNG
  if (type === 'qr') {
    const qr = evt?.qrCodeBase64
    return { providerId: '', qrCode: typeof qr === 'string' ? qr : undefined }
  }

  // Recibo de entrega/leitura
  if (type === 'readreceipt') {
    const status = mapWuzapiReceipt(String(evt?.state ?? ''))
    // MVP (Opção A): um ReadReceipt pode confirmar VÁRIAS mensagens (MessageIDs[]),
    // mas InboundStatusUpdate carrega um providerId só. Usamos o primeiro (a maioria
    // dos recibos é de 1 mensagem). Processar o array inteiro exigiria mudar o tipo
    // e as duas rotas inbound — fica como melhoria futura.
    const ids = evt?.event?.MessageIDs
    const providerId = Array.isArray(ids) ? ids[0] : undefined
    if (!providerId || !status) return null
    return { providerId: String(providerId), status }
  }

  // Message inbound (cliente respondendo, inclusive clique de botão).
  // ⚠️ NÃO VERIFICADO CONTRA PAYLOAD REAL — os caminhos abaixo seguem a
  // convenção whatsmeow/wuzapi (fonte wmiau.go: events.Message → Info.Sender +
  // Message.buttonsResponseMessage.{selectedButtonId,selectedDisplayText}),
  // mas até isso ser confirmado capturando um clique de verdade (ver runbook
  // de ativação), trate os nomes de campo como a MELHOR APOSTA, não um fato.
  if (type === 'message') {
    const from = String(
      evt?.event?.Info?.Sender ?? evt?.event?.info?.sender ?? evt?.Info?.Sender ?? '',
    ).split('@')[0]
    if (!from) return null

    const msg = evt?.event?.Message ?? evt?.event?.message ?? evt?.Message
    const btn = msg?.buttonsResponseMessage ?? msg?.buttonsResponseMessage
    const buttonText = btn?.selectedDisplayText ?? btn?.SelectedDisplayText
    const text = msg?.conversation ?? msg?.extendedTextMessage?.text

    const providerId = evt?.event?.Info?.ID ?? evt?.event?.info?.id ?? undefined

    return {
      providerId: '',
      inboundMessage: {
        from,
        buttonText: typeof buttonText === 'string' ? buttonText : undefined,
        text: typeof text === 'string' ? text : undefined,
        providerMessageId: typeof providerId === 'string' ? providerId : undefined,
      },
    }
  }

  // Presence, HistorySync, etc. → ignorado.
  return null
}

function mapWuzapiReceipt(state: string): MessageStatus | undefined {
  switch (state) {
    case 'Delivered':
      return 'DELIVERED'
    case 'Read':
    case 'ReadSelf':
      return 'READ'
    default:
      return undefined
  }
}

// ── Dispatcher ────────────────────────────────────────────────
// Recebe o provider (já normalizado para o enum) e o payload bruto; retorna o update
// parseado ou null se o payload não puder ser interpretado.
export function mapInboundStatus(provider: Provider, payload: any): InboundStatusUpdate | null {
  try {
    switch (provider) {
      case 'EVOLUTION':
        return mapEvolution(payload)
      case 'WUZAPI':
        return mapWuzapi(payload)
      case 'CLOUD_API':
        return mapCloudApi(payload)
      default:
        return null
    }
  } catch {
    return null
  }
}

// Normaliza o param :provider da rota (case-insensitive) para o enum Provider.
export function normalizeProvider(raw: string): Provider | null {
  switch (raw.toLowerCase()) {
    case 'evolution':
      return 'EVOLUTION'
    case 'wuzapi':
      return 'WUZAPI'
    case 'cloud_api':
    case 'cloudapi':
    case 'cloud-api':
      return 'CLOUD_API'
    default:
      return null
  }
}
