ALTER TABLE "issues" ADD COLUMN "pause_reason" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "pause_prev_status_id" integer REFERENCES "statuses"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "pause_by_id" integer REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
UPDATE "statuses" s SET "role" = 'paused' WHERE s."name" = 'Paused' AND s."role" IS NULL AND NOT EXISTS (SELECT 1 FROM "statuses" x WHERE x."project_id" = s."project_id" AND x."role" = 'paused');--> statement-breakpoint
UPDATE "statuses" s SET "role" = 'in_progress' WHERE s."name" = 'In Progress' AND s."role" IS NULL AND NOT EXISTS (SELECT 1 FROM "statuses" x WHERE x."project_id" = s."project_id" AND x."role" = 'in_progress');
