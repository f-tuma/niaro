//go:build !linux

package bridge

import (
	"niaro/conversion/internal/wire"
	"os"
)

func stdio() (*os.File, *os.File, error) { return nil, nil, wire.ErrInvalid }
