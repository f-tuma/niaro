# Compose conversion boundary feasibility

> Research record of 2026-10-30, kept for the decision in design 4.0 (NIAR-260). The test files are in `tests/fixtures/documents/` (`pilot/`, `qualification/`); compare engines with `services/converter/compare.py`. Raw results, reviews and the spike harnesses were not kept in the repository; their paths below are plain text.

2026-10-30. Bounded A6 / part-A7 research, not architecture acceptance or task
5.1 implementation. **A small opt-in Compose service is a credible replacement
for the proposed host launcher**, provided it includes a trusted confinement
gate and deliberately recycles the complete PID namespace after each attempt.
A container shared by a supervisor and a vulnerable same-UID child is
insufficient. The experiment supports the narrower contract below on the tested
Linux host; it does not establish an audited exploit sandbox or portable
production deployment on every self-hosting platform.

The conditional MarkItDown **0.1.9** + Tesseract **5.5.0** preference remains.
No prior corpus, result, fixture, lock, image or checksum was changed or rerun.
The existing **100-page** feature default is unchanged and unqualified. Neither
the pilot's 20-page bound nor a 512 MiB worker is approved, and neither is shown
to fit every mandatory format. Fresh independent review is required before
changing canonical design or starting production integration.

## Subject and deployment shape

Read CONTRIBUTING, spec-guide/workflow/contracts, canonical proposal/design/tasks,
the qualified document pilot and packaging/benchmark/isolation/setup/adapter
scripts, actual application Dockerfile and both Compose files, deployment
guidance and hosted sandbox implementation, plus the independent review and
editorial qualification under `/tmp/niaro-orchestration-20261030`.
The current hosted `ProcessSandbox` is Node-only and is not a Python/native OCR
boundary; its Docker counterpart requires runtime administration and a hosted
network. Neither should be repurposed by granting the application Docker access.

The spike lives in
`spikes/converter-worker-feasibility` (`spikes/converter-worker-feasibility/README.md`).
A static Go supervisor is container PID 1 and owns a fixed durable attempt slot
and Unix-socket endpoint. A static C gate runs before any parser code. It enters
an immutable parser root, sets its working directory inside that root, removes
supplementary groups, drops to UID/GID 65532, closes descriptors above 2, enables
no-new-privileges and installs a syscall filter. The outer supervisor runs as
UID 0/GID 1000 with only SETUID, SETGID and SYS_CHROOT. There is no SYS_ADMIN,
privileged mode, runtime socket, application data, storage credential, provider
credential or network interface connecting it to Niaro/RustFS.

