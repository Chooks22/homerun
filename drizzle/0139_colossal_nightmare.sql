DROP TABLE "pipeline_run" CASCADE;--> statement-breakpoint
ALTER TABLE "service" DROP COLUMN "pipelines_enabled";--> statement-breakpoint
ALTER TABLE "service" DROP COLUMN "pipeline_rates";--> statement-breakpoint
ALTER TABLE "service" DROP COLUMN "pipelines_synced_at";--> statement-breakpoint
ALTER TABLE "service" DROP COLUMN "pipelines_error";