ALTER TYPE "public"."notification_type" ADD VALUE 'client_problem';--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "client_problem_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "client_problem_webhook" varchar(512);--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "client_problem_count_threshold" integer DEFAULT 10;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "client_problem_window_minutes" integer DEFAULT 5;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "client_problem_cyber_count_threshold" integer DEFAULT 3;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "client_problem_cyber_window_minutes" integer DEFAULT 5;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "title_prefix" varchar(64);