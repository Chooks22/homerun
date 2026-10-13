ALTER TABLE "workstation" ADD COLUMN "domain" text;--> statement-breakpoint
CREATE UNIQUE INDEX "workstation_domain_idx" ON "workstation" USING btree ("domain");