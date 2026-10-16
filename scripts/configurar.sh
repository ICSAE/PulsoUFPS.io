#!/usr/bin/env bash
# Configuración inicial (una sola vez) desde un GitHub Codespace.
# Inicia sesión en Google (clasp), genera el secreto del Worker y guarda los 5 secretos del repositorio.
set -euo pipefail
cd "$(dirname "$0")/.."

azul() { printf '\n\033[1;34m%s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✔ %s\033[0m\n' "$*"; }

[ -d node_modules ] || npm ci

azul "1/4  Cuenta de GitHub con permiso para guardar secretos"
if ! env -u GITHUB_TOKEN gh auth status >/dev/null 2>&1; then
  echo "Se abrirá un código para autorizar GitHub CLI (copia el código y ábrelo en el navegador)."
  env -u GITHUB_TOKEN gh auth login --hostname github.com --git-protocol https --web --scopes repo,workflow
fi
REPO=$(env -u GITHUB_TOKEN gh repo view --json nameWithOwner -q .nameWithOwner)
ok "Repositorio: $REPO"
secreto() { env -u GITHUB_TOKEN gh secret set "$1" --repo "$REPO" --body "$2" >/dev/null && ok "Secreto $1 guardado"; }

azul "2/4  Iniciar sesión en Google (la cuenta dueña de la hoja)"
echo "Antes: activa la API de Apps Script en https://script.google.com/home/usersettings"
echo "Abre el enlace que aparece, autoriza, y cuando el navegador muestre una página que NO carga"
echo "(localhost:8888…), copia la dirección COMPLETA de la barra y pégala aquí."
npx --no-install clasp login --no-localhost
secreto CLASPRC_JSON "$(cat "$HOME/.clasprc.json")"

azul "3/4  ID de la secuencia de comandos de la hoja"
echo "En la hoja: Extensiones → Apps Script → ⚙ Configuración del proyecto → ID de la secuencia de comandos"
read -rp "Pega el ID: " SCRIPT_ID
secreto SCRIPT_ID "$SCRIPT_ID"
if env -u GITHUB_TOKEN gh secret list --repo "$REPO" | grep -q '^WORKER_SECRETO'; then
  ok "WORKER_SECRETO ya existía (se conserva)"
else
  secreto WORKER_SECRETO "$(openssl rand -hex 32)"
fi

azul "4/4  Cloudflare"
echo "En https://dash.cloudflare.com → Workers & Pages (si es la primera vez, elige tu subdominio workers.dev)."
echo "Account ID: aparece en la página de inicio de Workers & Pages (columna derecha)."
echo "Token: Mi perfil → API Tokens → Create Token → plantilla 'Edit Cloudflare Workers'."
read -rp "Account ID: " CF_ACCOUNT
read -rsp "API Token (no se muestra): " CF_TOKEN; echo
secreto CLOUDFLARE_ACCOUNT_ID "$CF_ACCOUNT"
secreto CLOUDFLARE_API_TOKEN "$CF_TOKEN"

rm -f "$HOME/.clasprc.json"
azul "Listo. Lanzando el despliegue…"
env -u GITHUB_TOKEN gh workflow run desplegar.yml --repo "$REPO" && ok "Workflow 'Desplegar' iniciado"
echo "Míralo en: https://github.com/$REPO/actions"
echo "Al terminar, el resumen muestra la URL del Worker para pegarla en la hoja (Config)."
