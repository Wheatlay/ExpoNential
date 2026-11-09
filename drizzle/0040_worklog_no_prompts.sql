UPDATE "activity" SET "payload" = jsonb_set("payload", '{prompts}', '[]'::jsonb) WHERE "payload"->>'kind' = 'worklog';
