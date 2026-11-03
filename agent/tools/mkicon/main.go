// mkicon renders the Exponential brand mark into a multi-size .ico (PNG entries).
// Usage: go run ./tools/mkicon assets/exponential.ico
package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"

	"golang.org/x/image/vector"
)

// The mark lives in a 26x26 box: a filled area under a rising curve, with an edge line along the curve.
type pt struct{ x, y float32 }

var (
	p0 = pt{2, 22}
	c1 = [4]pt{{2, 22}, {10, 22}, {14, 21}, {18, 14}}
	c2 = [4]pt{{18, 14}, {20, 10}, {21, 6}, {22, 3}}
)

func bez(c [4]pt, t float64) pt {
	u := 1 - t
	f := func(a, b, c, d float32) float32 {
		return float32(u*u*u)*a + float32(3*u*u*t)*b + float32(3*u*t*t)*c + float32(t*t*t)*d
	}
	return pt{f(c[0].x, c[1].x, c[2].x, c[3].x), f(c[0].y, c[1].y, c[2].y, c[3].y)}
}

func render(size int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	s := float32(size) / 26
	m := func(p pt) (float32, float32) { return p.x * s, p.y * s }

	fill := vector.NewRasterizer(size, size)
	fill.MoveTo(m(p0))
	fill.CubeTo(c1[1].x*s, c1[1].y*s, c1[2].x*s, c1[2].y*s, c1[3].x*s, c1[3].y*s)
	fill.CubeTo(c2[1].x*s, c2[1].y*s, c2[2].x*s, c2[2].y*s, c2[3].x*s, c2[3].y*s)
	fill.LineTo(m(pt{22, 22}))
	fill.ClosePath()
	fill.Draw(img, img.Bounds(), image.NewUniform(color.RGBA{0x5e, 0x6a, 0xd2, 0xff}), image.Point{})

	// Edge: the curve flattened into segments, each a quad of the same orientation (so overlaps add up, never cancel).
	var pts []pt
	for _, c := range [][4]pt{c1, c2} {
		for i := 0; i <= 24; i++ {
			pts = append(pts, bez(c, float64(i)/24))
		}
	}
	half := float64(1.6*s) / 2
	if half < 0.6 {
		half = 0.6
	}
	edge := vector.NewRasterizer(size, size)
	for i := 0; i+1 < len(pts); i++ {
		a, b := pts[i], pts[i+1]
		dx, dy := float64((b.x-a.x)*s), float64((b.y-a.y)*s)
		l := math.Hypot(dx, dy)
		if l == 0 {
			continue
		}
		nx, ny := float32(-dy/l*half), float32(dx/l*half)
		ax, ay, bx, by := a.x*s, a.y*s, b.x*s, b.y*s
		edge.MoveTo(ax+nx, ay+ny)
		edge.LineTo(bx+nx, by+ny)
		edge.LineTo(bx-nx, by-ny)
		edge.LineTo(ax-nx, ay-ny)
		edge.ClosePath()
	}
	edge.Draw(img, img.Bounds(), image.NewUniform(color.RGBA{0x71, 0x80, 0xff, 0xff}), image.Point{})
	return img
}

func main() {
	out := "assets/exponential.ico"
	if len(os.Args) > 1 {
		out = os.Args[1]
	}
	sizes := []int{16, 24, 32, 48, 256}
	var pngs [][]byte
	for _, s := range sizes {
		var b bytes.Buffer
		if err := png.Encode(&b, render(s)); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		pngs = append(pngs, b.Bytes())
	}
	var f bytes.Buffer
	binary.Write(&f, binary.LittleEndian, [3]uint16{0, 1, uint16(len(sizes))})
	off := 6 + 16*len(sizes)
	for i, s := range sizes {
		d := byte(s)
		if s >= 256 {
			d = 0
		}
		f.Write([]byte{d, d, 0, 0})
		binary.Write(&f, binary.LittleEndian, [2]uint16{1, 32})
		binary.Write(&f, binary.LittleEndian, [2]uint32{uint32(len(pngs[i])), uint32(off)})
		off += len(pngs[i])
	}
	for _, p := range pngs {
		f.Write(p)
	}
	_ = os.MkdirAll(filepath.Dir(out), 0o755)
	if err := os.WriteFile(out, f.Bytes(), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println("wrote", out)
}
