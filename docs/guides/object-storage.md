# Private S3 object storage foundation

NIAR-250 adds the server-side storage foundation. Attachment upload routes, chat bindings, camera UI, conversion, inference and automatic cleanup are later checkpoints. This configuration does not advertise or activate attachments. Existing text chat and meeting audio keep their current behavior.

The application uses one S3 adapter for RustFS, Hetzner and endpoints that pass the explicit contract suite. Only RustFS 1.0.4 has been exercised locally; no live Hetzner credentials were supplied. No provider failure selects another bucket, local files or public URLs.

## Configuration

Storage configuration belongs to the server environment and mounted secrets, separately from member/workspace settings and exports. Any nonempty `NIARO_S3_*` variable opts into validation; partial or unknown settings are invalid. All absent means disabled. Invalid storage makes storage unavailable while ordinary server startup continues; `server:check` exits nonzero.

| Variable                                               | Contract                                                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `NIARO_S3_ENDPOINT`                                    | HTTP(S) origin without userinfo/path/query/fragment. Omission selects `https://s3.<region>.amazonaws.com`.                               |
| `NIARO_S3_REGION`                                      | Required lowercase signing region. For example `fsn1` for the corresponding Hetzner location; RustFS bootstrap requires `us-east-1`.     |
| `NIARO_S3_BUCKET`                                      | Required existing private dedicated bucket, lowercase DNS-style name. No access-point ARNs.                                              |
| `NIARO_S3_PREFIX`                                      | Default `attachments`, maximum 256 characters; slash-separated letters/digits/underscore/hyphen segments. No empty/dot/encoded segments. |
| `NIARO_S3_CREDENTIAL_MODE`                             | Required `static` or `default`. No implicit ambient fallback.                                                                            |
| `NIARO_S3_ACCESS_KEY_ID`, `NIARO_S3_SECRET_ACCESS_KEY` | Required in static mode, each with the exact `_FILE` alternative.                                                                        |
| `NIARO_S3_SESSION_TOKEN`                               | Optional static token, also `_FILE`.                                                                                                     |
| `NIARO_S3_FORCE_PATH_STYLE`                            | Exactly `true`/`false`, default `false`. RustFS uses `true`.                                                                             |
| `NIARO_S3_ALLOW_HTTP`                                  | Exactly `true`/`false`, default `false`; enable only for a private HTTP endpoint.                                                        |

An empty environment value counts as absent. A nonempty direct secret and its file alternative conflict. Files must be regular and at most 16 KiB; one trailing LF/CRLF is removed, remaining controls/empty contents are invalid. Mount secrets read-only at the configured paths; Compose does not automatically mount a host path merely because `_FILE` names it. Direct secrets are supported for local trials, but Docker administrators can inspect container environment values.

`default` explicitly selects the SDK credential chain and refuses all Niaro static secret variables. Credentials are resolved only on network use. Secret changes require restarting Niaro (or rerunning the explicit command); there is no file watcher. Credential rotation preserves location identity.

HTTPS verifies certificates. Use Node's `NODE_EXTRA_CA_CERTS` for a private CA, including a read-only mount and environment entry in a Compose override. `NODE_TLS_REJECT_UNAUTHORIZED=0` is refused for configured storage. HTTP requires explicit opt-in and real loopback/RFC1918/IPv6 ULA addresses. Named HTTP endpoints require path style; every DNS answer is checked at socket lookup, and those checked results are used directly. Public, metadata/link-local, multicast and unspecified addresses fail. Redirects are refused and no application credentials are forwarded to a different origin.

## Offline check and explicit network contract

```sh
npm run server:check -- examples/self-hosted/server.json
npm run server:storage-check
# Container equivalents:
docker compose exec niaro niaro check
docker compose exec niaro niaro storage-check
```

The standalone storage commands read an optional ignored `.env` in their working directory, like the server CLI. The offline check validates syntax and local secret presence without DNS, credential-chain resolution, S3 requests or DB writes. A configured result does not establish connectivity. Ordinary startup runs the local location guard and logs a safe status; it does not probe S3. The explicit network command does not open/activate the live workflow registry.

