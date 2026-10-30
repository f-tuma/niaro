// Package wire implements the closed conversion/1 boundary. It never launches work.
package wire

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"
)

const MaxMetadata = 4096
const MaxResult = 2_097_152
const MaxInput = 26_214_400
const MaxCounter = 9_007_199_254_740_991

var ErrInvalid = errors.New("invalid conversion wire")

type object map[string]any
type invalid struct{}

func require(ok bool) {
	if !ok {
		panic(invalid{})
	}
}
func checked[T any](f func() T) (value T, err error) {
	defer func() {
		if e := recover(); e != nil {
			if _, ok := e.(invalid); ok {
				err = ErrInvalid
			} else {
				panic(e)
			}
		}
	}()
	value = f()
	return
}

// The parser bounds bytes before decoding and bounds every container before
// appending. It rejects duplicate decoded keys and lone UTF-16 surrogates (the
// standard JSON decoder otherwise silently replaces the latter).
type parser struct {
	b        []byte
	i, nodes int
}

func parse(b []byte, max int) any {
	require(len(b) >= 2 && len(b) <= max && utf8.Valid(b))
	p := parser{b: b}
	v := p.value(0)
	p.space()
	require(p.i == len(b))
	return v
}
func (p *parser) space() {
	for p.i < len(p.b) {
		switch p.b[p.i] {
		case ' ', '\t', '\r', '\n':
			p.i++
		default:
			return
		}
	}
}
func (p *parser) take(c byte) bool {
	p.space()
	if p.i < len(p.b) && p.b[p.i] == c {
		p.i++
		return true
	}
	return false
}
func (p *parser) str(limit int) string {
	p.space()
	require(p.i < len(p.b) && p.b[p.i] == '"')
	start := p.i
	p.i++
	size := 0
	for p.i < len(p.b) {
		c := p.b[p.i]
		p.i++
		if c == '"' {
			var s string
			require(json.Unmarshal(p.b[start:p.i], &s) == nil)
			return s
		}
		require(c >= 0x20)
		if c == '\\' {
			require(p.i < len(p.b))
			e := p.b[p.i]
			p.i++
			if e == 'u' {
				r := p.hex4()
				require(r < 0xdc00 || r > 0xdfff)
				if r >= 0xd800 && r <= 0xdbff {
					require(p.i+2 <= len(p.b) && string(p.b[p.i:p.i+2]) == "\\u")
					p.i += 2
					lo := p.hex4()
					require(lo >= 0xdc00 && lo <= 0xdfff)
					size += 4
				} else {
					size += utf8.RuneLen(rune(r))
				}
			} else {
				require(e == '"' || e == '\\' || e == '/' || e == 'b' || e == 'f' || e == 'n' || e == 'r' || e == 't')
				size++
			}
		} else {
			size++
		}
		require(size <= limit)
	}
	panic(invalid{})
}
func (p *parser) hex4() uint64 {
	require(p.i+4 <= len(p.b))
	n, e := strconv.ParseUint(string(p.b[p.i:p.i+4]), 16, 16)
	require(e == nil)
	p.i += 4
	return n
}
func (p *parser) value(depth int, field ...string) any {
	p.space()
	require(p.i < len(p.b))
	p.nodes++
	require(p.nodes <= 220_000)
	c := p.b[p.i]
	if c == '{' || c == '[' {
		require(depth < 10)
	}
	if p.take('{') {
		m := object{}
		if p.take('}') {
			return m
		}
		for {
			require(len(m) < 16)
			k := p.str(64)
			_, exists := m[k]
			require(!exists)
			require(p.take(':'))
			m[k] = p.value(depth+1, k)
			if p.take('}') {
				return m
			}
			require(p.take(','))
		}
	}
	if p.take('[') {
		limit := 20_000
		if len(field) > 0 {
			switch field[0] {
			case "tables", "warnings", "omitted":
				limit = 256
			case "region":
				limit = 4
			}
		}
		a := []any{}
		if p.take(']') {
			return a
		}
		for {
			require(len(a) < limit)
			a = append(a, p.value(depth+1))
			if p.take(']') {
				return a
			}
			require(p.take(','))
		}
	}
	if c == '"' {
		limit := 256 * 1024
		if len(field) > 0 {
			limit = 128
			switch field[0] {
			case "text":
				limit = 256 * 1024
			case "value", "display":
				limit = 4096
			case "name":
				limit = 256
			}
		}
		return p.str(limit)
	}
	for _, lit := range []string{"null", "true", "false"} {
		if len(p.b)-p.i >= len(lit) && string(p.b[p.i:p.i+len(lit)]) == lit {
			p.i += len(lit)
			if lit == "null" {
				return nil
			}
			return lit == "true"
		}
	}
	start := p.i
	for p.i < len(p.b) {
		c = p.b[p.i]
		if (c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E' {
			p.i++
		} else {
			break
		}
	}
	require(p.i > start)
	raw := p.b[start:p.i]
	require(json.Valid(raw))
	return exactNumber(string(raw))
}

