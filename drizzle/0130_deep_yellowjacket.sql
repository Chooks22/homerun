CREATE TABLE "audit_log" (
	"action" text NOT NULL,
	"actor_id" text,
	"actor_name" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"detail" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"ip_address" text,
	"status" integer
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "type" text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auditLog_createdAt_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "auditLog_actorId_idx" ON "audit_log" USING btree ("actor_id");