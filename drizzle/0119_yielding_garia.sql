ALTER TABLE "instance_settings" ADD COLUMN "crowdsec_url" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "crowdsec_machine_id" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "crowdsec_password_enc" text;