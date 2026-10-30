//go:build !linux

package bridge

import (
	"net"
	"niaro/conversion/internal/wire"
)

func AuthenticatePeer(_ *net.UnixConn, _ uint32) error { return wire.ErrInvalid }
