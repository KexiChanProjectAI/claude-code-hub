ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "protocols" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "protocol_urls" jsonb DEFAULT 'null'::jsonb;--> statement-breakpoint
UPDATE "providers" SET "protocols" = jsonb_build_array(
  CASE "provider_type"
    WHEN 'claude-auth' THEN 'claude'
    WHEN 'codex' THEN 'response'
    WHEN 'openai-compatible' THEN 'openai'
    ELSE "provider_type"
  END
) WHERE "protocols" = '[]'::jsonb;
