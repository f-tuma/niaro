//go:build linux

package bridge

import (
	"net"
	"niaro/conversion/internal/wire"
	"syscall"
)

// AuthenticatePeer is also the supervisor's future pre-read seam. Group/socket
// permissions and PID numbers do not substitute for the kernel UID check.
func AuthenticatePeer(conn *net.UnixConn, expectedUID uint32) error {
	raw, err := conn.SyscallConn()
	if err != nil {
		return err
	}
	var cred *syscall.Ucred
	var getErr error
	err = raw.Control(func(fd uintptr) {
		cred, getErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	})
	if err != nil {
		return err
	}
	if getErr != nil {
		return getErr
	}
	if cred == nil || cred.Uid != expectedUID {
		return wire.ErrInvalid
	}
	return nil
}
