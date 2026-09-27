-- Upstream quota scheduling: probe Coding Plan windows (Kimi / Zhipu GLM / MiniMax / OpenCode Go)
-- and stop routing new sessions to providers whose remaining upstream quota is below a threshold.
CREATE TABLE IF NOT EXISTS "provider_upstream_quota_snapshots" (
	"provider_id" integer PRIMARY KEY NOT NULL,
	"probe_type" varchar(20),
	"windows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plan_level" varchar(128),
	"credential_valid" boolean DEFAULT true NOT NULL,
	"last_error" text,
	"last_error_status" integer,
	"fetched_at" timestamp with time zone,
	"probed_at" timestamp with time zone NOT NULL,
	"reactive_pause_until" timestamp with time zone,
	"reactive_pause_reason" varchar(32),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "upstream_quota_probe_type" varchar(20) DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "upstream_quota_threshold_percent" integer;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "upstream_quota_probe_options" jsonb;--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "upstream_quota_scheduling_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "upstream_quota_threshold_percent" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "upstream_quota_probe_interval_minutes" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'provider_upstream_quota_snapshots_provider_id_providers_id_fk'
  ) THEN
    ALTER TABLE "provider_upstream_quota_snapshots"
      ADD CONSTRAINT "provider_upstream_quota_snapshots_provider_id_providers_id_fk"
      FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
