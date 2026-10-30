//go:build linux

package bridge

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"niaro/conversion/internal/wire"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func pair(t *testing.T) (*net.UnixConn, *net.UnixConn) {
	t.Helper()
	addr := &net.UnixAddr{Name: filepath.Join(t.TempDir(), "synthetic.sock"), Net: "unix"}
	l, e := net.ListenUnix("unix", addr)
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	a, e := net.DialUnix("unix", nil, addr)
	if e != nil {
		t.Fatal(e)
	}
	b, e := l.AcceptUnix()
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { a.Close(); b.Close() })
	a.SetDeadline(time.Now().Add(2 * time.Second))
	b.SetDeadline(time.Now().Add(2 * time.Second))
	return a, b
}
func vector(t *testing.T, name string) []byte {
	b, e := os.ReadFile("../../../../tests/fixtures/conversion-v1/wire-fixtures.v2.json")
	if e != nil {
		t.Fatal(e)
	}
	var x struct {
		Vectors []struct{ Name, WireHex string }
	}
	if e = json.Unmarshal(b, &x); e != nil {
		t.Fatal(e)
	}
	for _, v := range x.Vectors {
		if v.Name == name {
			b, e = hex.DecodeString(v.WireHex)
			if e != nil {
				t.Fatal(e)
			}
			return b
		}
	}
	t.Fatal("vector missing")
	return nil
}
func TestKernelPeerCredentialsBothEnds(t *testing.T) {
	a, b := pair(t)
	uid := uint32(os.Getuid())
	if AuthenticatePeer(a, uid) != nil || AuthenticatePeer(b, uid) != nil {
		t.Fatal("kernel UID not observed")
	}
	if AuthenticatePeer(a, uid+1) == nil || AuthenticatePeer(b, uid+1) == nil {
		t.Fatal("wrong UID admitted")
	}
	if uid != SupervisorUID && AuthenticatePeer(a, SupervisorUID) == nil {
		t.Fatal("unprivileged synthetic worker accepted as production supervisor")
	}
}
func TestWrongPeerBeforeBytes(t *testing.T) {
	a, b := pair(t)
	in, w, e := os.Pipe()
	if e != nil {
		t.Fatal(e)
	}
	defer in.Close()
	defer w.Close()
	out := bytes.Buffer{}
	if relay(context.Background(), in, &out, a, uint32(os.Getuid()+1), time.Second, time.Second) == nil {
		t.Fatal("wrong peer")
	}
	b.SetReadDeadline(time.Now().Add(20 * time.Millisecond))
	var one [1]byte
	if n, _ := b.Read(one[:]); n != 0 {
		t.Fatal("bytes sent before auth")
	}
	if out.Len() != 0 {
		t.Fatal("output before auth")
	}
}
func TestRelayEOFFenceAndHalfClose(t *testing.T) {
	for _, control := range []bool{false, true} {
		for _, extra := range []bool{false, true} {
			name := "submit"
			response := "submit-running"
			if control {
				name = "readiness"
				response = "readiness-ready-none"
			}
			t.Run(name+map[bool]string{false: "-valid", true: "-extra"}[extra], func(t *testing.T) {
				a, b := pair(t)
				in, w, e := os.Pipe()
				if e != nil {
					t.Fatal(e)
				}
				defer in.Close()
				defer w.Close()
				var launches atomic.Int32
				worker := make(chan error, 1)
				go func() {
					if e := AuthenticatePeer(b, uint32(os.Getuid())); e != nil {
						worker <- e
						return
					}
					_, e := wire.ReceiveRequest(b, io.Discard)
					if e == nil {
						launches.Add(1)
						e = wire.WriteAll(b, vector(t, response))
					}
					b.CloseWrite()
					worker <- e
				}()
				out := bytes.Buffer{}
				done := make(chan error, 1)
				go func() {
					e := relay(context.Background(), in, &out, a, uint32(os.Getuid()), time.Second, time.Second)
					a.Close()
					done <- e
				}()
				wire.WriteAll(w, vector(t, name))
				time.Sleep(30 * time.Millisecond)
				if launches.Load() != 0 {
					t.Fatal("early launch/control mutation")
				}
				if extra {
					w.Write([]byte{0xff})
				}
				w.Close()
				e = <-done
				we := <-worker
				if extra {
					if e == nil || we == nil || launches.Load() != 0 || out.Len() != 0 {
						t.Fatalf("invalid request reached worker e=%v worker=%v launches=%v", e, we, launches.Load())
					}
				} else {
					if e != nil || we != nil || launches.Load() != 1 {
						t.Fatalf("valid relay e=%v worker=%v", e, we)
					}
					if _, e = wire.ReceiveResponse(bytes.NewReader(out.Bytes())); e != nil {
						t.Fatal(e)
					}
				}
			})
		}
	}
}
func TestRelayResponseInvalidAndTimeout(t *testing.T) {
	for _, mode := range []string{"delayed-extra", "truncated", "no-eof", "cancel", "idle-input", "absolute-input"} {
		t.Run(mode, func(t *testing.T) {
			a, b := pair(t)
			in, w, e := os.Pipe()
			if e != nil {
				t.Fatal(e)
			}
			defer in.Close()
			defer w.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			worker := make(chan struct{})
			go func() {
				defer close(worker)
				defer b.Close()
				if mode == "idle-input" || mode == "absolute-input" {
					io.Copy(io.Discard, b)
					return
				}
				if _, e := wire.ReceiveRequest(b, io.Discard); e != nil {
					return
				}
				if mode == "cancel" {
					cancel()
					return
				}
				raw := vector(t, "readiness-ready-none")
				if mode == "truncated" {
					raw = raw[:len(raw)-1]
				}
				wire.WriteAll(b, raw)
				if mode == "delayed-extra" {
					time.Sleep(20 * time.Millisecond)
					b.Write([]byte{1})
				}
				if mode == "no-eof" {
					time.Sleep(120 * time.Millisecond)
				}
			}()
			var out bytes.Buffer
			done := make(chan error, 1)
			idle := 50 * time.Millisecond
			absolute := time.Second
			if mode == "absolute-input" {
				idle = time.Second
				absolute = 50 * time.Millisecond
			}
			go func() { e := relay(ctx, in, &out, a, uint32(os.Getuid()), idle, absolute); a.Close(); done <- e }()
			if mode != "idle-input" && mode != "absolute-input" {
				wire.WriteAll(w, vector(t, "readiness"))
				w.Close()
			}
			select {
			case e = <-done:
				if e == nil || out.Len() != 0 {
					t.Fatal("invalid response became transfer success")
				}
			case <-time.After(1500 * time.Millisecond):
				t.Fatal("unclean relay shutdown")
			}
			<-worker
		})
	}
}

