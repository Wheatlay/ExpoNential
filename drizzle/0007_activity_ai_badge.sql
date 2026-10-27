-- Wpisy z automatu (zajęcie analizy przez skrypt na PC, ślad pracy z hooka Claude Code) dostają znacznik AI, jak nowe.
UPDATE "activity" SET "via_ai" = true WHERE "payload"->>'kind' IN ('analysis_claimed', 'worklog') AND "via_ai" = false;
