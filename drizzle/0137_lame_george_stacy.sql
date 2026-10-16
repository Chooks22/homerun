ALTER TABLE "s3_destination" ADD COLUMN "backup_keep" integer;--> statement-breakpoint
ALTER TABLE "storage_volume" DROP COLUMN "backup_keep";