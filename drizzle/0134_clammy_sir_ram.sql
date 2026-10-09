ALTER TABLE "providers" ADD COLUMN "service_tier_override_rules" jsonb;
UPDATE "providers"
SET "service_tier_override_rules" = jsonb_build_array(
  jsonb_build_object(
    'when', '{}'::jsonb,
    'overrideServiceTier', "codex_service_tier_preference"
  )
)
WHERE "service_tier_override_rules" IS NULL
  AND "provider_type" = 'codex'
  AND "codex_service_tier_preference" IN ('auto', 'default', 'flex', 'priority');
