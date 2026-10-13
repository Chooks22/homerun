ALTER TABLE "stat_sample" ADD COLUMN "workstation_id" text;--> statement-breakpoint
ALTER TABLE "workstation" ADD COLUMN "editor_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workstation" ADD COLUMN "extensions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workstation" ADD COLUMN "git_author_email" text;--> statement-breakpoint
ALTER TABLE "workstation" ADD COLUMN "git_author_name" text;--> statement-breakpoint
ALTER TABLE "workstation" ADD COLUMN "git_provider_id" text;--> statement-breakpoint
ALTER TABLE "stat_sample" ADD CONSTRAINT "stat_sample_workstation_id_workstation_id_fk" FOREIGN KEY ("workstation_id") REFERENCES "public"."workstation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "statSample_workstationId_createdAt_idx" ON "stat_sample" USING btree ("workstation_id","created_at");