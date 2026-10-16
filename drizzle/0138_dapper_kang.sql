CREATE TABLE "pipeline_run" (
	"actor" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"billable_minutes" integer DEFAULT 0 NOT NULL,
	"branch" text,
	"commit_sha" text,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp NOT NULL,
	"duration_ms" double precision,
	"event" text,
	"external_id" text NOT NULL,
	"finished_at" timestamp,
	"id" text PRIMARY KEY NOT NULL,
	"jobs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"name" text NOT NULL,
	"number" integer,
	"provider" text NOT NULL,
	"queue_ms" double precision,
	"service_id" text NOT NULL,
	"started_at" timestamp,
	"status" text NOT NULL,
	"title" text,
	"trace_exported" boolean DEFAULT false NOT NULL,
	"trace_id" text,
	"updated_at" timestamp NOT NULL,
	"url" text
);
--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "pipelines_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "pipeline_rates" jsonb;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "pipelines_synced_at" timestamp;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "pipelines_error" text;--> statement-breakpoint
ALTER TABLE "pipeline_run" ADD CONSTRAINT "pipeline_run_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pipelineRun_serviceId_externalId_idx" ON "pipeline_run" USING btree ("service_id","external_id");--> statement-breakpoint
CREATE INDEX "pipelineRun_serviceId_createdAt_idx" ON "pipeline_run" USING btree ("service_id","created_at");