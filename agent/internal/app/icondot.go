package app

import (
	"bytes"
	"encoding/binary"
	"errors"
	"image"
	"image/draw"
	"image/png"
	"math"
	"sync"
)

// The tray icon with a small accent dot in the corner ("update available"): the dot is drawn into every frame
// of the embedded .ico (PNG frames and 32-bit BMP frames; other frames stay as they are).

var (
	dotFill = [3]float64{0x71, 0x80, 0xff} // --accent-hover
	dotRing = [3]float64{0xff, 0xff, 0xff}
)

// dotCoverage returns the ring and fill coverage (0..1) of pixel (x, y) for a frame of size s.
func dotCoverage(x, y, s int) (ring, fill float64) {
	r := math.Max(2.5, float64(s)*0.22)
	t := math.Max(1, float64(s)/16)
	cx, cy := float64(s)-r-0.5, r+0.5
	d := math.Hypot(float64(x)+0.5-cx, float64(y)+0.5-cy)
	clamp := func(v float64) float64 { return math.Max(0, math.Min(1, v)) }
	return clamp(r + 0.5 - d), clamp(r - t + 0.5 - d)
}

// blendDot puts the dot colours over a non-premultiplied RGBA pixel (0..255).
func blendDot(px *[4]float64, x, y, s int) {
	ring, fill := dotCoverage(x, y, s)
	if ring <= 0 {
		return
	}
	over := func(c [3]float64, a float64) {
		oa := px[3]/255*(1-a) + a
		if oa <= 0 {
			return
		}
		for i := 0; i < 3; i++ {
			px[i] = (px[i]*px[3]/255*(1-a) + c[i]*a) / oa
		}
		px[3] = oa * 255
	}
	over(dotRing, ring)
	if fill > 0 {
		over(dotFill, fill)
	}
}

func dotPNG(data []byte) ([]byte, error) {
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	b := img.Bounds()
	nr := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(nr, nr.Bounds(), img, b.Min, draw.Src)
	s := b.Dx()
	for y := 0; y < b.Dy(); y++ {
		for x := 0; x < s; x++ {
			i := nr.PixOffset(x, y)
			px := [4]float64{float64(nr.Pix[i]), float64(nr.Pix[i+1]), float64(nr.Pix[i+2]), float64(nr.Pix[i+3])}
			blendDot(&px, x, y, s)
			for k := 0; k < 4; k++ {
				nr.Pix[i+k] = uint8(math.Round(px[k]))
			}
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, nr); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// dotBMP handles a 32-bit DIB frame (BITMAPINFOHEADER, height doubled, bottom-up BGRA).
func dotBMP(data []byte) ([]byte, bool) {
	if len(data) < 40 || binary.LittleEndian.Uint32(data) != 40 || binary.LittleEndian.Uint16(data[14:]) != 32 || binary.LittleEndian.Uint32(data[16:]) != 0 {
		return nil, false
	}
	w := int(int32(binary.LittleEndian.Uint32(data[4:])))
	h := int(int32(binary.LittleEndian.Uint32(data[8:]))) / 2
	if w <= 0 || h != w || len(data) < 40+w*h*4 {
		return nil, false
	}
	out := append([]byte(nil), data...)
	for y := 0; y < h; y++ {
		row := 40 + (h-1-y)*w*4
		for x := 0; x < w; x++ {
			i := row + x*4
			px := [4]float64{float64(out[i+2]), float64(out[i+1]), float64(out[i]), float64(out[i+3])}
			blendDot(&px, x, y, w)
			out[i], out[i+1], out[i+2], out[i+3] = uint8(math.Round(px[2])), uint8(math.Round(px[1])), uint8(math.Round(px[0])), uint8(math.Round(px[3]))
		}
	}
	return out, true
}

// iconWithDot returns a copy of the .ico with the dot drawn in every frame it can handle.
func iconWithDot(ico []byte) ([]byte, error) {
	if len(ico) < 6 || binary.LittleEndian.Uint16(ico) != 0 || binary.LittleEndian.Uint16(ico[2:]) != 1 {
		return nil, errors.New("not an .ico")
	}
	n := int(binary.LittleEndian.Uint16(ico[4:]))
	if n == 0 || len(ico) < 6+n*16 {
		return nil, errors.New("bad .ico header")
	}
	head := append([]byte(nil), ico[:6+n*16]...)
	var body bytes.Buffer
	pngSig := []byte("\x89PNG\r\n\x1a\n")
	for i := 0; i < n; i++ {
		e := ico[6+i*16 : 6+i*16+16]
		size := int(binary.LittleEndian.Uint32(e[8:]))
		off := int(binary.LittleEndian.Uint32(e[12:]))
		if off < 0 || size < 0 || off+size > len(ico) {
			return nil, errors.New("bad .ico entry")
		}
		data := ico[off : off+size]
		var nd []byte
		if bytes.HasPrefix(data, pngSig) {
			if d, err := dotPNG(data); err == nil {
				nd = d
			}
		} else if d, ok := dotBMP(data); ok {
			nd = d
		}
		if nd == nil {
			nd = data
		}
		eo := 6 + i*16
		binary.LittleEndian.PutUint32(head[eo+8:], uint32(len(nd)))
		binary.LittleEndian.PutUint32(head[eo+12:], uint32(len(head)+body.Len()))
		body.Write(nd)
	}
	return append(head, body.Bytes()...), nil
}

var (
	dotOnce sync.Once
	dotICO  []byte
)

// iconDotICO is IconICO with the dot (nil when it cannot be made).
func iconDotICO() []byte {
	dotOnce.Do(func() {
		if len(IconICO) == 0 {
			return
		}
		if b, err := iconWithDot(IconICO); err == nil {
			dotICO = b
		} else {
			logf("tray icon dot: %v", err)
		}
	})
	return dotICO
}