The required bucket is dedicated, private, never versioned (neither Enabled nor Suspended) and has no Object Lock/retention. Provision it with the provider's operator tooling before using hosted S3. Niaro never changes an existing bucket's erasure settings. The explicit suite checks those properties, conditional creation/refused replacement, repeated identical put, independent SHA-256/size read-back, head, exact range, missing objects, anonymous refusal and repeated deletion. It uses unique synthetic objects only inside the configured prefix, attempts cleanup in `finally`, and exits nonzero on cleanup failure. An unknown PUT also prevents a claim of confirmed probe cleanup even if a later HEAD is missing.

Application permissions must include GetBucketVersioning and GetBucketObjectLockConfiguration on the bucket plus PutObject/GetObject/DeleteObject within the prefix. Some endpoints, including AWS, require ListBucket on the dedicated bucket for a missing HEAD to return 404 instead of 403; grant the required permission and rerun the suite. RustFS's tested scoped bootstrap policy omits listing. A provider that cannot distinguish missing objects or prove the bucket prerequisites fails the contract. ETags are opaque; Niaro computes SHA-256 itself. SDK request/response checksums use `WHEN_REQUIRED` for compatibility.

To assess Hetzner/custom endpoints, supply a designated empty test bucket/prefix and the variables above, then run the same command. Passing this suite is specific evidence for that endpoint/configuration. It does not certify every S3 feature or prove a live Hetzner run when no credentials were available.

## Optional local RustFS

Both Compose variants offer `object-storage`, with the pinned image `rustfs/rustfs:1.0.4@sha256:ed9210d6411d77ffceb70d94b964a3cb7d225983368bc25bebe01e995293dcc2`. Leaving the profile out starts no RustFS or bootstrap service and is the normal external-S3 deployment. The local file publishes its API only on `127.0.0.1:${NIARO_RUSTFS_PORT:-19010}`. Dokploy publishes no storage ports and places it only on the project network. The console is disabled. Do not attach RustFS to Dokploy's proxy network or add a public console route.

Set these operator variables in your private `.env`/deployment environment, generating four distinct non-default values (access keys at least 8 characters, secrets at least 16):

```dotenv
NIARO_S3_ENDPOINT=http://rustfs:9000
NIARO_S3_REGION=us-east-1
NIARO_S3_BUCKET=niaro-attachments
NIARO_S3_PREFIX=attachments
NIARO_S3_FORCE_PATH_STYLE=true
NIARO_S3_ALLOW_HTTP=true
NIARO_S3_CREDENTIAL_MODE=static
# Supply your separately generated application key/secret:
NIARO_S3_ACCESS_KEY_ID=
NIARO_S3_SECRET_ACCESS_KEY=
# Supply different root/bootstrap credentials:
NIARO_RUSTFS_ROOT_ACCESS_KEY=
NIARO_RUSTFS_ROOT_SECRET_KEY=
```

Blank values deliberately cannot bootstrap. Niaro receives only the application variables; root secrets go only to RustFS and its one-shot bootstrap. The root credential must remain stable for that RustFS volume. To use application secret files, add read-only mounts to both Niaro and `rustfs-bootstrap` in a private Compose override and use the exact `_FILE` variables. Bootstrap also supports `NIARO_RUSTFS_ROOT_ACCESS_KEY_FILE`/`NIARO_RUSTFS_ROOT_SECRET_KEY_FILE`; for file-based RustFS root configuration additionally replace the service's direct `RUSTFS_ACCESS_KEY`/`RUSTFS_SECRET_KEY` entries and startup credential check with explicit native `RUSTFS_ACCESS_KEY_FILE`/`RUSTFS_SECRET_KEY_FILE` configuration. Do not set conflicting native sources. The shipped root-service guard requires direct non-default values; file-based root service overrides are operator configuration, not an automatic mount.

Build the Niaro image and bootstrap first:

```sh
docker compose build niaro
docker compose --profile object-storage run --rm rustfs-bootstrap
docker compose --profile object-storage up -d niaro
# Add the https/diarization profiles independently when needed.
docker compose exec niaro niaro storage-check
```

