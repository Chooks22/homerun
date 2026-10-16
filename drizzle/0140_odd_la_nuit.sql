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
	"repository_id" text NOT NULL,
	"started_at" timestamp,
	"status" text NOT NULL,
	"title" text,
	"trace_exported" boolean DEFAULT false NOT NULL,
	"trace_id" text,
	"trace_service_id" text,
	"updated_at" timestamp NOT NULL,
	"url" text
);
--> statement-breakpoint
CREATE TABLE "repository" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"default_branch" text,
	"full_name" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"pipeline_rates" jsonb,
	"pipelines_enabled" boolean DEFAULT true NOT NULL,
	"pipelines_error" text,
	"pipelines_synced_at" timestamp,
	"provider_id" text NOT NULL,
	"provider_kind" text NOT NULL,
	"updated_at" timestamp NOT NULL,
	"user_id" text NOT NULL,
	"web_url" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "repository_id" text;--> statement-breakpoint
ALTER TABLE "pipeline_run" ADD CONSTRAINT "pipeline_run_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_run" ADD CONSTRAINT "pipeline_run_trace_service_id_service_id_fk" FOREIGN KEY ("trace_service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository" ADD CONSTRAINT "repository_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pipelineRun_repositoryId_externalId_idx" ON "pipeline_run" USING btree ("repository_id","external_id");--> statement-breakpoint
CREATE INDEX "pipelineRun_repositoryId_createdAt_idx" ON "pipeline_run" USING btree ("repository_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_providerId_fullName_idx" ON "repository" USING btree ("provider_id","full_name");--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE set null ON UPDATE no action;