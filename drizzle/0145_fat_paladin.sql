ALTER TABLE "instance_settings" ADD COLUMN "build_concurrency" integer;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "build_on_host" boolean;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "default_build_server" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "build_host_id" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "deferred_for" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "deferred_since" timestamp;--> statement-breakpoint
ALTER TABLE "remote_host" ADD COLUMN "max_concurrent_builds" integer;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "build_server_any" boolean DEFAULT false NOT NULL;