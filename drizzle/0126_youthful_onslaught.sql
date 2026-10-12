ALTER TABLE "service" ADD COLUMN "pinned_from_tag" text;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "pinned_locally" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "update_check_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "update_trial_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "update_check" jsonb;