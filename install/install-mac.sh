#!/usr/bin/env bash
# RetKit AI — one-command setup for macOS (also works on Linux).
#   curl -fsSL https://raw.githubusercontent.com/Brokenbass90/retkit-moeng/main/install/install-mac.sh | bash
#   ... | bash -s -- --codex        also install Codex
# Installs (only what is missing, no admin rights):
#   1. Claude Code (official installer)           → ~/.local/bin/claude
#   2. Node.js LTS, private copy for RetKit        → ~/.retkit/node
#   3. RetKit AI bridge                            → ~/.retkit/bridge
#   4. Autostart (LaunchAgent), then opens the Claude login if needed.
set -euo pipefail

REPO="${RETKIT_REPO:-Brokenbass90/retkit-moeng}"
REF="${RETKIT_REF:-main}"
HOME_DIR="${HOME}"
RK="${HOME_DIR}/.retkit"
WITH_CODEX=0
for arg in "$@"; do [ "$arg" = "--codex" ] && WITH_CODEX=1; done

say() { printf '\n\033[1;34m▸ %s\033[0m\n' "$1"; }
ok()  { printf '  \033[32m✓ %s\033[0m\n' "$1"; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$1"; exit 1; }

mkdir -p "$RK"
export PATH="$HOME_DIR/.local/bin:$RK/node/bin:$PATH"

# ── 1. Claude Code ───────────────────────────────────────────────────────────
say "Claude Code"
if command -v claude >/dev/null 2>&1; then
  ok "already installed: $(claude --version 2>/dev/null | head -1)"
else
  curl -fsSL https://claude.ai/install.sh | bash || die "Claude Code installer failed (see the message above)"
  command -v claude >/dev/null 2>&1 || die "claude is not on PATH after install — open a new Terminal and run this command again"
  ok "installed: $(claude --version 2>/dev/null | head -1)"
fi

# ── 2. Node.js for the bridge ────────────────────────────────────────────────
say "Node.js for the RetKit bridge"
NODE=""
if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0])>=20?0:1)' 2>/dev/null; then
  NODE="$(command -v node)"
  ok "using $(node -v) at $NODE"
else
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) PLAT="darwin-arm64" ;;
    Darwin-x86_64) PLAT="darwin-x64" ;;
    Linux-x86_64) PLAT="linux-x64" ;;
    Linux-aarch64|Linux-arm64) PLAT="linux-arm64" ;;
    *) die "unsupported system $(uname -s) $(uname -m)" ;;
  esac
  BASE="https://nodejs.org/dist/latest-v22.x"
  FILE="$(curl -fsSL "$BASE/SHASUMS256.txt" | awk -v p="$PLAT" '$2 ~ ("node-v[0-9.]+-" p "\\.tar\\.gz$") {print $2; exit}')"
  [ -n "$FILE" ] || die "could not find a Node.js download for $PLAT"
  SUM="$(curl -fsSL "$BASE/SHASUMS256.txt" | awk -v f="$FILE" '$2==f {print $1}')"
  TMP="$(mktemp -d)"
  curl -fsSL "$BASE/$FILE" -o "$TMP/node.tgz"
  if command -v shasum >/dev/null 2>&1; then GOT="$(shasum -a 256 "$TMP/node.tgz" | awk '{print $1}')"; else GOT="$(sha256sum "$TMP/node.tgz" | awk '{print $1}')"; fi
  [ "$GOT" = "$SUM" ] || die "Node.js download checksum mismatch"
  rm -rf "$RK/node" && mkdir -p "$RK/node"
  tar -xzf "$TMP/node.tgz" -C "$RK/node" --strip-components=1
  rm -rf "$TMP"
  NODE="$RK/node/bin/node"
  ok "installed private Node $("$NODE" -v) in $RK/node"
fi

# ── 3. Codex (optional) ──────────────────────────────────────────────────────
if [ "$WITH_CODEX" = "1" ]; then
  say "Codex"
  if command -v codex >/dev/null 2>&1; then
    ok "already installed"
  else
    NPM="$(dirname "$NODE")/npm"
    [ -x "$NPM" ] || NPM="npm"
    "$NPM" install -g --prefix "$RK/node" @openai/codex >/dev/null && ok "installed into $RK/node" || printf '  ! Codex install failed — Claude still works\n'
  fi
fi

# ── 4. RetKit bridge ─────────────────────────────────────────────────────────
say "RetKit AI bridge"
TMP="$(mktemp -d)"
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF" -o "$TMP/retkit.tgz" || die "could not download RetKit from GitHub"
tar -xzf "$TMP/retkit.tgz" -C "$TMP"
SRC="$(find "$TMP" -maxdepth 2 -type d -name bridge | head -1)"
[ -n "$SRC" ] || die "bridge folder not found in the download"
rm -rf "$RK/bridge" && cp -R "$SRC" "$RK/bridge"
rm -rf "$TMP"
ok "installed in $RK/bridge"

# ── 5. Autostart + start now ─────────────────────────────────────────────────
say "Autostart"
if [ "$(uname -s)" = "Darwin" ]; then
  "$NODE" "$RK/bridge/scripts/autostart.mjs" install
else
  printf '  Linux: start it with  %s %s\n' "$NODE" "$RK/bridge/src/index.mjs"
fi

# ── 6. Claude login ──────────────────────────────────────────────────────────
say "Claude login"
if claude auth status >/dev/null 2>&1; then
  ok "already logged in"
else
  printf '  A browser window opens for the Claude login. When it says "Login successful",\n  come back here and type /exit.\n\n'
  claude || true
fi
if [ "$WITH_CODEX" = "1" ] && command -v codex >/dev/null 2>&1; then
  codex login status >/dev/null 2>&1 || { say "Codex login"; codex login || true; }
fi

printf '\n\033[1;32m✓ RetKit AI is ready.\033[0m Go back to MoEngage → RetKit AI: it should show Claude as connected.\n'
