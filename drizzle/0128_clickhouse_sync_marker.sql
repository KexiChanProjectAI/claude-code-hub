-- ClickHouse request-log sync: per-row sync marker replaces the id cursor.
--
-- In MESSAGE_REQUEST_INSERT_MODE=async each process reserves ids in chunks and may use a
-- reserved id hours later, so "every row below the cursor has been synced" is false. The
-- sync worker now selects rows by clickhouse_synced_at IS NULL and marks them only after
-- ClickHouse acknowledged the insert; log cleanup only deletes marked (or out-of-scope) rows.
--
-- ADD COLUMN (nullable, no default) is catalog-only. The partial index build takes a SHARE
-- lock on message_request for a few seconds on large tables, and Drizzle's migrator runs
-- inside a transaction so CREATE INDEX CONCURRENTLY cannot be inlined here. On busy or
-- multi-replica installs, pre-create the identical index BEFORE deploying (psql, outside a
-- transaction); IF NOT EXISTS below then turns the build into a no-op:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_message_request_clickhouse_unsynced"
--     ON "message_request" USING btree ("created_at","id")
--     WHERE "deleted_at" IS NULL AND "clickhouse_synced_at" IS NULL
--       AND ("blocked_by" IS NULL OR "blocked_by" <> 'warmup');
-- (Requires the column first: ALTER TABLE "message_request" ADD COLUMN IF NOT EXISTS
--  "clickhouse_synced_at" timestamp with time zone;)
CREATE TABLE IF NOT EXISTS "clickhouse_sync_state" (
	"key" varchar(32) PRIMARY KEY DEFAULT 'default' NOT NULL,
	"floor_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_request" ADD COLUMN IF NOT EXISTS "clickhouse_synced_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_message_request_clickhouse_unsynced" ON "message_request" USING btree ("created_at","id") WHERE "message_request"."deleted_at" IS NULL AND "message_request"."clickhouse_synced_at" IS NULL AND ("message_request"."blocked_by" IS NULL OR "message_request"."blocked_by" <> 'warmup');