func TestRelayLargeSubmitRemainsTruncatedUntilValidEOF(t *testing.T) {
	for _, extra := range []bool{false, true} {
		t.Run(map[bool]string{false: "valid", true: "extra"}[extra], func(t *testing.T) {
			original := vector(t, "submit")
			n := int(binary.BigEndian.Uint32(original[:4]))
			var m map[string]any
			json.Unmarshal(original[4:4+n], &m)
			j := m["job"].(map[string]any)
			body := bytes.Repeat([]byte("synthetic"), 20000)
			j["inputBytes"] = len(body)
			j["sha256"] = wire.SHA(body)
			meta, _ := json.Marshal(m)
			var request bytes.Buffer
			wire.WriteMetadata(&request, meta)
			request.Write(body)
			response := vector(t, "submit-running")
			n = int(binary.BigEndian.Uint32(response[:4]))
			var res map[string]any
			json.Unmarshal(response[4:4+n], &res)
			res["job"] = j
			meta, _ = json.Marshal(res)
			var framed bytes.Buffer
			wire.WriteMetadata(&framed, meta)
			framed.Write(make([]byte, 4))
			a, b := pair(t)
			in, w, e := os.Pipe()
			if e != nil {
				t.Fatal(e)
			}
			defer in.Close()
			defer w.Close()
			var launches atomic.Int32
			worker := make(chan error, 1)
			go func() {
				_, e := wire.ReceiveRequest(b, io.Discard)
				if e == nil {
					launches.Add(1)
					e = wire.WriteAll(b, framed.Bytes())
				}
				b.CloseWrite()
				worker <- e
			}()
			var out bytes.Buffer
			done := make(chan error, 1)
			go func() {
				e := relay(context.Background(), in, &out, a, uint32(os.Getuid()), time.Second, time.Second)
				a.Close()
				done <- e
			}()
			wire.WriteAll(w, request.Bytes())
			time.Sleep(20 * time.Millisecond)
			if launches.Load() != 0 {
				t.Fatal("launched before EOF")
			}
			if extra {
				w.Write([]byte{1})
			}
			w.Close()
			e = <-done
			we := <-worker
			if extra {
				if e == nil || we == nil || launches.Load() != 0 {
					t.Fatal("invalid EOF authorized large body")
				}
			} else if e != nil || we != nil || launches.Load() != 1 {
				t.Fatalf("valid large relay %v %v", e, we)
			}
		})
	}
}