For Dokploy use `-f compose.dokploy.yml`, enable the profile in that deployment, and run the same bootstrap service before treating storage as ready. A combined `up` can serve text chat before bootstrap finishes; running containers alone do not establish storage readiness.

The one-shot task waits up to 60 seconds for RustFS, creates only the selected bucket, and inspects/provisions the exact requested application service account using the pinned RustFS SigV4 admin API. Its inline policy grants bucket-property inspection and object read/write/delete only under the configured prefix. It never grants application admin, bucket creation, policy mutation or access to another bucket/prefix. It then runs the application-credential contract suite. Existing matching principal/bucket reruns are safe. A wrong secret or different policy fails; bootstrap does not rotate or broaden an existing account. Any readiness/property/policy/probe/cleanup failure exits nonzero. It is an explicit operator command (`niaro storage-bootstrap` / `npm run server:storage-bootstrap`), never server startup or fallback behavior. Unknown image commands still exit 64.

The named `rustfs-data` volume is separate from Niaro's `niaro-data`; objects and IAM state survive container recreation. A single-disk instance is not redundant storage. Do not run `down -v` on data you intend to retain.

For a host-side check against local Compose, use `http://127.0.0.1:19010` in the command's environment; the container endpoint `http://rustfs:9000` resolves only inside Compose. Location identity includes the normalized endpoint, so this host-side probe must not activate or rewrite the application's registry.

## Location binding and uncertainty

The additive registry is in the existing workflow `workflow.sqlite`, with locations, one active location and immutable object reservations. It stores no credentials or display filenames. Location identity hashes endpoint/region/bucket/prefix/addressing; credentials and private-HTTP permission are excluded. Existing text data and workflow schema version remain readable. Startup refuses a different location while any non-deleted reservation remains and leaves text HTTP service running. There is no reset, force switch, migration command or silent reinterpretation.

Production handles are server-created, immutable, location-bound and checked against their registry row. Reservation precedes network I/O. PUT and DELETE admission uses durable operation tokens; concurrent mutations of the same handle return busy. Delete is irreversible, and a retired key is never reused. Each store allows two active operations, rejects excess work immediately, caps objects at 25 MiB, connects within 5 seconds and bounds a complete operation to 30 seconds including response reads and credential resolution. No SDK automatic retries run.

A lost/unknown PUT response quarantines its reservation durably, including after restart. Missing HEAD cannot prove that a delayed PUT will never arrive. Further same-handle mutations fail with non-retryable `uncertain`; location replacement stays blocked. **This phase offers no quarantine-clear/reconciliation command.** It can retain a reservation indefinitely. A confirmed PUT whose verification read failed is different: the write has settled, the reservation remains and explicit verification or deletion is possible. An unknown DELETE remains deleting; explicit retry can confirm deletion because the key can never receive another admitted PUT. These rules are a foundation, not complete attachment cleanup/reconciliation.

## Persistence, backup and verification scope

Niaro's existing data-directory backup contains registry metadata but no external object bytes. Complete future attachment backup needs matched database/object snapshots, manifests and quiescence/restore verification from later tasks 4.4–4.5; those are not implemented by this checkpoint. Preserve both named volumes for local experiments, or the hosted bucket plus Niaro volume, and keep root/application secrets separately protected. Never claim that an ordinary Niaro volume backup contains S3 originals. Existing meeting recordings remain in Niaro's identity directory.

Run the production tests with `npm run test:storage`. The opt-in destructive-to-its-own-synthetic-resources Docker test is:

```sh
node --import tsx tests/storage-rustfs.live.ts
```

It creates uniquely named containers/volumes, tests bootstrap and permissions, recreates its container, checks exact persisted bytes, and removes only those resources. It does not touch an existing RustFS, live server, emulator or `.env`. Full checkpoint execution evidence and limits are recorded beside the change in `reviews/storage-checkpoint-verification.md`.

## Attachment retention checkpoint

