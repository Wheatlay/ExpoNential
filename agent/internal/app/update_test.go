package app

import "testing"

func TestNewerAgentVersion(t *testing.T) {
	cases := []struct {
		tag, cur, want string
		ok             bool
	}{
		{"agent-v0.3.1", "0.3.0", "0.3.1", true},
		{"agent-v0.10.0", "0.9.5", "0.10.0", true},
		{"agent-v0.3.0", "0.3.0", "", false},
		{"agent-v0.2.9", "0.3.0", "", false},
		{"v1.0.0", "0.3.0", "", false},
		{"agent-v0.4.0-beta", "0.3.0", "", false},
	}
	for _, c := range cases {
		v, ok := newerAgentVersion(c.tag, c.cur)
		if v != c.want || ok != c.ok {
			t.Errorf("%s vs %s: %q %v", c.tag, c.cur, v, ok)
		}
	}
}

func TestParseSHA256Sums(t *testing.T) {
	h := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789ABCDEF"
	txt := "deadbeef  other.exe\r\n" + h + "  exponential-agent.exe\n"
	got, ok := parseSHA256Sums(txt, "exponential-agent.exe")
	if !ok || got != "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" {
		t.Fatal(got, ok)
	}
	if _, ok := parseSHA256Sums(h+" *exponential-agent.exe", "exponential-agent.exe"); !ok {
		t.Fatal("binary marker")
	}
	if _, ok := parseSHA256Sums("junk", "exponential-agent.exe"); ok {
		t.Fatal("junk")
	}
}
