ALTER TABLE "issues" ADD COLUMN "change_notes_at" timestamp with time zone;--> statement-breakpoint
UPDATE "issues" SET "change_notes_at" = now() WHERE "change_human" <> '' OR "change_ai" <> '';
