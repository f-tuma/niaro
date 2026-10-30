package wire

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"io"
	"time"
)

const BufferSize = 64 * 1024
const IdleTimeout = 15 * time.Second
const TransferTimeout = 120 * time.Second

// DeadlineReader applies an idle limit refreshed only by actual reads and a
// fixed absolute deadline. Use it from accept, including metadata/body/EOF.
type DeadlineReader struct {
	Reader      io.Reader
	SetDeadline func(time.Time) error
	Absolute    time.Time
	Idle        time.Duration
}

type DeadlineWriter struct {
	Writer      io.Writer
	SetDeadline func(time.Time) error
	Absolute    time.Time
	Idle        time.Duration
}

func (w *DeadlineWriter) Write(p []byte) (int, error) {
	if len(p) > BufferSize {
		p = p[:BufferSize]
	}
	deadline := time.Now().Add(w.Idle)
	if w.Absolute.Before(deadline) {
		deadline = w.Absolute
	}
	if e := w.SetDeadline(deadline); e != nil {
		return 0, e
	}
	return w.Writer.Write(p)
}

func (r *DeadlineReader) Read(p []byte) (int, error) {
	if len(p) > BufferSize {
		p = p[:BufferSize]
	}
	deadline := time.Now().Add(r.Idle)
	if r.Absolute.Before(deadline) {
		deadline = r.Absolute
	}
	if e := r.SetDeadline(deadline); e != nil {
		return 0, e
	}
	return r.Reader.Read(p)
}
func readSize(r io.Reader, max uint32, min uint32) (int, error) {
	var b [4]byte
	if _, e := io.ReadFull(r, b[:]); e != nil {
		return 0, e
	}
	n := binary.BigEndian.Uint32(b[:])
	if n < min || n > max {
		return 0, ErrInvalid
	}
	return int(n), nil
}
func metadata(r io.Reader) ([]byte, error) {
	n, e := readSize(r, MaxMetadata, 2)
	if e != nil {
		return nil, e
	}
	b := make([]byte, n)
	_, e = io.ReadFull(r, b)
	return b, e
}
func exactEOF(r io.Reader) error {
	var extra [1]byte
	n, e := io.ReadFull(r, extra[:])
	if n == 0 && e == io.EOF {
		return nil
	}
	if e != nil && e != io.EOF {
		return e
	}
	return ErrInvalid
}

// ReceiveRequest invokes no control handler or launcher. A caller may only
// act on its returned Request after a nil error. Sink must be an isolated,
// bounded temporary spool or discard; partial writes grant no authority.
func ReceiveRequest(r io.Reader, sink io.Writer) (Request, error) {
	b, e := metadata(r)
	if e != nil {
		return Request{}, e
	}
	req, e := DecodeRequest(b)
	if e != nil {
		return Request{}, e
	}
	return ReceiveRequestBody(r, sink, req)
}
func ReceiveRequestBody(r io.Reader, sink io.Writer, req Request) (Request, error) {
	if req.Op != "submit" {
		if e := exactEOF(r); e != nil {
			return Request{}, e
		}
		return req, nil
	}
	h := sha256.New()
	buf := make([]byte, BufferSize)
	n, e := io.CopyBuffer(io.MultiWriter(sink, h), io.LimitReader(r, req.Job.InputBytes), buf)
	if e != nil {
		return Request{}, e
	}
	if n != req.Job.InputBytes {
		return Request{}, io.ErrUnexpectedEOF
	}
	if e = exactEOF(r); e != nil {
		return Request{}, e
	}
	if hex.EncodeToString(h.Sum(nil)) != req.Job.SHA256 {
		return Request{}, ErrInvalid
	}
	return req, nil
}

// ReadRequestMetadata is for the authenticated bridge. It grants no launch or
// control authority; ReceiveRequestBody still must prove exact EOF/hash.
func ReadRequestMetadata(r io.Reader) ([]byte, Request, error) {
	b, e := metadata(r)
	if e != nil {
		return nil, Request{}, e
	}
	req, e := DecodeRequest(b)
	return b, req, e
}

type Reply struct {
	Metadata []byte
	Response Response
	Body     []byte
	Result   *Result
}

func ReceiveResponse(r io.Reader) (Reply, error) {
	b, e := metadata(r)
	if e != nil {
		return Reply{}, e
	}
	res, e := DecodeResponse(b)
	if e != nil {
		return Reply{}, e
	}
	n, e := readSize(r, MaxResult, 0)
	if e != nil {
		return Reply{}, e
	}
	expected := 0
	if res.Outcome != nil && res.Outcome.Kind == "result" {
		expected = int(res.Outcome.Bytes)
	}
	if n != expected {
		return Reply{}, ErrInvalid
	}
	body := make([]byte, n)
	if _, e = io.ReadFull(r, body); e != nil {
		return Reply{}, e
	}
	if e = exactEOF(r); e != nil {
		return Reply{}, e
	}
	reply := Reply{Metadata: b, Response: res, Body: body}
	if n > 0 {
		if SHA(body) != res.Outcome.SHA256 {
			return Reply{}, ErrInvalid
		}
		result, e := DecodeResult(body)
		if e != nil || result.ProcessorVersion != res.Job.ProcessorVersion {
			return Reply{}, ErrInvalid
		}
		reply.Result = &result
	}
	return reply, nil
}
func WriteAll(w io.Writer, b []byte) error {
	for len(b) > 0 {
		size := len(b)
		if size > BufferSize {
			size = BufferSize
		}
		n, e := w.Write(b[:size])
		if e != nil {
			return e
		}
		if n <= 0 {
			return io.ErrShortWrite
		}
		b = b[n:]
	}
	return nil
}
func WriteMetadata(w io.Writer, b []byte) error {
	if len(b) < 2 || len(b) > MaxMetadata {
		return ErrInvalid
	}
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], uint32(len(b)))
	if e := WriteAll(w, n[:]); e != nil {
		return e
	}
	return WriteAll(w, b)
}
func WriteReply(w io.Writer, r Reply) error {
	if e := WriteMetadata(w, r.Metadata); e != nil {
		return e
	}
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], uint32(len(r.Body)))
	if e := WriteAll(w, n[:]); e != nil {
		return e
	}
	return WriteAll(w, r.Body)
}
