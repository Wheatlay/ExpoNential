package app

import "testing"

func TestPathHelpers(t *testing.T) {
	d := `C:\Users\a\AppData\Local\Programs\Exponential`
	p := pathWith(`C:\x;C:\y`, d)
	if p != `C:\x;C:\y;`+d {
		t.Fatal(p)
	}
	if pathWith(p, d+`\`) != p {
		t.Fatal("dedupe")
	}
	if pathWithout(p, d) != `C:\x;C:\y` {
		t.Fatal("remove")
	}
	if pathWith("", d) != d {
		t.Fatal("empty")
	}
}