// Normalize only enough decimal digits to prove an exact safe integer. Huge
// exponents never cause huge integer allocations, and 1.000... / 0e999... are
// still legal integer spellings within the enclosing byte bound.
func exactNumber(raw string) int64 {
	mantissa := raw
	exponent := int64(0)
	if pos := strings.IndexAny(raw, "eE"); pos >= 0 {
		mantissa = raw[:pos]
		e := raw[pos+1:]
		n, err := strconv.ParseInt(e, 10, 64)
		limit := int64(len(raw) + 32)
		if err != nil || n > limit || n < -limit {
			n = limit
			if strings.HasPrefix(e, "-") {
				n = -limit
			}
		}
		exponent = n
	}
	negative := strings.HasPrefix(mantissa, "-")
	mantissa = strings.TrimPrefix(mantissa, "-")
	fraction := 0
	if dot := strings.IndexByte(mantissa, '.'); dot >= 0 {
		fraction = len(mantissa) - dot - 1
		mantissa = mantissa[:dot] + mantissa[dot+1:]
	}
	digits := strings.TrimLeft(mantissa, "0")
	if digits == "" {
		return 0
	}
	require(!negative)
	core := strings.TrimRight(digits, "0")
	shift := exponent - int64(fraction) + int64(len(digits)-len(core))
	require(shift >= 0 && int64(len(core))+shift <= 16)
	n, err := strconv.ParseInt(core+strings.Repeat("0", int(shift)), 10, 64)
	require(err == nil && n <= MaxCounter)
	return n
}

func obj(v any, required string, optional ...string) object {
	m, ok := v.(object)
	require(ok)
	keys := split(required)
	require(len(m) >= len(keys) && len(m) <= len(keys)+len(optional))
	for _, k := range keys {
		_, ok = m[k]
		require(ok)
	}
	for k := range m {
		require(contains(keys, k) || contains(optional, k))
	}
	return m
}
func split(s string) []string {
	if s == "" {
		return nil
	}
	var out []string
	start := 0
	for i := 0; i <= len(s); i++ {
		if i == len(s) || s[i] == ' ' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	return out
}
func contains(a []string, s string) bool {
	for _, v := range a {
		if s == v {
			return true
		}
	}
	return false
}
func text(v any, max int) string { s, ok := v.(string); require(ok && len(s) <= max); return s }
func en(v any, values string) string {
	s := text(v, 128)
	require(contains(split(values), s))
	return s
}
func num(v any, min, max int64) int64 {
	n, ok := v.(int64)
	require(ok && n >= min && n <= max)
	return n
}
func array(v any, max int) []any { a, ok := v.([]any); require(ok && len(a) <= max); return a }
func optional(m object, k string, f func(any)) {
	if v, ok := m[k]; ok {
		f(v)
	}
}
