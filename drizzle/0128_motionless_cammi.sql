CREATE TABLE "workstation_preset" (
	"cpu_limit" double precision,
	"created_at" timestamp NOT NULL,
	"description" text,
	"editor_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"extensions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"git_author_email" text,
	"git_author_name" text,
	"git_branch" text,
	"git_provider_id" text,
	"git_url" text,
	"home_path" text DEFAULT '/home/coder' NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"image" text DEFAULT 'codercom/code-server:latest' NOT NULL,
	"memory_limit_mb" integer,
	"name" text NOT NULL,
	"port" integer DEFAULT 8080 NOT NULL,
	"remote_host_id" text,
	"updated_at" timestamp NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workstation" ADD COLUMN "sign_in_with_git" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workstation_preset" ADD CONSTRAINT "workstation_preset_remote_host_id_remote_host_id_fk" FOREIGN KEY ("remote_host_id") REFERENCES "public"."remote_host"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workstation_preset" ADD CONSTRAINT "workstation_preset_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workstationPreset_userId_idx" ON "workstation_preset" USING btree ("user_id");