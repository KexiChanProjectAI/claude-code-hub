#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sync-upstream-providers.py — Self-contained Python port of the
TypeScript sync toolchain at scripts/sync-upstream-providers/*.ts.

This single-file script ports:
  - redaction.ts       (Section 1)
  - config.ts          (Section 2)
  - multiplier.ts      (Section 3)
  - naming.ts          (Section 4)
  - cch-client.ts      (Section 5)
  - upstream-discovery.ts (Section 6)
  - sync-planner.ts    (Section 7)
  - sync-upstream-providers.ts CLI (Section 8)

Constraints:
  - Stdlib only. No pip dependencies.
  - No `requests` library — uses `urllib.request` for all HTTP.
  - Model tests run concurrently via ThreadPoolExecutor (default 20 threads).
  - All output goes through redact_secrets() as defense-in-depth.

Usage:
  python3 scripts/sync-upstream-providers.py --config config.json [--apply] [--evidence FILE]
"""

from __future__ import annotations

import argparse
import concurrent.futures
import copy
import datetime as _dt
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import (
    Any,
    Callable,
    Dict,
    Iterable,
    List,
    Mapping,
    Optional,
    Sequence,
    Set,
    Tuple,
    Union,
)


# ============================================================================
# Section 1: Redaction
# ============================================================================
# Mirrors scripts/sync-upstream-providers/redaction.ts

# Each rule: (compiled regex, replacement template).
# Replacement uses "[REDACTED]" for the secret value.
_REDACTION_RULES: Tuple[Tuple[re.Pattern, str], ...] = (
    # Bearer tokens: "Bearer <token>" -> "Bearer [REDACTED]"
    # Must come before generic key-value patterns to avoid double-matching
    (re.compile(r"\bBearer\s+\S+", re.IGNORECASE), "Bearer [REDACTED]"),
    # API keys with common prefixes: sk-xxx, key-xxx
    (re.compile(r"\b(sk-|key-)\S+", re.IGNORECASE), "[REDACTED]"),
    # password: <value> or password=<value>
    (re.compile(r"\b(password)\s*[:=]\s*\S+", re.IGNORECASE), r"\1: [REDACTED]"),
    # token: <value> or token=<value>
    (re.compile(r"\b(token)\s*[:=]\s*\S+", re.IGNORECASE), r"\1: [REDACTED]"),
    # api_key: <value> or api_key=<value> (also matches api-key, apiKey)
    (re.compile(r"\b(api[-_]?key)\s*[:=]\s*\S+", re.IGNORECASE), r"\1: [REDACTED]"),
    # Authorization: <value> (catch-all for non-Bearer auth headers)
    (
        re.compile(r"\b(Authorization)\s*[:=]\s*(?!Bearer\b)\S+", re.IGNORECASE),
        r"\1: [REDACTED]",
    ),
)


def redact_secrets(text: Any) -> str:
    """Redact known secret patterns from a string.

    Replaces API keys, passwords, tokens, and Bearer auth values with
    [REDACTED]. Handles non-string input gracefully by returning "".

    Args:
        text: The string to redact (may be None or non-string).

    Returns:
        Redacted string with secrets replaced by [REDACTED], or "" if input
        is not a string.
    """
    if not isinstance(text, str):
        return ""
    result = text
    for pattern, replacement in _REDACTION_RULES:
        result = pattern.sub(replacement, result)
    return result


# ============================================================================
# Section 2: Configuration
# ============================================================================
# Mirrors scripts/sync-upstream-providers/config.ts

EnvResolver = Callable[[str], str]


def _default_env_resolver(name: str) -> str:
    """Resolve an environment variable by name (returns "" if unset)."""
    return os.environ.get(name, "")


@dataclass
class ConfigEntryError:
    """A single validation error for a config entry."""

    entry_index: int
    field: str
    message: str


@dataclass
class ValidatedProviderEntry:
    """A validated provider entry with resolved password."""

    host: str
    username: str
    recharge_multiplier: float
    rate_multiplier: Optional[float] = None
    password: Optional[str] = None
    password_env: Optional[str] = None
    api_key_sha256: Optional[str] = None
    api_key: Optional[str] = None
    resolved_password: str = ""
    model_whitelist: Optional[List[str]] = None


@dataclass
class ProviderConfigParseResult:
    """Result of parsing a provider config array."""

    valid: bool
    entries: List[ValidatedProviderEntry] = field(default_factory=list)
    errors: List[ConfigEntryError] = field(default_factory=list)


def _is_finite_number(value: Any) -> bool:
    """Return True iff value is a real (non-bool) finite number."""
    if isinstance(value, bool):
        return False
    if not isinstance(value, (int, float)):
        return False
    return math.isfinite(value)


def validate_provider_config_entry(
    entry: Any, entry_index: int
) -> List[ConfigEntryError]:
    """Validate a single provider config entry.

    Rules:
      - host: non-empty string
      - username: non-empty string
      - password or passwordEnv: at least one must be present and non-empty
      - rechargeMultiplier: positive finite number (> 0, not NaN, not Infinity)
      - apiKeySha256 (optional): 64-char hex string if present

    Args:
        entry: Raw config entry to validate.
        entry_index: Zero-based index in the config array.

    Returns:
        List of validation errors (empty if valid).
    """
    errors: List[ConfigEntryError] = []

    if not isinstance(entry, dict):
        errors.append(
            ConfigEntryError(
                entry_index=entry_index,
                field="root",
                message=f"Entry {entry_index + 1} must be an object",
            )
        )
        return errors

    # host
    host = entry.get("host")
    if not isinstance(host, str) or not host or not host.strip():
        errors.append(
            ConfigEntryError(
                entry_index=entry_index,
                field="host",
                message=f"Entry {entry_index + 1} missing required field: host",
            )
        )

    # username
    username = entry.get("username")
    if not isinstance(username, str) or not username or not username.strip():
        errors.append(
            ConfigEntryError(
                entry_index=entry_index,
                field="username",
                message=f"Entry {entry_index + 1} missing required field: username",
            )
        )

    # password / passwordEnv
    password = entry.get("password")
    password_env = entry.get("passwordEnv")
    has_password = isinstance(password, str) and len(password) > 0
    has_password_env = isinstance(password_env, str) and len(password_env) > 0
    if not has_password and not has_password_env:
        errors.append(
            ConfigEntryError(
                entry_index=entry_index,
                field="password",
                message=f"Entry {entry_index + 1} missing password or password_env",
            )
        )

    # apiKeySha256 (optional)
    sha = entry.get("apiKeySha256")
    if sha is not None:
        if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", sha or ""):
            errors.append(
                ConfigEntryError(
                    entry_index=entry_index,
                    field="apiKeySha256",
                    message=f"Entry {entry_index + 1} apiKeySha256 must be a 64-char hex string",
                )
            )

    # rechargeMultiplier
    rm = entry.get("rechargeMultiplier")
    if rm is None:
        errors.append(
            ConfigEntryError(
                entry_index=entry_index,
                field="rechargeMultiplier",
                message=f"Entry {entry_index + 1} missing required field: recharge_multiplier",
            )
        )
    elif not _is_finite_number(rm):
        errors.append(
            ConfigEntryError(
                entry_index=entry_index,
                field="rechargeMultiplier",
                message=f"Entry {entry_index + 1} recharge_multiplier must be a finite positive number",
            )
        )
    elif rm <= 0:
        errors.append(
            ConfigEntryError(
                entry_index=entry_index,
                field="rechargeMultiplier",
                message=f"Entry {entry_index + 1} recharge_multiplier must be a positive number",
            )
        )

    # modelWhitelist (optional)
    mw = entry.get("modelWhitelist")
    if mw is not None and (
        not isinstance(mw, list)
        or not all(isinstance(m, str) and m.strip() for m in mw)
    ):
        errors.append(
            ConfigEntryError(
                entry_index=entry_index,
                field="modelWhitelist",
                message=f"Entry {entry_index + 1} modelWhitelist must be a non-empty array of strings",
            )
        )

    return errors


def parse_provider_config(
    raw: Any,
    resolve_env: Optional[EnvResolver] = None,
) -> ProviderConfigParseResult:
    """Parse and validate a full provider config array.

    Mirrors the TypeScript parseProviderConfig behavior:
      - Top-level must be an array
      - Each entry is validated
      - passwordEnv is resolved via the env resolver
      - Returns either valid entries with resolved passwords, or collected errors

    Args:
        raw: Raw config data (should be an array of entries).
        resolve_env: Optional custom env var resolver (for testing).

    Returns:
        ProviderConfigParseResult with valid entries (and resolved passwords)
        or collected errors.
    """
    if not isinstance(raw, list):
        return ProviderConfigParseResult(
            valid=False,
            errors=[
                ConfigEntryError(
                    entry_index=0,
                    field="root",
                    message="JSON config top level must be an array",
                )
            ],
        )

    resolver = resolve_env if resolve_env is not None else _default_env_resolver
    all_errors: List[ConfigEntryError] = []
    valid_entries: List[ValidatedProviderEntry] = []

    for i, entry in enumerate(raw):
        if not isinstance(entry, dict):
            all_errors.append(
                ConfigEntryError(
                    entry_index=i,
                    field="root",
                    message=f"Entry {i + 1} must be an object",
                )
            )
            continue

        entry_errors = validate_provider_config_entry(entry, i)
        if entry_errors:
            all_errors.extend(entry_errors)
            continue

        # Resolve password
        password = entry.get("password")
        password_env = entry.get("passwordEnv")
        resolved_password = ""
        if isinstance(password, str) and password:
            resolved_password = password
        elif isinstance(password_env, str) and password_env:
            resolved_password = resolver(password_env)
            if not resolved_password:
                all_errors.append(
                    ConfigEntryError(
                        entry_index=i,
                        field="passwordEnv",
                        message=f"Entry {i + 1} env var {password_env} is unset or empty",
                    )
                )
                continue

        sha = entry.get("apiKeySha256")
        rm = entry.get("rechargeMultiplier")
        rate = entry.get("rateMultiplier")
        ak = entry.get("apiKey")
        mw = entry.get("modelWhitelist")
        model_whitelist = [str(m) for m in mw] if isinstance(mw, list) else None
        valid_entries.append(
            ValidatedProviderEntry(
                host=entry["host"],
                username=entry["username"],
                recharge_multiplier=float(rm) if _is_finite_number(rm) else 0.0,
                rate_multiplier=float(rate) if _is_finite_number(rate) else None,
                password=password if isinstance(password, str) else None,
                password_env=password_env if isinstance(password_env, str) else None,
                api_key_sha256=sha if isinstance(sha, str) else None,
                api_key=ak if isinstance(ak, str) and ak else None,
                resolved_password=resolved_password,
                model_whitelist=model_whitelist,
            )
        )

    if all_errors:
        return ProviderConfigParseResult(valid=False, errors=all_errors)

    return ProviderConfigParseResult(valid=True, entries=valid_entries)


# ============================================================================
# Section 3: Multiplier math
# ============================================================================
# Mirrors scripts/sync-upstream-providers/multiplier.ts

# Discriminated error kinds for recharge multiplier validation.
RECHARGE_ERROR_KIND_NON_FINITE = "non_finite"
RECHARGE_ERROR_KIND_ZERO_OR_NEGATIVE = "zero_or_negative"


@dataclass
class RechargeMultiplierValidationError:
    """Typed validation error for recharge multiplier."""

    kind: str
    entry_index: int
    message: str


@dataclass
class RechargeMultiplierValidationResult:
    """Validation result for recharge multiplier."""

    valid: bool
    error: Optional[RechargeMultiplierValidationError] = None


def validate_recharge_multiplier(
    value: Any, entry_index: int
) -> RechargeMultiplierValidationResult:
    """Validate a recharge multiplier value.

    Rules:
      - Must be a positive finite number (> 0, not NaN, not Infinity)
      - Error messages must never contain secrets

    Args:
        value: The recharge multiplier to validate.
        entry_index: Zero-based config entry index for error traceability.

    Returns:
        Validation result with typed error if invalid.
    """
    if not _is_finite_number(value):
        return RechargeMultiplierValidationResult(
            valid=False,
            error=RechargeMultiplierValidationError(
                kind=RECHARGE_ERROR_KIND_NON_FINITE,
                entry_index=entry_index,
                message=f"Entry {entry_index + 1} recharge_multiplier must be a finite positive number",
            ),
        )
    if value <= 0:
        return RechargeMultiplierValidationResult(
            valid=False,
            error=RechargeMultiplierValidationError(
                kind=RECHARGE_ERROR_KIND_ZERO_OR_NEGATIVE,
                entry_index=entry_index,
                message=f"Entry {entry_index + 1} recharge_multiplier must be a positive number",
            ),
        )
    return RechargeMultiplierValidationResult(valid=True)


def compute_actual_multiplier(
    upstream_resolved_rate_multiplier: Any,
    recharge_multiplier: Any,
    expected_rate: Optional[float] = None,
    allow_fallback: bool = False,
) -> float:
    """Compute the actual cost multiplier.

    Formula: actualMultiplier = upstreamResolvedRateMultiplier / rechargeMultiplier.

    Fallback behavior:
      - If upstream is NaN/undefined and allowFallback is True and expectedRate
        is provided, uses expectedRate as the upstream value:
        actual = expectedRate / recharge.
      - If upstream is NaN/undefined and allowFallback is False or expectedRate
        is missing, raises ValueError.
      - If upstream is a valid finite number, it always takes priority over
        expectedRate.

    Args:
        upstream_resolved_rate_multiplier: Resolved rate multiplier from
            the upstream provider.
        recharge_multiplier: Recharge multiplier (divisor).
        expected_rate: Optional configured expected rate (rateMultiplier).
        allow_fallback: Whether fallback to expectedRate is allowed when
            upstream is unresolved.

    Returns:
        Computed actual multiplier.

    Raises:
        ValueError: If recharge_multiplier is zero/negative/non-finite, or
            upstream is unresolved and fallback is not allowed.
    """
    recharge_validation = validate_recharge_multiplier(recharge_multiplier, 0)
    if not recharge_validation.valid:
        msg = (
            recharge_validation.error.message
            if recharge_validation.error
            else "invalid recharge"
        )
        raise ValueError(msg)

    upstream_is_finite = _is_finite_number(upstream_resolved_rate_multiplier)

    if not upstream_is_finite:
        has_expected_rate = expected_rate is not None and _is_finite_number(
            expected_rate
        )
        if allow_fallback and has_expected_rate:
            return float(expected_rate) / float(recharge_multiplier)
        raise ValueError(
            "Unresolved upstream rate multiplier and fallback to expected rate is not allowed"
        )

    return float(upstream_resolved_rate_multiplier) / float(recharge_multiplier)


def format_compact_decimal(value: float) -> str:
    """Format a number as a compact decimal string.

    Rules:
      - Up to 6 decimal places
      - Trim trailing zeros after the decimal point
      - Remove trailing decimal point if no fractional digits remain
      - Non-finite values raise

    Args:
        value: The number to format.

    Returns:
        Compact decimal string (e.g. "1.5", "2", "0.000123").

    Raises:
        ValueError: If value is not finite.
    """
    if not _is_finite_number(value):
        raise ValueError(f"formatCompactDecimal: value must be finite, got {value!r}")
    # Python's f"{:.6f}" matches the toFixed(6) of the TS version.
    result = f"{float(value):.6f}"
    if "." in result:
        result = result.rstrip("0").rstrip(".")
    return result


# ============================================================================
# Section 4: Naming and priority
# ============================================================================
# Mirrors scripts/sync-upstream-providers/naming.ts

ProviderTypeToken = str  # "chat" | "responses"

MAX_NAME_LENGTH = 128

PRIORITY_MIN = 3
PRIORITY_MAX = 15


def normalize_host_token(raw_url: str) -> str:
    """Extract and normalize hostname from a URL string.

    Rules:
      - Parse URL, extract hostname only (no port, no protocol, no path,
        no credentials)
      - Lowercase the hostname
      - Replace every non-alphanumeric character sequence with a single underscore
      - Strip leading/trailing underscores

    Args:
        raw_url: Full URL or hostname string.

    Returns:
        Normalized host token, or empty string if no valid hostname can be
        extracted.
    """
    parsed_hostname = ""
    try:
        # Python's urllib.parse requires a scheme for full URL parsing.
        # Mirror the TS logic: try URL parse first, then fall back to bare
        # regex stripping of the scheme.
        from urllib.parse import urlparse

        parsed = urlparse(raw_url)
        if parsed.hostname:
            parsed_hostname = parsed.hostname
    except Exception:
        parsed_hostname = ""

    if parsed_hostname:
        hostname = parsed_hostname
    else:
        hostname = raw_url or ""
        scheme_match = re.match(r"^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/(.+)", hostname)
        if scheme_match:
            hostname = scheme_match.group(2)

    # Strip port (and IPv6 brackets)
    bracket_index = hostname.find("]")
    if bracket_index != -1:
        hostname = hostname[: bracket_index + 1]
    else:
        colon_idx = hostname.find(":")
        if colon_idx != -1:
            hostname = hostname[:colon_idx]

    # Lowercase
    hostname = hostname.lower()

    # Replace non-alphanumeric sequences with a single underscore
    token = re.sub(r"[^a-z0-9]+", "_", hostname)

    # Strip leading/trailing underscores
    token = re.sub(r"^_+|_+$", "", token)

    return token


def build_generated_name(
    raw_url: str,
    type_token: ProviderTypeToken,
    actual_multiplier: float,
    model_id: Optional[str] = None,
) -> str:
    """Build a deterministic generated name for a sync-managed provider.

    Format: cchsync_<host>_<type>[_<model_slug>]_<multiplier>

    When model_id is provided, each model gets its own provider so CCH
    can apply per-model circuit breaker independently.

    Rules:
      - Host token from normalize_host_token
      - Type token is "chat" or "responses"
      - Model slug from _slugify_model (dots replaced with hyphens)
      - Multiplier from format_compact_decimal
      - If the name exceeds MAX_NAME_LENGTH, truncate the host token
      - Must never contain protocol, path, credentials, API keys, or usernames

    Args:
        raw_url: Upstream URL.
        type_token: Provider type ("chat" or "responses").
        actual_multiplier: The computed actual cost multiplier.
        model_id: Optional model ID for per-model naming.

    Returns:
        Deterministic generated name string.
    """
    host = normalize_host_token(raw_url)
    multiplier = format_compact_decimal(actual_multiplier)

    parts = [host, type_token]
    if model_id:
        parts.append(_slugify_model(model_id))
    skeleton_parts = [host, type_token]
    if model_id:
        skeleton_parts.append(_slugify_model(model_id))
    skeleton_no_host = f"cchsync__{'_'.join(skeleton_parts[1:])}_{multiplier}"
    full_prefix = f"cchsync_{'_'.join(parts)}_{multiplier}"

    if len(full_prefix) > MAX_NAME_LENGTH:
        # Truncate host
        available_for_host = MAX_NAME_LENGTH - len(skeleton_no_host)
        truncated_host = (
            host[: max(0, available_for_host)] if available_for_host > 0 else "h"
        )
        name = f"cchsync_{truncated_host}_{'_'.join(parts[1:])}_{multiplier}"
    else:
        name = full_prefix

    return name


def _slugify_model(model_id: str) -> str:
    """Slugify a model ID for use in provider names.

    Replace dots with hyphens so the name stays URL-safe.
    """
    return model_id.replace(".", "-").replace("_", "-")


@dataclass
class PriorityInput:
    """Input for priority computation."""

    actual_multiplier: float
    host: str
    type_token: ProviderTypeToken
    upstream_key_ref: str


def assign_priorities(inputs: Sequence[PriorityInput]) -> Dict[str, int]:
    """Assign deterministic priorities to a list of providers.

    Rules:
      - Sort by actualMultiplier ascending (lower cost = lower numeric
        priority = higher precedence).
      - Ties broken by: host (alpha), then typeToken (alpha: "chat" <
        "responses"), then upstreamKeyRef (alpha).
      - Priorities start at PRIORITY_MIN (3).
      - Each distinct rank increments priority by 1.
      - Priority is capped at PRIORITY_MAX (15).

    Args:
        inputs: Array of priority inputs.

    Returns:
        Map from composite key (host:typeToken:upstreamKeyRef) to assigned
        priority.
    """
    sorted_inputs = sorted(
        inputs,
        key=lambda p: (p.actual_multiplier, p.host, p.type_token, p.upstream_key_ref),
    )

    result: Dict[str, int] = {}
    current_priority = PRIORITY_MIN
    last_multiplier: Optional[float] = None

    for item in sorted_inputs:
        key = f"{item.host}:{item.type_token}:{item.upstream_key_ref}"
        if last_multiplier is not None and item.actual_multiplier != last_multiplier:
            current_priority = min(current_priority + 1, PRIORITY_MAX)
        assigned = min(current_priority, PRIORITY_MAX)
        result[key] = assigned
        last_multiplier = item.actual_multiplier

    return result


# ============================================================================
# Section 5: CCH API Client
# ============================================================================
# Mirrors scripts/sync-upstream-providers/cch-client.ts


class CchClientConfigError(Exception):
    """Raised when client configuration is invalid (missing/empty env vars)."""

    def __init__(self, message: str):
        super().__init__(message)
        self.name = "CchClientConfigError"


@dataclass
class CchProblemDetail:
    """Problem detail shape from RFC 7807 / application/problem+json."""

    type: str = ""
    title: str = ""
    status: int = 0
    detail: str = ""
    instance: str = ""
    error_code: str = ""
    trace_id: Optional[str] = None
    invalid_params: Optional[List[Dict[str, Any]]] = None


class CchApiError(Exception):
    """Raised when the API returns a non-2xx response."""

    def __init__(self, status: int, problem: CchProblemDetail):
        # Redact: never include auth tokens in error messages
        safe_detail = re.sub(r"Bearer\s+\S+", "Bearer [REDACTED]", problem.detail or "")
        parts = [f"API {status}: {safe_detail}"]
        if problem.title and problem.title != f"HTTP Error {status}":
            parts.append(f"title={problem.title}")
        if problem.invalid_params:
            params = "; ".join(
                f"{p.get('name', '?')}: {p.get('reason', '?')}"
                for p in problem.invalid_params
            )
            parts.append(f"invalidParams=[{params}]")
        if problem.error_code and problem.error_code != "http.error":
            parts.append(f"code={problem.error_code}")
        super().__init__(" | ".join(parts))
        self.name = "CchApiError"
        self.status = status
        self.problem = problem


PROBLEM_JSON_CONTENT_TYPE = "application/problem+json"


class CchClient:
    """Typed REST client for the Claude Code Hub management API.

    All methods use Bearer auth from the configured admin token. Error
    responses with Content-Type application/problem+json are parsed into
    CchProblemDetail; other error responses produce a fallback detail.
    """

    def __init__(self, base_url: str, admin_token: str):
        if not (isinstance(base_url, str) and base_url.strip()):
            raise CchClientConfigError("CCH_BASE_URL must be a non-empty string")
        if not (isinstance(admin_token, str) and admin_token.strip()):
            raise CchClientConfigError("CCH_ADMIN_TOKEN must be a non-empty string")
        # Trim trailing slashes
        self.base_url = re.sub(r"\/+$", "", base_url)
        self.admin_token = admin_token

    # -- Public methods --------------------------------------------------------

    def list_providers(self) -> List[Dict[str, Any]]:
        """GET /api/v1/providers — list all visible providers."""
        data = self._request("GET", "/api/v1/providers")
        items = data.get("items", []) if isinstance(data, dict) else []
        if not isinstance(items, list):
            return []
        return [self._normalize_provider_item(p) for p in items]

    def fetch_upstream_models(
        self,
        provider_url: str,
        api_key: str,
        provider_type: str = "openai-compatible",
        model: Optional[str] = None,
        proxy_url: Optional[str] = None,
        proxy_fallback_to_direct: Optional[bool] = None,
        timeout_ms: Optional[int] = None,
    ) -> Dict[str, Any]:
        """POST /api/v1/providers/upstream-models:fetch — fetch upstream models."""
        body: Dict[str, Any] = {
            "providerUrl": provider_url,
            "apiKey": api_key,
            "providerType": provider_type,
        }
        if model is not None:
            body["model"] = model
        if proxy_url is not None:
            body["proxyUrl"] = proxy_url
        if proxy_fallback_to_direct is not None:
            body["proxyFallbackToDirect"] = proxy_fallback_to_direct
        if timeout_ms is not None:
            body["timeoutMs"] = timeout_ms
        return self._request("POST", "/api/v1/providers/upstream-models:fetch", body)

    def test_chat_completions(
        self,
        provider_url: str,
        api_key: str,
        model: str,
        proxy_url: Optional[str] = None,
        proxy_fallback_to_direct: Optional[bool] = None,
        timeout_ms: Optional[int] = None,
    ) -> Dict[str, Any]:
        """POST /api/v1/providers/test:openai-chat-completions."""
        body: Dict[str, Any] = {
            "providerUrl": provider_url,
            "apiKey": api_key,
            "model": model,
        }
        if proxy_url is not None:
            body["proxyUrl"] = proxy_url
        if proxy_fallback_to_direct is not None:
            body["proxyFallbackToDirect"] = proxy_fallback_to_direct
        if timeout_ms is not None:
            body["timeoutMs"] = timeout_ms
        return self._request(
            "POST", "/api/v1/providers/test:openai-chat-completions", body
        )

    def test_responses(
        self,
        provider_url: str,
        api_key: str,
        model: str,
        proxy_url: Optional[str] = None,
        proxy_fallback_to_direct: Optional[bool] = None,
        timeout_ms: Optional[int] = None,
    ) -> Dict[str, Any]:
        """POST /api/v1/providers/test:openai-responses."""
        body: Dict[str, Any] = {
            "providerUrl": provider_url,
            "apiKey": api_key,
            "model": model,
        }
        if proxy_url is not None:
            body["proxyUrl"] = proxy_url
        if proxy_fallback_to_direct is not None:
            body["proxyFallbackToDirect"] = proxy_fallback_to_direct
        if timeout_ms is not None:
            body["timeoutMs"] = timeout_ms
        return self._request("POST", "/api/v1/providers/test:openai-responses", body)

    def create_provider(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """POST /api/v1/providers — create a new provider."""
        return self._request("POST", "/api/v1/providers", payload)

    def patch_provider(
        self, provider_id: int, payload: Dict[str, Any]
    ) -> Dict[str, Any]:
        """PATCH /api/v1/providers/{id} — update (partial) a provider by id."""
        if not _is_finite_number(provider_id):
            raise ValueError(
                f"patch_provider: provider_id must be a number, got {provider_id!r}"
            )
        return self._request("PATCH", f"/api/v1/providers/{int(provider_id)}", payload)

    def delete_provider(self, provider_id: str) -> None:
        """DELETE /api/v1/providers/{id} — remove a provider."""
        self._request("DELETE", f"/api/v1/providers/{provider_id}")

    # -- Internal --------------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        timeout: float = 60.0,
    ) -> Dict[str, Any]:
        """Make HTTP request with Bearer auth. Parse JSON response.

        Handles application/problem+json errors. Redacts auth token from
        any error messages.

        Args:
            method: HTTP method (GET, POST, PATCH, ...).
            path: Path component (e.g. "/api/v1/providers").
            body: Optional JSON body to send.
            timeout: Total timeout in seconds for the request.

        Returns:
            Parsed JSON response as a dict (empty dict for empty bodies).

        Raises:
            CchApiError: If the server returns a non-2xx response.
        """
        url = f"{self.base_url}{path}"
        data: Optional[bytes] = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")

        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.admin_token}")
        if body is not None:
            req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "application/json")
        req.add_header(
            "User-Agent",
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        )

        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                if not raw:
                    return {}
                # Some endpoints return non-JSON; try to parse, fall back to text wrap.
                try:
                    return json.loads(raw.decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    return {"_raw": raw[:2000].decode("utf-8", errors="replace")}
        except urllib.error.HTTPError as e:
            # Drain error body and translate to CchApiError
            err_body = b""
            try:
                err_body = e.read() or b""
            except Exception:
                pass
            content_type = (e.headers.get("Content-Type") if e.headers else "") or ""
            raise self._make_api_error(
                e.code, content_type, err_body, getattr(e, "url", url)
            ) from None
        except urllib.error.URLError as e:
            # Network-level error — bubble up as a generic exception (caller will catch)
            raise RuntimeError(
                f"Network error contacting CCH: {redact_secrets(str(e))}"
            ) from e

    def _make_api_error(
        self,
        status: int,
        content_type: str,
        body: bytes,
        request_url: str,
    ) -> CchApiError:
        """Build a CchApiError from an HTTP error response."""
        instance = (
            request_url[len(self.base_url) :]
            if request_url.startswith(self.base_url)
            else request_url
        )
        if PROBLEM_JSON_CONTENT_TYPE in (content_type or "").lower():
            try:
                parsed = json.loads(body.decode("utf-8")) if body else {}
            except (ValueError, UnicodeDecodeError):
                parsed = {}
            if isinstance(parsed, dict):
                problem = CchProblemDetail(
                    type=str(parsed.get("type", "")),
                    title=str(parsed.get("title", "")),
                    status=int(parsed.get("status", status) or status),
                    detail=str(parsed.get("detail", "")),
                    instance=str(parsed.get("instance", instance) or instance),
                    error_code=str(parsed.get("errorCode", "")),
                    trace_id=parsed.get("traceId")
                    if isinstance(parsed.get("traceId"), str)
                    else None,
                    invalid_params=(
                        parsed.get("invalidParams")
                        if isinstance(parsed.get("invalidParams"), list)
                        else None
                    ),
                )
            else:
                problem = CchProblemDetail(
                    type="urn:claude-code-hub:problem:http-error",
                    title=f"HTTP Error {status}",
                    status=status,
                    detail=str(parsed)[:500],
                    instance=instance,
                    error_code="http.error",
                )
        else:
            # Fallback for non-problem+json error responses
            detail_text = ""
            if body:
                try:
                    detail_text = body.decode("utf-8", errors="replace")
                except Exception:
                    detail_text = ""
            if not detail_text:
                detail_text = f"HTTP {status}"
            problem = CchProblemDetail(
                type="urn:claude-code-hub:problem:http-error",
                title=f"HTTP Error {status}",
                status=status,
                detail=detail_text,
                instance=instance,
                error_code="http.error",
            )
        return CchApiError(status, problem)

    @staticmethod
    def _normalize_provider_item(item: Any) -> Dict[str, Any]:
        """Coerce a provider item from the CCH list API into a uniform dict."""
        if not isinstance(item, dict):
            return {
                "id": 0,
                "name": "",
                "url": "",
                "isEnabled": False,
                "providerType": "",
            }
        # TS tolerated `provider_type` or `providerType`; mirror that flexibility.
        provider_type = item.get("provider_type", item.get("providerType", ""))
        out = {
            "id": item.get("id", 0),
            "name": item.get("name", ""),
            "url": item.get("url", ""),
            "isEnabled": item.get("isEnabled", item.get("is_enabled", False)),
            "providerType": provider_type,
        }
        # Carry through any other fields for the planner to consume.
        for k, v in item.items():
            if k not in out and k not in ("provider_type", "is_enabled"):
                out[k] = v
        return out


def create_cch_client_from_env() -> CchClient:
    """Create a CchClient from environment variables.

    Reads CCH_BASE_URL and CCH_ADMIN_TOKEN. Raises CchClientConfigError
    if either is missing or empty.

    Returns:
        Configured CchClient instance.
    """
    base_url = os.environ.get("CCH_BASE_URL", "")
    admin_token = os.environ.get("CCH_ADMIN_TOKEN", "")
    return CchClient(base_url=base_url, admin_token=admin_token)


# ============================================================================
# Section 6: Upstream discovery
# ============================================================================
# Mirrors scripts/sync-upstream-providers/upstream-discovery.ts


@dataclass
class SyncCandidate:
    """A sync-ready candidate produced by the bridge."""

    host: str
    username: str
    key_id: int
    key_name: str
    key: str  # Full API key (never logged)
    key_masked: str
    status: str
    group: str
    upstream_resolved_rate_multiplier: Optional[float]
    expected_rate: Optional[float]
    recharge_multiplier: float
    actual_multiplier: float
    unlimited_quota: bool
    remain_quota: Optional[float]
    used_quota: Optional[float]
    expired_time: Optional[str]
    expired: bool
    site_login_success: bool


@dataclass
class SkippedKey:
    """A reason a key was excluded from candidates (no secrets in reason)."""

    key_id: int
    key_name: str
    reason: str


@dataclass
class DiscoveryResult:
    """Summary of the discovery process."""

    candidates: List[SyncCandidate]
    skipped_keys: List[SkippedKey]
    warnings: List[str]


@dataclass
class Sha256Filter:
    """A filter entry that pins a specific API key by its SHA256 hash."""

    host: str
    username: str
    api_key_sha256: str


ClockFn = Callable[[], "_dt.datetime"]


def _default_clock() -> _dt.datetime:
    """Default clock: current UTC time."""
    return _dt.datetime.now(_dt.timezone.utc)


def _normalize_host_for_match(raw: str) -> str:
    """Normalize a host string for matching by stripping scheme and trailing slash."""
    return re.sub(r"^https?:\/\/", "", raw or "").rstrip("/").lower()


def load_provider_results(json_path: str) -> List[Dict[str, Any]]:
    """Read and parse a provider_client --json output file.

    The file must contain a JSON array of provider client output objects.

    Args:
        json_path: Path to the provider_client --json output file.

    Returns:
        Parsed list of provider client output dicts.

    Raises:
        FileNotFoundError: If the file cannot be read.
        ValueError: If JSON is invalid or top-level value is not an array.
    """
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            raw = f.read()
    except OSError as err:
        raise FileNotFoundError(
            f"Failed to read provider results file {json_path}: {err}"
        ) from err

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as err:
        raise ValueError(f"Failed to parse JSON in {json_path}: {err}") from err

    if not isinstance(parsed, list):
        kind = "object" if isinstance(parsed, dict) else type(parsed).__name__
        raise ValueError(f"Expected JSON array in {json_path}, got {kind}")

    return parsed  # type: ignore[return-value]


def is_expired_key(
    expired_time: Optional[str], now: Optional[_dt.datetime] = None
) -> bool:
    """Determine whether a key's expired_time has passed relative to `now`.

    Rules:
      - None / empty string: never expired (no expiry known)
      - Invalid date string: never expired (treat as unknown, not as stale)
      - Valid date in the past: expired
      - Valid date in the future or exactly now: not expired

    Args:
        expired_time: ISO 8601 string, None, or empty.
        now: Reference "now" (defaults to UTC current time).

    Returns:
        True when expired_time exists and is a valid past date.
    """
    if not expired_time:
        return False
    try:
        ts = _dt.datetime.fromisoformat(expired_time.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return False
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=_dt.timezone.utc)
    if now is None:
        now = _dt.datetime.now(_dt.timezone.utc)
    elif now.tzinfo is None:
        now = now.replace(tzinfo=_dt.timezone.utc)
    return ts < now


def filter_enabled_keys(
    api_keys: Sequence[Dict[str, Any]],
    now: Optional[_dt.datetime] = None,
) -> Tuple[List[Dict[str, Any]], List[SkippedKey]]:
    """Filter API keys to those eligible for sync candidates.

    Skip rules (in order of evaluation):
      1. status is not "enabled" (covers "disabled" and "exhausted")
      2. expired_time is in the past
      3. remain_quota is 0 or less AND not unlimited_quota

    Args:
        api_keys: Raw API keys from a single site result.
        now: Reference "now" for expiry checks.

    Returns:
        Tuple of (enabled keys, skipped reasons).
    """
    enabled: List[Dict[str, Any]] = []
    skipped: List[SkippedKey] = []

    for k in api_keys:
        status = str(k.get("status", ""))
        if status not in ("enabled", "active"):
            skipped.append(
                SkippedKey(
                    key_id=int(k.get("id", 0) or 0),
                    key_name=str(k.get("name", "")),
                    reason=f'Key status is "{status}", only "enabled"/"active" keys are syncable',
                )
            )
            continue

        expired_time = k.get("expired_time")
        if is_expired_key(expired_time, now):
            skipped.append(
                SkippedKey(
                    key_id=int(k.get("id", 0) or 0),
                    key_name=str(k.get("name", "")),
                    reason=f"Key expired at {expired_time or 'unknown'}",
                )
            )
            continue

        unlimited = bool(k.get("unlimited_quota", False))
        if not unlimited:
            remain = k.get("remain_quota")
            if remain is not None and isinstance(remain, (int, float)) and remain <= 0:
                skipped.append(
                    SkippedKey(
                        key_id=int(k.get("id", 0) or 0),
                        key_name=str(k.get("name", "")),
                        reason="Key has zero remaining quota and is not unlimited",
                    )
                )
                continue

        enabled.append(k)

    return enabled, skipped


def try_build_candidate(
    site: Dict[str, Any],
    api_key: Dict[str, Any],
    expected_rate: Optional[float],
    now: Optional[_dt.datetime] = None,
) -> Optional[SyncCandidate]:
    """Build a SyncCandidate, or return None when no rate can be resolved.

    Exposed for unit-testability of the per-key decision logic.

    Args:
        site: Site result dict from provider_client.
        api_key: API key dict.
        expected_rate: Site-level expected rate.
        now: Reference "now" for expiry checks.

    Returns:
        A SyncCandidate or None.
    """
    resolved = api_key.get("resolved_rate_multiplier")
    has_resolved = resolved is not None and _is_finite_number(resolved)
    has_expected = expected_rate is not None and _is_finite_number(expected_rate)

    if not has_resolved and not has_expected:
        return None

    recharge = site.get("recharge_multiplier")
    if not _is_finite_number(recharge):
        return None
    recharge_f = float(recharge)

    try:
        if has_resolved:
            actual_multiplier = compute_actual_multiplier(float(resolved), recharge_f)
        else:
            # expectedRate is the only available upstream signal — use it via fallback
            actual_multiplier = compute_actual_multiplier(
                float("nan"),
                recharge_f,
                expected_rate=float(expected_rate),  # type: ignore[arg-type]
                allow_fallback=True,
            )
    except (ValueError, ZeroDivisionError, ArithmeticError):
        return None

    expired_time = api_key.get("expired_time")
    expired = is_expired_key(expired_time, now)

    return SyncCandidate(
        host=str(site.get("host", "")),
        username=str(site.get("username", "")),
        key_id=int(api_key.get("id", 0) or 0),
        key_name=str(api_key.get("name", "")),
        key=str(api_key.get("key", "")),
        key_masked=str(api_key.get("key_masked", "")),
        status=str(api_key.get("status", "")),
        group=str(api_key.get("group", "")),
        upstream_resolved_rate_multiplier=float(resolved) if has_resolved else None,
        expected_rate=float(expected_rate) if has_expected else None,
        recharge_multiplier=recharge_f,
        actual_multiplier=actual_multiplier,
        unlimited_quota=bool(api_key.get("unlimited_quota", False)),
        remain_quota=(
            float(api_key["remain_quota"])
            if isinstance(api_key.get("remain_quota"), (int, float))
            else None
        ),
        used_quota=(
            float(api_key["used_quota"])
            if isinstance(api_key.get("used_quota"), (int, float))
            else None
        ),
        expired_time=str(expired_time) if isinstance(expired_time, str) else None,
        expired=expired,
        site_login_success=bool(site.get("login_success", False)),
    )


def _normalize_api_key(raw: str) -> str:
    """Strip ``sk-`` prefix if present; provider_client stores keys without it."""
    k = raw.strip()
    if k.startswith("sk-"):
        return k[3:]
    return k


def try_fetch_rate_from_upstream(host: str, api_key: str) -> Optional[float]:
    """Try to fetch the group rate multiplier from upstream /api/pricing endpoint.

    new-api exposes /api/pricing with ``group_ratio`` even to API-key-authenticated
    requests.  sub2api requires a session cookie, so this call will only work
    for new-api instances and silently returns None otherwise.
    """
    url = f"{host.rstrip('/')}/api/pricing"
    req = urllib.request.Request(url, method="GET")
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        gr = body.get("group_ratio") if isinstance(body, dict) else None
        if isinstance(gr, dict):
            # Return the first non-zero rate found — the caller can refine
            # with a specific group name later.
            for _g, r in gr.items():
                if _is_finite_number(r) and float(r) > 0:
                    return float(r)
        return None
    except Exception:
        return None


def inject_direct_api_keys(
    results: Sequence[Dict[str, Any]],
    entries: Sequence[ValidatedProviderEntry],
) -> List[Dict[str, Any]]:
    """Inject synthetic result entries for config entries that have an ``apiKey``
    but whose upstream login failed (or who have no result entry at all).

    For each such entry:
      1. Create a synthetic site result with ``login_success=True``.
      2. Add a single API-key dict carrying the raw key.
      3. Try to fetch the rate multiplier from the upstream ``/api/pricing``
         endpoint; fall back to the config's ``rateMultiplier`` if the API call
         fails or the upstream is not a new-api instance.

    Args:
        results: Provider-client results (one entry per site).
        entries: Validated config entries.

    Returns:
        Augmented results list.
    """
    out = list(results)
    result_by_host: Dict[str, Dict[str, Any]] = {r.get("host"): r for r in results}

    for e in entries:
        if not e.api_key:
            continue

        existing = result_by_host.get(e.host)
        if existing is not None and not existing.get("login_success", False):
            # Login failed — replace with synthetic entry.
            out = [r for r in out if r.get("host") != e.host]
            existing = None

        if existing is not None:
            # For login-succeeded sites, just add the key if it doesn't exist yet.
            existing_keys = existing.get("api_keys") or []
            existing_hashes = {
                hashlib.sha256(k.get("key", "").encode("utf-8")).hexdigest()
                for k in existing_keys
                if k.get("key")
            }
            # Also include normalized (no ``sk-`` prefix) hashes for comparison.
            existing_hashes.update(
                hashlib.sha256(
                    _normalize_api_key(k.get("key", "")).encode("utf-8")
                ).hexdigest()
                for k in existing_keys
                if k.get("key")
            )
            # Compute config key hash both original and normalized.
            config_key_hash = hashlib.sha256(e.api_key.encode("utf-8")).hexdigest()
            config_key_norm_hash = hashlib.sha256(
                _normalize_api_key(e.api_key).encode("utf-8")
            ).hexdigest()
            if (
                config_key_hash in existing_hashes
                or config_key_norm_hash in existing_hashes
            ):
                # Key already in result — still override rate if config has rateMultiplier.
                if e.rate_multiplier is not None:
                    for k in existing_keys:
                        kh = hashlib.sha256(
                            _normalize_api_key(k.get("key", "")).encode("utf-8")
                        ).hexdigest()
                        if kh == config_key_norm_hash:
                            k["resolved_rate_multiplier"] = e.rate_multiplier
                            k["_rate_overridden"] = True
                            break
                # Also override site-level recharge_multiplier to match config.
                existing["recharge_multiplier"] = e.recharge_multiplier
                continue

            # Key is new — append it to the existing site result.
            # Also sync the site-level recharge_multiplier.
            existing["recharge_multiplier"] = e.recharge_multiplier

            # Resolve rate for this key and append.
            resolved_rate = try_fetch_rate_from_upstream(e.host, e.api_key)
            if resolved_rate is None and e.rate_multiplier is not None:
                resolved_rate = e.rate_multiplier

            existing_keys.append(
                {
                    "key": e.api_key,
                    "key_name": e.username,
                    "group_name": "",
                    "resolved_rate_multiplier": resolved_rate,
                    "status": "active",
                    "unlimited_quota": True,
                }
            )
            continue

        # No existing result — create synthetic site entry.
        resolved_rate = try_fetch_rate_from_upstream(e.host, e.api_key)
        if resolved_rate is None and e.rate_multiplier is not None:
            resolved_rate = e.rate_multiplier

        api_key_entry: Dict[str, Any] = {
            "key": e.api_key,
            "key_name": "direct",
            "group_name": "",
            "resolved_rate_multiplier": resolved_rate,
            "status": "active",
            "unlimited_quota": True,
        }

        synthetic: Dict[str, Any] = {
            "host": e.host,
            "username": e.username,
            "login_success": True,
            "site_type": "unknown",
            "api_keys": [api_key_entry],
            "data_complete": True,
            "raw_data": {},
            "recharge_multiplier": e.recharge_multiplier,
            "rate_multipliers": {},
            "expected_rate": None,
            "balance": None,
            "balance_usd": None,
            "error": None,
        }
        out.append(synthetic)

    return out


def _read_expected_rate(site: Dict[str, Any]) -> Optional[float]:
    """Read the site-level expected rate (from expected_rate or rate_multipliers['default'])."""
    er = site.get("expected_rate")
    if er is not None and _is_finite_number(er):
        return float(er)
    rm = site.get("rate_multipliers")
    if isinstance(rm, dict):
        default = rm.get("default")
        if _is_finite_number(default):
            return float(default)
    return None


def map_to_candidates(
    results: Sequence[Dict[str, Any]],
    now: Optional[_dt.datetime] = None,
) -> Tuple[List[SyncCandidate], List[SkippedKey], List[str]]:
    """Map parsed provider_client results to sync-ready candidates.

    For each site with login_success: true:
      - Filter enabled keys via filter_enabled_keys
      - Compute actualMultiplier per key (with expectedRate fallback)
      - Skip keys when neither resolved nor expected rate is available

    Args:
        results: Parsed provider_client output.
        now: Reference "now" for expiry checks.

    Returns:
        Tuple of (candidates, skipped_keys, warnings).
    """
    if now is None:
        now = _dt.datetime.now(_dt.timezone.utc)
    candidates: List[SyncCandidate] = []
    skipped_keys: List[SkippedKey] = []
    warnings: List[str] = []

    for site in results:
        host = str(site.get("host", ""))
        username = str(site.get("username", ""))

        if not site.get("login_success", False):
            err = site.get("error", "no error message")
            warnings.append(f"Site {host} (user {username}) login failed: {err}")
            continue

        api_keys = site.get("api_keys") or []
        if not api_keys:
            warnings.append(f"Site {host} (user {username}) returned no API keys")
            continue

        expected_rate = _read_expected_rate(site)
        enabled, skipped = filter_enabled_keys(api_keys, now)
        skipped_keys.extend(skipped)

        for k in enabled:
            candidate = try_build_candidate(site, k, expected_rate, now)
            if candidate is None:
                kid = int(k.get("id", 0) or 0)
                kname = str(k.get("name", ""))
                skipped_keys.append(
                    SkippedKey(
                        key_id=kid,
                        key_name=kname,
                        reason="No rate multiplier or expected rate available",
                    )
                )
                warnings.append(
                    f'Site {host} key "{kname}" (id={kid}) has no resolved rate and no expected rate'
                )
                continue
            candidates.append(candidate)

    if not candidates and results:
        warnings.append("Discovery produced no sync candidates")

    return candidates, skipped_keys, warnings


def filter_keys_by_sha256(
    results: Sequence[Dict[str, Any]],
    sha256_filters: Sequence[Union[Sha256Filter, Dict[str, Any]]],
) -> List[Dict[str, Any]]:
    """Filter each site's API keys against a set of SHA256 pin entries.

    For each site result, if a matching filter exists (by host + username),
    only API keys whose hex SHA256 matches the pin are kept. Sites without
    a matching filter are returned unchanged.

    Args:
        results: Provider client output (one entry per site).
        sha256_filters: SHA256 pin entries from config (host, username, sha256).

    Returns:
        New list with filtered api_keys per site.
    """
    if not sha256_filters:
        return list(results)

    filter_map: Dict[str, Set[str]] = {}
    for f in sha256_filters:
        if isinstance(f, dict):
            host = str(f.get("host", ""))
            username = str(f.get("username", ""))
            sha = str(f.get("apiKeySha256", ""))
        else:
            host = f.host
            username = f.username
            sha = f.api_key_sha256
        key = f"{_normalize_host_for_match(host)}::{username}"
        if key not in filter_map:
            filter_map[key] = set()
        filter_map[key].add(sha)

    out: List[Dict[str, Any]] = []
    for site in results:
        host = str(site.get("host", ""))
        username = str(site.get("username", ""))
        site_key = f"{_normalize_host_for_match(host)}::{username}"
        expected_shas = filter_map.get(site_key)
        api_keys = site.get("api_keys") or []
        if not expected_shas or not api_keys:
            out.append(site)
            continue

        filtered = []
        for k in api_keys:
            key_value = str(k.get("key", ""))
            if not key_value:
                continue
            digest = hashlib.sha256(key_value.encode("utf-8")).hexdigest()
            norm_digest = hashlib.sha256(
                _normalize_api_key(key_value).encode("utf-8")
            ).hexdigest()
            if digest in expected_shas or norm_digest in expected_shas:
                filtered.append(k)
        out.append({**site, "api_keys": filtered})
    return out


# ============================================================================
# Section 7: Sync planner
# ============================================================================
# Mirrors scripts/sync-upstream-providers/sync-planner.ts

ApiType = str  # "chat" | "responses"

API_TYPE_TO_PROVIDER_TYPE: Dict[str, str] = {
    "chat": "openai-compatible",
    "responses": "codex",
}

FALLBACK_MODELS: Tuple[str, ...] = (
    "gpt-4o",
    "gpt-4o-mini",
    "claude-sonnet-4-20250514",
)

CCHSYNC_PREFIX = "cchsync_"

CIRCUIT_BREAKER_FAILURE_THRESHOLD = 1
CIRCUIT_BREAKER_OPEN_DURATION_MS = 300_000
CIRCUIT_BREAKER_MAX_RETRY_ATTEMPTS = 1
FIRST_BYTE_TIMEOUT_STREAMING_MS = 3_000


@dataclass
class AllowedModelRule:
    """An allowed-model rule object."""

    match_type: str  # always "exact"
    pattern: str

    def to_dict(self) -> Dict[str, str]:
        return {"matchType": self.match_type, "pattern": self.pattern}


@dataclass
class TestedModel:
    """A single model that was tested against a specific API type."""

    model_id: str
    api_type: ApiType
    passed: bool
    error: Optional[str] = None


@dataclass
class TestResults:
    """Results of testing all models for one SyncCandidate across API types."""

    candidate: SyncCandidate
    models: List[TestedModel]
    passing_by_type: Dict[ApiType, List[str]]


@dataclass
class DesiredProvider:
    """A desired provider payload derived from passing tests."""

    name: str
    api_type: ApiType
    host_token: str
    upstream_key_ref: str
    actual_multiplier: float
    provider_type: str
    url: str
    key: str  # never logged
    priority: int
    passing_models: List[str]
    allowed_models: List[AllowedModelRule]


@dataclass
class ProviderOperation:
    """A provider mutation operation, matching CCH API shape."""

    operation: str  # "create" | "patch"
    provider_type: str
    name: str
    url: str
    key: str  # never logged
    priority: int
    cost_multiplier: float
    allowed_models: List[AllowedModelRule]
    circuit_breaker_failure_threshold: int = CIRCUIT_BREAKER_FAILURE_THRESHOLD
    circuit_breaker_open_duration: int = CIRCUIT_BREAKER_OPEN_DURATION_MS
    circuit_breaker_max_retry_attempts: int = CIRCUIT_BREAKER_MAX_RETRY_ATTEMPTS
    first_byte_timeout_streaming_ms: int = FIRST_BYTE_TIMEOUT_STREAMING_MS
    remote_provider_id: Optional[str] = None


@dataclass
class RemoteProvider:
    """Remote provider from CCH API (relevant fields)."""

    id: str
    name: str
    provider_type: str
    url: str
    key: str
    priority: int
    cost_multiplier: float
    allowed_models: List[AllowedModelRule]
    extra: Dict[str, Any] = field(default_factory=dict)


@dataclass
class MatchResult:
    """Result of matching desired providers against remote providers."""

    creates: List[ProviderOperation]
    patches: List[ProviderOperation]
    unchanged: List[str]
    stale_self_managed: List[Tuple[str, str]]


@dataclass
class MatchContext:
    """Optional context for matching: names that should NOT be flagged as stale."""

    candidate_tested_names: Set[str] = field(default_factory=set)


@dataclass
class SyncPlan:
    """Full sync plan for all candidates."""

    operations: List[ProviderOperation]
    stale_self_managed: List[Tuple[str, str]]
    test_failed_unchanged: List[str]
    warnings: List[str]


# Backwards-compatible alias used by the CLI print helper.
Unchanged = List[str]


def build_test_plan(
    _candidate: SyncCandidate,
    upstream_models: Sequence[str],
) -> Dict[str, List[str]]:
    """Plan which models to test for each API type.

    Priority:
      1. If `upstream_models` is non-empty → use it for both types
      2. Otherwise → use FALLBACK_MODELS for both types
      3. Deduplicate the resulting lists, preserving first occurrence

    Args:
        _candidate: Sync candidate (reserved for future per-candidate logic).
        upstream_models: Upstream model list (may be empty).

    Returns:
        Dict with deduplicated chat and responses model lists.
    """
    source = list(upstream_models) if upstream_models else list(FALLBACK_MODELS)
    deduped: List[str] = []
    seen: Set[str] = set()
    for m in source:
        if m not in seen:
            seen.add(m)
            deduped.append(m)
    return {"chatModels": list(deduped), "responsesModels": list(deduped)}


def _safe_test(candidate_key: str, fn: Callable[[], Dict[str, Any]]) -> Dict[str, Any]:
    """Run a model test and convert any thrown error to a redacted string.

    Never propagates exceptions; treats throws as failures.
    """
    try:
        fn()
        return {"passed": True}
    except Exception as err:  # noqa: BLE001 — treat all errors as test failures
        raw = (
            err.message
            if hasattr(err, "message") and isinstance(err.message, str)
            else str(err)
        )
        # Defense-in-depth: strip the candidate's key value first, then apply
        # the general redaction rules.
        if candidate_key:
            key_stripped = (
                raw.split(candidate_key).join(["[REDACTED]"])
                if False
                else raw.replace(candidate_key, "[REDACTED]")
            )
        else:
            key_stripped = raw
        return {"passed": False, "error": redact_secrets(key_stripped)}


def run_model_tests(
    candidate: SyncCandidate,
    chat_models: Sequence[str],
    responses_models: Sequence[str],
    cch_client: CchClient,
) -> TestResults:
    """Test all models for a single candidate against both API endpoints.

    For each chat model, calls cch_client.test_chat_completions; for each
    responses model, calls cch_client.test_responses. Records pass/fail and
    a redacted error message on failure.

    Args:
        candidate: Upstream sync candidate.
        chat_models: Models to test against the chat endpoint.
        responses_models: Models to test against the responses endpoint.
        cch_client: CCH REST client.

    Returns:
        TestResults with all tested models.
    """
    models: List[TestedModel] = []
    chat_passes: List[str] = []
    responses_passes: List[str] = []

    for model_id in chat_models:
        result = _safe_test(
            candidate.key,
            lambda mid=model_id: cch_client.test_chat_completions(
                provider_url=candidate.host, api_key=candidate.key, model=mid
            ),
        )
        models.append(
            TestedModel(
                model_id=model_id,
                api_type="chat",
                passed=bool(result.get("passed")),
                error=result.get("error"),
            )
        )
        if result.get("passed"):
            chat_passes.append(model_id)

    for model_id in responses_models:
        result = _safe_test(
            candidate.key,
            lambda mid=model_id: cch_client.test_responses(
                provider_url=candidate.host, api_key=candidate.key, model=mid
            ),
        )
        models.append(
            TestedModel(
                model_id=model_id,
                api_type="responses",
                passed=bool(result.get("passed")),
                error=result.get("error"),
            )
        )
        if result.get("passed"):
            responses_passes.append(model_id)

    passing_by_type: Dict[ApiType, List[str]] = {}
    if chat_passes:
        passing_by_type["chat"] = chat_passes
    if responses_passes:
        passing_by_type["responses"] = responses_passes

    return TestResults(
        candidate=candidate, models=models, passing_by_type=passing_by_type
    )


def run_model_tests_batch(
    candidates: Sequence[SyncCandidate],
    test_plans: Sequence[Dict[str, List[str]]],
    cch_client: CchClient,
    max_workers: int = 20,
) -> List[TestResults]:
    """Run all model tests across all candidates concurrently.

    Builds a flat list of all (candidate_idx, model_id, api_type) test tasks
    and submits them to a ThreadPoolExecutor. Groups the results back into
    per-candidate TestResults.

    Args:
        candidates: All sync candidates.
        test_plans: Per-candidate model lists (chatModels, responsesModels).
        cch_client: CCH REST client.
        max_workers: Max concurrent test threads (default 20).

    Returns:
        List of TestResults, one per candidate, in same order as ``candidates``.
    """
    if len(candidates) != len(test_plans):
        raise ValueError(
            f"candidates ({len(candidates)}) / test_plans ({len(test_plans)}) mismatch"
        )

    # ── 1. Build flat task list ──────────────────────────────────
    # Each task: (candidate_idx, model_id, api_type, fn)
    Task = Tuple[int, str, str, Callable[[], Dict[str, Any]]]

    tasks: List[Task] = []
    for i, c in enumerate(candidates):
        plan = test_plans[i]
        key = c.key
        host = c.host
        for model_id in plan.get("chatModels") or []:
            mid = model_id
            tasks.append(
                (
                    i,
                    model_id,
                    "chat",
                    lambda _key=key, _host=host, _mid=mid: _safe_test(
                        _key,
                        lambda: cch_client.test_chat_completions(
                            provider_url=_host, api_key=_key, model=_mid
                        ),
                    ),
                )
            )
        for model_id in plan.get("responsesModels") or []:
            mid = model_id
            tasks.append(
                (
                    i,
                    model_id,
                    "responses",
                    lambda _key=key, _host=host, _mid=mid: _safe_test(
                        _key,
                        lambda: cch_client.test_responses(
                            provider_url=_host, api_key=_key, model=_mid
                        ),
                    ),
                )
            )

    # ── 2. Submit all tasks concurrently ──────────────────────────
    # Per-candidate accumulators
    tested_models: List[List[TestedModel]] = [[] for _ in candidates]
    chat_pass: List[List[str]] = [[] for _ in candidates]
    resp_pass: List[List[str]] = [[] for _ in candidates]

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
        fut_to_task = {pool.submit(fn): (idx, mid, at) for idx, mid, at, fn in tasks}
        for fut in concurrent.futures.as_completed(fut_to_task):
            idx, model_id, api_type = fut_to_task[fut]
            key = candidates[idx].key
            try:
                result = fut.result()
                passed = (
                    bool(result.get("passed")) if isinstance(result, dict) else False
                )
                error = result.get("error") if isinstance(result, dict) else str(result)
            except Exception as exc:
                passed = False
                error = redact_secrets(str(exc))

            tested_models[idx].append(
                TestedModel(
                    model_id=model_id, api_type=api_type, passed=passed, error=error
                )
            )
            if passed and api_type == "chat":
                chat_pass[idx].append(model_id)
            elif passed and api_type == "responses":
                resp_pass[idx].append(model_id)

    # ── 3. Build TestResults ─────────────────────────────────────
    results: List[TestResults] = []
    for i, c in enumerate(candidates):
        passing_by_type: Dict[str, List[str]] = {}
        if chat_pass[i]:
            passing_by_type["chat"] = chat_pass[i]
        if resp_pass[i]:
            passing_by_type["responses"] = resp_pass[i]
        results.append(
            TestResults(
                candidate=c, models=tested_models[i], passing_by_type=passing_by_type
            )
        )

    return results


def _make_synthetic_test_result(
    candidate: SyncCandidate, all_models: List[str]
) -> TestResults:
    """Build TestResults where every model passes (no testing done).

    Args:
        candidate: The sync candidate.
        all_models: Model IDs to mark as passed for both chat and responses.

    Returns:
        TestResults with all models passed.
    """
    models_list: List[TestedModel] = []
    for m in all_models:
        models_list.append(
            TestedModel(model_id=m, api_type="chat", passed=True, error=None)
        )
        models_list.append(
            TestedModel(model_id=m, api_type="responses", passed=True, error=None)
        )
    return TestResults(
        candidate=candidate,
        models=models_list,
        passing_by_type={
            "chat": list(all_models),
            "responses": list(all_models),
        },
    )


def _merge_with_trusted(
    tested: TestResults, candidate: SyncCandidate, trusted_models: List[str]
) -> TestResults:
    """Merge real test results with additional trusted (auto-passed) models.

    Args:
        tested: Real test results for whitelisted models.
        candidate: The sync candidate (used only if merge needed).
        trusted_models: Model IDs to auto-pass.

    Returns:
        Combined TestResults.
    """
    models_list = list(tested.models)
    chat_passing = set(tested.passing_by_type.get("chat") or [])
    resp_passing = set(tested.passing_by_type.get("responses") or [])
    for m in trusted_models:
        models_list.append(
            TestedModel(model_id=m, api_type="chat", passed=True, error=None)
        )
        models_list.append(
            TestedModel(model_id=m, api_type="responses", passed=True, error=None)
        )
        chat_passing.add(m)
        resp_passing.add(m)
    return TestResults(
        candidate=candidate,
        models=models_list,
        passing_by_type={
            "chat": sorted(chat_passing),
            "responses": sorted(resp_passing),
        },
    )


def _make_desired(
    tr: TestResults,
    api_type: ApiType,
    host_token: str,
    upstream_key_ref: str,
    model_id: Optional[str] = None,
) -> DesiredProvider:
    """Build a single DesiredProvider entry for one API type, optionally scoped to one model."""
    candidate = tr.candidate
    type_token: ProviderTypeToken = api_type
    name = build_generated_name(
        candidate.host, type_token, candidate.actual_multiplier, model_id=model_id
    )
    if model_id:
        passing_models = [model_id]
    else:
        passing_models = list(tr.passing_by_type.get(api_type) or [])
    allowed_models = [
        AllowedModelRule(match_type="exact", pattern=m) for m in passing_models
    ]
    return DesiredProvider(
        name=name,
        api_type=api_type,
        host_token=host_token,
        upstream_key_ref=upstream_key_ref,
        actual_multiplier=candidate.actual_multiplier,
        provider_type=API_TYPE_TO_PROVIDER_TYPE[api_type],
        url=candidate.host,
        key=candidate.key,
        priority=0,
        passing_models=passing_models,
        allowed_models=allowed_models,
    )


def build_desired_providers(
    test_results: Sequence[TestResults],
) -> List[DesiredProvider]:
    """Build desired provider payloads from test results, one per model per API type.

    Each passing model gets its own provider so CCH can apply per-model
    circuit breaker independently. Priorities are assigned across the FULL batch
    via assign_priorities, ensuring stable ordering across all candidates.

    Args:
        test_results: Array of test results.

    Returns:
        List of desired provider payloads with assigned priorities.
    """
    fragments: List[DesiredProvider] = []

    for tr in test_results:
        candidate = tr.candidate
        host_token = normalize_host_token(candidate.host)
        upstream_key_ref = str(candidate.key_id)

        for model_id in tr.passing_by_type.get("chat") or []:
            fragments.append(
                _make_desired(
                    tr, "chat", host_token, upstream_key_ref, model_id=model_id
                )
            )
        for model_id in tr.passing_by_type.get("responses") or []:
            fragments.append(
                _make_desired(
                    tr, "responses", host_token, upstream_key_ref, model_id=model_id
                )
            )

    if not fragments:
        return []

    priority_inputs = [
        PriorityInput(
            actual_multiplier=d.actual_multiplier,
            host=d.host_token,
            type_token=d.api_type,
            upstream_key_ref=d.upstream_key_ref,
        )
        for d in fragments
    ]
    priority_map = assign_priorities(priority_inputs)

    for d in fragments:
        key = f"{d.host_token}:{d.api_type}:{d.upstream_key_ref}"
        d.priority = priority_map.get(key, PRIORITY_MAX)

    return fragments


def _remote_matches_desired(remote: RemoteProvider, desired: DesiredProvider) -> bool:
    """Return True iff remote's mutable fields match desired exactly."""
    if remote.provider_type != desired.provider_type:
        return False
    if remote.url != desired.url:
        return False
    if remote.priority != desired.priority:
        return False
    # Compare cost_multiplier using exact equality — TypeScript used ===, and the
    # candidates are computed from the same source.
    if remote.cost_multiplier != desired.actual_multiplier:
        return False
    if len(remote.allowed_models) != len(desired.allowed_models):
        return False
    remote_set = {f"{m.match_type}:{m.pattern}" for m in remote.allowed_models}
    for m in desired.allowed_models:
        if f"{m.match_type}:{m.pattern}" not in remote_set:
            return False
    return True


def _to_operation(
    desired: DesiredProvider,
    operation: str,
    remote_provider_id: Optional[str],
) -> ProviderOperation:
    """Convert a DesiredProvider to a ProviderOperation."""
    return ProviderOperation(
        operation=operation,
        provider_type=desired.provider_type,
        name=desired.name,
        url=desired.url,
        key=desired.key,
        priority=desired.priority,
        cost_multiplier=desired.actual_multiplier,
        allowed_models=list(desired.allowed_models),
        remote_provider_id=remote_provider_id,
    )


def match_remote_providers(
    desired: Sequence[DesiredProvider],
    remote: Sequence[RemoteProvider],
    context: Optional[MatchContext] = None,
) -> MatchResult:
    """Match desired providers against existing remote providers.

    Matching rule: a desired provider matches a remote provider when both
    carry the same generated `name`. This name is deterministic and encodes
    the host token, type token, and actual multiplier.

    Outcomes:
      - Desired + matching remote + identical fields → unchanged (no operation)
      - Desired + matching remote + differing fields → patch (with remoteProviderId)
      - Desired + no matching remote → create
      - Remote cchsync_ + no matching desired + no candidate context → stale
      - Remote cchsync_ + name listed in `context.candidateTestedNames` → NOT stale
        (distinguishes "no candidate at all" from "candidate tested but failed")
      - Remote non-cchsync_ → ignored entirely

    Args:
        desired: Desired providers from build_desired_providers.
        remote: Existing remote providers from CCH.
        context: Optional matching context (candidate test results).

    Returns:
        Categorized MatchResult.
    """
    ctx = context if context is not None else MatchContext()
    by_name: Dict[str, RemoteProvider] = {r.name: r for r in remote}

    creates: List[ProviderOperation] = []
    patches: List[ProviderOperation] = []
    unchanged: List[str] = []
    matched_remote_ids: Set[str] = set()
    matched_desired_names: Set[str] = set()

    for d in desired:
        r = by_name.get(d.name)
        if r is None:
            creates.append(_to_operation(d, "create", None))
            matched_desired_names.add(d.name)
            continue
        matched_remote_ids.add(r.id)
        matched_desired_names.add(d.name)
        if _remote_matches_desired(r, d):
            unchanged.append(d.name)
        else:
            patches.append(_to_operation(d, "patch", r.id))

    stale_self_managed: List[Tuple[str, str]] = []
    for r in remote:
        if not r.name.startswith(CCHSYNC_PREFIX):
            continue
        if r.id in matched_remote_ids:
            continue
        if r.name in matched_desired_names:
            continue
        if r.name in ctx.candidate_tested_names:
            continue
        stale_self_managed.append((r.name, r.id))

    return MatchResult(
        creates=creates,
        patches=patches,
        unchanged=unchanged,
        stale_self_managed=stale_self_managed,
    )


def _upstream_key(c: SyncCandidate) -> str:
    """Composite key used to look up per-candidate upstream model lists."""
    return f"{c.host}::{c.key_id}"


def plan_sync(
    candidates: Sequence[SyncCandidate],
    remote_providers: Sequence[RemoteProvider],
    cch_client: Optional[CchClient] = None,
    upstream_models: Optional[Mapping[str, Sequence[str]]] = None,
    pre_tested_results: Optional[Sequence[TestResults]] = None,
    test_concurrency: int = 20,
    skip_model_tests: bool = False,
    test_model_whitelist: Optional[Set[str]] = None,
    config_entries: Optional[Sequence[ValidatedProviderEntry]] = None,
) -> SyncPlan:
    """Plan the full set of provider mutations required to reconcile upstream
    candidates with the existing CCH provider state.

    Flow:
      1. For each candidate, build the test plan (model list per API type)
      2. Either run model tests (production) or use pre-tested results
      3. Build desired provider payloads from passing tests
      4. Match desired providers against existing remote cchsync_ providers
      5. Categorize test-failed cchsync_ providers (left unchanged, warned)
      6. Accumulate warnings

    Args:
        candidates: Sync candidates from upstream discovery.
        remote_providers: Existing remote providers from CCH.
        cch_client: CCH client (required when running model tests).
        upstream_models: Available upstream models per candidate.
        pre_tested_results: Pre-tested results to skip live testing.
        config_entries: Parsed config entries (for per-site modelWhitelist).

    Returns:
        SyncPlan with operations and categorizations.
    """
    warnings: List[str] = []

    # Build per-site model whitelist map from config entries.
    # Keyed by (host, sha256) to support multiple whitelists per site with
    # different API keys (e.g., xixiapi main + xixicode image-only).
    model_whitelist_map: Dict[str, Set[str]] = {}
    if config_entries:
        for e in config_entries:
            if e.model_whitelist is not None:
                host_key = _normalize_host_for_match(e.host)
                sha = e.api_key_sha256 or ""
                map_key = f"{host_key}::{sha}"
                model_whitelist_map[map_key] = set(e.model_whitelist)

    if not candidates and not remote_providers:
        return SyncPlan(
            operations=[], stale_self_managed=[], test_failed_unchanged=[], warnings=[]
        )

    test_results: List[TestResults] = []
    if pre_tested_results is not None:
        test_results = list(pre_tested_results)
    else:
        if cch_client is None:
            raise ValueError(
                "plan_sync: cch_client is required when running model tests in production"
            )
        plans: List[Dict[str, List[str]]] = []
        for c in candidates:
            models = (
                list(upstream_models.get(_upstream_key(c), []))
                if upstream_models
                else []
            )
            plan = build_test_plan(c, models)
            # Apply per-site model whitelist (intersection) after plan is built,
            # so it also catches the FALLBACK_MODELS fallback.
            site_key = _normalize_host_for_match(c.host)
            key_hash = hashlib.sha256(c.key.encode("utf-8")).hexdigest()
            map_key = f"{site_key}::{key_hash}"
            site_whitelist = model_whitelist_map.get(map_key)
            # When the config has whitelist entries but this candidate has none,
            # it means the site was intentionally removed → zero models allowed.
            if site_whitelist is None and model_whitelist_map:
                site_whitelist = set()
            if site_whitelist is not None:
                for api_field in ("chatModels", "responsesModels"):
                    existing = plan.get(api_field) or []
                    # Empty whitelist = no models allowed.
                    # Non-empty whitelist: keep matching models + add any missing.
                    plan[api_field] = (
                        list(site_whitelist)
                        if not existing
                        else list(
                            {m for m in existing if m in site_whitelist}
                            | site_whitelist
                        )
                    )
            plans.append(plan)

        if skip_model_tests:
            # Nothing to test — auto-pass all
            for i, c in enumerate(candidates):
                all_models = list(plans[i].get("chatModels") or [])
                test_results.append(_make_synthetic_test_result(c, all_models))
        elif test_model_whitelist:
            # Test only whitelisted models; auto-pass the rest
            whitelist = test_model_whitelist
            to_test_plans: List[Dict[str, List[str]]] = []
            trusted_map: Dict[int, List[str]] = {}
            for i, c in enumerate(candidates):
                all_models = set(plans[i].get("chatModels") or [])
                test_set = [m for m in all_models if m in whitelist]
                trusted_set = [m for m in all_models if m not in whitelist]
                to_test_plans.append(
                    {"chatModels": test_set, "responsesModels": test_set}
                )
                if trusted_set:
                    trusted_map[i] = trusted_set
            tested = run_model_tests_batch(
                candidates, to_test_plans, cch_client, max_workers=test_concurrency
            )
            for i, c in enumerate(candidates):
                base = tested[i]
                trusted = trusted_map.get(i, [])
                if not trusted:
                    test_results.append(base)
                else:
                    test_results.append(_merge_with_trusted(base, c, trusted))
        else:
            # Test all models
            test_results = run_model_tests_batch(
                candidates, plans, cch_client, max_workers=test_concurrency
            )

    # Compute names that any candidate (passing or failing) would have generated.
    candidate_tested_names: Set[str] = set()
    for tr in test_results:
        for api_type in ("chat", "responses"):
            candidate_tested_names.add(
                build_generated_name(
                    tr.candidate.host, api_type, tr.candidate.actual_multiplier
                )
            )

    # Build desired providers from passing tests and match against remote.
    desired = build_desired_providers(test_results)
    desired_names = {d.name for d in desired}
    match = match_remote_providers(
        desired,
        remote_providers,
        MatchContext(candidate_tested_names=desired_names),
    )

    # With per-model naming, every passing model gets its own provider.
    # Any remote cchsync_ provider whose exact name is not in desired_names
    # is stale — there is no "test-failed but not stale" scenario.
    test_failed_unchanged: List[str] = []

    for sname, _sid in match.stale_self_managed:
        warnings.append(
            f"Stale self-managed provider {sname} has no matching upstream; will be deleted with --apply"
        )

    return SyncPlan(
        operations=list(match.creates) + list(match.patches),
        stale_self_managed=list(match.stale_self_managed),
        test_failed_unchanged=test_failed_unchanged,
        warnings=warnings,
    )


# ============================================================================
# Section 8: CLI entry point
# ============================================================================


class CliArgsError(Exception):
    """Raised when CLI argument parsing fails."""

    def __init__(self, message: str):
        super().__init__(message)
        self.name = "CliArgsError"


DEFAULT_CONCURRENCY = 5
DEFAULT_TEST_CONCURRENCY = 20


def _print_usage() -> None:
    """Print CLI usage to stdout."""
    lines = [
        "Usage: sync-upstream-providers.py --config <path> [options]",
        "",
        "Options:",
        "  --config <path>            Path to the upstream provider config JSON (required)",
        "  --provider-results <path>  Use a pre-existing provider results JSON (skip provider_client.py)",
        "  --apply                    Apply create/patch operations (default: dry-run)",
        "  --evidence <path>          Write summary evidence to a file",
        "  --concurrency <N>          Max concurrent upstream model fetches (default 5)",
        "  --help, -h                 Print this help",
    ]
    print("\n".join(lines))


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    """Parse CLI arguments.

    Supported flags:
      --config <path>            (required)
      --provider-results <path>  (optional, skips python subprocess)
      --apply                    (default false = dry-run)
      --evidence <path>          (optional)
      --cch-base-url <url>       (optional, overrides CCH_BASE_URL env)
      --cch-token <token>        (optional, overrides CCH_ADMIN_TOKEN env)
      --concurrency <N>          (default 5)
      --help, -h

    Args:
        argv: Argv slice (defaults to sys.argv[1:]).

    Returns:
        Parsed argparse.Namespace with attributes: config, apply,
        evidence (Optional[str]), concurrency, provider_results (Optional[str]),
        cch_base_url (Optional[str]), cch_token (Optional[str]).

    Raises:
        SystemExit: When --help is requested or required args are missing.
    """
    parser = argparse.ArgumentParser(
        prog="sync-upstream-providers.py",
        description="Sync upstream provider state to a Claude Code Hub instance.",
        add_help=True,
    )
    parser.add_argument(
        "--config",
        required=True,
        help="Path to the upstream provider config JSON (required)",
    )
    parser.add_argument(
        "--provider-results",
        default=None,
        help="Use a pre-existing provider results JSON (skip provider_client.py)",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        default=False,
        help="Apply create/patch operations (default: dry-run)",
    )
    parser.add_argument(
        "--evidence",
        default=None,
        help="Write summary evidence to a file",
    )
    parser.add_argument(
        "--cch-base-url",
        default=None,
        help="CCH instance base URL (default: CCH_BASE_URL env var)",
    )
    parser.add_argument(
        "--cch-token",
        default=None,
        help="CCH admin token (default: CCH_ADMIN_TOKEN env var)",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=DEFAULT_CONCURRENCY,
        help="Max concurrent upstream model fetches (default 5)",
    )
    parser.add_argument(
        "--test-concurrency",
        type=int,
        default=DEFAULT_TEST_CONCURRENCY,
        help="Max concurrent model test threads (default 20)",
    )
    parser.add_argument(
        "--skip-model-tests",
        action="store_true",
        default=False,
        help="Skip model testing (mark all models as passed without testing)",
    )
    parser.add_argument(
        "--test-models",
        default=None,
        help="Comma-separated whitelist of model IDs to test; all others auto-pass",
    )
    if argv is None:
        return parser.parse_args()
    return parser.parse_args(list(argv))


# ---------------------------------------------------------------------------
# Discovery subprocess (provider_client.py)
# ---------------------------------------------------------------------------

_LAST_DISCOVERY_TMP_DIR: Optional[str] = None


def _candidate_provider_client_paths() -> List[str]:
    """Return ordered list of candidate paths for provider_client.py."""
    cwd = os.getcwd()
    return [
        os.path.join(cwd, "scripts", "provider_client.py"),
        os.path.join(cwd, "scripts", "sync-upstream-providers", "provider_client.py"),
        os.path.join(cwd, "provider_client.py"),
    ]


def _locate_provider_client() -> Optional[str]:
    """Search for provider_client.py in known locations."""
    for path in _candidate_provider_client_paths():
        if os.path.isfile(path):
            return path
    return None


def run_upstream_discovery(
    args: argparse.Namespace,
    config_path: Optional[str] = None,
) -> str:
    """Resolve the path to the provider results JSON.

    If `--provider-results` is set, returns it as-is.
    Otherwise, spawns `python3 provider_client.py --config <config> --json <tmpfile>`
    in a temp directory and returns the JSON output path.

    The temp dir is tracked so cleanup_discovery_dir() can remove it after
    the caller has consumed the JSON file.

    Args:
        args: Parsed CLI args.
        config_path: Override config path (defaults to args.config).

    Returns:
        Path to the provider results JSON file.
    """
    global _LAST_DISCOVERY_TMP_DIR

    if getattr(args, "provider_results", None):
        return args.provider_results

    use_config = config_path or args.config
    script_path = _locate_provider_client()
    if script_path is None:
        raise FileNotFoundError(
            "Unable to locate provider_client.py. Searched: "
            + ", ".join(_candidate_provider_client_paths())
        )

    tmp_dir = tempfile.mkdtemp(prefix="sync-upstream-")
    json_path = os.path.join(tmp_dir, "results.json")
    stderr_chunks: List[str] = []

    try:
        proc = subprocess.Popen(
            [sys.executable, script_path, "--config", use_config, "--json", json_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            _, stderr_text = proc.communicate(timeout=None)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise RuntimeError("provider_client.py timed out")
        stderr_chunks.append(stderr_text or "")

        if proc.returncode != 0:
            safe_stderr = redact_secrets(stderr_text or "")
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise RuntimeError(
                f"provider_client.py exited with code {proc.returncode}. "
                f"stderr: {safe_stderr[:2000]}"
            )

        if not os.path.isfile(json_path):
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise FileNotFoundError(
                f"provider_client.py did not write expected output: {json_path}"
            )

        stderr_text = "".join(stderr_chunks)
        if stderr_text.strip():
            print(redact_secrets(stderr_text.strip()), file=sys.stderr)

        _LAST_DISCOVERY_TMP_DIR = tmp_dir
        return json_path
    except Exception:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        _LAST_DISCOVERY_TMP_DIR = None
        raise


def cleanup_discovery_dir() -> None:
    """Clean up the temp directory created by the most recent run_upstream_discovery."""
    global _LAST_DISCOVERY_TMP_DIR
    if _LAST_DISCOVERY_TMP_DIR:
        shutil.rmtree(_LAST_DISCOVERY_TMP_DIR, ignore_errors=True)
        _LAST_DISCOVERY_TMP_DIR = None


# ---------------------------------------------------------------------------
# Upstream model fetch
# ---------------------------------------------------------------------------

UpstreamModelsMap = Dict[str, List[str]]


def _candidate_upstream_key(c: SyncCandidate) -> str:
    return f"{c.host}::{c.key_id}"


def fetch_upstream_models(
    cch_client: CchClient,
    candidates: Sequence[SyncCandidate],
    concurrency: int = 5,
) -> UpstreamModelsMap:
    """Fetch upstream model lists for each candidate via the CCH client.

    Synchronous batched loop (no asyncio). On per-candidate failure, logs
    a redacted warning and continues with an empty model list for that
    candidate.

    Args:
        cch_client: CCH REST client.
        candidates: Sync candidates to query.
        concurrency: Max concurrent fetches per batch (defaults to 5).

    Returns:
        Dict mapping "host::keyId" to a list of model ID strings.
    """
    result: UpstreamModelsMap = {}
    if not candidates:
        return result

    limit = max(1, min(int(concurrency), len(candidates)))

    for i in range(0, len(candidates), limit):
        batch = list(candidates[i : i + limit])
        for c in batch:
            key = _candidate_upstream_key(c)
            try:
                response = cch_client.fetch_upstream_models(
                    provider_url=c.host,
                    api_key=c.key,
                    provider_type="openai-compatible",
                )
                models = response.get("models") if isinstance(response, dict) else None
                if not isinstance(models, list):
                    models = []
                cleaned = [m for m in models if isinstance(m, str)]
                result[key] = cleaned
            except Exception as err:  # noqa: BLE001 — log and continue
                reason = str(err)
                print(
                    f"[WARN] fetch_upstream_models failed for {c.host} key "
                    f"{c.key_masked}: {redact_secrets(reason)}",
                    file=sys.stderr,
                )
                result[key] = []
    return result


# ---------------------------------------------------------------------------
# Print helpers
# ---------------------------------------------------------------------------


def _format_cost(value: float) -> str:
    """Format a cost multiplier for display (or 'n/a' if non-finite)."""
    if not _is_finite_number(value):
        return "n/a"
    return str(value)


def print_dry_run_summary(plan: SyncPlan, candidates: Sequence[SyncCandidate]) -> None:
    """Print a dry-run summary of the sync plan to stdout."""
    lines: List[str] = []
    lines.append("=== DRY RUN ===")
    lines.append(f"Candidates: {len(candidates)}")
    lines.append("")

    creates = [op for op in plan.operations if op.operation == "create"]
    patches = [op for op in plan.operations if op.operation == "patch"]

    if creates or patches:
        lines.append("Provider Operations:")
        for op in creates:
            lines.append(
                f"  CREATE  {op.name}  {op.provider_type}  priority {op.priority}  "
                f"cost {_format_cost(op.cost_multiplier)}  models: {op.allowed_models[0].pattern if op.allowed_models else ''}"
            )
        for op in patches:
            lines.append(
                f"  PATCH   {op.name}  {op.provider_type}  priority {op.priority}  "
                f"cost {_format_cost(op.cost_multiplier)}  models: {op.allowed_models[0].pattern if op.allowed_models else ''}  "
                f"remoteId={op.remote_provider_id or ''}"
            )
        lines.append("")

    if plan.operations:
        lines.append(
            f"Total operations: {len(plan.operations)} ({len(creates)} CREATE, {len(patches)} PATCH)"
        )

    deletions = plan.stale_self_managed
    if deletions:
        lines.append("")
        lines.append(f"Deletions ({len(deletions)} stale cchsync_ providers):")
        for sname, _sid in deletions:
            lines.append(f"  DELETE  {sname}")
        lines.append("")

    lines.append(f"Self-managed providers unchanged: 0")
    lines.append(f"Stale self-managed (no upstream): {len(deletions)}")
    lines.append(f"Test-failed (unchanged): {len(plan.test_failed_unchanged)}")
    lines.append(f"Warnings: {len(plan.warnings)}")

    if plan.warnings:
        lines.append("")
        lines.append("Warnings:")
        for w in plan.warnings:
            lines.append(f"  - {redact_secrets(w)}")

    lines.append("")
    lines.append("Run with --apply to apply changes.")

    print(redact_secrets("\n".join(lines)))


@dataclass
class ApplyOutcome:
    """Outcome of a single apply operation."""

    operation: str
    name: str
    ok: bool
    status: Optional[int] = None
    detail: Optional[str] = None


@dataclass
class ApplyResult:
    """Result of applying a sync plan."""

    success: int
    failures: int
    outcomes: List[ApplyOutcome]


def _apply_one_operation(op: ProviderOperation, cch_client: CchClient) -> ApplyOutcome:
    """Apply a single create/patch operation to the CCH instance."""
    payload = {
        "name": op.name,
        "url": op.url,
        "key": op.key,
        "provider_type": op.provider_type,
        "priority": op.priority,
        "cost_multiplier": op.cost_multiplier,
        "allowed_models": [m.to_dict() for m in op.allowed_models],
        "circuit_breaker_failure_threshold": op.circuit_breaker_failure_threshold,
        "circuit_breaker_open_duration": op.circuit_breaker_open_duration,
        "max_retry_attempts": op.circuit_breaker_max_retry_attempts,
        "first_byte_timeout_streaming_ms": op.first_byte_timeout_streaming_ms,
        "is_enabled": True,
    }
    try:
        if op.operation == "create":
            cch_client.create_provider(payload)
            return ApplyOutcome(operation="create", name=op.name, ok=True, status=201)
        if op.operation == "patch":
            if not op.remote_provider_id:
                return ApplyOutcome(
                    operation="patch",
                    name=op.name,
                    ok=False,
                    status=0,
                    detail="missing remote provider id",
                )
            try:
                provider_id = int(op.remote_provider_id)
            except (TypeError, ValueError):
                return ApplyOutcome(
                    operation="patch",
                    name=op.name,
                    ok=False,
                    status=0,
                    detail=f"invalid remote provider id: {op.remote_provider_id}",
                )
            cch_client.patch_provider(provider_id, payload)
            return ApplyOutcome(operation="patch", name=op.name, ok=True, status=200)
        return ApplyOutcome(
            operation=op.operation,
            name=op.name,
            ok=False,
            status=0,
            detail=f"unknown operation: {op.operation}",
        )
    except Exception as err:  # noqa: BLE001
        reason = str(err)
        return ApplyOutcome(
            operation=op.operation,
            name=op.name,
            ok=False,
            detail=redact_secrets(reason),
        )


def apply_plan(plan: SyncPlan, cch_client: CchClient) -> ApplyResult:
    """Apply the plan's create/patch/delete operations to the CCH instance.

    Returns counts and a per-operation outcome array for evidence.
    """
    outcomes: List[ApplyOutcome] = []
    success = 0
    failures = 0

    for op in plan.operations:
        outcome = _apply_one_operation(op, cch_client)
        outcomes.append(outcome)
        if outcome.ok:
            success += 1
            print(
                f"  \u2713 {op.operation.upper()} {op.name} \u2192 {outcome.status or 200}"
            )
        else:
            failures += 1
            print(
                f"  \u2717 {op.operation.upper()} {op.name} \u2192 "
                f"{outcome.status or 'error'} ({redact_secrets(outcome.detail or 'unknown')})"
            )

    for sname, sid in plan.stale_self_managed:
        try:
            cch_client.delete_provider(sid)
            success += 1
            outcomes.append(
                ApplyOutcome(operation="delete", name=sname, ok=True, status=204)
            )
            print(f"  \u2713 DELETE {sname} [{sid}]")
        except Exception as exc:
            failures += 1
            outcomes.append(
                ApplyOutcome(operation="delete", name=sname, ok=False, detail=str(exc))
            )
            print(f"  \u2717 DELETE {sname} [{sid}] \u2192 {redact_secrets(str(exc))}")

    return ApplyResult(success=success, failures=failures, outcomes=outcomes)


# ---------------------------------------------------------------------------
# Evidence file
# ---------------------------------------------------------------------------


def _path_dirname(p: str) -> str:
    """Cross-platform dirname (avoids shadowing os.path.dirname at module scope)."""
    idx = p.rfind("/")
    win_idx = p.rfind("\\")
    cut = max(idx, win_idx)
    if cut == -1:
        return ""
    return p[:cut]


def write_evidence(
    path: str,
    plan: SyncPlan,
    args: argparse.Namespace,
    apply: Optional[ApplyResult],
) -> None:
    """Write a summary of the sync to an evidence file."""
    now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    creates = sum(1 for op in plan.operations if op.operation == "create")
    patches = sum(1 for op in plan.operations if op.operation == "patch")

    lines: List[str] = []
    lines.append(f"# Sync Evidence \u2014 {now}")
    lines.append(f"## Config: {args.config}")
    lines.append(f"## Mode: {'apply' if args.apply else 'dry-run'}")
    lines.append(
        f"## Candidates: {len(plan.operations) + len(plan.test_failed_unchanged)}"
    )
    lines.append(f"## Operations: {creates} CREATE, {patches} PATCH")
    lines.append(f"## Stale: {len(plan.stale_self_managed)}")
    lines.append(f"## Test-failed: {len(plan.test_failed_unchanged)}")
    lines.append(f"## Warnings: {len(plan.warnings)}")
    lines.append("")

    if plan.operations:
        lines.append("## Operations")
        for op in plan.operations:
            model_count = len(op.allowed_models)
            cost = _format_cost(op.cost_multiplier)
            lines.append(
                f"- {op.operation.upper()} {op.name} ({op.provider_type}): "
                f"{model_count} models, priority {op.priority}, cost {cost}"
            )
        lines.append("")

    if apply is not None:
        lines.append("## Apply Results")
        lines.append(f"## Success: {apply.success}")
        lines.append(f"## Failures: {apply.failures}")
        for o in apply.outcomes:
            status = o.status if o.status is not None else (200 if o.ok else 0)
            detail = f" ({redact_secrets(o.detail)})" if o.detail else ""
            lines.append(
                f"- {'OK' if o.ok else 'FAIL'} {o.operation} {o.name} -> {status}{detail}"
            )
        lines.append("")

    if plan.warnings:
        lines.append("## Warnings")
        for w in plan.warnings:
            lines.append(f"- {redact_secrets(w)}")
        lines.append("")

    parent_dir = _path_dirname(path)
    if parent_dir and parent_dir not in (".", ""):
        os.makedirs(parent_dir, exist_ok=True)

    with open(path, "w", encoding="utf-8") as f:
        f.write(redact_secrets("\n".join(lines)))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


@dataclass
class MainResult:
    """Result of the main workflow."""

    mode: str  # "dry-run" | "apply"
    candidates: int
    creates: int
    patches: int
    stale: int
    test_failed: int
    warnings: int
    plan: SyncPlan
    apply: Optional[ApplyResult]


@dataclass
class MainOptions:
    """Options for main(), exposed for testing."""

    argv_override: Optional[Sequence[str]] = None
    cch_client: Optional[CchClient] = None
    config_path: Optional[str] = None


def _list_remote_providers(cch_client: CchClient) -> List[RemoteProvider]:
    """Call listProviders and normalize into RemoteProvider objects."""
    items = cch_client.list_providers()
    out: List[RemoteProvider] = []
    for item in items:
        allowed = []
        for m in item.get("allowed_models") or []:
            if isinstance(m, dict):
                mt = str(m.get("matchType", m.get("match_type", "exact")))
                pat = str(m.get("pattern", ""))
                allowed.append(AllowedModelRule(match_type=mt, pattern=pat))
            elif isinstance(m, AllowedModelRule):
                allowed.append(m)
        # Carry extras (e.g. group_tag, weight) under .extra for future use.
        known = {
            "id",
            "name",
            "url",
            "isEnabled",
            "providerType",
            "provider_type",
            "is_enabled",
            "priority",
            "cost_multiplier",
            "allowed_models",
        }
        extra = {k: v for k, v in item.items() if k not in known}
        out.append(
            RemoteProvider(
                id=str(item.get("id", "")),
                name=str(item.get("name", "")),
                provider_type=str(
                    item.get(
                        "provider_type", item.get("providerType", "openai-compatible")
                    )
                ),
                url=str(item.get("url", "")),
                key=str(item.get("key", "")),
                priority=int(item.get("priority", 0) or 0),
                cost_multiplier=float(item.get("cost_multiplier", 1) or 1),
                allowed_models=allowed,
                extra=extra,
            )
        )
    return out


def main(options: Optional[MainOptions] = None) -> MainResult:
    """Main workflow. Synchronous end-to-end execution.

    Steps:
      1. Parse args
      2. Read and validate config
      3. Create CCH client (from env or injection)
      4. List remote providers from CCH
      5. Run upstream discovery (subprocess or pre-built JSON)
      6. Apply SHA256 key filtering
      7. Map to candidates
      8. Fetch upstream models per candidate (bounded concurrency)
      9. Plan sync
     10. Print dry-run summary or apply
     11. Optionally write evidence file

    Args:
        options: Optional test overrides (argv, cch_client, config_path).

    Returns:
        MainResult summarizing the workflow.
    """
    options = options or MainOptions()
    args = parse_args(options.argv_override)
    config_path = options.config_path or args.config

    # Step 1: read config
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            raw_config_text = f.read()
    except OSError as err:
        raise FileNotFoundError(
            f"Failed to read config file {config_path}: {redact_secrets(str(err))}"
        ) from err

    try:
        parsed_config = json.loads(raw_config_text)
    except json.JSONDecodeError as err:
        raise ValueError(
            f"Failed to parse JSON config: {redact_secrets(str(err))}"
        ) from err

    config_result = parse_provider_config(parsed_config)
    if not config_result.valid:
        messages = [
            f"  - [entry {e.entry_index + 1}] {e.field}: {e.message}"
            for e in config_result.errors
        ]
        raise ValueError("Config validation failed:\n" + "\n".join(messages))

    # Step 2: CCH client
    cch_client: CchClient
    if options.cch_client is not None:
        cch_client = options.cch_client
    else:
        base_url = args.cch_base_url or os.environ.get("CCH_BASE_URL", "")
        admin_token = args.cch_token or os.environ.get("CCH_ADMIN_TOKEN", "")
        cch_client = CchClient(base_url=base_url, admin_token=admin_token)

    # Step 3: list remote providers
    try:
        remote_providers = _list_remote_providers(cch_client)
    except Exception as err:
        raise RuntimeError(
            f"Failed to list remote providers: {redact_secrets(str(err))}"
        ) from err

    # Step 4: run upstream discovery
    json_path = run_upstream_discovery(args, config_path=config_path)
    try:
        results = load_provider_results(json_path)
    finally:
        cleanup_discovery_dir()

    # Step 4b: inject direct API key entries for login-failed sites
    results = inject_direct_api_keys(results, config_result.entries)

    # Step 5: SHA256 key pinning
    sha256_filters = [
        Sha256Filter(
            host=e.host,
            username=e.username,
            api_key_sha256=e.api_key_sha256,  # type: ignore[arg-type]
        )
        for e in config_result.entries
        if e.api_key_sha256
    ]
    if sha256_filters:
        results = filter_keys_by_sha256(results, sha256_filters)

    # Step 6: map to candidates
    candidates, skipped_keys, discovery_warnings = map_to_candidates(results)
    if discovery_warnings and not args.apply:
        for w in discovery_warnings:
            print(f"[WARN] {redact_secrets(w)}", file=sys.stderr)

    # Step 7: fetch upstream models
    upstream_models = fetch_upstream_models(cch_client, candidates, args.concurrency)

    # Step 8: plan sync
    test_whitelist: Optional[Set[str]] = None
    if args.test_models:
        test_whitelist = {m.strip() for m in args.test_models.split(",") if m.strip()}
    plan = plan_sync(
        candidates=candidates,
        remote_providers=remote_providers,
        cch_client=cch_client,
        upstream_models=upstream_models,
        test_concurrency=args.test_concurrency,
        skip_model_tests=args.skip_model_tests,
        test_model_whitelist=test_whitelist,
        config_entries=config_result.entries,
    )

    # Step 9: print / apply
    if args.apply:
        print("=== APPLYING ===")
        if not plan.operations:
            print("  (no operations to apply)")
    else:
        print_dry_run_summary(plan, candidates)

    apply_result: Optional[ApplyResult] = None
    if args.apply:
        apply_result = apply_plan(plan, cch_client)

    # Step 10: evidence file
    if args.evidence:
        write_evidence(args.evidence, plan, args, apply_result)

    # Surface post-apply warnings
    if apply_result is not None and plan.warnings:
        for w in plan.warnings:
            print(f"[WARN] {redact_secrets(w)}", file=sys.stderr)

    return MainResult(
        mode="apply" if args.apply else "dry-run",
        candidates=len(candidates),
        creates=sum(1 for op in plan.operations if op.operation == "create"),
        patches=sum(1 for op in plan.operations if op.operation == "patch"),
        stale=len(plan.stale_self_managed),
        test_failed=len(plan.test_failed_unchanged),
        warnings=len(plan.warnings),
        plan=plan,
        apply=apply_result,
    )


# ============================================================================
# Entry point
# ============================================================================


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("[FATAL] interrupted", file=sys.stderr)
        sys.exit(130)
    except Exception as err:  # noqa: BLE001
        print(f"[FATAL] {redact_secrets(str(err))}", file=sys.stderr)
        sys.exit(1)
