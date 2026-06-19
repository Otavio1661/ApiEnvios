# CONTEXT.md — ApiEnvios

> Documento de contexto do projeto. Serve para retomar o desenvolvimento em qualquer
> momento (com Claude ou outro assistente) sabendo exatamente o que já existe,
> como está estruturado e o que falta implementar.

---

## 1. O que é o projeto

Plataforma **multi-instância multi-tenant** de envio de WhatsApp, no modelo **UltraMsg**:
serve como ponte de terceiro **Sistemas → ApiEnvios → usuários**. Cada conta (tenant)
possui **instâncias dedicadas**, cada uma com seu **Status de autenticação, API URL,
ID da instância e Token**. Aplicações externas autenticam por **token de instância**;
o dono da conta gerencia tudo por uma **API key de conta**.

Suporta 3 providers (Evolution / WAHA / Cloud API). O **fallback automático entre
providers é OPT-IN por tenant** (`ApiClient.fallbackEnabled`) e ocorre apenas entre as
instâncias **do próprio tenant** (+ Cloud API como último recurso). Por padrão o envio é
**dedicado à instância informada**.

**Objetivo principal:** entregabilidade com isolamento por tenant e mitigação de ban
(espaçamento anti-ban serializado por instância, warm-up de números novos, rotação).

### Modelo de envio
```
Sistema Cliente → POST /v1/instance/:id/messages/chat (header Token)
        → ApiEnvios (fila BullMQ + worker + gate anti-ban)
        → provider da instância (Evolution | WAHA | Cloud API) → usuário
```
- Envio dedicado à instância do token (sem fallback por padrão).
- `fallbackEnabled=true` → tenta outras instâncias ATIVAS do mesmo tenant, depois Cloud API.
- Ban detectado → instância marcada `BANNED` + `connectionState=BANNED` + webhook + rotação.
- Status de entrega (DELIVERED/READ) volta do provider via webhook inbound e é repassado
  ao webhook do tenant (`MESSAGE_DELIVERED`).

---

## 2. Stack técnica

| Camada | Tecnologia | Motivo |
|--------|-----------|--------|
| Runtime | Node.js 20+ | LTS, compatível com Evolution |
| Linguagem | TypeScript | Tipagem, manutenibilidade |
| Framework HTTP | Fastify 4 | Mais performático que Express |
| ORM | Prisma 5 | Migrations, type-safe |
| Banco | PostgreSQL 16 | JSON, transações, escala |
| Cache/Filas | Redis 7 + BullMQ | Filas assíncronas em volume |
| Validação | Zod | Schema validation runtime |
| Logs | Pino | Performático, estruturado |
| Infra dev | Docker Compose | Sobe tudo localmente |

---

## 3. Estrutura de pastas

```
ApiEnvios/
├── src/
│   ├── config/index.ts              # Variáveis de ambiente centralizadas
│   ├── providers/                   # Um arquivo por provider
│   │   ├── evolution.provider.ts    # Provider principal
│   │   ├── waha.provider.ts         # Fallback grátis
│   │   └── cloudapi.provider.ts     # Fallback oficial
│   ├── services/
│   │   ├── provider-router.service.ts  # ⭐ Lógica de fallback + rotação
│   │   └── notification.service.ts     # Webhooks de ban
│   ├── routes/
│   │   ├── messages.route.ts        # POST/GET de mensagens
│   │   ├── numbers.route.ts         # CRUD de números
│   │   └── webhooks.route.ts        # Webhooks + healthcheck
│   ├── middlewares/auth.middleware.ts  # Auth por API key
│   ├── jobs/reset-counters.job.ts   # Reset diário de contadores
│   ├── utils/                       # prisma, redis, helpers
│   ├── types/index.ts               # Tipos globais + interface IWhatsappProvider
│   └── server.ts                    # Bootstrap Fastify
├── prisma/
│   ├── schema.prisma                # Modelos do banco
│   └── seed.ts                      # Dados iniciais (cliente dev + 2 números)
├── docker/Dockerfile.dev
├── docker-compose.yml               # Postgres, Redis, Evolution, WAHA, app
├── .env.example
└── README.md
```

---

## 4. Modelo de dados (PostgreSQL)

