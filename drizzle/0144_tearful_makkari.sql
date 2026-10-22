ALTER TABLE "blocked_hit" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "ip_ban" ADD COLUMN "intel" jsonb;--> statement-breakpoint
ALTER TABLE "ip_ban" ADD COLUMN "user_agent" text;--> statement-breakpoint
UPDATE "ip_ban" SET "expires_at" = NULL;--> statement-breakpoint
UPDATE "instance_settings" SET "ip_bans" = jsonb_set("ip_bans", '{durationHours}', '0') WHERE "ip_bans" ? 'durationHours';