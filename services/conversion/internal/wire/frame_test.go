package wire

import (
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"sync/atomic"
	"testing"
	"time"
)

func TestFrameCutsAndBounds(t *testing.T) {
	for _, name := range []string{"submit", "readiness", "outcome-complete"} {
		frame := vectorBytes(t, name)
		for cut := 0; cut < len(frame); cut++ {
			var e error
			if name == "outcome-complete" {
				_, e = ReceiveResponse(bytes.NewReader(frame[:cut]))
			} else {
				_, e = ReceiveRequest(bytes.NewReader(frame[:cut]), io.Discard)
			}
			if e == nil {
				t.Fatalf("%s accepted cut %d", name, cut)
			}
		}
		for _, extra := range [][]byte{{0}, frame} {
			b := append(bytes.Clone(frame), extra...)
			var e error
			if name == "outcome-complete" {
				_, e = ReceiveResponse(bytes.NewReader(b))
			} else {
				_, e = ReceiveRequest(bytes.NewReader(b), io.Discard)
			}
			if e == nil {
				t.Fatal("accepted trailing bytes")
			}
		}
	}
	for _, n := range []uint32{0, 1, 4097, 0xffffffff} {
		var b [4]byte
		binary.BigEndian.PutUint32(b[:], n)
		if _, e := ReceiveRequest(bytes.NewReader(b[:]), io.Discard); e == nil {
			t.Fatal("metadata bound")
		}
	}
	b := bytes.Clone(vectorBytes(t, "outcome-complete"))
	n := int(binary.BigEndian.Uint32(b[:4]))
	binary.BigEndian.PutUint32(b[4+n:8+n], MaxResult+1)
	if _, e := ReceiveResponse(bytes.NewReader(b)); e == nil {
		t.Fatal("result preallocation bound")
	}
}
func TestEOFLaunchFence(t *testing.T) {
	for _, control := range []bool{false, true} {
		for _, extra := range []bool{false, true} {
			t.Run(map[bool]string{false: "submit", true: "control"}[control]+map[bool]string{false: "-EOF", true: "-delayed-extra"}[extra], func(t *testing.T) {
				r, w := io.Pipe()
				defer r.Close()
				defer w.Close()
				var launches atomic.Int32
				done := make(chan error, 1)
				go func() {
					_, e := ReceiveRequest(r, io.Discard)
					if e == nil {
						launches.Add(1)
					}
					done <- e
				}()
				name := "submit"
				if control {
					name = "readiness"
				}
				if _, e := w.Write(vectorBytes(t, name)); e != nil {
					t.Fatal(e)
				}
				time.Sleep(30 * time.Millisecond)
				if launches.Load() != 0 {
					t.Fatal("mutation/launch before EOF")
				}
				select {
				case <-done:
					t.Fatal("completed before EOF")
				default:
				}
				if extra {
					w.Write([]byte{0xff})
				}
				w.Close()
				e := <-done
				if (e == nil) == extra {
					t.Fatalf("extra=%v error=%v", extra, e)
				}
				expected := int32(1)
				if extra {
					expected = 0
				}
				if launches.Load() != expected {
					t.Fatal("bad launch count")
				}
			})
		}
	}
}

func TestIdleAndAbsoluteDeadline(t *testing.T) {
	for _, absolute := range []bool{false, true} {
		a, b := net.Pipe()
		done := make(chan error, 1)
		start := time.Now()
		idle := 30 * time.Millisecond
		deadline := start.Add(300 * time.Millisecond)
		if absolute {
			idle = time.Second
			deadline = start.Add(50 * time.Millisecond)
		}
		go func() {
			_, e := ReceiveRequest(&DeadlineReader{Reader: a, SetDeadline: a.SetReadDeadline, Absolute: deadline, Idle: idle}, io.Discard)
			done <- e
		}()
		if _, e := b.Write(vectorBytes(t, "submit")); e != nil {
			t.Fatal(e)
		}
		select {
		case e := <-done:
			if e == nil {
				t.Fatal("timeout accepted")
			}
		case <-time.After(time.Second):
			t.Fatal("unbounded EOF wait")
		}
		a.Close()
		b.Close()
		if time.Since(start) > 500*time.Millisecond {
			t.Fatal("deadline exceeded")
		}
	}
}
func TestResponseEOFIsRequired(t *testing.T) {
	r, w := io.Pipe()
	defer r.Close()
	defer w.Close()
	done := make(chan error, 1)
	go func() { _, e := ReceiveResponse(r); done <- e }()
	w.Write(vectorBytes(t, "outcome-complete"))
	select {
	case <-done:
		t.Fatal("response observed before EOF")
	case <-time.After(30 * time.Millisecond):
	}
	w.Write([]byte{1})
	w.Close()
	if <-done == nil {
		t.Fatal("delayed response extra accepted")
	}
}

// This deliberately broken receiver is a negative control: the same spy
// assertion detects the missing EOF fence rather than merely testing a mock.
func TestNegativeControlMissingEOF(t *testing.T) {
	r, w := io.Pipe()
	defer r.Close()
	defer w.Close()
	launched := make(chan struct{})
	go func() {
		_, req, e := ReadRequestMetadata(r)
		if e != nil {
			return
		}
		io.CopyN(io.Discard, r, req.Job.InputBytes)
		close(launched)
	}()
	w.Write(vectorBytes(t, "submit"))
	select {
	case <-launched:
	case <-time.After(time.Second):
		t.Fatal("negative control did not expose early launch")
	}
}
