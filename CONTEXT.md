# CONTEXT.md — ApiEnvios

> Documento de contexto do projeto. Serve para retomar o desenvolvimento em qualquer
> momento (com Claude ou outro assistente) sabendo exatamente o que já existe,
> como está estruturado e o que falta implementar.

---

## 1. O que é o projeto

API de envio de mensagens WhatsApp com **fallback automático entre 3 providers** e
**rotação de números** para minimizar banimentos. A API serve como camada única para
vários sistemas clientes enviarem notificações via WhatsApp.

**Objetivo principal:** maximizar entregabilidade gratuita, caindo para a API oficial
(paga) só quando as opções gratuitas falham.

### Cadeia de fallback
```
Sistema Cliente → ApiEnvios
                      │
   1️⃣ Evolution API   (principal, grátis)
   2️⃣ WAHA            (fallback grátis)
   3️⃣ WhatsApp Cloud API (fallback oficial/pago)
```
- Provider 1 falha ou número banido → tenta Provider 2
- Provider 2 falha → cai no Provider 3 (oficial)
- Ban detectado → número marcado `BANNED` + notificação via webhook + rotação automática

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
| `WhatsappNumber` | Números com status, provider, contadores diários, ban tracking |
| `Message` | Mensagens com status de entrega, provider usado, retries |
| `MessageAttempt` | Histórico de cada tentativa (provider, erro, duração) |
| `NumberRotation` | Log de rotações (BAN, LIMIT_REACHED, MANUAL, SCHEDULED) |
| `ApiClient` | Clientes consumidores da API (multi-tenant via API key) |
| `Webhook` | URLs e eventos para notificação |

**Enums importantes:**
- `Provider`: EVOLUTION | WAHA | CLOUD_API
- `NumberStatus`: ACTIVE | WARMING | BANNED | SUSPENDED | RETIRED
- `MessageStatus`: QUEUED | SENDING | SENT | DELIVERED | READ | FAILED | SCHEDULED | CANCELLED

---

## 5. ✅ O QUE JÁ FOI IMPLEMENTADO

### Infraestrutura
- [x] Estrutura completa de pastas e config TypeScript
- [x] `docker-compose.yml` com Postgres, Redis, Evolution API (v2.3.7), WAHA
- [x] Schema Prisma completo com todas as tabelas e relações
- [x] Seed com cliente de dev (`dev-key-123456`) e 2 números de exemplo
- [x] Config centralizada lendo do `.env`

### Providers
- [x] `EvolutionProvider` — sendText, sendMedia, status, create/delete instance, detecção de ban
- [x] `WahaProvider` — sendText, sendMedia, status, create/delete session
- [x] `CloudApiProvider` — sendText, sendMedia (Graph API v20.0)
- [x] Interface comum `IWhatsappProvider` que todos implementam

### Lógica de negócio
- [x] **Fallback automático** entre os 3 providers (`provider-router.service.ts`)
- [x] **Detecção de ban** por análise de erro
- [x] **Marcação automática** de número banido + log de rotação
- [x] **Delay anti-ban** aleatório entre envios (configurável)
- [x] **Seleção de número** por prioridade + menor uso diário
- [x] **Notificação de ban** via webhook (`notification.service.ts`)

### API REST
- [x] `POST /v1/messages` — envio (texto, mídia, agendado) com idempotência via externalId
- [x] `GET /v1/messages/:id` — status de mensagem
- [x] `GET /v1/messages` — listagem com filtros e paginação
- [x] `GET /v1/numbers` — lista números
- [x] `POST /v1/numbers` — cadastra número
- [x] `PATCH /v1/numbers/:id/status` — muda status
- [x] `POST /v1/numbers/:id/rotate` — rotaciona manualmente
- [x] `GET /v1/numbers/stats` — dashboard rápido
- [x] `POST/GET/DELETE /v1/webhooks` — gestão de webhooks
- [x] `GET /health` — healthcheck
- [x] Middleware de auth por API key

---

## 6. ⏳ O QUE FALTA IMPLEMENTAR (roadmap priorizado)

### 🔴 Prioridade ALTA (necessário para funcionar de verdade)

1. **Conexão de instâncias via QR Code**
   - Endpoint `POST /v1/numbers/:id/connect` que cria a instância no provider e retorna o QR
   - Endpoint `GET /v1/numbers/:id/qr` para buscar/atualizar o QR
   - Endpoint `GET /v1/numbers/:id/connection-status` para checar se conectou
   - *Sem isso os números não enviam — é o gargalo #1*

2. **Fila assíncrona com BullMQ**
   - Mover o envio do request síncrono para uma fila (`send-message` queue)
   - Worker que consome a fila e chama `sendWithFallback`
   - Retry com backoff exponencial usando a config de `maxRetries`
   - *Essencial para volume — hoje o envio trava o request HTTP*

3. **Webhook de status dos providers (inbound)**
   - Receber callbacks da Evolution/WAHA sobre entrega/leitura
   - Atualizar `Message.status` para DELIVERED/READ
   - Endpoint `POST /v1/webhooks/inbound/:provider`

4. **Migrations versionadas no git**
   - Hoje o `.gitignore` ignora `prisma/migrations/` — reconsiderar para produção
   - Gerar a migration inicial e versioná-la

### 🟡 Prioridade MÉDIA

5. **Job agendado de reset de contadores**
   - Hoje `resetDailyCounters` só roda no boot em dev
   - Criar cron real (BullMQ repeatable job) à meia-noite

6. **Processamento de mensagens agendadas**
   - Job que varre `Message` com status SCHEDULED e `scheduledAt <= now`
   - Enfileira para envio

7. **Rate limiting por ApiClient**
   - Usar `@fastify/rate-limit` com o `rateLimit` de cada cliente
   - Hoje o campo existe no banco mas não é aplicado

8. **Health check dos providers**
   - Job periódico que checa status de cada número/instância
   - Marca como desconectado e dispara `PROVIDER_DOWN`

9. **Warm-up automático de números novos**
   - Lógica que aumenta gradualmente o limite de números em status WARMING

### 🟢 Prioridade BAIXA (melhorias)

10. **Dashboard de monitoramento** (web simples ou Grafana)
11. **Autenticação JWT para painel admin** (separado da API key dos clientes)
12. **Testes automatizados** (Vitest — unitários nos providers e router)
13. **Suporte a templates** (Cloud API exige templates aprovados para mensagens proativas)
14. **Métricas Prometheus** (`/metrics`)
15. **Dockerfile de produção** (multi-stage build)

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
