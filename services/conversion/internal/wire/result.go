package wire

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const resultReasons = "none ocr_review coverage_incomplete unsupported protected malformed empty input_limit page_limit pixel_limit office_expansion_limit cell_limit output_limit scratch_limit timeout cancelled resource_unknown interrupted invalid_result unavailable"
const warningCodes = "ocr_requires_review low_confidence mixed_raster layout_unverified embedded_omitted formula_not_evaluated cache_unknown hidden_content coverage_unknown limit_reached"
const omissionReasons = "unsupported_feature embedded_resource layout_unverified formula_not_evaluated cache_unknown limit_reached coverage_unknown"

var decimalRE = regexp.MustCompile(`^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$`)

// Result exposes only validated evidence, not arbitrary parser/library objects.
// Its backing tree is private; exact transport bytes are the retained payload.
type Result struct {
	ProcessorVersion, Status, Reason string
	fields                           object
}

func DecodeResult(b []byte) (Result, error) {
	return checked(func() Result {
		m := obj(parse(b, MaxResult), "version processorVersion status reason sources blocks tables coverage warnings")
		num(m["version"], 1, 1)
		r := Result{match(m["processorVersion"], processorRE), en(m["status"], "complete partial failed"), en(m["reason"], resultReasons), m}
		sources := array(m["sources"], 20_000)
		blocks := array(m["blocks"], 20_000)
		tables := array(m["tables"], 256)
		warnings := array(m["warnings"], 256)
		source := func(v any) int64 { return num(v, 0, int64(len(sources)-1)) }
		sourceIDs := map[string]bool{}
		for i, v := range sources {
			s := obj(v, "kind ordinal", "parent", "name", "visibility", "region")
			k := en(s["kind"], "page sheet slide slideShape documentBlock table row image")
			max := int64(20_000)
			if k == "page" || k == "slide" {
				max = 100
			}
			n := num(s["ordinal"], 1, max)
			parent := int64(-1)
			optional(s, "parent", func(v any) { parent = num(v, 0, int64(i-1)) })
			optional(s, "name", func(v any) { text(v, 256) })
			optional(s, "visibility", func(v any) { require(k == "sheet"); en(v, "visible hidden veryHidden") })
			id := k + ":" + u(parent) + ":" + u(n)
			require(!sourceIDs[id])
			sourceIDs[id] = true
			optional(s, "region", func(v any) {
				a := array(v, 4)
				require(len(a) == 4)
				ns := [4]int64{}
				for j, x := range a {
					ns[j] = num(x, 0, 1_000_000)
				}
				require(ns[0] <= ns[2] && ns[1] <= ns[3])
				pk := k
				if parent >= 0 {
					pk = text(sources[parent].(object)["kind"], 128)
				}
				require(pk == "page" || pk == "slide" || pk == "image")
			})
		}
		blockIDs := map[string]bool{}
		tableIDs := map[string]bool{}
		totalText := 0
		hasOCR := false
		hasFormula := false
		for _, v := range blocks {
			b := obj(v, "source ordinal method text")
			s := source(b["source"])
			n := num(b["ordinal"], 1, MaxCounter)
			id := u(s) + ":" + u(n)
			require(!blockIDs[id])
			blockIDs[id] = true
			method := en(b["method"], "native ocr")
			hasOCR = hasOCR || method == "ocr"
			totalText += len(text(b["text"], 256*1024))
			require(totalText <= 1024*1024)
		}
		totalCells := 0
		for _, v := range tables {
			t := obj(v, "source ordinal rows columns cells")
			s := source(t["source"])
			n := num(t["ordinal"], 1, MaxCounter)
			id := u(s) + ":" + u(n)
			require(!tableIDs[id])
			tableIDs[id] = true
			rows := num(t["rows"], 0, 20_000)
			columns := num(t["columns"], 0, 256)
			cells := array(t["cells"], 20_000)
			totalCells += len(cells)
			require(totalCells <= 20_000)
			type rect struct{ row, col, h, w int64 }
			rects := make([]rect, 0, len(cells))
			for _, v := range cells {
				c := obj(v, "row column rowSpan columnSpan type value display", "numberFormat")
				row := num(c["row"], 0, rows-1)
				col := num(c["column"], 0, columns-1)
				h := num(c["rowSpan"], 1, rows-row)
				w := num(c["columnSpan"], 1, columns-col)
				rects = append(rects, rect{row, col, h, w})
				k := en(c["type"], "text number boolean date formula empty")
				text(c["display"], 4096)
				optional(c, "numberFormat", func(v any) { text(v, 128) })
				if k == "empty" {
					require(c["value"] == nil)
				} else {
					value := text(c["value"], 4096)
					switch k {
					case "number":
						require(decimalRE.MatchString(value))
					case "boolean":
						require(value == "true" || value == "false")
					case "date":
						require(isoDate(value))
					case "formula":
						require(strings.HasPrefix(value, "="))
						hasFormula = true
					}
				}
			}
			// Sorted rectangles plus 256 column end rows avoids allocating a dense
			// rows*columns grid or quadratic overlap comparisons.
			sort.Slice(rects, func(i, j int) bool { return rects[i].row < rects[j].row })
			ends := [256]int64{}
			for _, c := range rects {
				for col := c.col; col < c.col+c.w; col++ {
					require(ends[col] <= c.row)
					ends[col] = c.row + c.h
				}
			}
		}
		c := obj(m["coverage"], "totalUnits visitedUnits omitted")
		total := num(c["totalUnits"], 0, 20_000)
		visited := num(c["visitedUnits"], 0, total)
		omitted := array(c["omitted"], 256)
		for _, v := range omitted {
			o := obj(v, "kind reason", "source", "ordinal")
			en(o["kind"], "page sheet slide block image table unknown")
			en(o["reason"], omissionReasons)
			optional(o, "source", func(v any) { source(v) })
			optional(o, "ordinal", func(v any) { num(v, 1, 20_000) })
		}
		codes := map[string]bool{}
		for _, v := range warnings {
			w := obj(v, "code", "source")
			codes[en(w["code"], warningCodes)] = true
			optional(w, "source", func(v any) { source(v) })
		}
		if r.Status == "failed" {
			require(r.Reason != "none" && r.Reason != "ocr_review" && r.Reason != "coverage_incomplete" && len(sources) == 0 && len(blocks) == 0 && len(tables) == 0 && visited == 0)
		} else {
			require(len(sources) > 0 && len(blocks)+totalCells > 0 && visited > 0)
			if r.Status == "complete" {
				require(r.Reason == "none" && visited == total && len(omitted) == 0 && !hasOCR && !hasFormula)
				for code := range codes {
					require(code == "hidden_content")
				}
			} else {
				require(r.Reason != "none" && len(omitted) > 0)
			}
		}
		if hasOCR {
			require(r.Status == "partial" && codes["ocr_requires_review"])
		}
		if hasFormula {
			require(r.Status == "partial" && codes["formula_not_evaluated"])
		}
		return r
	})
}

func isoDate(s string) bool {
	date := dateRE.FindStringSubmatch(s)
	clock := s
	if date != nil {
		year, _ := strconv.Atoi(date[1])
		month, _ := strconv.Atoi(date[2])
		day, _ := strconv.Atoi(date[3])
		d := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
		if d.Year() != year || int(d.Month()) != month || d.Day() != day {
			return false
		}
		if date[4] == "" {
			return true
		}
		clock = date[4]
	}
	t := clockRE.FindStringSubmatch(clock)
	if t == nil {
		return false
	}
	for i, max := range []int{23, 59, 59} {
		n, _ := strconv.Atoi(t[i+1])
		if n > max {
			return false
		}
	}
	if date != nil && t[4] == "" {
		return false
	}
	if t[4] != "" && t[4] != "Z" {
		h, _ := strconv.Atoi(t[4][1:3])
		m, _ := strconv.Atoi(t[4][4:])
		if h > 23 || m > 59 {
			return false
		}
	}
	return true
}

var dateRE = regexp.MustCompile(`^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:T(.+))?$`)
var clockRE = regexp.MustCompile(`^([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})?$`)
