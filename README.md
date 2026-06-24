# ApiEnvios

Plataforma **multi-tenant** de envio de mensagens WhatsApp no modelo UltraMsg
(Sistemas → ApiEnvios → usuários), com **pool de números por instância**, **fallback
opt-in entre 3 providers**, mitigação de ban, painel web e API REST.

## Arquitetura

```
Conta (ApiClient / tenant)
  ├── Usuários (OWNER / MEMBER)         ── login JWT (painel/API)
  └── Instâncias                        ── 1 "instância" = um POOL de números
        └── Números (InstanceNumber)    ── cada número = 1 sessão real de provider
              ├── 1️⃣ Evolution API   (principal)
              ├── 2️⃣ WAHA            (fallback grátis)        ← opt-in por conta
              └── 3️⃣ WhatsApp Cloud  (fallback oficial/pago)
```

Você envia para a **instância** e o roteador escolhe automaticamente o melhor número
**CONNECTED** (rodízio anti-ban). Ban detectado → número marcado `BANNED` + webhook.

Stack: Node 20 · TypeScript · Fastify 4 · Prisma 5 (PostgreSQL 16) · Redis 7 + BullMQ ·
Zod · Pino · Eta + Alpine.js (painel) · Vitest · Docker Compose.

---

## Papéis e acesso

Há três formas de autenticar e três papéis humanos:

| Autenticação | Header | Para quê |
|---|---|---|
| **Token de instância** | `Token: <token>` | Apps cliente enviando por uma instância específica |
| **API key da conta** | `x-api-key: <chave>` | Gestão/multi-instância (escolhe a instância no corpo) |
| **JWT (login humano)** | `Authorization: Bearer <jwt>` ou cookie no painel | Pessoas (painel/API), com papel |

**Matriz de permissões (papel humano):**

| Recurso | MEMBER | OWNER (dono da conta) | Super admin |
|---|:---:|:---:|:---:|
| Enviar / campanhas / status | ✅ (suas instâncias) | ✅ (conta) | ✅ (global) |
| Ver instâncias | só as **dele** (`ownerUserId`) | todas da conta | todas |
| Métricas (`/v1/metrics`) | das instâncias dele | da conta | da conta |
| Criar/editar/excluir instância | suas | da conta | qualquer |
| Atribuir dono de instância | ❌ | ✅ | ✅ |
| Gerenciar membros (`/v1/account/users`) | ❌ | ✅ (só MEMBER) | ✅ |
| Webhooks da conta | — | ✅ | ✅ |
| Admin: contas/usuários/instâncias globais (`/v1/admin/*`) | ❌ | ❌ | ✅ |
| Provider WAHA (teste) | ❌ | ❌ | ✅ |

> A doc **dentro do painel** (`/admin/docs`) já mostra só as seções do papel logado.

---

## Setup (desenvolvimento)

```bash
git clone git@github.com:Otavio1661/ApiEnvios.git && cd ApiEnvios
npm install
cp .env.example .env          # configure DATABASE_URL, REDIS_*, EVOLUTION_*, JWT_SECRET, API_SECRET

# Infra (Postgres, Redis, Evolution, WAHA)
docker compose up -d postgres redis evolution_api waha

npx prisma migrate deploy && npx prisma generate
npm run db:seed               # cria o ApiClient ADMIN inicial (ver ADMIN_SEED_* no .env)
npm run dev                   # sobe a API + painel
```

Em Docker, a API/painel sobem em **`http://localhost:3002`** (painel em `/admin`).

---

## Painel web (`/admin`)

Login JWT (cookie httpOnly). Telas por papel:
- **Instâncias** (dashboard) — status **derivado do pool** + apagar instância.
- **Docs** — referência da API, já filtrada pelo papel.
- **Time** (OWNER) — cria/edita/remove membros + atribui dono de instância.
- **Gestão** (super admin) — contas (teto anti-flood, quota, ativar/desativar, apagar cascata), usuários e instâncias globais.

---

