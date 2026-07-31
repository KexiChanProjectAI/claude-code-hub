# Learnings — reasoning-effort-predicate-overrides

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## [2026-07-31 00:21:44 UTC] Task: 1

- The existing `ProviderModelRedirectMatchType` and `matchesPattern` provide the canonical five case-insensitive model match modes; the evaluator validates the mode before invoking the matcher, so unknown modes return no-match without evaluating pattern text.
- Canonical exports are `ReasoningEffortOverrideModelPredicate`, `ReasoningEffortOverrideRuleWhen`, `ReasoningEffortOverrideRule`, `ReasoningEffortOverrideInput`, `ReasoningEffortOverrideNoMatchResult`, `ReasoningEffortOverrideMatchResult`, and `ReasoningEffortOverrideResult` from `src/types/provider.ts`.
- Evaluator exports are `evaluateReasoningEffortOverride`, `convertLegacyCodexReasoningEffortToRules`, `convertLegacyAnthropicAdaptiveThinkingToRules`, and `convertLegacyReasoningEffortOverrideToRules` from `src/lib/reasoning-effort-override.ts`.
- Evaluation accepts unknown runtime shapes defensively, validates the complete ordered list before matching, ANDs populated predicates, uses own-property detection for explicit `originalReasoningEffort: null`, returns the exact no-match shape, and never mutates input objects.
- Legacy conversion preserves order: Codex non-inherit effort and Anthropic adaptive `all` become catch-all rules; Anthropic `specific` emits adjacent exact and `model-` prefix rules per model; empty specific models emit an empty list.
- `ProviderParameterOverrideSpecialSetting` keeps all existing `changes[]` fields unchanged and adds optional `ruleEvaluation?: ReasoningEffortOverrideResult` metadata.

## [2026-07-30 20:43:00 UTC] Task: 2

- The persisted field is database column `providers.reasoning_effort_override_rules` and runtime/repository field `reasoningEffortOverrideRules`; it is nullable JSONB and is normalized to `null` only when the stored projection is absent, while stored `[]` and ordered rule objects pass through unchanged.
- `src/repository/provider.ts` now includes the field in create/update/batch writes and every provider return projection; `src/repository/_shared/transformers.ts` returns the canonical `ReasoningEffortOverrideRule[] | null` shape without reordering or dropping explicit `originalReasoningEffort: null` predicates.
- Drizzle generated `drizzle/0109_calm_vulcan.sql` and `drizzle/meta/0109_snapshot.json`; only the generated SQL was amended with a `WHERE reasoning_effort_override_rules IS NULL` backfill. Codex non-inherit, Anthropic adaptive all, and Anthropic specific models use the task-1 converter JSON shape, while specific-empty becomes `[]` and legacy columns remain untouched.
- The required unit evidence passed. The migration integration test is isolated-by-design and skips only when no `DSN`/`DATABASE_URL` is available; this environment has neither Docker nor a local PostgreSQL server, so live scratch-database execution remains unavailable here.

## [2026-07-31 00:57:37 UTC] Task: 2

- postgres.js JSONB fixture parameters must use the client `sql.json(value)` helper rather than interpolating `JSON.stringify(value)` strings; the former preserves object/array JSONB binding for the isolated migration database.
- The migration integration test keeps strict equality for converted rules, pre-populated rules, and rerun rows, but uses semantic equality for legacy-column snapshots because postgres.js can expose equivalent JSONB objects with different prototypes across separate queries.

## [2026-07-31 01:18:00 UTC] Task: 5

- Anthropic adapter calls now accept `(provider, request, context?)`, where `context` is the immutable `AnthropicProviderOverrideContext` `{ originalModel, executionModel, originalReasoningEffort, reasoningEffortOverrideRules? }`; all three snapshots are `string | null`, and the optional rules field preserves `null` versus `[]` when it is supplied.
- The persisted provider field is `provider.reasoningEffortOverrideRules`; when the context has no own `reasoningEffortOverrideRules` property, the adapter uses that provider field. Two-argument legacy callers remain valid and derive a fallback raw model/effort snapshot from the untouched request body.
- `applyAnthropicProviderOverridesWithAudit` evaluates the conditional rules once, reuses that result for mutation and audit, keeps the historical four `changes[]` paths unchanged, and adds `ruleEvaluation` only for non-null rule configuration. Matched rules use adaptive thinking and output-config effort; nonmatching/empty rules suppress legacy adaptive effort but leave max-token and thinking-budget behavior active.

## [2026-07-31 01:13:44 UTC] Task: 4

