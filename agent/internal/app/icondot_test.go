package app

import (
	"bytes"
	"encoding/binary"
	"image/png"
	"os"
	"testing"
)

type icoFrame struct {
	w    int
	data []byte
}

func parseICO(t *testing.T, b []byte) []icoFrame {
	t.Helper()
	if len(b) < 6 || binary.LittleEndian.Uint16(b[2:]) != 1 {
		t.Fatal("not an ico")
	}
	n := int(binary.LittleEndian.Uint16(b[4:]))
	var out []icoFrame
	for i := 0; i < n; i++ {
		e := b[6+i*16:]
		size, off := int(binary.LittleEndian.Uint32(e[8:])), int(binary.LittleEndian.Uint32(e[12:]))
		if off+size > len(b) {
			t.Fatalf("frame %d out of range", i)
		}
		w := int(e[0])
		if w == 0 {
			w = 256
		}
		out = append(out, icoFrame{w, b[off : off+size]})
	}
	return out
}

func TestIconDotRealIcon(t *testing.T) {
	src, err := os.ReadFile("../../assets/exponential.ico")
	if err != nil {
		t.Skip("no icon")
	}
	out, err := iconWithDot(src)
	if err != nil {
		t.Fatal(err)
	}
	a, b := parseICO(t, src), parseICO(t, out)
	if len(a) != len(b) {
		t.Fatalf("frames %d vs %d", len(a), len(b))
	}
	seen := map[int]bool{}
	for i := range b {
		if b[i].w != a[i].w {
			t.Fatal("size changed")
		}
		img, err := png.Decode(bytes.NewReader(b[i].data))
		if err != nil {
			t.Fatalf("frame %d: %v", b[i].w, err)
		}
		if img.Bounds().Dx() != b[i].w {
			t.Fatal("frame size")
		}
		if bytes.Equal(a[i].data, b[i].data) {
			t.Errorf("frame %d unchanged", b[i].w)
		}
		// a pixel inside the dot: opaque and blue-ish (the accent), not the white ring
		r, g, bl, al := img.At(b[i].w-1-b[i].w/8, b[i].w/8).RGBA()
		if al>>8 < 250 || bl>>8 < 200 || (r>>8 > 0xf0 && g>>8 > 0xf0 && bl>>8 > 0xf0) {
			t.Errorf("frame %d: dot colour %d %d %d %d", b[i].w, r>>8, g>>8, bl>>8, al>>8)
		}
		seen[b[i].w] = true
	}
	if !seen[16] || !seen[32] {
		t.Fatalf("16 and 32 px frames expected: %v", seen)
	}
}

func TestIconDotBMPFrame(t *testing.T) {
	const s = 16
	dib := make([]byte, 40+s*s*4+s*4)
	binary.LittleEndian.PutUint32(dib, 40)
	binary.LittleEndian.PutUint32(dib[4:], s)
	binary.LittleEndian.PutUint32(dib[8:], s*2)
	binary.LittleEndian.PutUint16(dib[12:], 1)
	binary.LittleEndian.PutUint16(dib[14:], 32)
	for i := 40; i < 40+s*s*4; i += 4 {
		dib[i], dib[i+1], dib[i+2], dib[i+3] = 0x20, 0x1b, 0x1a, 255
	}
	ico := make([]byte, 22+len(dib))
	binary.LittleEndian.PutUint16(ico[2:], 1)
	binary.LittleEndian.PutUint16(ico[4:], 1)
	ico[6], ico[7] = s, s
	binary.LittleEndian.PutUint32(ico[14:], uint32(len(dib)))
	binary.LittleEndian.PutUint32(ico[18:], 22)
	copy(ico[22:], dib)
	out, err := iconWithDot(ico)
	if err != nil {
		t.Fatal(err)
	}
	f := parseICO(t, out)
	if len(f) != 1 || len(f[0].data) != len(dib) || bytes.Equal(f[0].data, dib) {
		t.Fatal("BMP frame not changed")
	}
	// inside the dot, near the top-right corner (the top image row is the last row of the DIB)
	i := 40 + (s-1-s/8)*s*4 + (s-1-s/8)*4
	if f[0].data[i+2] < 0x60 || f[0].data[i] < 0xd0 {
		t.Fatalf("pixel %v", f[0].data[i:i+4])
	}
}

func TestIconDotRejectsJunk(t *testing.T) {
	if _, err := iconWithDot([]byte("nope")); err == nil {
		t.Fatal("junk must fail")
	}
}
