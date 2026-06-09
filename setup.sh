#!/usr/bin/env bash
#
# setup.sh — install, build, and link this local GitNexus checkout.
#
# Steps:
#   1. Install gitnexus-shared dependencies (provides the tsc the build invokes).
#   2. Install gitnexus (CLI/MCP) dependencies (runs the tree-sitter grammar postinstall).
#   3. Build gitnexus — scripts/build.js also builds and bundles gitnexus-web.
#   4. `npm link` the `gitnexus` binary so the command resolves to THIS checkout.
#
# Re-runnable: every step is idempotent. To undo the link: `npm unlink -g gitnexus`.
#
# Env:
#   GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1  Skip Dart/Proto/Swift grammar build (no C++ toolchain needed).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR"
SHARED_DIR="$ROOT/gitnexus-shared"
CLI_DIR="$ROOT/gitnexus"
WEB_DIR="$ROOT/gitnexus-web"

log() { printf '\033[1;34m[setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[setup]\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31m[setup] error:\033[0m %s\n' "$*" >&2
  exit 1
}

# ── Prerequisites ───────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "node not found. Install Node.js >= 22 (e.g. 'nvm install 22')."
command -v npm >/dev/null 2>&1 || die "npm not found. It ships with Node.js."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node $(node -v) is too old; gitnexus/ requires >= 22.0.0. Try 'nvm install 22'."

[ -d "$SHARED_DIR" ] || die "gitnexus-shared not found at $SHARED_DIR — run this from the monorepo root."
[ -d "$CLI_DIR" ] || die "gitnexus not found at $CLI_DIR — run this from the monorepo root."

VERSION="$(node -p "require('$CLI_DIR/package.json').version")"
log "Repo root : $ROOT"
log "Toolchain : node $(node -v), npm $(npm -v)"
log "GitNexus  : v$VERSION"

# ── 1. gitnexus-shared dependencies ─────────────────────────────────
log "Installing gitnexus-shared dependencies…"
(cd "$SHARED_DIR" && npm install)

# ── 2. gitnexus (CLI/MCP) dependencies ──────────────────────────────
if [ "${GITNEXUS_SKIP_OPTIONAL_GRAMMARS:-}" = "1" ]; then
  warn "GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1 — Dart/Proto/Swift grammars will not be built."
fi
log "Installing gitnexus dependencies…"
(cd "$CLI_DIR" && npm install)

# ── 3. Web UI dependencies (build.js bundles it into dist) ──────────
if [ -d "$WEB_DIR" ]; then
  log "Installing gitnexus-web dependencies…"
  (cd "$WEB_DIR" && npm install)
fi

# ── 4. Build CLI (+ web UI) ─────────────────────────────────────────
log "Building gitnexus…"
(cd "$CLI_DIR" && npm run build)

# ── 5. Link the binary onto PATH ────────────────────────────────────
log "Linking 'gitnexus' onto your PATH (npm link)…"
(cd "$CLI_DIR" && npm link)

# ── 6. Verify ───────────────────────────────────────────────────────
RESOLVED=""
if command -v gitnexus >/dev/null 2>&1; then
  LINK_PATH="$(command -v gitnexus)"
  RESOLVED="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$LINK_PATH" 2>/dev/null || echo "$LINK_PATH")"
fi

EXPECTED="$CLI_DIR/dist/cli/index.js"
if [ "$RESOLVED" = "$EXPECTED" ]; then
  log "Done. 'gitnexus' → $RESOLVED"
  log "Smoke test: $(gitnexus --version 2>/dev/null || echo 'gitnexus --version failed')"
else
  GLOBAL_BIN="$(npm prefix -g)/bin"
  warn "'gitnexus' is not resolving to this checkout (expected $EXPECTED)."
  if [ -z "$RESOLVED" ]; then
    warn "npm's global bin is not on your PATH. Add it to ~/.zshrc:"
    warn "    export PATH=\"$GLOBAL_BIN:\$PATH\""
    warn "then run: source ~/.zshrc"
  else
    warn "It currently resolves to: $RESOLVED"
    warn "Another gitnexus is shadowing it on PATH. Ensure $GLOBAL_BIN comes first."
  fi
  exit 1
fi
