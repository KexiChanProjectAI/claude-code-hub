-- Edge executor kill switch (default off: all traffic stays on the local proxy path).
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "edge_execution_enabled" boolean DEFAULT false NOT NULL;