- The Codex adapter now accepts an optional third parameter named `reasoningEffortOverrideContext` with exported type `CodexReasoningEffortOverrideContext`: readonly `originalModel: string | null`, readonly `executionModel: string | null`, readonly `originalReasoningEffort: string | null`, and readonly `reasoningEffortOverrideRules: readonly ReasoningEffortOverrideRule[] | null`.
- Task 7 should omit the context only for legacy-compatible calls; when passing context, `reasoningEffortOverrideRules: null` preserves `codexReasoningEffortPreference`, while any non-null list is evaluated once and suppresses legacy static effort, including explicit `[]`. A malformed supplied context safely produces evaluator no-match and does not revive static effort.
- Conditional decisions use only the context snapshots, then merge `reasoning.effort` into a copied reasoning object. Existing reasoning siblings and every existing audit `changes[]` entry remain unchanged; matched rule results are attached as `audit.ruleEvaluation` when an audit is emitted.
- Focused evidence is saved in `.omo/evidence/w3-t4-codex-adapter.txt`; 32 Codex adapter tests pass and targeted Biome is clean.

## [2026-07-31 01:35:00 UTC] Task: 3

- Public write/read field names are `reasoning_effort_override_rules` on action/REST writes and `reasoningEffortOverrideRules` on provider responses. The canonical rule JSON is `{ when: { originalModel?, executionModel?, originalReasoningEffort? }, overrideEffort }`; an omitted effort predicate is a wildcard while an own-property `null` matches missing effort.
- Rules are accepted only for `codex` targets `none|minimal|low|medium|high|xhigh` and `claude`/`claude-auth` targets `low|medium|high|xhigh|max`; other provider types reject the field. Invalid regexes, malformed predicates, over-50 lists, and mixed new-plus-legacy mutations are rejected before repository writes.
- Batch patch modes are `reasoning_effort_override_rules: { no_change: true }`, `{ set: rules }`, and `{ clear: true }`; `set: []` remains an explicit empty list and `clear` maps to persisted `null`. Legacy-only effort mutations are rejected when existing rules are non-null.
- The OpenAPI client was regenerated with `bun run openapi:generate`; focused action/REST contract tests and `bun run openapi:check` passed, with evidence in `.omo/evidence/w3-t3-provider-contract.txt`.

## [2026-07-31 02:03:35 UTC] Task: 7

- `ProxySession` now stores immutable `getRawIntakeModel()`, `getRawResponsesReasoningEffort()`, and `getRawMessagesReasoningEffort()` values from parsed intake before guards, redirects, filters, or provider overrides mutate the request. The rule model snapshot intentionally excludes the derived Gemini default when the client supplied no model.
- Forwarder passes those snapshots, the post-redirect `getCurrentModel()`, and loaded-provider rule configuration to the Codex and Anthropic adapters only within their existing provider-type branches. Missing type-surface support for the loaded field is isolated by a local narrowing helper that preserves `null` as the legacy-fallback state.
- Provider override evaluation is now once per logical provider attempt in both classic and streaming-hedge forwarding. A reactive same-provider retry keeps the rectifier's stripped request state, while a different provider begins a fresh evaluation against its own execution model.
- `w4-t7-forwarding.txt` records 107 passing focused tests across the new forwarding suite and both completed adapter suites. Targeted Biome passes; repository typecheck remains blocked by concurrent, non-owned batch-draft and reasoning-effort rule editor errors.

## [2026-07-31 03:00:00 UTC] Task: 6

- `ProviderDisplay` does not yet expose `reasoningEffortOverrideRules`; the form state and batch analysis use `as unknown as` casts to access the runtime field. The canonical types will be extended by a later task.
- `ProviderBatchPatchDraft` (from `src/types/provider.ts`) lacks `reasoning_effort_override_rules`; `build-patch-draft.ts` uses a `Record<string, unknown>` cast to assign the field. The `provider-patch-contract.ts` defines `ProviderBatchPatchDraftWithReasoningEffortRules` with the field but the form draft builder returns the narrower type.
- The `ReasoningEffortOverrideRuleWhen` type uses `readonly` properties; the rule editor creates mutable copies via `as Record<string, unknown>` before setting/deleting condition properties.
- In batch mode, the rule editor appears once in the Codex section (shared for all provider types via `providerType` prop); the Anthropic section wraps its rule editor with `{!isBatch && ...}` to avoid duplication.
- When rules are non-null at form submission, legacy `codex_reasoning_effort_preference` is sent as `"inherit"` and `anthropic_adaptive_thinking` as `null` to avoid server-side rejection of mixed payloads.
- The `ReasoningEffortRuleEditor` component is protocol-agnostic: it receives `providerType` and shows the matching target effort options (codex: `none|minimal|low|medium|high|xhigh`; claude/claude-auth: `low|medium|high|xhigh|max`).
- All 112 tests pass across three suites: reasoning-effort-rule-editor (12 + 1 locale check), build-patch-draft (66), and options-section (34).
- `bun run typecheck` and `bunx biome check` on all owned files pass cleanly.

## [2026-07-31 00:36:00 UTC] Task: 3 regression repair

- The existing `tests/unit/actions/providers-batch-field-mapping.test.ts` repository mock needed `findAllProvidersFresh`; legacy adaptive batch updates now inspect persisted rules before mapping, so the mock defaults to an empty provider list and supplies a non-null-rule provider for the overwrite-rejection regression.
- The full `tests/unit/actions` suite passes with `DSN=postgres://postgres:postgres@127.0.0.1:5432/cch_test`, including the new rejection case; no production changes were needed for this repair.
