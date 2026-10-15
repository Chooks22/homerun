ALTER TABLE "service" ADD COLUMN "scale_to_zero_minutes" integer;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "sleeping_since" timestamp;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "woken_at" timestamp;