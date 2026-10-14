ALTER TABLE "cron_job" ADD COLUMN "secret_env_keys" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "stale_dns_hosts" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "workstation_preset" ADD COLUMN "auth_allowed_emails" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workstation_preset" ADD COLUMN "auth_allowed_groups" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workstation_preset" ADD COLUMN "auth_allowed_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workstation_preset" ADD COLUMN "auth_providers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workstation_preset" ADD COLUMN "auth_required" boolean DEFAULT false NOT NULL;