The parser cannot see the supervisor executable, IPC/state mounts, proc/sys or
device mounts. Only one aggregate tmpfs is writable, and output uses private
pipes. Its effective/permitted/inheritable/ambient capabilities were observed
as zero; no-new-privileges was 1 and two seccomp filters were active. Supplementary
groups were empty. Separate credentials, descriptor closure, immutable mounts
and syscall restrictions matter: [chroot alone does not provide a security
sandbox](https://man7.org/linux/man-pages/man2/chroot.2.html).

Each completed, failed, cancelled or timed-out attempt persists its bounded
record and exits PID 1. Linux then kills every process in that PID namespace,
including detached/reparented children; Compose restarts a fresh namespace and
tmpfs. This follows the [PID namespace termination
contract](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html), rather
than relying on a process-group kill that a child can escape with `setsid`.
There must be no `init: true`, shell/init wrapper, host/shared PID mode or
surviving inner supervisor. The implementation checks that its PID is 1.

## Evidence and limits

The small durable evidence manifest (`spikes/converter-worker-feasibility/evidence.json`)
contains exact runtime/image identities, per-case outcomes, charged-memory/PID
measurements, observed parser credentials, failed preliminary probes and cleanup.
Raw commands and measurements remain task-local at
`/tmp/niaro-worker-feasibility-20261030`; they are not historical pilot evidence.
Tests used isolated random Compose projects and synthetic bytes/behaviors only.
The evidence combines eleven principal cases from `run4` with corrected
supervisor-crash recovery and burst probes from `run5`, all on the same image.
`run4` is explicitly not an all-green run: its final operator-signal injection
was an invalid test of automatic restart. `run5` exited successfully.

| Property | Actual evidence | Scope of conclusion |
|---|---|---|
| Parser cannot reach app, secrets or supervisor IPC | AF_INET, AF_INET6 and AF_UNIX socket creation returned EPERM; app/state/socket/proc/runtime-socket paths were absent; root-owned shadow read failed; supervisor signal and `setuid(0)` failed; root write returned EROFS; no extra descriptors or secret environment variables were visible. | Process-level boundary on this kernel/configuration; no kernel-exploit or audited syscall-policy claim. The whole worker also uses `network_mode: none`; no sideways app or RustFS network is attached. |
| Aggregate writable bytes | Many 1 MiB files hit ENOSPC after 31 complete files, with a partially filled last file and the fixed input consuming the same 32 MiB tmpfs. | One shared byte ceiling, not RLIMIT_FSIZE or a sampled per-file total. No writable output/host bind. Scratch includes input and temporary/output files. |
| Aggregate inode/process limits | Empty files hit ENOSPC after 254 creations under a 256-inode mount. Fork pressure reached the 64-task cgroup ceiling and returned EAGAIN; detached children were removed on namespace recycle. | Prevents unbounded small-file/fork expansion in this synthetic envelope. Threads count toward the PID ceiling. |
| Output and unsafe paths | Both stdout and stderr floods produced terminal `output_limit`; the collectors retain at most 64 KiB each. A parser result containing a filesystem `path` failed the strict result decoder. Invalid request paths/identities/schema failed before launch. | Fixed opaque input path and length-framed bytes; no parser-provided paths are opened. Production source/table/partial DTO validation is still required. |
| Whole-job timeout/cancel | A direct parser parent exited while a child created a new session, ignored SIGTERM and kept a pipe open. The supervisor's 3-second timeout exited PID 1; observed old host PIDs disappeared before the new epoch. Cancellation of a hanging session also recycled the namespace. | Covers controlled session escape, inherited pipes and cancellation. This is not proof about uninterruptible kernel I/O; parent leases must remain conservative while no fresh epoch is observed. |
| Memory pressure | An allocator reached the 268,435,456-byte cgroup peak; `memory.events` recorded `oom_kill=1`. The retained attempt became `resource_or_parser_failure` and was not automatically replayed. | Actual charged aggregate cgroup memory, including tmpfs/cache, not summed RSS. The prototype deliberately does not infer a precise OOM reason from every parser signal. |
| Supervisor crash/restart | An operator-only disposable process joins this test PID namespace and signals Go PID 1 to abort. The worker restarts and turns durable `running` into terminal `interrupted`. | No production fault API or runtime permission is added. Ordinary container restart is tested; daemon/host reboot and storage power loss are not. |
| Stable outcomes / no repeated inference | Every retained attempt replay returns the same terminal record; conflicting digest retries are rejected. A single durable slot uses file fsync, atomic rename and directory fsync. No Niaro/provider inference, CRM or storage action runs. | Parent ACK releases the slot; Niaro must preserve durable idempotency and tombstone history after ACK. This is not a complete app/DB exactly-once implementation. |
| Candidate runtime | The retained selected image loaded MarkItDown 0.1.9, reported Tesseract 5.5.0, and converted a fresh tiny synthetic text file with plugins disabled inside the boundary. | This smoke establishes basic packaging compatibility, not OCR-model provisioning, every native codec/syscall, fidelity, or mandatory-format capacity. |

The prototype's state volume is writable only by trusted code and contains two
fixed ledger filenames, not parser-selected files. Each captured stream is at
most 64 KiB, and result serialization can expand escaped JSON by a bounded
factor; reserve **1 MiB for the two ledger files**, separately from the bounded
Docker log rotation and filesystem metadata. This is an application-enforced
fixed-slot bound, **not a filesystem quota on an arbitrary writable volume**.
Production should enforce the final encoded record size explicitly. Parser
output is never copied to the container log. The local log driver is configured
for two 1 MiB files without compression; these are rotation settings, not an
exact whole-host disk quota. Input/output spool reservations in Niaro remain A5.

The container memory cap includes both trusted supervisor and parser: they are
not independent OOM domains. The observed child OOM and separately injected
supervisor crash recover the attempt conservatively. Supervisor starvation,
continuous fork races, all namespace variants, crafted native-parser exploits,
disk-full/power-loss corruption, daemon/host restart, startup corruption and
adversarial concurrency against the trusted socket have not been comprehensively
tested. A missing/invalid terminal outcome must not mean success or trigger a
model/action replay. A fresh worker epoch and parent lease/fencing are required
before publication or replacement work.

## Cost and operational qualification

The tested runtime is Linux/amd64 kernel 7.3.0-4-cachyos, rootful Docker Engine
29.9.2 with cgroup v2/systemd and built-in seccomp, Compose 5.6.1. The prototype
used one worker CPU, 256 MiB memory/no swap, 64 tasks, 32 MiB/256-inode scratch,
4096 input bytes, two 64 KiB streams and a 3-second deadline. These deliberately
small **test** settings are not product defaults. The synthetic IPC client has
its own 64 MiB test cap and is not a production service requirement.

The worker image is **986,998,287 bytes**, versus **985,599,913 bytes** for the
retained v2 parser image: a Docker-reported difference of **1,398,374 bytes**.
Its `docker save | gzip -1` stream is **255,661,491 bytes**. Flattening the parser
under the jail means build/cache storage can retain a whole additional roughly
987 MB layer; the small reported difference is not an incremental disk-space
promise. The pilot's separately pinned 18,482,879-byte OCR asset set is additional
and was not mounted for this version/text smoke. Final code/model notices remain
a separate redistribution gate. Host Go/GCC versions and binary hashes are
recorded; the experiment is not a reproducible production build pipeline.

Idle worker memory was **5,099,520 charged bytes** in the final recovery run;
initial service readiness took **503 ms**. Principal cases took **764–1707 ms**
from submission through recovered-status/replay verification, apart from the
**3608 ms** timeout case with its full 3-second deadline. These include harness
RPC and verification overhead. Four immediately submitted short jobs took
**565, 796, 1231 and 2074 ms** through recovery, showing the backoff cost. These
are single observations, not a latency distribution or throughput promise.

Recycling each attempt is simple but exposes **Docker restart backoff**. The
main probes deliberately allow more than ten seconds uptime between jobs;
the separate burst measures increasing delays for short jobs. Upstream
[restart-manager code](https://raw.githubusercontent.com/moby/moby/master/daemon/internal/restartmanager/restartmanager.go)
doubles its delay from 100 ms up to one minute and resets it after ten seconds
uptime. That source explains the observed pattern; the one-minute ceiling was
not benchmarked locally. A low-throughput first deployment can explicitly
advertise bounded busy/restarting states, or gate acceptance until ten seconds
uptime to avoid escalating backoff. The latter limits fast-job throughput to
roughly six attempts/minute/worker. Do not silently assume an always-ready pool.
If required latency/capacity rules out that tradeoff, reopen this decision before
adding workers or a more complex per-job namespace manager.

Two failed crash-injection attempts are retained: `docker kill` with SIGKILL,
then SIGABRT, marked the container manually stopped and prevented automatic
`unless-stopped` recovery. [Docker's signal implementation](https://raw.githubusercontent.com/moby/moby/master/daemon/kill.go)
explains this distinction; the corrected fixture signals from an operator-only
process and exercises actual PID 1 death. Manual stop is an operator action,
not an availability failure that Niaro should bypass. Early log-driver and
socket-group packaging failures were corrected without adding capabilities.
A preliminary preservation check over-collected unrelated container metadata in
task-local logs; it was removed and the check narrowed to timestamps only. No
live credentials were used.

The existing application keeps **2 GiB memory and its 512 MiB `/tmp`** in both
Compose variants. That tmpfs is charged within its app cgroup; it is not spare
converter memory. Worker scratch is also charged within its own cap. Account
separately for worker, app/meeting pressure, RustFS, optional diarization and OS
headroom. No simultaneous app/meeting/conversion/RustFS test ran, and no roughly
4 GiB host or two-core responsiveness claim is justified. Rootless engines,
user-namespace remapping, SELinux/AppArmor, Docker Desktop and Dokploy are
deployment acceptance targets, not observed passes. A startup capability/cgroup
probe must fail closed where the required boundary cannot be installed.

## Proposed next canonical contract, pending review

1. **Deploy one optional conversion service**, with a separate IPC volume and a
   worker-private fixed-slot state volume. No app `/data`, application/storage/
   model credentials, public port, runtime socket or runtime administration API.
   Keep RustFS connectivity in Niaro; only bounded immutable attachment bytes
   cross into conversion. Define socket UID/GID and directory ownership explicitly.
2. **Trust only a small supervisor/gate.** Run parser code after credential,
   descriptor, filesystem, capability and syscall confinement. Keep only quota-
   limited job storage writable, with byte and inode ceilings and capped pipes.
   Review native gate/syscall policy and offline model/codec compatibility before
   acceptance; do not equate a container or chroot with a protected supervisor.
3. **Make whole-namespace recycle contractual.** Timeout, cancel, parser failure,
   OOM or supervisor failure must never leave parser descendants serving a new
   attempt. Persist the outcome where possible, terminate PID 1, and wait for a
   fresh epoch before considering the boundary available. Missing outcome becomes
   `interrupted/resource-unknown`, never success or automatic inference. Include
   explicit restarting/backoff/unavailable status and a reviewed latency policy.
4. **Keep the durable lifecycle in Niaro.** Reserve capacity before spooling;
   persist opaque attachment/attempt/generation/digest identity before delivery;
   independently verify exact byte length/hash at the trusted receiver. Accept
   only fixed schema/version/limits, never commands, paths, images or mounts.
   Retain outcome until an explicit parent ACK after durable observation; keep
   app idempotency/fencing history beyond ACK. Recovery queries status rather
   than blindly resubmitting. Bound queue, slot retention and parent spool totals.
5. **Version structured evidence and status.** Define typed text/table/source/
   warning/partial/failed results and encoded-byte/depth/count/index bounds; use
   parent-chosen opaque derivative names and verify length/digest. The spike's
   schema-1 synthetic text/checks object is not that production DTO. Reauthorize
   owner/generation/tombstone before publication or model use and route obsolete
   outputs to durable deletion. Conversion never invokes a model or CRM action.
6. **Choose a resource envelope from required-format and aggregate evidence.**
   Preserve the feature's 100-page requirement until explicitly revised by the
   owner. Do not promise every mandatory format fits 512 MiB or a page/pixel cap
   based on this sandbox test. Review app/meeting/RustFS coexistence separately.
7. **Require fresh review and bounded integration acceptance.** Exercise the
   real approved adapter/models inside the chosen boundary, deployment variants,
   all termination/recovery windows and parent stale-result/deletion/model-budget
   gates before enabling attachments. Only then revise canonical A6/A7/task 5.1.

A host launcher is **not demonstrated necessary** for these bounded properties.
The earlier dedicated-user rootless OCI proposal remains a fallback if the
owner rejects the three setup capabilities/container-root trust or requires
per-job runtime isolation/availability that this recycle policy cannot meet.
That route still needs rootless cgroup delegation, image provisioning, socket/
UID ownership, installation/upgrades and orphan/restart management on both
deployment variants. A Docker socket in Niaro is not an acceptable shortcut.
No heavier platform is selected here.

Mixed text/scan PDF omissions, exact field/cell and negative-source acceptance,
notice completeness and corpus regeneration/replay remain separate production
gates from R1/R3/R4/R5. This spike does not repair or supersede them, enable new
formats, implement RustFS or change the lifecycle planner's canonical artifacts.
The cleanup and preservation manifest records removal of only disposable
resources and unchanged prior source/evidence; new-file hashes are supplied in
the spike's `SHA256SUMS`. No app/dependency/production Compose changes,
stage/commit/push, deployment, real customer data or delegation occurred.

Final preservation verification matched **580 prior files**, including all
existing pilot/canonical/deployment subjects in the before snapshot, and the
three retained pilot image IDs. Existing service start timestamps were unchanged.
All disposable project containers/volumes and the spike output image were
removed; task-local logs and unpruned build cache remain. Static C checks, Go
vet, Python compilation, Compose configuration and whitespace/link/hash checks
passed; app tests and full converter benchmarks were outside this scope.