## Endpoints (resumo)

### Envio (token de instância ou API key)
```
POST /v1/instance/:id/messages/chat     { to, body }
POST /v1/instance/:id/messages/media    { to, type, mediaUrl, caption }
POST /v1/messages                       { to, type, text|mediaUrl, instanceId?, scheduledAt? }
POST /v1/campaigns                      { to:[...], text|mediaUrl, instanceId?, externalIdPrefix? }
GET  /v1/messages/:id                   status da mensagem
GET  /v1/messages?status=&page=&limit=  histórico
```

### Instâncias e números (API key / JWT, escopo por papel)
```
GET/POST/PATCH/DELETE /v1/instances[/:id]
PATCH  /v1/instances/:id/owner          (OWNER) atribui dono
POST   /v1/instances/:id/connect | GET .../qr | .../status
.../numbers ...                         pool de números
GET    /v1/instances/:id  →  inclui `connection` (status real derivado do pool)
```

### Métricas, webhooks, conta
```
GET    /v1/metrics?days=30              totais/série/por instância/por número
POST   /v1/webhooks                     { url, events[], secret? }   (assinatura HMAC)
GET/POST/PATCH/DELETE /v1/account/users (OWNER) gerencia MEMBERs da própria conta
```

### Admin (super admin)
```
GET/POST/PATCH/DELETE /v1/admin/clients[/:id]    contas (DELETE = cascata)
POST/PATCH/DELETE      /v1/admin/users[/:id]      usuários de qualquer conta
GET/DELETE             /v1/admin/instances[/:id]  instâncias globais (DELETE = cascata)
```

### Health
```
GET /health   → { status, version, uptimeSec, checks:{database,redis} }   (200/503)
```

---

## Webhooks (eventos + HMAC)

Eventos: `BAN_DETECTED`, `NUMBER_DISCONNECTED`, `NUMBER_ROTATED`, `MESSAGE_FAILED`,
`MESSAGE_DELIVERED`, `PROVIDER_DOWN`.

Entrega assíncrona com **retry/backoff** (BullMQ) e **DLQ** (jobs esgotados ficam no
conjunto `failed`). Com `secret`, cada POST leva:
```
X-ApiEnvios-Event:     <evento>
X-ApiEnvios-Timestamp: <epoch ms>
X-ApiEnvios-Signature: sha256=<HMAC-SHA256 de "<timestamp>.<body>">
```
Valide recomputando o HMAC com o seu segredo sobre `${timestamp}.${rawBody}`.

---

## Anti-ban e anti-flood

- **Espaçamento anti-ban** por instância (lock + atraso aleatório no Redis).
- **Teto por destinatário/hora** por conta (`ApiClient.maxPerRecipientPerHour`, `0` = ilimitado)
  → estouro responde `429 Retry-After`, sem enfileirar.
- Warm-up de números novos, rotação automática em ban, limite diário por número.

`.env`: `SEND_DELAY_MIN`, `SEND_DELAY_MAX`, `MAX_MESSAGES_PER_NUMBER_DAY`.

---

## Banco de dados (Prisma / PostgreSQL)

| Tabela | Descrição |
|--------|-----------|
| `ApiClient` | Conta (tenant): apiKey, role, rateLimit, maxInstances, **maxPerRecipientPerHour** |
| `User` | Usuário humano (OWNER / MEMBER / SUPER_ADMIN), login JWT |
| `Instance` | Pool de números; `token`, `ownerUserId` (dono), `connectionState` (legado) |
| `InstanceNumber` | Número/sessão real de provider sob a instância (fonte de verdade do envio) |
| `Message` / `MessageAttempt` | Mensagens e histórico de tentativas/fallback |
| `NumberRotation` | Log de rotações (ban/limite/manual) |
| `Webhook` | URLs + eventos + `secret` (HMAC) |

`npm run db:studio` abre o Prisma Studio.

---

## Testes

```bash
npm test          # vitest (unit + integração)
npx tsc --noEmit  # type-check
```
