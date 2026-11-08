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
#   CCH_MODEL           optional. Codex default model slug (default: gpt-6-sol when the gateway lists it)
#   CODEX_HOME          optional. Codex home: config.toml, auth.json and the key file live there
#                       (default: ~/.codex; `~` and relative paths are resolved). A non-default
#                       home is used by Codex only while CODEX_HOME is exported to it
#   CCH_RESTART_CODEX_DAEMON optional. 0 = do not restart a running Codex app-server daemon
#                       (default: restart it so it loads the new config)
#   PI_CODING_AGENT_DIR optional. omp agent dir (default: ~/.omp/agent; resolved like CODEX_HOME)
#   CCH_REUSE_KEY       optional. 1 = reuse a working key found in existing configs without asking,
#                       0 = never reuse (default: ask, yes by default; reuse without a terminal)
#   CCH_REUSE_KEY_DOMAIN optional. Domain whose providers' keys may be reused
#                       (default: jackllm4sci.online, also matching its subdomains)
#
# The API key is typed in (hidden), or reused from an existing Codex/omp provider whose endpoint
# is on CCH_REUSE_KEY_DOMAIN and that still works against CCH_HOST. Reusable keys: a key
# hard-coded in the config (Codex `experimental_bearer_token`, omp `apiKey`), the key file this
# script writes, or Codex's auth.json `OPENAI_API_KEY` for a provider with
# `requires_openai_auth = true` or the built-in provider moved by `openai_base_url`. It is never
# read from arguments, so it does not end up in shell history. Configs are backed up first.

set -euo pipefail

PROVIDER="${CCH_PROVIDER_NAME:-cch}"
BEGIN_MARK="# >>> cch-client-setup ${PROVIDER} >>>"
END_MARK="# <<< cch-client-setup ${PROVIDER} <<<"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*" >&2; }

