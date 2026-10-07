-- Case-insensitive model name lookups for price fallback matching.
CREATE INDEX IF NOT EXISTS "idx_model_prices_model_name_lower" ON "model_prices" USING btree (lower("model_name"));
