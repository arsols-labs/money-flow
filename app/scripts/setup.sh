#!/usr/bin/env bash
# Stranger / self-host path. Not the reserved production preview deploy.
set -euo pipefail
cd "$(dirname "$0")/.."

MIN_NODE_MAJOR=20
NODE_INSTALL_URL='https://nodejs.org/'

print_node_help() {
  local found="${1:-none}"
  cat >&2 <<EOF
Node.js ${MIN_NODE_MAJOR}+ is required (found ${found}).
Setup cannot continue on this Node version.

Install or upgrade Node.js LTS (${MIN_NODE_MAJOR}+) from:
  ${NODE_INSTALL_URL}

Then open a new terminal, confirm \`node -v\`, and re-run from app/:
  npm run setup

EOF
}

if ! command -v node >/dev/null 2>&1; then
  print_node_help 'none — `node` is not on PATH'
  exit 1
fi

node_major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || true)"
if ! [[ "${node_major}" =~ ^[0-9]+$ ]] || [ "${node_major}" -lt "${MIN_NODE_MAJOR}" ]; then
  print_node_help "$(node -v 2>/dev/null || echo none)"
  exit 1
fi

exec node ./scripts/setup.mjs "$@"
