-- Plugin i serwer MCP nazywają się teraz expo (Server 1.3.23): własne polecenia projektów dostają nowe nazwy.
UPDATE "projects" SET
  "prompt_start" = replace(replace(replace(replace("prompt_start", 'tracker:analyze-tracker-ticket', 'expo:analyze-ticket'), 'tracker:close-ticket', 'expo:close-ticket'), 'mcp__tracker__', 'mcp__expo__'), 'analyze-tracker-ticket', 'analyze-ticket'),
  "prompt_analyze" = replace(replace(replace(replace("prompt_analyze", 'tracker:analyze-tracker-ticket', 'expo:analyze-ticket'), 'tracker:close-ticket', 'expo:close-ticket'), 'mcp__tracker__', 'mcp__expo__'), 'analyze-tracker-ticket', 'analyze-ticket'),
  "prompt_close" = replace(replace(replace(replace("prompt_close", 'tracker:analyze-tracker-ticket', 'expo:analyze-ticket'), 'tracker:close-ticket', 'expo:close-ticket'), 'mcp__tracker__', 'mcp__expo__'), 'analyze-tracker-ticket', 'analyze-ticket'),
  "prompt_deep" = replace(replace(replace(replace("prompt_deep", 'tracker:analyze-tracker-ticket', 'expo:analyze-ticket'), 'tracker:close-ticket', 'expo:close-ticket'), 'mcp__tracker__', 'mcp__expo__'), 'analyze-tracker-ticket', 'analyze-ticket');
