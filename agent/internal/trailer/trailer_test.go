package trailer

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func build(payload []byte, js string) []byte {
	var b bytes.Buffer
	b.Write(payload)
	b.WriteString(js)
	l := make([]byte, 4)
	binary.LittleEndian.PutUint32(l, uint32(len(js)))
	b.Write(l)
	b.WriteString(magic)
	return b.Bytes()
}

func TestParse(t *testing.T) {
	data := build([]byte("MZ fake pe bytes"), `{"url":"http://127.0.0.1:9","pairing":"pair_abc"}`)
	c, total, err := Parse(bytes.NewReader(data), int64(len(data)))
	if err != nil || c.URL != "http://127.0.0.1:9" || c.Pairing != "pair_abc" {
		t.Fatalf("got %+v %v", c, err)
	}
	if int64(len(data))-total != int64(len("MZ fake pe bytes")) {
		t.Fatalf("total %d", total)
	}
}

func TestParseNone(t *testing.T) {
	for _, d := range [][]byte{[]byte("MZ plain exe without trailer"), {}, []byte("EXPCFG01")} {
		if _, _, err := Parse(bytes.NewReader(d), int64(len(d))); err == nil {
			t.Fatalf("expected error for %q", d)
		}
	}
}

func TestParseBadLength(t *testing.T) {
	d := build(nil, `{"url":"x"}`)
	binary.LittleEndian.PutUint32(d[len(d)-12:], 99999)
	if _, _, err := Parse(bytes.NewReader(d), int64(len(d))); err == nil {
		t.Fatal("expected error")
	}
}