| Tabela | Função |
|--------|--------|
| `Instance` | Instância/número de um tenant: `apiClientId`, `token`, provider, `instanceId` (id no provider), `status`, `connectionState`, `qrCode`, contadores, ban tracking |
| `Message` | Mensagens (`apiClientId`, `instanceId`) com status de entrega, provider, retries |
| `MessageAttempt` | Histórico de cada tentativa (provider, erro, duração) |
| `NumberRotation` | Log de rotações (BAN, LIMIT_REACHED, MANUAL, SCHEDULED) — vinculado a `Instance` |
| `ApiClient` | Conta/tenant: `apiKey`, `role` (ADMIN\|CLIENT), `fallbackEnabled`, `rateLimit` |
| `Webhook` | URLs e eventos por tenant (`apiClientId` nulo = webhook global do admin) |

**Enums importantes:**
- `Provider`: EVOLUTION | WAHA | CLOUD_API
- `ClientRole`: ADMIN | CLIENT
- `NumberStatus`: ACTIVE | WARMING | BANNED | SUSPENDED | RETIRED  *(ciclo de vida da instância)*
- `InstanceConnState`: DISCONNECTED | QR_PENDING | CONNECTED | BANNED  *(estado de conexão)*
- `MessageStatus`: QUEUED | SENDING | SENT | DELIVERED | READ | FAILED | SCHEDULED | CANCELLED

---

## 5. ✅ O QUE JÁ FOI IMPLEMENTADO

> Evolução em fases (plano em `~/.claude/plans/claude-seguindo-o-plno-sharded-fairy.md`).
> Fases 0–5 concluídas, com `tsc` limpo e validação de runtime a cada fase. **Envio real
> confirmado** (status `SENT`) para um número via sessão WAHA conectada.

### Fase 0 — Migrations versionadas
- [x] `prisma/migrations/` versionado (removido do `.gitignore`); baseline `init` + `fase2_instances`

### Fase 1 — Multi-tenancy + token por instância (fundação)
- [x] `WhatsappNumber` renomeado para **`Instance`** (entidade central) com `apiClientId`, `token` único, `connectionState`, `qrCode/qrExpiresAt`, `name`, `phone` opcional
- [x] `ApiClient` com `role` (ADMIN|CLIENT) e `fallbackEnabled`; `Message`/`Webhook` com `apiClientId`
- [x] Auth em 3 guards: `authAccount` (API key de conta), `authInstance` (header `Token`), `requireAdmin`
- [x] **Escopo por tenant** em todas as queries (corrige vazamento entre tenants); idempotência `@@unique([apiClientId, externalId])`

### Fase 2 — Ciclo de vida de instância + QR (estilo UltraMsg)
- [x] `POST/GET /v1/instances`, `GET /:id`, `DELETE /:id`, `GET /:id/stats` (escopados; cada um retorna `apiUrl`)
- [x] `POST /:id/connect` (cria + connect/QR), `GET /:id/qr`, `GET /:id/status`
- [x] Envio por token: `POST /v1/instance/:id/messages/chat` e `/media`
- [x] Admin: `POST/GET /v1/admin/clients` (provisiona tenants)
- [x] `sendViaInstance` (envio dedicado, sem fallback)

### Fase 3 — Fila assíncrona BullMQ + jobs
- [x] Fila `send-message` + worker (retry/backoff exponencial via `maxRetries`); POSTs respondem `202 QUEUED`
- [x] Repeatable jobs: `reset-counters` (meia-noite) e `scheduled-messages` (a cada min)
- [x] `sendWithFallback` respeita `fallbackEnabled` (só instâncias do tenant + Cloud API)
- [x] Registry único de providers; providers ganharam `connect`/`getQr` (separados de `createInstance`)

### Fase 4 — Webhooks inbound de status
- [x] `POST /v1/webhooks/inbound/:provider/:instanceId` (sem auth; escopo via providerId + instância)
- [x] Mapeia callbacks Evolution/WAHA/Cloud → `Message.status` (só avança SENT→DELIVERED→READ)
- [x] `setWebhook` registrado no provider no connect; repassa `MESSAGE_DELIVERED` ao webhook do tenant
- [x] Webhooks do tenant escopados por `apiClientId`

