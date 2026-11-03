ALTER TABLE "agents" ADD COLUMN "max_others_tokens_per_day" bigint;--> statement-breakpoint
-- Stary limit liczby zleceń przestaje obowiązywać (zastąpił go limit w tokenach).
UPDATE "agents" SET "max_for_others_per_day" = NULL;
