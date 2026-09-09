ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "overwrite_response_model" boolean DEFAULT false NOT NULL;
