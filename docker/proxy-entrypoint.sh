#!/bin/sh
set -e

# /etc/nginx/active é um volume nomeado (sobrevive a recriação do próprio
# proxy) — só semeia o default na primeira vez que o volume existir vazio.
# Depois disso, quem decide o slot ativo é o job de deploy (escreve aqui e
# manda `nginx -s reload`), nunca este entrypoint de novo.
mkdir -p /etc/nginx/active
if [ ! -f /etc/nginx/active/upstream.conf ]; then
    echo 'set $upstream_app app_blue:3002;' > /etc/nginx/active/upstream.conf
fi

exec nginx -g "daemon off;"
