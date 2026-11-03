//go:build windows

package app

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	procPrivateExtractIcons = user32.NewProc("PrivateExtractIconsW")
	procDrawIconEx          = user32.NewProc("DrawIconEx")
	procDestroyIcon         = user32.NewProc("DestroyIcon")
	procGetDC               = user32.NewProc("GetDC")
	procReleaseDC           = user32.NewProc("ReleaseDC")
	gdi32                   = windows.NewLazySystemDLL("gdi32.dll")
	procCreateCompatibleDC  = gdi32.NewProc("CreateCompatibleDC")
	procCreateDIBSection    = gdi32.NewProc("CreateDIBSection")
	procSelectObject        = gdi32.NewProc("SelectObject")
	procDeleteObject        = gdi32.NewProc("DeleteObject")
	procDeleteDC            = gdi32.NewProc("DeleteDC")
	procGdiFlush            = gdi32.NewProc("GdiFlush")
)

type bitmapInfoHeader struct {
	Size          uint32
	Width, Height int32
	Planes, Bits  uint16
	Compression   uint32
	SizeImage     uint32
	XPels, YPels  int32
	ClrUsed       uint32
	ClrImportant  uint32
}

// engineIcons returns data:image/png URIs for the engine binary and for the editor that hosts it ("" = none).
func engineIcons(bin string) (engine, host string) {
	defer func() { _ = recover() }()
	engine = exeIconURI(bin)
	for _, c := range hostExeCandidates(bin, os.Getenv("LOCALAPPDATA"), os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)")) {
		if _, err := os.Stat(c); err == nil {
			if host = exeIconURI(c); host != "" {
				break
			}
		}
	}
	return
}

// exeIconURI extracts the 64 px icon of an .exe and returns it as a PNG data URI; "" for scripts/shims or on failure.
func exeIconURI(path string) string {
	if path == "" || !strings.EqualFold(filepath.Ext(path), ".exe") {
		return ""
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return ""
	}
	const sz = 64
	var hicon uintptr
	n, _, _ := procPrivateExtractIcons.Call(uintptr(unsafe.Pointer(p)), 0, sz, sz, uintptr(unsafe.Pointer(&hicon)), 0, 1, 0)
	if n == 0 || n == 0xFFFFFFFF || hicon == 0 {
		return ""
	}
	defer procDestroyIcon.Call(hicon)

	screen, _, _ := procGetDC.Call(0)
	defer procReleaseDC.Call(0, screen)
	dc, _, _ := procCreateCompatibleDC.Call(screen)
	if dc == 0 {
		return ""
	}
	defer procDeleteDC.Call(dc)
	bi := bitmapInfoHeader{Size: uint32(unsafe.Sizeof(bitmapInfoHeader{})), Width: sz, Height: -sz, Planes: 1, Bits: 32}
	var bits unsafe.Pointer
	bmp, _, _ := procCreateDIBSection.Call(dc, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if bmp == 0 || bits == nil {
		return ""
	}
	defer procDeleteObject.Call(bmp)
	old, _, _ := procSelectObject.Call(dc, bmp)
	defer procSelectObject.Call(dc, old)
	if r, _, _ := procDrawIconEx.Call(dc, 0, 0, hicon, sz, sz, 0, 0, 3); r == 0 { // DI_NORMAL
		return ""
	}
	procGdiFlush.Call()
	raw := unsafe.Slice((*byte)(bits), sz*sz*4)
	img := image.NewRGBA(image.Rect(0, 0, sz, sz))
	opaque := true // icons without an alpha channel leave alpha 0
	for i := 0; i < sz*sz*4; i += 4 {
		if raw[i+3] != 0 {
			opaque = false
			break
		}
	}
	for i := 0; i < sz*sz*4; i += 4 {
		a := raw[i+3]
		if opaque {
			if raw[i]|raw[i+1]|raw[i+2] == 0 {
				continue
			}
			a = 255
		}
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = raw[i+2], raw[i+1], raw[i], a // BGRA (premultiplied) -> RGBA
	}
	var buf bytes.Buffer
	if png.Encode(&buf, img) != nil {
		return ""
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
}
