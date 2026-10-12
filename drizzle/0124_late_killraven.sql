ALTER TABLE "workstation" ADD COLUMN "auto_stop_at" timestamp;--> statement-breakpoint
ALTER TABLE "workstation" ADD COLUMN "auto_stop_minutes" integer;--> statement-breakpoint
ALTER TABLE "workstation" ADD COLUMN "auto_stop_mode" text;