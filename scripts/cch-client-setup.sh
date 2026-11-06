#!/usr/bin/env bash
# Configure Codex CLI and/or omp to use a Claude Code Hub (CCH) gateway.
#
# Usage:
#   CCH_HOST=https://cch.example.com bash cch-client-setup.sh [codex|omp|both]
#   curl -fsSL <url>/cch-client-setup.sh | CCH_HOST=https://cch.example.com bash -s -- codex
#
# Environment:
#   CCH_HOST            required. Gateway origin, e.g. https://cch.example.com (a trailing /v1 is ok)
#   CCH_CLIENT          optional. codex | omp | both (same as the first argument)
#   CCH_PROVIDER_NAME   optional. Provider id prefix written to the configs (default: cch)
#   CCH_MODEL           optional. Codex default model slug (default: the gateway's first listed model)
#   CODEX_HOME          optional. Codex config dir (default: ~/.codex)
#   PI_CODING_AGENT_DIR optional. omp agent dir (default: ~/.omp/agent)
#
# The API key is always typed in (hidden). It is never read from arguments or the environment,
# so it does not end up in shell history. Existing configs are backed up before they change.

set -euo pipefail

PROVIDER="${CCH_PROVIDER_NAME:-cch}"
BEGIN_MARK="# >>> cch-client-setup ${PROVIDER} >>>"
END_MARK="# <<< cch-client-setup ${PROVIDER} <<<"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*" >&2; }

# ---------------------------------------------------------------- input

TTY=""
if { exec 3</dev/tty; } 2>/dev/null; then
  TTY=/dev/tty
  exec 3<&-
fi

ask() { # ask <prompt> -> stdin line, from the terminal when there is one
  local prompt="$1" answer=""
  if [ -n "$TTY" ]; then
    printf '%s' "$prompt" >/dev/tty
    IFS= read -r answer </dev/tty || true
  else
    IFS= read -r answer || true
  fi
  printf '%s' "$answer"
}

ask_secret() { # ask_secret <prompt> -> hidden line
  local prompt="$1" answer=""
  if [ -n "$TTY" ]; then
    printf '%s' "$prompt" >/dev/tty
    IFS= read -r -s answer </dev/tty || true
    printf '\n' >/dev/tty
  else
    IFS= read -r answer || true
  fi
  printf '%s' "$answer"
}

# ---------------------------------------------------------------- host

normalize_host() {
  local h="$1"
  h="${h#"${h%%[![:space:]]*}"}"
  h="${h%"${h##*[![:space:]]}"}"
  case "$h" in
    http://* | https://*) ;;
    "") return 1 ;;
    *) h="https://$h" ;;
  esac
  while [ "${h%/}" != "$h" ]; do h="${h%/}"; done
  h="${h%/v1}"
  while [ "${h%/}" != "$h" ]; do h="${h%/}"; done
  printf '%s' "$h"
}

[ -n "${CCH_HOST:-}" ] || die "set CCH_HOST to your gateway, e.g. CCH_HOST=https://cch.example.com"
HOST="$(normalize_host "$CCH_HOST")" || die "CCH_HOST is empty"
command -v curl >/dev/null 2>&1 || die "curl is required"

# ---------------------------------------------------------------- client choice

CLIENT="${1:-${CCH_CLIENT:-}}"
if [ -z "$CLIENT" ]; then
  [ -n "$TTY" ] || die "pass codex, omp or both as the first argument"
  CLIENT="$(ask "Configure which client? [codex/omp/both] (both): ")"
  CLIENT="${CLIENT:-both}"
fi
case "$CLIENT" in
  codex | omp | both) ;;
  *) die "unknown client '$CLIENT' (expected codex, omp or both)" ;;
esac

# ---------------------------------------------------------------- key check

# The gateway hides providers whose client rules reject the caller, so discovery requests are
# sent with the target client's own User-Agent: the script then sees exactly what that client
# will see. Versions come from the installed client when there is one.
client_version() { # client_version <command> -> x.y.z or 0.0.0
  local v=""
  if command -v "$1" >/dev/null 2>&1; then
    v="$("$1" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  fi
  printf '%s' "${v:-0.0.0}"
}
CODEX_VERSION="$(client_version codex)"
OMP_VERSION="$(client_version omp)"
CODEX_UA="codex_cli_rs/$CODEX_VERSION"
OMP_UA="omp/$OMP_VERSION"

HTTP_BODY=""
HTTP_STATUS=""
fetch() { # fetch <path> <key> <user-agent>: sets HTTP_STATUS and HTTP_BODY
  local out
  out="$(curl -sS --max-time 20 -w '\n%{http_code}' \
    -H "Authorization: Bearer $2" -H "User-Agent: $3" \
    "$HOST$1" 2>/dev/null)" || out=$'\n000'
  HTTP_STATUS="${out##*$'\n'}"
  HTTP_BODY="${out%$'\n'*}"
}

count_fields() { # count_fields <json> <field>
  { printf '%s' "$1" | grep -o "\"$2\"[[:space:]]*:" || true; } | wc -l | tr -d ' '
}

KEY=""
for attempt in 1 2 3; do
  KEY="$(ask_secret "CCH API key for $HOST: ")"
  [ -n "$KEY" ] || { info "The key is empty."; continue; }
  case "$KEY" in
    *[[:space:]]* | *\"* | *\\*) info "The key contains spaces, quotes or backslashes."; KEY=""; continue ;;
  esac
  fetch "/codex/models?client_version=$CODEX_VERSION" "$KEY" "$CODEX_UA"
  case "$HTTP_STATUS" in
    200) break ;;
    401 | 403) info "The gateway rejected this key (HTTP $HTTP_STATUS)." ;;
    000) die "cannot reach $HOST" ;;
    *) die "unexpected HTTP $HTTP_STATUS from $HOST/codex/models" ;;
  esac
  KEY=""
