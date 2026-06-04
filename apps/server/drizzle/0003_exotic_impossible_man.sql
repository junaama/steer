ALTER TABLE "sessions" ADD COLUMN "environment" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "claimed_by" text;--> statement-breakpoint
CREATE INDEX "sessions_environment_idx" ON "sessions" USING btree ("environment");