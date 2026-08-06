#!/bin/bash
# Deploy blue/green — roda dentro de /home/r4server/prod/apienvios (chamado
# pelo job "deploy" do .gitlab-ci.yml, depois do checkout do commit certo).
#
# Nunca derruba o slot que já está servindo: builda a imagem nova, sobe só
# no slot INATIVO, espera ele responder saudável no /health, só DEPOIS troca
# o upstream do proxy (nginx -s reload, gracioso) e para o slot antigo. Se o
# slot novo nunca ficar saudável, o deploy falha e quem continua no ar é o
# antigo — sem susto. Workers de fila (BullMQ) rodam dentro do próprio
# processo do app — seguro ter os dois slots ativos por instantes durante o
# healthcheck, o BullMQ garante que cada job só é processado por um worker.
set -e

# CONTAINER_PREFIX vem do .env desta pasta (docker compose lê sozinho, mas
# este script roda fora do compose, então precisa ler explicitamente). Só
# essa variável, sem `source .env` inteiro — o .env tem valores com espaço
# (ex. ADMIN_SEED_NAME=Otavio Silva) que quebram quando o bash tenta
# executar o arquivo como script.
CONTAINER_PREFIX=$(grep -E '^CONTAINER_PREFIX=' .env | tail -1 | cut -d= -f2-)

PROXY="${CONTAINER_PREFIX:-apienvios}_proxy"

echo "==> Validando e recarregando config do proxy (nginx -s reload, sem recriar container)..."
docker exec "$PROXY" nginx -t
docker exec "$PROXY" nginx -s reload

ATUAL=$(docker exec "$PROXY" cat /etc/nginx/active/upstream.conf | grep -o 'app_[a-z]*' | head -1)
if [ "$ATUAL" = "app_blue" ]; then
    ALVO="app_green"
else
    ALVO="app_blue"
fi

echo "Slot ativo agora: $ATUAL — deploy vai pro slot: $ALVO"

echo "==> Buildando imagem nova..."
docker compose build app_blue

echo "==> Subindo $ALVO com a imagem nova..."
docker compose up -d --force-recreate --no-deps "$ALVO"

echo "==> Esperando $ALVO responder saudável em /health..."
TENTATIVAS=0
until docker exec "$PROXY" wget -qO- --timeout=2 "http://$ALVO:3002/health" > /dev/null 2>&1; do
    TENTATIVAS=$((TENTATIVAS + 1))
    if [ "$TENTATIVAS" -ge 60 ]; then
        echo "ERRO: $ALVO não ficou saudável em 60s. Abortando — $ATUAL continua servindo, nada foi trocado."
        exit 1
    fi
    sleep 1
done
echo "$ALVO saudável!"

echo "==> Trocando o proxy pra $ALVO (reload gracioso, sem derrubar conexão)..."
docker exec "$PROXY" sh -c "echo 'set \$upstream_app $ALVO:3002;' > /etc/nginx/active/upstream.conf"
docker exec "$PROXY" nginx -s reload

echo "==> Parando $ATUAL (fica pronto pro próximo deploy, sem gastar recurso à toa)..."
docker compose stop "$ATUAL"

echo "Deploy concluído. Servindo por: $ALVO"