func largeOutcomeFrame(t *testing.T) []byte {
	original := vector(t, "outcome-complete")
	n := int(binary.BigEndian.Uint32(original[:4]))
	var m map[string]any
	json.Unmarshal(original[4:4+n], &m)
	blocks := []any{}
	for i := 0; i < 4; i++ {
		blocks = append(blocks, map[string]any{"source": 0, "ordinal": i + 1, "method": "native", "text": strings.Repeat("x", 256*1024)})
	}
	body, _ := json.Marshal(map[string]any{"version": 1, "processorVersion": "conversion-v1.fixture", "status": "complete", "reason": "none", "sources": []any{map[string]any{"kind": "documentBlock", "ordinal": 1}}, "blocks": blocks, "tables": []any{}, "coverage": map[string]any{"totalUnits": 1, "visitedUnits": 1, "omitted": []any{}}, "warnings": []any{}})
	outcome := map[string]any{"kind": "result", "bytes": len(body), "sha256": wire.SHA(body)}
	m["outcome"] = outcome
	hashInput, _ := json.Marshal(map[string]any{"job": m["job"], "origin": m["origin"], "outcome": outcome})
	pre, e := wire.HashInput(hashInput, "outcome")
	if e != nil {
		t.Fatal(e)
	}
	m["outcomeSha256"] = wire.SHA(pre)
	meta, _ := json.Marshal(m)
	var response bytes.Buffer
	wire.WriteMetadata(&response, meta)
	binary.Write(&response, binary.BigEndian, uint32(len(body)))
	response.Write(body)
	return response.Bytes()
}

func TestRelayBlockedStdoutDeadline(t *testing.T) {
	response := largeOutcomeFrame(t)
	a, b := pair(t)
	in, w, e := os.Pipe()
	if e != nil {
		t.Fatal(e)
	}
	defer in.Close()
	defer w.Close()
	outReader, out, e := os.Pipe()
	if e != nil {
		t.Fatal(e)
	}
	defer outReader.Close()
	defer out.Close()
	worker := make(chan error, 1)
	go func() {
		_, e := wire.ReceiveRequest(b, io.Discard)
		if e == nil {
			e = wire.WriteAll(b, response)
		}
		b.CloseWrite()
		worker <- e
	}()
	done := make(chan error, 1)
	go func() {
		e := relay(context.Background(), in, out, a, uint32(os.Getuid()), 40*time.Millisecond, time.Second)
		a.Close()
		done <- e
	}()
	wire.WriteAll(w, vector(t, "job-status"))
	w.Close()
	select {
	case e := <-done:
		if e == nil {
			t.Fatal("blocked stdout accepted")
		}
	case <-time.After(time.Second):
		t.Fatal("blocked stdout did not expire")
	}
	if e := <-worker; e != nil {
		t.Fatal(e)
	}
}

// TestNodeStdioProbe is reachable only in a Go test binary, never either
// production command. Node's production-module suite invokes it over actual
// child-process pipes to verify Go fd polling/deadlines and exact framing.
func TestNodeStdioProbe(t *testing.T) {
	if os.Getenv("NIARO_CONVERSION_STDIO_TEST") == "" {
		t.Skip("Node-only synthetic stdio helper")
	}
	os.Exit(nodeStdioProbe(t))
}

