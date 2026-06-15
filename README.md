# ApiEnvios

API de envio de mensagens WhatsApp com **fallback automático entre 3 providers** e rotação de números para minimizar banimentos.

## Arquitetura

```
Sistema Cliente
      │
      ▼
  ApiEnvios API  ──── PostgreSQL (dados)
      │           ──── Redis (filas/cache)
      │
   Fallback chain:
      │
      ├── 1️⃣  Evolution API  (principal, grátis)
      │
      ├── 2️⃣  WAHA           (fallback grátis)
      │
      └── 3️⃣  WhatsApp Cloud API  (fallback oficial/pago)
```

- Se o Provider 1 falhar ou o número for banido → tenta o Provider 2
- Se o Provider 2 também falhar → cai no Provider 3 (oficial)
- Ban detectado automaticamente → número marcado como BANNED + notificação webhook

---

## Pré-requisitos

- [Node.js 20+](https://nodejs.org/)
- [Docker + Docker Compose](https://docs.docker.com/compose/)
- Git

---

## Instalação e Setup (Desenvolvimento)

### 1. Clone e instale dependências

```bash
git clone https://github.com/seu-usuario/ApiEnvios.git
cd ApiEnvios
npm install
```

### 2. Configure as variáveis de ambiente

```bash
cp .env.example .env
```

Edite o `.env` — no mínimo configure:
```env
DATABASE_URL="postgresql://apienvios:senha123@localhost:5432/apienvios"
EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_KEY=evolution-key-dev-123
```

### 3. Suba o banco, Redis, Evolution API e WAHA

```bash
# Sobe APENAS a infraestrutura (sem a app — em dev, roda fora do Docker)
docker compose up postgres redis evolution_api waha -d
```

Aguarde ~30 segundos para os serviços inicializarem. Verifique:
```bash
docker compose ps
# Todos devem estar "healthy" ou "running"
```

### 4. Crie as tabelas no banco

```bash
npx prisma migrate dev --name init
npx prisma generate
```

### 5. Popule com dados iniciais

```bash
npm run db:seed
```

Isso cria um **ApiClient de dev** com a key `dev-key-123456` e 2 números de exemplo.

### 6. Inicie o servidor

```bash
npm run dev
```

O servidor sobe em `http://localhost:3000`.

---

## Endpoints

Todos os endpoints autenticados precisam do header:
```
x-api-key: dev-key-123456
```

### Healthcheck
```
GET /health
```

### Enviar mensagem
```bash
POST /v1/messages
Content-Type: application/json
x-api-key: dev-key-123456

{
  "to": "5544988880000",
  "type": "TEXT",
  "text": "Olá, mundo!"
}
```

Resposta:
```json
{
  "id": "clxxxxx",
  "status": "SENT",
  "provider": "EVOLUTION",
  "providerId": "BAE5..."
}
```

### Enviar imagem
```json
{
  "to": "5544988880000",
  "type": "IMAGE",
  "mediaUrl": "https://exemplo.com/imagem.jpg",
  "caption": "Confira nossa oferta!"
}
```

### Envio agendado
```json
{
  "to": "5544988880000",
  "type": "TEXT",
  "text": "Lembrete: sua consulta é amanhã!",
  "scheduledAt": "2025-01-15T09:00:00-03:00"
}
```

### Ver status de mensagem
```
GET /v1/messages/:id
```

### Listar mensagens
```
GET /v1/messages?status=FAILED&page=1&limit=20
```

### Gerenciar números
```bash
# Listar
GET /v1/numbers

# Cadastrar novo número
POST /v1/numbers
{ "phone": "5544999990003", "provider": "EVOLUTION", "instanceId": "instancia-02", "priority": 0 }

# Ver estatísticas
GET /v1/numbers/stats

# Rotacionar número manualmente
POST /v1/numbers/:id/rotate

# Mudar status
PATCH /v1/numbers/:id/status
{ "status": "SUSPENDED" }
```

### Webhooks de notificação
```bash
# Cadastrar webhook para ser notificado de bans
POST /v1/webhooks
{
  "url": "https://meu-sistema.com/webhooks/whatsapp",
  "events": ["BAN_DETECTED", "MESSAGE_FAILED", "NUMBER_ROTATED"]
}
```

Payload enviado ao seu webhook:
```json
{
  "event": "BAN_DETECTED",
  "timestamp": "2025-01-15T14:30:00.000Z",
  "data": {
    "phone": "5544999990001",
    "provider": "EVOLUTION",
    "reason": "Stream Errored (515)",
    "bannedAt": "2025-01-15T14:30:00.000Z"
  }
}
```

---

## Estrutura do Projeto

```
ApiEnvios/
├── src/
│   ├── config/          # Variáveis de ambiente centralizadas
│   ├── providers/       # Implementação de cada provider
│   │   ├── evolution.provider.ts
│   │   ├── waha.provider.ts
│   │   └── cloudapi.provider.ts
│   ├── services/        # Lógica de negócio
│   │   ├── provider-router.service.ts  # Fallback automático
│   │   └── notification.service.ts     # Alertas de ban
│   ├── routes/          # Endpoints da API
│   ├── middlewares/     # Auth, rate limit
│   ├── jobs/            # Tarefas agendadas
│   ├── utils/           # Prisma, Redis, helpers
│   └── types/           # Tipos TypeScript
├── prisma/
│   ├── schema.prisma    # Modelos do banco
│   └── seed.ts          # Dados iniciais
├── docker/
│   └── Dockerfile.dev
├── docker-compose.yml   # Infra completa
└── .env.example
```

---

## Banco de Dados

**PostgreSQL** via Prisma ORM. Tabelas principais:

| Tabela | Descrição |
|--------|-----------|
| `WhatsappNumber` | Números cadastrados com status, provider e contadores diários |
| `Message` | Todas as mensagens com status de entrega |
| `MessageAttempt` | Histórico de cada tentativa (qual provider, erro, duração) |
| `NumberRotation` | Log de rotações de número (ban, limite, manual) |
| `ApiClient` | Clientes que consomem a API (multi-tenant) |
| `Webhook` | URLs para notificações de eventos |

### Visualizar banco
```bash
npm run db:studio
# Abre o Prisma Studio em http://localhost:5555
```

---

## Anti-ban: Configurações importantes

No `.env`:
```env
# Delay entre mensagens (ms) — varie para parecer humano
SEND_DELAY_MIN=2000
SEND_DELAY_MAX=5000

# Limite diário por número antes de rotacionar automaticamente
MAX_MESSAGES_PER_NUMBER_DAY=200
```

Boas práticas:
- Registre apenas números que já conversaram com o destinatário antes
- Faça warm-up: comece com poucos envios e aumente gradualmente
- Use o status `WARMING` para números novos
- Monitore o webhook `BAN_DETECTED` e troque o número imediatamente

---

## Próximos passos

- [ ] Fila BullMQ para envio assíncrono em volume
- [ ] Cron para reset diário de contadores (meia-noite)
- [ ] Endpoint para conectar instância via QR Code
- [ ] Dashboard de monitoramento
- [ ] Rate limiting por ApiClient
- [ ] Autenticação JWT para admin
