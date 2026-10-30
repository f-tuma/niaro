//go:build linux

package bridge

import (
	"niaro/conversion/internal/wire"
	"os"
	"syscall"
	"time"
)

// Inherited Node pipes may be blocking when os.Stdin/Stdout are initialized.
// Go only attempts deadline-capable polling for nonblocking NewFile fds.
// Duplicate the fixed stdio endpoints atomically with CLOEXEC. Ownership of a
// duplicate transfers exactly once from syscall to os.File; Close then clears
// its finalizer. Never close/re-wrap fd0/1: their original global os.File owners
// remain alive and cannot later close a reused descriptor. No File.Fd call
// changes polling mode after wrapping. O_NONBLOCK is shared with the original
// child-side endpoint; the original wrappers are deliberately never used.
func stdio() (*os.File, *os.File, error) {
	in, e := pollableStandard(0, true)
	if e != nil {
		return nil, nil, e
	}
	out, e := pollableStandard(1, false)
	if e != nil {
		in.Close()
		return nil, nil, e
	}
	return in, out, nil
}
func pollableStandard(fd int, read bool) (*os.File, error) {
	dup, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), syscall.F_DUPFD_CLOEXEC, 3)
	if errno != 0 {
		return nil, errno
	}
	if e := syscall.SetNonblock(int(dup), true); e != nil {
		syscall.Close(int(dup))
		return nil, e
	}
	f := os.NewFile(dup, "conversion-stdio")
	if f == nil {
		syscall.Close(int(dup))
		return nil, wire.ErrInvalid
	}
	deadline := time.Now().Add(wire.TransferTimeout)
	var e error
	if read {
		e = f.SetReadDeadline(deadline)
	} else {
		e = f.SetWriteDeadline(deadline)
	}
	if e != nil {
		f.Close()
		return nil, e
	}
	return f, nil
}