func auditStdioOwnership() error {
	in, out, e := stdio()
	if e != nil {
		return e
	}
	if e = in.Close(); e != nil {
		return e
	}
	if e = out.Close(); e != nil {
		return e
	}
	freshIn, freshOut, e := stdio()
	if e != nil {
		return e
	}
	defer freshIn.Close()
	defer freshOut.Close()
	// Deliberately repeat Close and collect old wrappers after new duplicate fds
	// may reuse their numbers. A stale wrapper must not close the new owner.
	if in.Close() == nil || out.Close() == nil {
		return wire.ErrInvalid
	}
	runtime.GC()
	for _, f := range []*os.File{freshIn, freshOut} {
		if _, e = f.Stat(); e != nil {
			return e
		}
		raw, e := f.SyscallConn()
		if e != nil {
			return e
		}
		var bad bool
		e = raw.Control(func(fd uintptr) {
			flags, _, err := syscall.Syscall(syscall.SYS_FCNTL, fd, syscall.F_GETFD, 0)
			status, _, err2 := syscall.Syscall(syscall.SYS_FCNTL, fd, syscall.F_GETFL, 0)
			bad = err != 0 || err2 != 0 || flags&syscall.FD_CLOEXEC == 0 || status&syscall.O_NONBLOCK == 0
		})
		if e != nil {
			return e
		}
		if bad {
			return wire.ErrInvalid
		}
	}
	for _, fd := range []uintptr{0, 1} {
		_, _, err := syscall.Syscall(syscall.SYS_FCNTL, fd, syscall.F_GETFD, 0)
		if err != 0 {
			return err
		}
	}
	return nil
}

func nodeStdioProbe(t *testing.T) int {
	if e := auditStdioOwnership(); e != nil {
		fmt.Fprintln(os.Stderr, "synthetic stdio ownership:", e)
		return 1
	}
	in, out, e := stdio()
	if e != nil {
		fmt.Fprintln(os.Stderr, "synthetic stdio polling:", e)
		return 1
	}
	defer in.Close()
	defer out.Close()
	mode := os.Getenv("NIARO_CONVERSION_STDIO_TEST")
	directory := os.Getenv("NIARO_CONVERSION_STDIO_TEST_DIR")
	if directory == "" {
		return 1
	}
	addr := &net.UnixAddr{Name: filepath.Join(directory, "synthetic.sock"), Net: "unix"}
	listener, e := net.ListenUnix("unix", addr)
	if e != nil {
		return 1
	}
	defer listener.Close()
	a, e := net.DialUnix("unix", nil, addr)
	if e != nil {
		return 1
	}
	defer a.Close()
	b, e := listener.AcceptUnix()
	if e != nil {
		return 1
	}
	defer b.Close()
	b.SetDeadline(time.Now().Add(2 * time.Second))
	worker := make(chan error, 1)
	go func() {
		e := AuthenticatePeer(b, uint32(os.Getuid()))
		if e == nil {
			_, e = wire.ReceiveRequest(b, io.Discard)
		}
		if e == nil {
			response := vector(t, "readiness-ready-none")
			if mode == "output" {
				response = largeOutcomeFrame(t)
			}
			e = wire.WriteAll(b, response)
		}
		b.CloseWrite()
		worker <- e
	}()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	ctx, stop := context.WithTimeout(ctx, 2*time.Second)
	defer stop()
	idle := time.Second
	if mode == "input" || mode == "output" {
		idle = 60 * time.Millisecond
	}
	fmt.Fprintln(os.Stderr, "synthetic ready")
	e = relay(ctx, in, out, a, uint32(os.Getuid()), idle, 2*time.Second)
	a.Close()
	we := <-worker
	if e != nil {
		fmt.Fprintln(os.Stderr, "synthetic relay:", e)
		return 1
	}
	if we != nil {
		fmt.Fprintln(os.Stderr, "synthetic peer:", we)
		return 1
	}
	return 0
}
