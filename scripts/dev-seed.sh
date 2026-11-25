#!/usr/bin/env bash
# Crea (una sola vez) la empresa Artix + admin de desarrollo en la D1 LOCAL usando /provision.
# Las credenciales viven en .dev.vars (DEV_ADMIN_EMAIL / DEV_ADMIN_PASSWORD), que está en .gitignore.
set -euo pipefail
cd "$(dirname "$0")/.."
API=${API:-http://127.0.0.1:8797}
get() { grep -E "^$1=" .dev.vars | tail -1 | cut -d= -f2-; }
if [ -z "$(get DEV_ADMIN_PASSWORD)" ]; then
  echo "DEV_ADMIN_EMAIL=admin@artix.co" >> .dev.vars
  echo "DEV_ADMIN_PASSWORD=Kio$(openssl rand -hex 6)" >> .dev.vars
fi
EMAIL=$(get DEV_ADMIN_EMAIL); PASS=$(get DEV_ADMIN_PASSWORD); TOKEN=$(get PROVISION_TOKEN)
curl -s -X POST "$API/provision" -H "X-Provision-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"company\":{\"name\":\"Artix\",\"nit\":\"900000000-0\",\"city\":\"Bogotá\"},\"admin\":{\"name\":\"Administrador\",\"email\":\"$EMAIL\",\"password\":\"$PASS\"},\"demo\":true}" \
  | (command -v jq >/dev/null && jq -c . || cat)
echo "→ Usuario: $EMAIL  (contraseña en kio-sbs-bk/.dev.vars → DEV_ADMIN_PASSWORD)"
