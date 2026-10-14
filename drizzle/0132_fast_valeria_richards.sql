ALTER TABLE "instance_settings" ADD COLUMN "service_subdomain" text;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "preview_uptime_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workstation" ADD COLUMN "auth_allowed_emails" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workstation" ADD COLUMN "auth_allowed_groups" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workstation" ADD COLUMN "auth_allowed_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workstation" ADD COLUMN "auth_providers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workstation" ADD COLUMN "auth_required" boolean DEFAULT false NOT NULL;