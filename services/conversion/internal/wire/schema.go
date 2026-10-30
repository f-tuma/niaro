package wire

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strconv"
	"strings"
)

var uuidRE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var shaRE = regexp.MustCompile(`^[0-9a-f]{64}$`)
var epochRE = regexp.MustCompile(`^[0-9a-f]{32}$`)
var processorRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+\-]{0,127}$`)

const formats = "pdf docx xlsx pptx csv tsv txt md png jpg"
const failures = "input_limit malformed timeout cancelled resource_unknown interrupted invalid_result output_limit scratch_limit unavailable"
const identityKeys = "protocol processorVersion imageBuildSha gatePolicySha enginePolicySha assetsSha probeSuiteSha platformSha deploymentSha"
const jobKeys = "jobId attempt generation attemptVersion contentId sha256 inputBytes format processorVersion limitsProfile"

type Identity struct {
	ProcessorVersion string
	Hashes           [7]string
}
type BootRef struct {
	Epoch   string
	Counter int64
}
type Boot struct {
	BootRef
	Identity Identity
}
type Job struct {
	JobID                                   string
	Attempt                                 int64
	Generation                              string
	AttemptVersion                          int64
	ContentID, SHA256                       string
	InputBytes                              int64
	Format, ProcessorVersion, LimitsProfile string
}
type Outcome struct {
	Kind           string
	Bytes          int64
	SHA256, Reason string
}
type Request struct {
	Op, Query     string
	Job           *Job
	OutcomeSHA256 string
}

// Response retains its closed, validated JSON variant privately. No arbitrary
// extension map or native DTO is accepted by this API.
type Response struct {
	Op, Kind      string
	Boot          Boot
	Job           *Job
	Origin        *BootRef
	Outcome       *Outcome
	OutcomeSHA256 string
	fields        object
}

func match(v any, re *regexp.Regexp) string { s := text(v, 128); require(re.MatchString(s)); return s }
func identity(v any) Identity {
	m := obj(v, identityKeys)
	num(m["protocol"], 1, 1)
	id := Identity{ProcessorVersion: match(m["processorVersion"], processorRE)}
	for i, k := range split(identityKeys)[2:] {
		id.Hashes[i] = match(m[k], shaRE)
	}
	return id
}
func bootRef(v any) BootRef {
	m := obj(v, "epoch counter")
	return BootRef{match(m["epoch"], epochRE), num(m["counter"], 1, MaxCounter)}
}
func boot(v any) Boot {
	m := obj(v, "epoch counter identity")
	return Boot{BootRef{match(m["epoch"], epochRE), num(m["counter"], 1, MaxCounter)}, identity(m["identity"])}
}
func job(v any) Job {
	m := obj(v, jobKeys)
	return Job{match(m["jobId"], uuidRE), num(m["attempt"], 1, 2_147_483_647), match(m["generation"], uuidRE), num(m["attemptVersion"], 1, 2_147_483_647), match(m["contentId"], uuidRE), match(m["sha256"], shaRE), num(m["inputBytes"], 1, MaxInput), en(m["format"], formats), match(m["processorVersion"], processorRE), en(m["limitsProfile"], "conversion-v1")}
}
func outcome(v any) Outcome {
	m, ok := v.(object)
	require(ok)
	k := en(m["kind"], "result failure")
	if k == "result" {
		m = obj(v, "kind bytes sha256")
		return Outcome{Kind: k, Bytes: num(m["bytes"], 1, MaxResult), SHA256: match(m["sha256"], shaRE)}
	}
	m = obj(v, "kind reason")
	return Outcome{Kind: k, Reason: en(m["reason"], failures)}
}
func DecodeIdentity(b []byte) (Identity, error) {
	return checked(func() Identity { return identity(parse(b, MaxMetadata)) })
}
func DecodeJob(b []byte) (Job, error) {
	return checked(func() Job { return job(parse(b, MaxMetadata)) })
}
func DecodeQualification(b []byte) (object, error) {
	return checked(func() object {
		m := obj(parse(b, MaxMetadata), "version key phase tries probe testDigest firstServing")
		num(m["version"], 1, 1)
		match(m["key"], shaRE)
		phase := en(m["phase"], "probing passed blocked")
		num(m["tries"], 1, 2)
		p := bootRef(m["probe"])
		if phase == "passed" {
			match(m["testDigest"], shaRE)
			if m["firstServing"] != nil {
				require(Recycled(bootRef(m["firstServing"]), p))
			}
		} else {
			require(m["testDigest"] == nil && m["firstServing"] == nil)
		}
		return m
	})
}
func DecodeRequest(b []byte) (Request, error) {
	return checked(func() Request {
		m, ok := parse(b, MaxMetadata).(object)
		require(ok)
		num(m["version"], 1, 1)
		op := en(m["op"], "status submit cancel ack")
		r := Request{Op: op}
		if op == "status" {
			r.Query = en(m["query"], "readiness job")
			if r.Query == "readiness" {
				obj(m, "version op query")
				return r
			}
			obj(m, "version op query job")
		} else if op == "ack" {
			obj(m, "version op job outcomeSha256")
			r.OutcomeSHA256 = match(m["outcomeSha256"], shaRE)
		} else {
			obj(m, "version op job")
		}
		j := job(m["job"])
		r.Job = &j
		return r
	})
}
func Recycled(current, origin BootRef) bool {
	return current.Epoch != origin.Epoch && current.Counter > origin.Counter
}
func retry(v any, required bool) {
	if required {
		num(v, 1000, 10000)
	} else {
		require(v == nil)
	}
}
func DecodeResponse(b []byte) (Response, error) {
	return checked(func() Response {
		m, ok := parse(b, MaxMetadata).(object)
		require(ok)
		num(m["version"], 1, 1)
		r := Response{Kind: en(m["kind"], "readiness job outcome cancel ack absent error"), Boot: boot(m["boot"]), fields: m}
		if m["op"] != nil {
			r.Op = en(m["op"], "submit status cancel ack")
		}
		prefix := "version op boot kind "
		if r.Kind == "readiness" {
			obj(m, prefix+"state slot qualificationKey probe reason retryAfterMs")
			require(r.Op == "status")
			s := en(m["state"], "starting ready running restarting retained unavailable")
			slot := en(m["slot"], "empty occupied")
			reason := en(m["reason"], "none startup busy restarting qualification_required qualification_failed unavailable")
			require((m["qualificationKey"] == nil) == (m["probe"] == nil))
			if m["probe"] != nil {
				require(match(m["qualificationKey"], shaRE) == qualificationHash(r.Boot.Identity))
				p := bootRef(m["probe"])
				require(p == r.Boot.BootRef || Recycled(r.Boot.BootRef, p))
			}
			switch s {
			case "ready":
				require(slot == "empty" && reason == "none" && m["probe"] != nil && Recycled(r.Boot.BootRef, bootRef(m["probe"])))
			case "starting":
				require(reason == "startup" || reason == "qualification_required")
			case "running", "retained":
				require(slot == "occupied" && reason == "busy")
			case "restarting":
				require(slot == "occupied" && reason == "restarting")
			case "unavailable":
				require(reason == "qualification_failed" || reason == "unavailable")
			}
			retry(m["retryAfterMs"], s != "ready" && s != "unavailable")
			return r
		}
		if r.Kind == "error" {
			obj(m, prefix+"job code retryAfterMs")
			c := en(m["code"], "invalid_request unsupported_version busy conflict restarting unavailable not_terminal not_recycled already_acked")
			if m["job"] != nil {
				require(r.Op != "")
				j := job(m["job"])
				r.Job = &j
			}
			retry(m["retryAfterMs"], c == "busy" || c == "restarting")
			return r
		}
		j := job(m["job"])
		r.Job = &j
		switch r.Kind {
		case "job":
			obj(m, prefix+"job state origin retryAfterMs")
			require(r.Op == "status" || r.Op == "submit")
			en(m["state"], "receiving running")
			o := bootRef(m["origin"])
			r.Origin = &o
			require(o == r.Boot.BootRef)
			retry(m["retryAfterMs"], true)
		case "outcome":
			obj(m, prefix+"job origin outcome outcomeSha256")
			require(r.Op == "status" || r.Op == "submit")
			o := bootRef(m["origin"])
			r.Origin = &o
			require(o == r.Boot.BootRef || Recycled(r.Boot.BootRef, o))
			d := outcome(m["outcome"])
			r.Outcome = &d
			r.OutcomeSHA256 = match(m["outcomeSha256"], shaRE)
			require(r.OutcomeSHA256 == outcomeHash(j, o, d))
		case "cancel":
			obj(m, prefix+"job origin disposition")
			require(r.Op == "cancel")
			o := bootRef(m["origin"])
			r.Origin = &o
			d := en(m["disposition"], "requested already_requested terminal")
			if d != "terminal" {
				require(o == r.Boot.BootRef)
			} else {
				require(o == r.Boot.BootRef || Recycled(r.Boot.BootRef, o))
			}
		case "ack":
			obj(m, prefix+"job disposition")
			require(r.Op == "ack")
			en(m["disposition"], "cleared already_cleared absent")
		case "absent":
			obj(m, prefix+"job disposition")
			require(r.Op == "status" || r.Op == "cancel")
			en(m["disposition"], "absent already_acked")
		}
		return r
	})
}

// ValidateReply binds a syntactically valid frame to its actual request. ACK
// proof is supplied from the caller's previously validated retained outcome;
// transport completion alone cannot establish any lifecycle success.
func ValidateReply(req Request, res Response, expected Identity, ackOrigin *BootRef) error {
	_, err := checked(func() bool {
		require(res.Boot.Identity == expected && res.Op == req.Op)
		if req.Job == nil {
			require(res.Job == nil && (res.Kind == "readiness" || res.Kind == "error"))
		} else {
			if res.Kind != "error" || res.Job != nil {
				require(res.Job != nil && *req.Job == *res.Job)
			}
			require(res.Kind != "readiness")
		}
		if res.Kind == "ack" && res.fields["disposition"] != "absent" {
			require(ackOrigin != nil)
			proof := bootRef(object{"epoch": ackOrigin.Epoch, "counter": ackOrigin.Counter})
			require(Recycled(res.Boot.BootRef, proof))
		}
		return true
	})
	return err
}

// All arguments to these serializers must be validated. Public byte entry
// points below perform validation before reconstructing the preimage.
func quote(s string) string { return `"` + s + `"` }
func u(n int64) string      { return strconv.FormatInt(n, 10) }
func qualificationPreimage(id Identity) []byte {
	a := []string{quote("conversion-qualification/1"), "1", quote(id.ProcessorVersion)}
	for _, s := range id.Hashes {
		a = append(a, quote(s))
	}
	return []byte("[" + strings.Join(a, ",") + "]")
}
func jobPreimage(j Job) string {
	values := []string{quote(j.JobID), u(j.Attempt), quote(j.Generation), u(j.AttemptVersion), quote(j.ContentID), quote(j.SHA256), u(j.InputBytes), quote(j.Format), quote(j.ProcessorVersion), quote(j.LimitsProfile)}
	a := []string{}
	for i, k := range split(jobKeys) {
		a = append(a, quote(k)+":"+values[i])
	}
	return "{" + strings.Join(a, ",") + "}"
}
func outcomePreimage(j Job, o BootRef, d Outcome) []byte {
	s := `{"kind":` + quote(d.Kind)
	if d.Kind == "result" {
		s += `,"bytes":` + u(d.Bytes) + `,"sha256":` + quote(d.SHA256)
	} else {
		s += `,"reason":` + quote(d.Reason)
	}
	return []byte(`["conversion-outcome/1",` + jobPreimage(j) + `,{"epoch":` + quote(o.Epoch) + `,"counter":` + u(o.Counter) + `},` + s + `}]`)
}
func SHA(b []byte) string                            { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func qualificationHash(id Identity) string           { return SHA(qualificationPreimage(id)) }
func outcomeHash(j Job, o BootRef, d Outcome) string { return SHA(outcomePreimage(j, o, d)) }
func HashInput(b []byte, kind string) ([]byte, error) {
	return checked(func() []byte {
		v := parse(b, MaxMetadata)
		if kind == "qualification" {
			return qualificationPreimage(identity(v))
		}
		require(kind == "outcome")
		m := obj(v, "job origin outcome")
		return outcomePreimage(job(m["job"]), bootRef(m["origin"]), outcome(m["outcome"]))
	})
}
