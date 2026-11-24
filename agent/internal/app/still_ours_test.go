package app

import "testing"

func TestStillOurs(t *testing.T) {
	s := func(v string) *string { return &v }
	cases := []struct {
		req, dev *string
		want     bool
	}{
		{s("2026-11-24T12:47:36.936Z"), s("me"), true},     // nothing saved
		{nil, s("me"), false},                              // analysis saved (flag cleared)
		{s("2026-11-24T12:47:36.936Z"), nil, false},        // claim released
		{s("2026-11-24T12:47:36.936Z"), s("other"), false}, // re-requested and taken by another PC
	}
	for i, c := range cases {
		if got := stillOurs(c.req, c.dev, "me"); got != c.want {
			t.Errorf("case %d: got %v", i, got)
		}
	}
}
