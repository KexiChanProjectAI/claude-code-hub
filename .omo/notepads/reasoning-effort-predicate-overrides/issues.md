# Issues — reasoning-effort-predicate-overrides

Problems and gotchas encountered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## [2026-07-31 00:21:44 UTC] Task: 1

- TypeScript LSP is unavailable because the repository/session previously declined installation; validation used `tsgo`, Vitest, and Biome instead.
- Repository-wide `bun run lint` reports pre-existing unrelated warnings/errors outside the four owned files. The owned files pass `bunx biome check` cleanly.

## [2026-07-30 20:43:00 UTC] Task: 2

- Task 1 froze the canonical rule types but did not add `reasoningEffortOverrideRules` to the exported `Provider`, `CreateProviderData`, or `UpdateProviderData` interfaces. Because task 2 explicitly forbids editing `src/types/provider.ts`, repository-local intersection types expose the persisted field and accept the snake_case repository input until the later public-contract task owns those shared interfaces.
- Live migration execution could not run in this environment because Docker and local PostgreSQL tooling are unavailable; the integration test records the required isolated-database flow and skips without a configured DSN.
- Repository-wide `bun run lint` still fails on pre-existing Biome configuration/version diagnostics and unrelated `useOptionalChain` findings; owned files pass targeted Biome checks. Repository-wide `bun run test` still has three unrelated failures in user-insights date expectations and language-switcher storage handling; the requested persistence tests pass.

## [2026-07-31 00:57:37 UTC] Task: 2

- The first live migration run exposed a test-fixture-only postgres.js binding issue: `JSON.stringify(...)` parameters were sent as invalid JSONB strings. The fixture now uses `isolated.json(...)`; no migration or production code changed.

## [2026-07-31 01:18:00 UTC] Task: 5

- `bun run typecheck` is still blocked by pre-existing Task 3 contract errors outside the owned files (`src/actions/providers.ts`, `src/lib/provider-patch-contract.ts`, and `src/lib/validation/schemas.ts`); the Anthropic adapter and delegated tests have no AFT diagnostics.
- The repository's TypeScript no-excuse audit script referenced by the programming skill is absent at `scripts/typescript/check-no-excuse-rules.ts`; targeted Biome validation completed successfully instead.

## [2026-07-31 01:13:44 UTC] Task: 4

- `bun run typecheck` remains blocked by unrelated unfinished Task 3 files: `src/lib/provider-patch-contract.ts` references a missing `ProviderBatchPatchField` member, and `src/lib/validation/schemas.ts` references missing `PROVIDER_RULE_LIMITS`. Neither diagnostic points to the Task 4 owned files.
- TypeScript LSP remains unavailable because installation was previously declined, and the standalone no-excuse checker could not run because the caller project does not have a resolvable local `typescript` package.

## [2026-07-31 01:35:00 UTC] Task: 3

- Zod v4 forbids `.omit()` and `.extend()` after refinements. Provider schemas now keep reusable object shapes separate from refined public create/update schemas; the dashboard-internal update handler extends the unrefined object shape and applies the shared mutation contract explicitly.

## [2026-07-31 04:00:00 UTC] Task: 6 (coverage fix)

- The initial `ReasoningEffortRuleEditor` test suite covered only 54.78% statements / 59% lines because the `Select` mock did not expose `onValueChange`, preventing tests from triggering Select-based interactions (matchType changes, effort mode transitions, target effort selection). The fix added a hidden input ref to the Select mock that stores `onValueChange`, and a `triggerSelectValue` helper to invoke it.
- The effort mode is determined by `Object.hasOwn(rule.when, "originalReasoningEffort")`: absent = "any", present null = "missing", present string = "specific". Tests that expected `null` to render the specific-value input were incorrect -- `null` maps to "missing" mode where no input renders.
- Happy-dom environment does not propagate `disabled` from parent Select to child inputs in the mock; test assertions for disabled state should target buttons (which do receive the prop) rather than inputs.

## [2026-07-31 00:36:00 UTC] Task: 3 regression repair

- Action tests that exercise legacy effort mutations must mock `findAllProvidersFresh` because the provider action now reads existing rule state to prevent legacy-only writes from destroying non-null rule lists. A missing mock export can surface as a false action failure before repository mapping is reached.
