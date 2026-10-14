#!/bin/bash
# Deploy daozang-mcp Worker to Cloudflare.
#
# Deployment is a direct `wrangler deploy` upload from this directory —
# it does NOT go through GitHub. See DEPLOY.md.
#
# Required environment:
#   CLOUDFLARE_API_TOKEN   API token with Workers/KV/DO write permission
#   CLOUDFLARE_ACCOUNT_ID  your account id (32 hex chars)
set -euo pipefail
cd "$(dirname "$0")"

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"

# Optional: route outbound traffic through an HTTP proxy ("" = direct).
if [ -n "${CF_PROXY:-}" ]; then
  export HTTP_PROXY="$CF_PROXY" HTTPS_PROXY="$CF_PROXY"
  export http_proxy="$CF_PROXY" https_proxy="$CF_PROXY"
fi

export WRANGLER_SEND_METRICS=false

npx wrangler deploy
