package wire

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func fixture(t *testing.T, name string, v any) {
	t.Helper()
	b, e := os.ReadFile("../../../../tests/fixtures/conversion-v1/" + name)
	if e != nil {
		t.Fatal(e)
	}
	if e = json.Unmarshal(b, v); e != nil {
		t.Fatal(e)
	}
}

type wireVector struct {
	Name, Direction, WireHex string
	Valid                    bool
}

func wireVectors(t *testing.T) []wireVector {
	var x struct{ Vectors []wireVector }
	fixture(t, "wire-fixtures.v2.json", &x)
	return x.Vectors
}
func vectorBytes(t *testing.T, name string) []byte {
	t.Helper()
	for _, v := range wireVectors(t) {
		if v.Name == name {
			b, e := hex.DecodeString(v.WireHex)
			if e != nil {
				t.Fatal(e)
			}
			return b
		}
	}
	t.Fatal("missing vector")
	return nil
}
func TestSharedWireVectors(t *testing.T) {
	for _, v := range wireVectors(t) {
		t.Run(v.Name, func(t *testing.T) {
			b, e := hex.DecodeString(v.WireHex)
			if e != nil {
				t.Fatal(e)
			}
			if v.Direction == "request" {
				_, e = ReceiveRequest(bytes.NewReader(b), ioDiscard{})
			} else {
				_, e = ReceiveResponse(bytes.NewReader(b))
			}
			if (e == nil) != v.Valid {
				t.Fatalf("valid=%v error=%v", v.Valid, e)
			}
		})
	}
}

type ioDiscard struct{}

func (ioDiscard) Write(b []byte) (int, error) { return len(b), nil }
func TestSharedHashes(t *testing.T) {
	var x struct {
		Vectors []struct {
			Name, Hash, InputHex, CanonicalHex, SHA256 string
			Valid                                      bool
		}
	}
	fixture(t, "hash-vectors.v2.json", &x)
	if len(x.Vectors) != 100 {
		t.Fatal("vector drift")
	}
	for _, v := range x.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			input, e := hex.DecodeString(v.InputHex)
			if e != nil {
				t.Fatal(e)
			}
			pre, e := HashInput(input, v.Hash)
			if (e == nil) != v.Valid {
				t.Fatalf("valid=%v error=%v", v.Valid, e)
			}
			if e == nil && (hex.EncodeToString(pre) != v.CanonicalHex || SHA(pre) != v.SHA256 || bytes.HasSuffix(pre, []byte("\n"))) {
				t.Fatal("preimage/hash mismatch")
			}
		})
	}
}
func TestSharedResults(t *testing.T) {
	var x struct {
		Cases []struct {
			Name  string
			Valid bool
			Value json.RawMessage
		}
	}
	fixture(t, "result-cases.json", &x)
	for _, v := range x.Cases {
		t.Run(v.Name, func(t *testing.T) {
			_, e := DecodeResult(v.Value)
			if (e == nil) != v.Valid {
				t.Fatalf("valid=%v error=%v", v.Valid, e)
			}
		})
	}
}
func TestJSONBounds(t *testing.T) {
	valid := `{"version":1,"op":"status","query":"readiness"}`
	cases := []string{
		strings.Replace(valid, `"version":1`, `"version":9007199254740991.1`, 1), strings.Replace(valid, `"version":1`, `"version":1e999999999999999999`, 1), strings.Replace(valid, `"version":1`, `"version":-1`, 1), strings.Replace(valid, `"op":"status"`, `"op":"sta\ud800tus"`, 1), strings.Replace(valid, `"op":"status"`, `"op":"sta\udc00tus"`, 1), strings.Replace(valid, `"op":"status"`, `"op":"status","\u006fp":"status"`, 1), valid + "{}", string([]byte{0xef, 0xbb, 0xbf}) + valid, "[" + strings.Repeat("[", 10) + "0" + strings.Repeat("]", 11), "[" + strings.Repeat("0,", 20000) + "0]", `{"x":"` + strings.Repeat("x", 256*1024+1) + `"}`,
	}
	for _, s := range cases {
		if _, e := checked(func() any { return parse([]byte(s), MaxResult) }); e == nil {
			t.Fatalf("accepted %.80s", s)
		}
	}
	for _, s := range []string{strings.Replace(valid, `"version":1`, `"version":1.0`, 1), strings.Replace(valid, `"version":1`, `"version":1e0`, 1)} {
		if _, e := DecodeRequest([]byte(s)); e != nil {
			t.Fatal(e)
		}
	}
}
func TestQualificationAndAckProof(t *testing.T) {
	ref := `{"epoch":"11111111111111111111111111111111","counter":1}`
	record := `{"version":1,"key":"` + strings.Repeat("a", 64) + `","phase":"passed","tries":1,"probe":` + ref + `,"testDigest":"` + strings.Repeat("b", 64) + `","firstServing":null}`
	if _, e := DecodeQualification([]byte(record)); e != nil {
		t.Fatal(e)
	}
	if _, e := DecodeQualification([]byte(strings.Replace(record, `"firstServing":null`, `"firstServing":`+ref, 1))); e == nil {
		t.Fatal("same-boot qualification accepted")
	}
	raw := vectorBytes(t, "ack-cleared")
	reply, e := ReceiveResponse(bytes.NewReader(raw))
	if e != nil {
		t.Fatal(e)
	}
	req, e := ReceiveRequest(bytes.NewReader(vectorBytes(t, "ack")), ioDiscard{})
	if e != nil {
		t.Fatal(e)
	}
	origin := BootRef{Epoch: strings.Repeat("1", 32), Counter: 1}
	if e = ValidateReply(req, reply.Response, reply.Response.Boot.Identity, &origin); e != nil {
		t.Fatal(e)
	}
	same := reply.Response.Boot.BootRef
	if ValidateReply(req, reply.Response, reply.Response.Boot.Identity, &same) == nil || ValidateReply(req, reply.Response, reply.Response.Boot.Identity, nil) == nil {
		t.Fatal("ACK without recycle proof")
	}
	tied := BootRef{Epoch: origin.Epoch, Counter: reply.Response.Boot.Counter}
	if ValidateReply(req, reply.Response, reply.Response.Boot.Identity, &tied) == nil {
		t.Fatal("ACK without counter advancement")
	}
	bad := BootRef{Epoch: "invalid", Counter: 0}
	if ValidateReply(req, reply.Response, reply.Response.Boot.Identity, &bad) == nil {
		t.Fatal("invalid ACK origin")
	}
}

