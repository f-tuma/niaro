// Package bridge transports one bounded request to an already-running worker.
// It has no launcher, runtime client, resource override or worker administration.
package bridge

import (
	"context"
	"io"
	"net"
	"niaro/conversion/internal/wire"
	"os"
	"runtime"
	"time"
)

const SocketPath = "/run/niaro-conversion/conversion.sock"
const AppUID = 1000
const SupervisorUID = 0

type deadlineFile interface {
	io.Reader
	SetReadDeadline(time.Time) error
}

// Run has deliberately no configuration arguments or environment lookups.
func Run(ctx context.Context) error {
	if runtime.GOOS != "linux" || os.Getuid() != AppUID || os.Geteuid() != AppUID || len(os.Args) != 1 {
		return wire.ErrInvalid
	}
	in, out, err := stdio()
	if err != nil {
		return err
	}
	defer in.Close()
	defer out.Close()
	d := net.Dialer{Timeout: wire.IdleTimeout}
	c, err := d.DialContext(ctx, "unix", SocketPath)
	if err != nil {
		return err
	}
	conn, ok := c.(*net.UnixConn)
	if !ok {
		c.Close()
		return wire.ErrInvalid
	}
	defer conn.Close()
	return relay(ctx, in, out, conn, SupervisorUID, wire.IdleTimeout, wire.TransferTimeout)
}

// holdLast keeps submit incomplete at the worker until stdin has exact EOF.
// Closing on invalid trailing input therefore cannot accidentally turn a
// fully forwarded body into a valid EOF at the worker.
type holdLast struct {
	dst  io.Writer
	last byte
	held bool
}

func (w *holdLast) Write(b []byte) (int, error) {
	if len(b) == 0 {
		return 0, nil
	}
	if w.held {
		if e := wire.WriteAll(w.dst, []byte{w.last}); e != nil {
			return 0, e
		}
	}
	if e := wire.WriteAll(w.dst, b[:len(b)-1]); e != nil {
		return 0, e
	}
	w.last = b[len(b)-1]
	w.held = true
	return len(b), nil
}

func relay(ctx context.Context, in deadlineFile, out io.Writer, conn *net.UnixConn, uid uint32, idle, absolute time.Duration) error {
	// Peer auth precedes every read of the request and every socket write.
	if err := AuthenticatePeer(conn, uid); err != nil {
		return err
	}
	deadline := time.Now().Add(absolute)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	if err := conn.SetWriteDeadline(deadline); err != nil {
		return err
	}
	outputDeadline, hasOutputDeadline := out.(interface{ SetWriteDeadline(time.Time) error })
	if hasOutputDeadline {
		if err := outputDeadline.SetWriteDeadline(deadline); err != nil {
			return err
		}
	}
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			conn.Close()
			in.SetReadDeadline(time.Now())
			if hasOutputDeadline {
				outputDeadline.SetWriteDeadline(time.Now())
			}
		case <-done:
		}
	}()
	input := &wire.DeadlineReader{Reader: in, SetDeadline: in.SetReadDeadline, Absolute: deadline, Idle: idle}
	socketWriter := &wire.DeadlineWriter{Writer: conn, SetDeadline: conn.SetWriteDeadline, Absolute: deadline, Idle: idle}
	if hasOutputDeadline {
		out = &wire.DeadlineWriter{Writer: out, SetDeadline: outputDeadline.SetWriteDeadline, Absolute: deadline, Idle: idle}
	}
	meta, req, err := wire.ReadRequestMetadata(input)
	if err != nil {
		return err
	}
	if req.Op == "submit" {
		if err = wire.WriteMetadata(socketWriter, meta); err != nil {
			return err
		}
		held := holdLast{dst: socketWriter}
		if _, err = wire.ReceiveRequestBody(input, &held, req); err != nil {
			return err
		}
		if !held.held {
			return wire.ErrInvalid
		}
		if err = wire.WriteAll(socketWriter, []byte{held.last}); err != nil {
			return err
		}
	} else {
		if _, err = wire.ReceiveRequestBody(input, io.Discard, req); err != nil {
			return err
		}
		if err = wire.WriteMetadata(socketWriter, meta); err != nil {
			return err
		}
	}
	if err = conn.CloseWrite(); err != nil {
		return err
	}
	response := &wire.DeadlineReader{Reader: conn, SetDeadline: conn.SetReadDeadline, Absolute: deadline, Idle: idle}
	reply, err := wire.ReceiveResponse(response)
	if err != nil {
		return err
	}
	// The parent independently binds the immutable expected identity and ACK
	// recycle proof. The bridge still checks op/job equality for all frames.
	if reply.Response.Op != req.Op {
		return wire.ErrInvalid
	}
	if req.Job == nil {
		if reply.Response.Job != nil || (reply.Response.Kind != "readiness" && reply.Response.Kind != "error") {
			return wire.ErrInvalid
		}
	} else {
		if reply.Response.Kind == "readiness" {
			return wire.ErrInvalid
		}
		if reply.Response.Kind != "error" || reply.Response.Job != nil {
			if reply.Response.Job == nil || *req.Job != *reply.Response.Job {
				return wire.ErrInvalid
			}
		}
	}
	return wire.WriteReply(out, reply)
}
