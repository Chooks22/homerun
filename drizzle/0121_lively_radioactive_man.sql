ALTER TABLE "cron_job" ADD COLUMN "files" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cron_job" ADD COLUMN "runtime" text;--> statement-breakpoint
ALTER TABLE "cron_job" ADD COLUMN "source" text;