Attachment retention is opt-in: `NIARO_ATTACHMENTS_ENABLED=false` by default.
Capability discovery is `GET /v1/:workspace/attachments/capabilities?profile=agent-attachments%2F1`.
It always reports `processingAvailable:false` at this checkpoint. An accepted
file-bearing send stores its user message and original references atomically and
reports `blocked_capability`; it performs no caption-only inference, conversion,
OCR, image routing, CRM action or automatic paid retry. Uploading alone never
interprets a file. Existing server-info output stays unchanged.

Use the strict shapes in `packages/protocol/attachments.ts`. Attachment routes
require exactly one `profile=agent-attachments/1`; command/snapshot/event/stream
delivery requires exactly one `attachments=agent-attachments/1` alongside the
existing chat projection. Older clients receive 406 before command effects when
the selected response would contain attachment evidence. A file-only message is
valid; the text allowance remains 4,000 characters and the command body 64 KiB.
The internal assistant publication seam uses the existing native projection and
workflow save transaction, with a unique attempt publication key and no second
user message or receipt. Native admission is a separate strict catalog sidecar;
old complete native journal rows remain readable. Preparation interrupted after
possible inference stays unknown; absence of a native root is no no-dispatch proof.

The workflow database owns generations, drafts, immutable content, separate
message bindings, ingestion/attempt rows, request replay and purge jobs. Account
ownership includes server/workspace/user rather than device credentials. Web
unsaved drafts must be adopted by the existing conversation.create command.
Ordinary archive moves the public locator while preserving the ownership
generation and native session identity. Clearing a fixed chat creates a new
generation; an old generation's purge cannot select the new thread or original.
Again creates new message bindings; removing an Edit chip does not erase source
history. Original reads reauthorize current membership/device and generation on
each response chunk; originals use private no-store attachment downloads,
octet-stream and nosniff. Preview and model derivative routes are unavailable.

Default limits are 25 MiB per file, 10 files/50 MiB per message; four open drafts
per owner/100 globally; 20/200 staged files and 100 MiB/1 GiB staged bytes;
500/5,000 retained objects and 1 GiB/10 GiB retained bytes. Draft expiry is an
absolute 24 hours. The capability response publishes validated effective limits;
invalid settings disable attachment admission. Global inbound upload and original
download slots are one each, with no wait queue. A transfer writes exclusive
0600 disk spools in the private workflow attachment-spool directory, checks disk
headroom of 50 MiB plus declared bytes, enforces the exact length/digest and a
120-second absolute/15-second idle deadline, then materializes the bounded
original for the accepted storage API. Spools are excluded from backup and stale
owned files are removed at startup. File signatures and bounded container names
are identification only, never execution or document interpretation.

Fifty MiB is a logical payload limit, not an RSS bound: caller buffers, adapter
read chunks/concatenation, upload buffers and a stalled download can coexist.
The opt-in synthetic resource/roundtrip suite is
`node --import tsx tests/attachment-rustfs.live.ts`. It owns only its random
RustFS container/volume, samples the application in a separate process during
25 MiB upload/download coexistence with meeting upload and native process model
traffic, and reports RustFS separately. It does not qualify converters, OCR,
real device capture, arbitrary host workloads or an unprovided Hetzner bucket.
The application's existing 2 GiB cap is unchanged; keep processing activation off.

Logical deletion immediately denies access, scrubs workflow/history/search/event
source projections, retires local tokens and queues exact object/native erasure.
Approved business records and content-free execution/action replay protection
retain their existing policy. Cleanup runs one durable job/object operation at a
time, yields to foreground transfers, retries settled failures with bounded
backoff and releases retained quota only after registry deletion settles. Native
cleanup retires exact generation aliases, threads and executable checkpoints
without resuming them. Missing native lineage stays blocked rather than deleting
all threads of a fixed chat. Diagnostics expose content-free counts and age.
An unknown PUT remains quarantined even after missing HEAD or delayed arrival;
it keeps quota and the location reference. Generic-S3 uncertainty reconciliation,
quota reset, fallback originals and an operator force-release are unsupported.
