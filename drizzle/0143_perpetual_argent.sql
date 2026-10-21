ALTER TABLE "blocked_hit" ADD COLUMN "bait_bytes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "blocked_hit" ADD COLUMN "pattern" text;--> statement-breakpoint
ALTER TABLE "blocked_hit" ADD COLUMN "service_id" text;--> statement-breakpoint
ALTER TABLE "blocked_hit" ADD CONSTRAINT "blocked_hit_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blockedHit_createdAt_idx" ON "blocked_hit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "blockedHit_serviceId_createdAt_idx" ON "blocked_hit" USING btree ("service_id","created_at");