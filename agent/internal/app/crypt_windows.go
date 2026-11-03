//go:build windows

package app

import (
	"encoding/base64"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Secrets in config.json (refresh token, trk_ token) are encrypted with DPAPI for the current Windows user and
// stored as "dpapi:<base64>". A plain value (older config) is read as is and encrypted on the next write.
const dpapiPrefix = "dpapi:"

func protectSecret(s string) string {
	if s == "" || strings.HasPrefix(s, dpapiPrefix) {
		return s
	}
	in := []byte(s)
	var inBlob, outBlob windows.DataBlob
	inBlob.Size, inBlob.Data = uint32(len(in)), &in[0]
	if err := windows.CryptProtectData(&inBlob, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &outBlob); err != nil {
		return s // cannot encrypt: keep it readable rather than lose the sign-in
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(outBlob.Data)))
	enc := unsafe.Slice(outBlob.Data, outBlob.Size)
	return dpapiPrefix + base64.StdEncoding.EncodeToString(enc)
}

func unprotectSecret(s string) string {
	if !strings.HasPrefix(s, dpapiPrefix) {
		return s
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(s, dpapiPrefix))
	if err != nil || len(raw) == 0 {
		return ""
	}
	var inBlob, outBlob windows.DataBlob
	inBlob.Size, inBlob.Data = uint32(len(raw)), &raw[0]
	if err := windows.CryptUnprotectData(&inBlob, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &outBlob); err != nil {
		return "" // another user or machine: treated as not logged in
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(outBlob.Data)))
	return string(unsafe.Slice(outBlob.Data, outBlob.Size))
}