# Absolute form of a config dir: a leading `~` is expanded (it stays literal when quoted in the
# environment) and a relative path is taken from the current directory. The dir need not exist.
abs_dir() { # abs_dir <path>
  local d="$1"
  case "$d" in
    "~") d="$HOME" ;;
    "~/"*) d="$HOME/${d#\~/}" ;;
  esac
  case "$d" in
    /*) ;;
    *) d="$PWD/$d" ;;
  esac
  while [ "${#d}" -gt 1 ] && [ "${d%/}" != "$d" ]; do d="${d%/}"; done
  printf '%s' "$d"
}

DEFAULT_CODEX_HOME="$HOME/.codex"
DEFAULT_OMP_DIR="$HOME/.omp/agent"
CODEX_DIR="$(abs_dir "${CODEX_HOME:-$DEFAULT_CODEX_HOME}")"
OMP_DIR="$(abs_dir "${PI_CODING_AGENT_DIR:-$DEFAULT_OMP_DIR}")"

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

# ---------------------------------------------------------------- key reuse

REUSE_DOMAIN="${CCH_REUSE_KEY_DOMAIN:-jackllm4sci.online}"

url_host() { # url_host <url> -> lowercase host
  local h="${1#*://}"
  h="${h%%/*}"
  h="${h%%:*}"
  printf '%s' "$h" | tr 'A-Z' 'a-z'
}

host_in_reuse_domain() { # host_in_reuse_domain <host>
  case "$1" in
    "$REUSE_DOMAIN" | *."$REUSE_DOMAIN") return 0 ;;
    *) return 1 ;;
  esac
}

# Lines "provider|base_url|bearer_token|requires_openai_auth|auth_command|auth_arg" (| is \037,
# the ASCII unit separator: `read` collapses runs of whitespace separators, which would shift
# empty fields). A top-level `openai_base_url` yields the built-in "openai" provider, which uses
# auth.json credentials.
# for every [model_providers.<name>] table (plus its .auth subtable) in a Codex config.toml.
codex_provider_rows() { # codex_provider_rows <config.toml>
  awk '
    function val(line) {
      sub(/^[^=]*=[[:space:]]*/, "", line)
      sub(/[[:space:]]*(#.*)?$/, "", line)
      gsub(/^"|"$/, "", line)
      return line
    }
    !intable && /^[[:space:]]*openai_base_url[[:space:]]*=/ {
      url["openai"] = val($0); roa["openai"] = "true"; seen["openai"] = 1
    }
    /^[[:space:]]*\[/ {
      intable = 1
      h = $0; gsub(/[[:space:]]/, "", h); cur = ""; kind = ""
      if (h ~ /^\[model_providers\.[^].]+\]$/) {
        cur = substr(h, 18, length(h) - 18); kind = "main"; seen[cur] = 1
      } else if (h ~ /^\[model_providers\.[^].]+\.auth\]$/) {
        cur = substr(h, 18); sub(/\.auth\]$/, "", cur); kind = "auth"
      }
      next
    }
    cur == "" { next }
    kind == "main" && /^[[:space:]]*base_url[[:space:]]*=/ { url[cur] = val($0) }
    kind == "main" && /^[[:space:]]*experimental_bearer_token[[:space:]]*=/ { tok[cur] = val($0) }
    kind == "main" && /^[[:space:]]*requires_openai_auth[[:space:]]*=/ { roa[cur] = val($0) }
    kind == "auth" && /^[[:space:]]*command[[:space:]]*=/ { cmd[cur] = val($0) }
    kind == "auth" && /^[[:space:]]*args[[:space:]]*=/ {
      a = $0; sub(/^[^[]*\[[[:space:]]*"/, "", a); sub(/".*$/, "", a); arg[cur] = a
    }
    END {
      for (p in seen) printf "%s\037%s\037%s\037%s\037%s\037%s\n", p, url[p], tok[p], roa[p], cmd[p], arg[p]
    }
  ' "$1"
}

# Lines "provider|baseUrl|apiKey" (| is \037) for the top-level `providers:` map of an omp models.yml.
omp_provider_rows() { # omp_provider_rows <models.yml>
  awk '
    function val(line, key) {
      sub("^[[:space:]]*" key ":[[:space:]]*", "", line)
      sub(/[[:space:]]+#.*$/, "", line)
      sub(/[[:space:]]*$/, "", line)
      gsub(/^["\047]|["\047]$/, "", line)
      return line
    }
    /^providers:[[:space:]]*$/ { inp = 1; next }
    /^[^[:space:]#]/ { inp = 0; cur = "" }
    !inp { next }
    /^  [^[:space:]#][^:]*:[[:space:]]*$/ { cur = $0; sub(/^  /, "", cur); sub(/:.*$/, "", cur); seen[cur] = 1; next }
    cur != "" && /^    baseUrl:/ { url[cur] = val($0, "baseUrl") }
    cur != "" && /^    apiKey:/ { key[cur] = val($0, "apiKey") }
    END { for (p in seen) printf "%s\037%s\037%s\n", p, url[p], key[p] }
  ' "$1"
}

# OPENAI_API_KEY from Codex's auth.json (API-key login), if present.
auth_json_api_key() { # auth_json_api_key <auth.json>
  [ -r "$1" ] || return 0
  sed -n 's/.*"OPENAI_API_KEY"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n 1
}

# Candidate keys as "source|provider|host|key" (| is \037), existing configs first.
reuse_candidates() {
  local file name url tok roa cmd arg key host auth_json src
  file="$CODEX_DIR/config.toml"
  auth_json="$CODEX_DIR/auth.json"
  if [ -f "$file" ]; then
    while IFS=$'\037' read -r name url tok roa cmd arg; do
      host="$(url_host "$url")"
      host_in_reuse_domain "$host" || continue
      key=""
      src="$file"
      if [ -n "$tok" ]; then
        key="$tok"
      elif [ "$cmd" = "cat" ] && [ -n "$arg" ] && [ -r "$arg" ]; then
        key="$(head -n 1 "$arg" | tr -d '\r')"
        src="$arg"
      elif [ "$roa" = "true" ]; then
        key="$(auth_json_api_key "$auth_json")"
        src="$auth_json"
      fi
      [ -n "$key" ] && printf 'Codex %s\037%s\037%s\037%s\n' "$src" "$name" "$host" "$key"
    done < <(codex_provider_rows "$file")
  fi
  file="$OMP_DIR/models.yml"
  if [ -f "$file" ]; then
    while IFS=$'\037' read -r name url key; do
      host="$(url_host "$url")"
      host_in_reuse_domain "$host" || continue
      [ -n "$key" ] && printf 'omp %s\037%s\037%s\037%s\n' "$file" "$name" "$host" "$key"
    done < <(omp_provider_rows "$file")
  fi
}

valid_key_chars() { # valid_key_chars <key>
  case "$1" in
    "" | *[[:space:]]* | *\"* | *\\*) return 1 ;;
  esac
}

# Offer the first existing key that still works against $HOST. Sets KEY and CODEX_CATALOG.
try_reuse_key() {
  local source name host key tried=" " answer
  [ "${CCH_REUSE_KEY:-}" = "0" ] && return 0
  while IFS=$'\037' read -r source name host key; do
    valid_key_chars "$key" || continue
    case "$tried" in *" $key "*) continue ;; esac
    tried="$tried$key "
    fetch "/codex/models?client_version=$CODEX_VERSION" "$key" "$CODEX_UA"
    [ "$HTTP_STATUS" = "200" ] || {
      info "Existing key of $name ($host) in $source does not work for $HOST (HTTP $HTTP_STATUS)."
      continue
    }
    info "Found a working key in $source: provider \"$name\" ($host), ending in ...${key: -4}."
    if [ "${CCH_REUSE_KEY:-}" = "1" ] || [ -z "$TTY" ]; then
      answer=y
    else
      answer="$(ask "Reuse it? [Y/n] ")"
      answer="${answer:-y}"
    fi
    case "$answer" in
      y | Y | yes | YES)
        KEY="$key"
        CODEX_CATALOG="$HTTP_BODY"
        info "Reusing the existing key."
        return 0
        ;;
    esac
    info "Not reusing it."
    return 0
  done < <(reuse_candidates)
}

KEY=""
CODEX_CATALOG=""
try_reuse_key
for attempt in 1 2 3; do
  [ -z "$KEY" ] || break
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
[ -n "$CODEX_CATALOG" ] || CODEX_CATALOG="$HTTP_BODY"

backup() { # backup <file>
  if [ -f "$1" ]; then
    local dest
    dest="$1.bak.$(date +%Y%m%d%H%M%S)"
    cp -p "$1" "$dest"
    info "  backup: $dest"
  fi
}

# ---------------------------------------------------------------- codex

# Codex default model when CCH_MODEL is not set. Pinning it avoids depending on whichever model
# the gateway happens to list first (e.g. a provider-prefixed route) for `codex --yolo`.
CODEX_DEFAULT_MODEL="gpt-6-sol"

catalog_has_slug() { # catalog_has_slug <slug>
  printf '%s' "$CODEX_CATALOG" | grep -qF "\"slug\":\"$1\""
}

configure_codex() {
  local dir="$CODEX_DIR" file tmp count model="" keyfile
  file="$dir/config.toml"
  count="$(count_fields "$CODEX_CATALOG" slug)"
  [ "$count" -gt 0 ] || info "warning: the gateway lists no Codex (Responses API) models for this key"

  if [ -n "${CCH_MODEL:-}" ]; then
    model="$CCH_MODEL"
    catalog_has_slug "$model" ||
      info "warning: CCH_MODEL=$model is not in the gateway catalog for this key; using it anyway"
  elif catalog_has_slug "$CODEX_DEFAULT_MODEL"; then
    model="$CODEX_DEFAULT_MODEL"
  else
    info "warning: $CODEX_DEFAULT_MODEL is not in the gateway catalog for this key;" \
      "Codex will use the first listed model (set CCH_MODEL to choose one)"
  fi

  mkdir -p "$dir"
  dir="$(cd "$dir" && pwd)"
  file="$dir/config.toml"
  # The key is read by a provider auth command instead of `experimental_bearer_token`.
  # Codex treats command auth as provider-managed: the gateway catalog is always fetched,
  # even when a client such as Codex Desktop (over remote control) turns off the
  # `api_key_model_discovery` feature on the shared app-server daemon. With a bearer token the
  # daemon then lists no models at all ("No additional models are available").
  keyfile="$dir/$PROVIDER.key"
  (umask 077 && printf '%s\n' "$KEY" >"$keyfile.tmp") && mv "$keyfile.tmp" "$keyfile"
  chmod 600 "$keyfile"
  backup "$file"
  tmp="$(mktemp "$dir/.config.toml.XXXXXX")"
  {
    printf '%s\n' "$BEGIN_MARK"
    printf 'model_provider = "%s"\n' "$PROVIDER"
    if [ -n "$model" ]; then printf 'model = "%s"\n' "$model"; fi
    printf '%s\n' "$END_MARK"
    if [ -f "$file" ]; then
      # Drop our previous blocks, the top-level model/model_provider keys (they belong to the
      # provider we replace) and an old [model_providers.<name>] table; keep everything else.
      awk -v begin="$BEGIN_MARK" -v end="$END_MARK" -v table="[model_providers.$PROVIDER]" \
        -v subtable="[model_providers.$PROVIDER." '
        $0 == begin { skip = 1; next }
        $0 == end { skip = 0; next }
        skip { next }
        /^[[:space:]]*\[/ {
          top = 1
          header = $0; gsub(/[[:space:]]/, "", header)
          intable = (header == table || index(header, subtable) == 1)
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
    printf 'model_catalog_url = "%s/codex/models"\n' "$HOST"
    printf '\n[model_providers.%s.auth]\n' "$PROVIDER"
    printf 'command = "cat"\n'
    printf 'args = ["%s"]\n' "$keyfile"
    printf 'refresh_interval_ms = 0\n'
    # Explicit cwd: the command otherwise runs in the daemon's working directory, which may be
    # one this user cannot enter (the command then fails with "Permission denied").
    printf 'cwd = "%s"\n' "$dir"
    printf '%s\n' "$END_MARK"
  } >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
  info "Codex: wrote $file (provider \"$PROVIDER\", $count models in the gateway catalog)."
  info "  API key stored in $keyfile (mode 600), read by the provider auth command."
  if [ -n "$model" ]; then
    info "  Default model: $model (switch with /model)."
  else
    info "  The default model is the first one the gateway lists; switch with /model."
  fi
  refresh_codex_runtime "$dir"
  if [ "$dir" != "$(abs_dir "$DEFAULT_CODEX_HOME")" ]; then
    info "  Codex home: $dir (Codex uses it while CODEX_HOME points there; to keep it, add"
    info "  to your shell profile: export CODEX_HOME=\"$dir\")"
  fi
}

# Codex >= 0.167 keeps a background app-server daemon that holds the config it started with.
# A daemon started before this script ran ignores the new provider, so /model shows the old
# catalog or "No additional models are available". Warm the catalog cache first (a cold fetch
# takes seconds through a proxy), then restart a running daemon by default so it loads the new
# config. The restart interrupts Codex sessions running in that daemon.
limited() { # limited <seconds> <command...>: `timeout` when available (macOS has none)
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then timeout "$seconds" "$@"; else "$@"; fi
}

refresh_codex_runtime() { # refresh_codex_runtime <codex_home>
  local dir="$1" status
  command -v codex >/dev/null 2>&1 || return 0

  if CODEX_HOME="$dir" limited 60 codex debug models </dev/null >/dev/null 2>&1; then
    info "  Codex model catalog fetched and cached."
  fi

  # A daemon counts as running when Codex says so or when its process is alive (a stuck daemon
  # may not answer `daemon version` at all).
  status="$(CODEX_HOME="$dir" limited 20 codex app-server daemon version </dev/null 2>/dev/null || true)"
  case "$status" in
    *'"status":"running"'*) ;;
    *) [ -n "$(codex_daemon_pids "$dir")" ] || return 0 ;;
  esac

  if [ "${CCH_RESTART_CODEX_DAEMON:-1}" = "0" ]; then
    info "  A Codex daemon started before this setup is still running with the old config."
    info "  Restart it before using Codex: codex app-server daemon restart (or /daemon in Codex)"
    return 0
  fi
  # `daemon restart` alone can leave the old process running (it fails or times out, e.g. on a
  # stale lock or a daemon from another Codex version), and that daemon keeps the old config.
  # Stop it, make sure it is gone, then start a new one.
  if ! stop_codex_daemon "$dir"; then
    info "  warning: could not stop the Codex daemon; stop it and start Codex again:"
    info "    pkill -u \"\$(id -u)\" -f '$dir/packages/app-server-daemon/.*app-server'"
    return 0
  fi
  # Start from the Codex home: the new daemon inherits this working directory.
  if (cd "$dir" && CODEX_HOME="$dir" limited 60 codex app-server daemon start </dev/null >/dev/null 2>&1); then
    info "  Restarted the Codex app-server daemon so it loads the new config"
    info "  (Codex sessions that were running in it were interrupted; start them again)."
  else
    info "  Stopped the old Codex daemon; Codex starts a new one when needed"
    info "  (or run: codex app-server daemon start)."
  fi
}

# ERE-escape a literal for pgrep/pkill -f.
ere_escape() { printf '%s' "$1" | sed 's/[][\\.*^$+?(){}|]/\\&/g'; }

# Pids of this Codex home's managed app-server daemon: the pid file, plus any process running the
# daemon binary that Codex installs under <CODEX_HOME>/packages/app-server-daemon. App-servers
# that an IDE or Codex Desktop starts on their own are not matched.
codex_daemon_pids() { # codex_daemon_pids <codex_home>
  local dir="$1" pid
  pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' \
    "$dir/app-server-daemon/daemon.pid" 2>/dev/null | head -n 1)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null &&
    ps -o args= -p "$pid" 2>/dev/null | grep -q 'app-server'; then
    printf '%s\n' "$pid"
  fi
  command -v pgrep >/dev/null 2>&1 &&
    pgrep -u "$(id -u)" -f "$(ere_escape "$dir/packages/app-server-daemon/").*app-server" 2>/dev/null
  return 0
}

stop_codex_daemon() { # stop_codex_daemon <codex_home>: 0 when no daemon process is left
  local dir="$1" pids i
  CODEX_HOME="$dir" limited 30 codex app-server daemon stop </dev/null >/dev/null 2>&1 || true
  for i in 1 2 3 4 5 6 7 8 9 10; do
    pids="$(codex_daemon_pids "$dir" | sort -u)"
    [ -n "$pids" ] || return 0
    case "$i" in
      1) kill $pids 2>/dev/null || true ;;
      6) kill -9 $pids 2>/dev/null || true ;;
    esac
    sleep 1
  done
  pids="$(codex_daemon_pids "$dir" | sort -u)"
  [ -z "$pids" ]
}

# ---------------------------------------------------------------- omp

configure_omp() {
  local dir="$OMP_DIR" file tmp block="" listed=""
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
  if [ "$dir" != "$(abs_dir "$DEFAULT_OMP_DIR")" ]; then
    info "  omp agent dir: $dir (omp uses it while PI_CODING_AGENT_DIR points there; to keep it,"
    info "  add to your shell profile: export PI_CODING_AGENT_DIR=\"$dir\")"
  fi
}

case "$CLIENT" in
  codex) configure_codex ;;
  omp) configure_omp ;;
  both) configure_codex; configure_omp ;;
esac
info "Done."
