package app

import "testing"

func TestParseClaudeUsage(t *testing.T) {
	sample := `{"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"result":"ok","total_cost_usd":0.0421,"usage":{"input_tokens":12,"output_tokens":345,"cache_read_input_tokens":6789,"cache_creation_input_tokens":1011}}`
	for name, in := range map[string]string{
		"object": sample, "noise": "warning\n" + sample + "\n", "array": `[{"type":"system"},` + sample + `]`,
	} {
		u := parseClaudeUsage([]byte(in))
		if u == nil || *u.InputTokens != 12 || *u.OutputTokens != 345 || *u.CacheReadTokens != 6789 || *u.CacheWriteTokens != 1011 || *u.CostUSD != 0.0421 {
			t.Fatalf("%s: unexpected %+v", name, u)
		}
	}
	if parseClaudeUsage([]byte("plain text")) != nil || parseClaudeUsage(nil) != nil {
		t.Fatal("expected nil for non-JSON output")
	}
	if u := parseClaudeUsage([]byte(`{"type":"result","usage":{"output_tokens":5}}`)); u == nil || u.InputTokens != nil || *u.OutputTokens != 5 {
		t.Fatalf("partial usage: %+v", u)
	}
}
