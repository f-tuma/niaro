package main

import (
	"context"
	"fmt"
	"niaro/conversion/internal/bridge"
	"niaro/conversion/internal/wire"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	ctx, stop := context.WithTimeout(ctx, wire.TransferTimeout)
	defer stop()
	if bridge.Run(ctx) != nil {
		fmt.Fprintln(os.Stderr, "conversion transport unavailable")
		os.Exit(1)
	}
}
