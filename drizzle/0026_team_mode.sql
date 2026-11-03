ALTER TABLE "agents" ADD COLUMN "team_mode" text DEFAULT 'ask' NOT NULL;
--> statement-breakpoint
-- Komputery, które dołączyły do kolejki zespołu w jakimkolwiek projekcie, już się zgodziły: tryb bez pytania.
UPDATE "agents" SET "team_mode" = 'auto' WHERE "id" IN (SELECT "agent_id" FROM "agent_team_projects");
