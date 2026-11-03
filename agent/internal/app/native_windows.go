//go:build windows

package app

import (
	"errors"
	"fmt"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Small native helpers of the settings window: the clipboard and the folder picker.

var (
	procOpenClipboard    = user32.NewProc("OpenClipboard")
	procCloseClipboard   = user32.NewProc("CloseClipboard")
	procEmptyClipboard   = user32.NewProc("EmptyClipboard")
	procSetClipboardData = user32.NewProc("SetClipboardData")
	kernel32             = windows.NewLazySystemDLL("kernel32.dll")
	procGlobalAlloc      = kernel32.NewProc("GlobalAlloc")
	procGlobalLock       = kernel32.NewProc("GlobalLock")
	procGlobalUnlock     = kernel32.NewProc("GlobalUnlock")
	procGlobalFree       = kernel32.NewProc("GlobalFree")
	shell32              = windows.NewLazySystemDLL("shell32.dll")
	procBrowseForFolder  = shell32.NewProc("SHBrowseForFolderW")
	procPathFromIDList   = shell32.NewProc("SHGetPathFromIDListW")
	procCoCreateInstance = windows.NewLazySystemDLL("ole32.dll").NewProc("CoCreateInstance")
)

// setClipboard puts text on the clipboard as CF_UNICODETEXT.
func setClipboard(text string) error {
	u, err := windows.UTF16FromString(text)
	if err != nil {
		return err
	}
	var opened bool
	for i := 0; i < 10 && !opened; i++ { // another program may hold the clipboard for a moment
		r, _, _ := procOpenClipboard.Call(0)
		if opened = r != 0; !opened {
			time.Sleep(20 * time.Millisecond)
		}
	}
	if !opened {
		return errors.New("clipboard is busy")
	}
	defer procCloseClipboard.Call()
	procEmptyClipboard.Call()
	size := uintptr(len(u) * 2)
	h, _, _ := procGlobalAlloc.Call(0x0002, size) // GMEM_MOVEABLE
	if h == 0 {
		return errors.New("out of memory")
	}
	p, _, _ := procGlobalLock.Call(h)
	if p == 0 {
		procGlobalFree.Call(h)
		return errors.New("cannot lock memory")
	}
	copy(unsafe.Slice((*uint16)(*(*unsafe.Pointer)(unsafe.Pointer(&p))), len(u)), u)
	procGlobalUnlock.Call(h)
	if r, _, _ := procSetClipboardData.Call(13, h); r == 0 { // CF_UNICODETEXT
		procGlobalFree.Call(h)
		return errors.New("cannot set clipboard data")
	}
	return nil // the system owns the memory now
}

// IFileOpenDialog (FOS_PICKFOLDERS) through raw COM calls.
var (
	clsidFileOpenDialog = windows.GUID{Data1: 0xDC1C5A9C, Data2: 0xE88A, Data3: 0x4DDE, Data4: [8]byte{0xA5, 0xA1, 0x60, 0xF8, 0x2A, 0x20, 0xAE, 0xF7}}
	iidFileOpenDialog   = windows.GUID{Data1: 0xD57C7288, Data2: 0xD4AD, Data3: 0x4768, Data4: [8]byte{0xBE, 0x02, 0x9D, 0x96, 0x95, 0x32, 0xD9, 0x60}}
)

// vcall calls method idx of a COM object (vtable layout: IUnknown first).
func vcall(obj unsafe.Pointer, idx int, args ...uintptr) uintptr {
	vt := *(*unsafe.Pointer)(obj)
	fn := *(*uintptr)(unsafe.Add(vt, idx*int(unsafe.Sizeof(uintptr(0)))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{uintptr(obj)}, args...)...)
	return r
}

const hrCancelled = 0x800704C7 // HRESULT_FROM_WIN32(ERROR_CANCELLED)

// pickFolder shows the native folder picker. "" with a nil error = cancelled. When COM fails, the older
// SHBrowseForFolder dialog is used.
func pickFolder(owner uintptr, title string) (string, error) {
	err := windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED)
	switch err {
	case nil, syscall.Errno(1): // S_OK, S_FALSE: initialised (balance below)
		defer windows.CoUninitialize()
	}
	p, perr := pickFolderCOM(owner, title)
	if perr == nil {
		return p, nil
	}
	logf("folder picker (COM): %v", perr)
	return pickFolderLegacy(owner, title)
}

func pickFolderCOM(owner uintptr, title string) (string, error) {
	var dlg unsafe.Pointer
	hr0, _, _ := procCoCreateInstance.Call(uintptr(unsafe.Pointer(&clsidFileOpenDialog)), 0, 1 /* CLSCTX_INPROC_SERVER */, uintptr(unsafe.Pointer(&iidFileOpenDialog)), uintptr(unsafe.Pointer(&dlg)))
	if hr0 != 0 || dlg == nil {
		return "", fmt.Errorf("cannot create the dialog (0x%x)", hr0)
	}
	defer vcall(dlg, 2) // Release
	var opts uint32
	if hr := vcall(dlg, 10, uintptr(unsafe.Pointer(&opts))); hr != 0 { // GetOptions
		return "", errors.New("GetOptions failed")
	}
	opts |= 0x20 | 0x40 | 0x800                      // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST
	if hr := vcall(dlg, 9, uintptr(opts)); hr != 0 { // SetOptions
		return "", errors.New("SetOptions failed")
	}
	if t, err := windows.UTF16PtrFromString(title); err == nil {
		vcall(dlg, 17, uintptr(unsafe.Pointer(t))) // SetTitle
	}
	hr := vcall(dlg, 3, owner) // Show
	if hr == hrCancelled {
		return "", nil
	}
	if hr != 0 {
		return "", errors.New("Show failed")
	}
	var item unsafe.Pointer
	if hr := vcall(dlg, 20, uintptr(unsafe.Pointer(&item))); hr != 0 || item == nil { // GetResult
		return "", errors.New("GetResult failed")
	}
	defer vcall(item, 2)
	var name *uint16
	if hr := vcall(item, 5, 0x80058000, uintptr(unsafe.Pointer(&name))); hr != 0 || name == nil { // GetDisplayName(SIGDN_FILESYSPATH)
		return "", errors.New("GetDisplayName failed")
	}
	defer windows.CoTaskMemFree(unsafe.Pointer(name))
	return windows.UTF16PtrToString(name), nil
}

type browseInfo struct {
	Owner       uintptr
	Root        uintptr
	DisplayName *uint16
	Title       *uint16
	Flags       uint32
	Fn          uintptr
	LParam      uintptr
	Image       int32
}

func pickFolderLegacy(owner uintptr, title string) (string, error) {
	buf := make([]uint16, windows.MAX_PATH)
	t, _ := windows.UTF16PtrFromString(title)
	bi := browseInfo{Owner: owner, DisplayName: &buf[0], Title: t, Flags: 0x1 | 0x40 | 0x10} // RETURNONLYFSDIRS | NEWDIALOGSTYLE | EDITBOX
	pidl, _, _ := procBrowseForFolder.Call(uintptr(unsafe.Pointer(&bi)))
	if pidl == 0 {
		return "", nil
	}
	defer windows.CoTaskMemFree(*(*unsafe.Pointer)(unsafe.Pointer(&pidl)))
	if r, _, _ := procPathFromIDList.Call(pidl, uintptr(unsafe.Pointer(&buf[0]))); r == 0 {
		return "", errors.New("not a file system folder")
	}
	return windows.UTF16ToString(buf), nil
}
