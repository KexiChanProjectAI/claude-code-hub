-- Admin-authored Markdown appended to the model catalog (/v1/models/catalog and /models).
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "agent_catalog_notes" text;
