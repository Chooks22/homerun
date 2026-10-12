ALTER TABLE "cron_job" ADD COLUMN "docker_socket" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cron_job" ADD COLUMN "mounts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cron_job" ADD COLUMN "run_as_user" text;