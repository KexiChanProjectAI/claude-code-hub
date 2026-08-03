ALTER TABLE "providers" ADD COLUMN "reasoning_effort_override_rules" jsonb;

UPDATE "providers"
SET "reasoning_effort_override_rules" = CASE
  WHEN "provider_type" = 'codex'
    AND "codex_reasoning_effort_preference" IN ('none', 'minimal', 'low', 'medium', 'high', 'xhigh')
    THEN jsonb_build_array(
      jsonb_build_object(
        'when', '{}'::jsonb,
        'overrideEffort', "codex_reasoning_effort_preference"
      )
    )
  WHEN "provider_type" IN ('claude', 'claude-auth')
    AND jsonb_typeof("anthropic_adaptive_thinking") = 'object'
    AND "anthropic_adaptive_thinking"->>'effort' IN ('low', 'medium', 'high', 'xhigh', 'max')
    AND jsonb_typeof("anthropic_adaptive_thinking"->'models') = 'array'
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements("anthropic_adaptive_thinking"->'models') AS model(value)
      WHERE jsonb_typeof(model.value) <> 'string'
    )
    AND "anthropic_adaptive_thinking"->>'modelMatchMode' = 'all'
    THEN jsonb_build_array(
      jsonb_build_object(
        'when', '{}'::jsonb,
        'overrideEffort', "anthropic_adaptive_thinking"->>'effort'
      )
    )
  WHEN "provider_type" IN ('claude', 'claude-auth')
    AND jsonb_typeof("anthropic_adaptive_thinking") = 'object'
    AND "anthropic_adaptive_thinking"->>'effort' IN ('low', 'medium', 'high', 'xhigh', 'max')
    AND jsonb_typeof("anthropic_adaptive_thinking"->'models') = 'array'
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements("anthropic_adaptive_thinking"->'models') AS model(value)
      WHERE jsonb_typeof(model.value) <> 'string'
    )
    AND "anthropic_adaptive_thinking"->>'modelMatchMode' = 'specific'
    THEN COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'when', jsonb_build_object(
              'originalModel', jsonb_build_object(
                'matchType', rule.match_type,
                'pattern', rule.pattern
              )
            ),
            'overrideEffort', "anthropic_adaptive_thinking"->>'effort'
          )
          ORDER BY model.ordinality, rule.rule_order
        )
        FROM jsonb_array_elements_text("anthropic_adaptive_thinking"->'models')
          WITH ORDINALITY AS model(model, ordinality)
        CROSS JOIN LATERAL (
          VALUES
            (0, 'exact'::text, model.model),
            (1, 'prefix'::text, model.model || '-')
        ) AS rule(rule_order, match_type, pattern)
      ),
      '[]'::jsonb
    )
END
WHERE "reasoning_effort_override_rules" IS NULL
  AND (
    (
      "provider_type" = 'codex'
      AND "codex_reasoning_effort_preference" IN ('none', 'minimal', 'low', 'medium', 'high', 'xhigh')
    )
    OR (
      "provider_type" IN ('claude', 'claude-auth')
      AND jsonb_typeof("anthropic_adaptive_thinking") = 'object'
      AND "anthropic_adaptive_thinking"->>'effort' IN ('low', 'medium', 'high', 'xhigh', 'max')
      AND jsonb_typeof("anthropic_adaptive_thinking"->'models') = 'array'
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements("anthropic_adaptive_thinking"->'models') AS model(value)
        WHERE jsonb_typeof(model.value) <> 'string'
      )
      AND "anthropic_adaptive_thinking"->>'modelMatchMode' IN ('all', 'specific')
    )
  );