### Fase 5 — Robustez multi-tenant
- [x] **Rate limit por tenant** (`@fastify/rate-limit` + store Redis; key=apiClient.id, max=rateLimit)
- [x] **Anti-ban serializado por instância** (lock Redis `lock:send:<id>` + espaçamento; `src/utils/rate-gate.ts`)
- [x] **Health check** de instâncias (job `instances-health` a cada 3min → `PROVIDER_DOWN`)
- [x] **Warm-up** dinâmico (`dailyLimitFor`) para instâncias WARMING
- [x] Logger **Pino** compartilhado (`src/utils/logger.ts`) substituindo `console.*`

### Compatibilidade
- [x] Rotas legadas `/v1/numbers*` mantidas (operam sobre `Instance`)

---

## 6. ⏳ O QUE FALTA IMPLEMENTAR (roadmap)

> Itens 1–9 do roadmap original concluídos nas Fases 0–5.

### 🟢 Prioridade BAIXA / próximos passos
- **Painel web** (estilo UltraMsg) e **JWT** para admin do painel
- **Testes automatizados** (Vitest — providers, router, rate-gate, inbound)
- **Suporte a templates** Cloud API (mensagens proativas)
- **Métricas Prometheus** (`/metrics`) + **Dockerfile de produção** (multi-stage)
- **Gestão de membros pela própria conta** (OWNER convida MEMBER) — sem signup público (decisão: provisionamento é exclusivo do admin da plataforma)

### Dívidas técnicas conhecidas (das revisões)
- Cache curto (Redis) na resolução de tenant para evitar query dupla por request
- Health check com paralelismo limitado; notificar também em `BANNED`
- (Opcional) secret/assinatura nos webhooks inbound para evitar spoofing
- Convergir `/v1/numbers*` → `/v1/instances*` e remover o legado

---

## 7. Como rodar (ambiente de dev)

```bash
# 1. Instalar dependências
npm install

# 2. Configurar ambiente
cp .env.example .env   # editar com suas chaves

# 3. Subir infra (sem a app — roda fora do Docker em dev)
docker compose up postgres redis evolution_api waha -d

# 4. Criar tabelas + popular
npx prisma migrate dev --name init
npm run db:seed

# 5. Rodar
npm run dev   # http://localhost:3000
```

Testar:
```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "x-api-key: dev-key-123456" \
  -H "Content-Type: application/json" \
  -d '{"to":"5544988880000","type":"TEXT","text":"Teste!"}'
```

---

## 8. Decisões de arquitetura já tomadas

- **Evolution API fixada na v2.3.7** — a v2.4.0+ exige ativação de licença online (phone-home).
  Manter ≤ 2.3.7 enquanto isso for um problema.
- **WAHA usa engine NOWEB** (baseada em Baileys) — mais leve que browser, sem Chromium.
- **PostgreSQL escolhido** sobre MySQL pelo melhor suporte a JSON e arrays (usado em `Webhook.events`).
- **Fastify** sobre Express por performance em alto volume.
- **Não empilhar os 3 providers como libs separadas** — Evolution já usa Baileys internamente;
  os 3 são acionados via REST como serviços independentes.

---

## 9. Riscos conhecidos / pontos de atenção

- ⚠️ **Banimento é o maior risco.** Toda solução não-oficial viola os ToS da Meta.
  Para envio proativo em alto volume, migrar o fluxo para a Cloud API oficial.
- ⚠️ **Evolution API tem issues de QR Code/pareamento** (issue #2437) na v2.3.7 — validar bem.
- ⚠️ **Baileys/WAHA têm relatos de erro 463** (restrição de conta) — monitorar.
- ⚠️ Persistir credenciais de sessão em banco/volume, nunca só em memória.
- ⚠️ Cloud API: mensagens proativas exigem **templates aprovados** pela Meta.

---

## 10. Prompt sugerido para retomar com Claude

> "Estou continuando o projeto ApiEnvios (contexto no CONTEXT.md em anexo).
> Já tenho a estrutura base, os 3 providers e o fallback funcionando.
> Quero implementar agora o item [X] do roadmap. Me ajude a montar isso
> seguindo os padrões já existentes no projeto."

Anexe este arquivo + o(s) arquivo(s) relevante(s) que vai modificar.
