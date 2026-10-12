CREATE TABLE "workstation" (
	"cpu_limit" double precision,
	"created_at" timestamp NOT NULL,
	"desired_state" text DEFAULT 'stopped' NOT NULL,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"git_branch" text,
	"git_url" text,
	"home_path" text DEFAULT '/home/coder' NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"image" text DEFAULT 'codercom/code-server:latest' NOT NULL,
	"last_error" text,
	"memory_limit_mb" integer,
	"name" text NOT NULL,
	"password_enc" text NOT NULL,
	"port" integer DEFAULT 8080 NOT NULL,
	"remote_host_id" text,
	"slug" text NOT NULL,
	"updated_at" timestamp NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workstation" ADD CONSTRAINT "workstation_remote_host_id_remote_host_id_fk" FOREIGN KEY ("remote_host_id") REFERENCES "public"."remote_host"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workstation" ADD CONSTRAINT "workstation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workstation_slug_idx" ON "workstation" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "workstation_userId_idx" ON "workstation" USING btree ("user_id");