done
[ -n "$KEY" ] || die "no valid API key after 3 attempts"
CODEX_CATALOG="$HTTP_BODY"

backup() { # backup <file>
  if [ -f "$1" ]; then
    local dest
    dest="$1.bak.$(date +%Y%m%d%H%M%S)"
    cp -p "$1" "$dest"
    info "  backup: $dest"
  fi
}

# ---------------------------------------------------------------- codex

configure_codex() {
  local dir="${CODEX_HOME:-$HOME/.codex}" file tmp count
  file="$dir/config.toml"
  count="$(count_fields "$CODEX_CATALOG" slug)"
  [ "$count" -gt 0 ] || info "warning: the gateway lists no Codex (Responses API) models for this key"

  mkdir -p "$dir"
  backup "$file"
  tmp="$(mktemp "$dir/.config.toml.XXXXXX")"
  {
    printf '%s\n' "$BEGIN_MARK"
    printf 'model_provider = "%s"\n' "$PROVIDER"
    if [ -n "${CCH_MODEL:-}" ]; then printf 'model = "%s"\n' "$CCH_MODEL"; fi
    printf '%s\n' "$END_MARK"
    if [ -f "$file" ]; then
      # Drop our previous blocks, the top-level model/model_provider keys (they belong to the
      # provider we replace) and an old [model_providers.<name>] table; keep everything else.
      awk -v begin="$BEGIN_MARK" -v end="$END_MARK" -v table="[model_providers.$PROVIDER]" '
        $0 == begin { skip = 1; next }
        $0 == end { skip = 0; next }
        skip { next }
        /^[[:space:]]*\[/ {
          top = 1
          header = $0; gsub(/[[:space:]]/, "", header)
          intable = (header == table)
        }
        intable { next }
        !top && /^[[:space:]]*(model|model_provider)[[:space:]]*=/ { next }
        { print }
      ' "$file"
    fi
    printf '\n%s\n' "$BEGIN_MARK"
    printf '[model_providers.%s]\n' "$PROVIDER"
    printf 'name = "%s"\n' "$PROVIDER"
    printf 'base_url = "%s/v1"\n' "$HOST"
    printf 'wire_api = "responses"\n'
    printf 'experimental_bearer_token = "%s"\n' "$KEY"
    printf 'model_catalog_url = "%s/codex/models"\n' "$HOST"
    printf '%s\n' "$END_MARK"
  } >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
  info "Codex: wrote $file (provider \"$PROVIDER\", $count models in the gateway catalog)."
  if [ -z "${CCH_MODEL:-}" ]; then
    info "  The default model is the first one the gateway lists; switch with /model."
  fi
}

# ---------------------------------------------------------------- omp

configure_omp() {
  local dir="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}" file tmp block="" listed=""
  file="$dir/models.yml"

  local spec name path api auth n
  for spec in "anthropic|anthropic|anthropic-messages|apiKey" "chat|chat|openai-completions|" \
    "responses|responses|openai-responses|"; do
    IFS='|' read -r name path api auth <<<"$spec"
    fetch "/$path/v1/models" "$KEY" "$OMP_UA"
    if [ "$HTTP_STATUS" != "200" ]; then
      info "  skip $PROVIDER-$name: /$path/v1/models returned HTTP $HTTP_STATUS"
      continue
    fi
    n="$(count_fields "$HTTP_BODY" id)"
    if [ "$n" -eq 0 ]; then
      info "  skip $PROVIDER-$name: no models on this protocol for this key"
      continue
    fi
    listed="$listed $PROVIDER-$name($n)"
    block="$block  $PROVIDER-$name:
    baseUrl: $HOST/$path/v1
    apiKey: \"$KEY\"
    api: $api
"
    if [ -n "$auth" ]; then block="$block    auth: $auth
"; fi
    block="$block    discovery: { type: openai-models-list }
"
  done
  [ -n "$block" ] || die "omp: the gateway lists no models for this key on any protocol"

  mkdir -p "$dir"
  backup "$file"
  tmp="$(mktemp "$dir/.models.yml.XXXXXX")"
  if [ -f "$file" ] && grep -q '^providers:[[:space:]]*$' "$file"; then
    # Replace our block, or insert it right under the existing top-level `providers:` key.
    CCH_BLOCK="$block" awk -v begin="  $BEGIN_MARK" -v end="  $END_MARK" '
      $0 == begin { skip = 1; next }
      $0 == end { skip = 0; next }
      skip { next }
      { print }
      /^providers:[[:space:]]*$/ && !done {
        printf "%s\n%s%s\n", begin, ENVIRON["CCH_BLOCK"], end
        done = 1
      }
    ' "$file" >"$tmp"
  else
    if [ -f "$file" ]; then
      grep -q '^providers:' "$file" &&
        { rm -f "$tmp"; die "omp: $file has an inline providers map; add the providers by hand"; }
      cat "$file" >"$tmp"
      printf '\n' >>"$tmp"
    fi
    printf 'providers:\n  %s\n%s  %s\n' "$BEGIN_MARK" "$block" "$END_MARK" >>"$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$file"
  info "omp: wrote $file with providers:$listed."
  if command -v omp >/dev/null 2>&1; then
    if PI_CODING_AGENT_DIR="$dir" omp models refresh >/dev/null 2>&1; then
      info "  omp models refreshed; list them with: omp models $PROVIDER-responses"
    else
      info "  could not refresh omp models now; run: omp models refresh"
    fi
  fi
}

case "$CLIENT" in
  codex) configure_codex ;;
  omp) configure_omp ;;
  both) configure_codex; configure_omp ;;
esac
info "Done."