func TestResultByteAndCountLimits(t *testing.T) {
	reply, e := ReceiveResponse(bytes.NewReader(vectorBytes(t, "outcome-complete")))
	if e != nil {
		t.Fatal(e)
	}
	base := func() map[string]any {
		var m map[string]any
		if e := json.Unmarshal(reply.Body, &m); e != nil {
			t.Fatal(e)
		}
		return m
	}
	run := func(name string, valid bool, mutate func(map[string]any)) {
		t.Run(name, func(t *testing.T) {
			m := base()
			mutate(m)
			b, e := json.Marshal(m)
			if e != nil {
				t.Fatal(e)
			}
			_, e = DecodeResult(b)
			if (e == nil) != valid {
				t.Fatalf("valid=%v bytes=%d error=%v", valid, len(b), e)
			}
		})
	}
	run("text-at-limit", true, func(m map[string]any) {
		m["blocks"] = []any{map[string]any{"source": 0, "ordinal": 1, "method": "native", "text": strings.Repeat("x", 256*1024)}}
	})
	run("text-over-limit", false, func(m map[string]any) {
		m["blocks"].([]any)[0].(map[string]any)["text"] = strings.Repeat("x", 256*1024+1)
	})
	for _, over := range []bool{false, true} {
		run(map[bool]string{false: "aggregate-at-limit", true: "aggregate-over-limit"}[over], !over, func(m map[string]any) {
			blocks := []any{}
			for i := 0; i < 4; i++ {
				blocks = append(blocks, map[string]any{"source": 0, "ordinal": i + 1, "method": "native", "text": strings.Repeat("x", 256*1024)})
			}
			if over {
				blocks = append(blocks, map[string]any{"source": 0, "ordinal": 5, "method": "native", "text": "x"})
			}
			m["blocks"] = blocks
		})
	}
	run("name-utf8-at-limit", true, func(m map[string]any) { m["sources"].([]any)[0].(map[string]any)["name"] = strings.Repeat("é", 128) })
	run("name-utf8-over-limit", false, func(m map[string]any) { m["sources"].([]any)[0].(map[string]any)["name"] = strings.Repeat("é", 129) })
	for _, field := range []string{"warnings", "tables"} {
		run(field+"-count", false, func(m map[string]any) {
			a := []any{}
			for i := 0; i < 257; i++ {
				a = append(a, map[string]any{})
			}
			m[field] = a
		})
	}
	run("sources-count", false, func(m map[string]any) {
		a := []any{}
		for i := 0; i < 20001; i++ {
			a = append(a, map[string]any{"kind": "documentBlock", "ordinal": i + 1})
		}
		m["sources"] = a
	})
	for _, s := range []string{"x\n", "x\r", "x\u2028"} {
		run("processor-terminator", false, func(m map[string]any) { m["processorVersion"] = s })
	}
}

func TestIntegerSpellingsWithoutRounding(t *testing.T) {
	for _, s := range []string{"1." + strings.Repeat("0", 100), "10e-1", "0e99999999999999999999999999999", "-0"} {
		b := []byte(`{"x":` + s + `}`)
		if _, e := checked(func() any { return parse(b, MaxMetadata) }); e != nil {
			t.Fatalf("legal integer %s: %v", s, e)
		}
	}
	for _, s := range []string{"9007199254740991.0000000001", "1e99999999999999999", "1e-9999999999999999"} {
		if _, e := checked(func() any { return parse([]byte(`{"x":`+s+`}`), MaxMetadata) }); e == nil {
			t.Fatal("unsafe integer", s)
		}
	}
}
