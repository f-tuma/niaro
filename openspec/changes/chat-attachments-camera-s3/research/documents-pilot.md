# NIAR-250: bounded FOSS document/OCR pilot

> Research record of 2026-10-30, kept for the decision in design 4.0 (NIAR-260). The test files are in `tests/fixtures/documents/` (`pilot/`, `qualification/`); compare engines with `services/converter/compare.py`. Raw results, reviews and the spike harnesses were not kept in the repository; their paths below are plain text.

Measured 2026-10-30 in isolated checkout `niaro-documents-pilot`, HEAD `260b1eef413dc3e6295ef9776c2a5ea868a8ef0f`. Recommendation: take **MarkItDown 0.1.9 plus explicit local Tesseract 5.5.0 and small deterministic format adapters** to the next reviewed checkpoint. Do not enable its hosted OCR plugin. Docling 2.145.0 has stronger native layout/provenance and rotation handling, but the tested standard PDF/image pipeline exhausts a 1 GiB worker on a normal-sized 12 MP photo and costs substantially more memory/package space. This is a conditional engineering recommendation, not production integration, release approval, or completion of canonical task 1.3.

Task 1.2 has reproducible measured evidence. Task 1.3 still needs the coordinator's design/resource decision and independent review, final production dependency/license packaging and a conforming worker/result implementation. Neither raw engine meets the full contract unchanged. No mandatory format was removed to obtain this result.

The independent review (`/tmp/niaro-orchestration-20261030/documents-review.md`) passes the bounded research and conditional candidate preference while leaving production integration pending. Its R1–R5 dispositions and the historical-versus-revised documentation hashes are in the editorial addendum (`spikes/documents/results/editorial-qualification-20261030.md`). Recorded fixtures, measurements and license evidence remain unchanged.

## Inputs and method

Read proposal, design, tasks, every change delta, CONTRIBUTING, deployment/Compose/Docker constraints, meeting processing/admission and hosting sandbox code, and the fresh main-checkout EGM report (A5–A7/C3/D4). Canonical design SHA-256 is `f0a0bc02f4d95c39fbb3ef386e8fb5c6317ddceee213bb07be4cb54bb64f6344`; tasks hash is `69d056fd3f6e8550afde974be24986a9ccde3647c0c9cfe9649ff82ffb1de8d0`. Those files remain unchanged.

The pilot (`spikes/documents/README.md`) contains 21 quality fixtures and three stress probes: invented CS/EN business cards; 90-degree rotation, EXIF orientation, blur, glare and blank images; two-page text/table PDF, two-column PDF, scanned CS/EN PDF; DOCX table; two-slide PPTX; two-sheet XLSX; CSV/TSV/TXT/Markdown; optional JSON; malformed PDF/DOCX and AES-256 protected PDF; a 12 MP JPEG, ten-page scan and 2.31 MB text output probe. Manifest entries pin original bytes, expected strings, full table rows and source references. Originals were not modified by conversion.

Every conversion used a fresh non-root, read-only Docker container, no network, capabilities or app mounts/credentials; one CPU quota, no swap, 64 PIDs, 256 MiB scratch, 120 s wall and 110 s CPU ceiling. The main comparison used 1 GiB RAM. The final local adapter ran all 24 files under **512 MiB**. CPU is quota-limited, not isolated from host scheduling. Processes were cold; host filesystem/model page cache was not flushed. This is one run per fixture/configuration, not a latency distribution or throughput/load test. Host/kernel/CPU, image IDs and source hashes are retained in `results/environment.json`.

Three configurations distinguish library behavior from adapter behavior:

1. Native MarkItDown with plugins disabled and no LLM client.
2. Docling standard PDF/image pipeline: CPU, one thread/batch, local Tesseract `ces+eng`, Heron layout and accurate TableFormer, remote services/plugins/enrichment disabled. UTF-8/CSV/TSV/Markdown/JSON go through the explicitly labelled standard-library bridge rather than being attributed to Docling native support.
3. MarkItDown local adapter: page-preserving PDF splitting with PyPDF, PDFium rasterization only for pages with no text, Tesseract TSV word evidence, explicit EXIF correction and local OSD, strict Office ZIP preflight, and the same deterministic text bridge. OCR always produces `partial`/`ocr_requires_review`; empty extraction fails.

The [official MarkItDown OCR plugin](https://github.com/microsoft/markitdown/tree/main/packages/markitdown-ocr) expects an OpenAI-compatible client. It was not installed or called. All model assets were prefetched through official repositories at setup; conversion containers could not make hosted calls. These are local parser comparisons, not a Niaro inference/model evaluation.

## Quality, sources and outcome behavior

Complete per-file F/T/R results are in `comparison.md` (`spikes/documents/results/comparison.md`); native outputs and errors are retained beside each measurement. **F measures expected-string recall by substring presence** after NFC/case/whitespace normalization, not parsed-field equality. Expected `12.5` therefore scores present in `112.5 kg`, as the independent R3 scoring probe (`/tmp/niaro-orchestration-20261030/documents-review-scoring-probe.json`) demonstrates. F does not certify wrong-digit avoidance, field boundaries or the absence of extra/wrong values. T separately requires an exact normalized cell sequence for each expected row, including headers and units; this protects the current simple numeric table examples, but does not establish table identity, row order across tables or omission coverage. R counts expected source-reference presence. The separate `source-linkage.json` audit checks strings within intended PDF pages, slides and workbook sheets for five representative documents; it is not a universal source-association guarantee. Production acceptance still needs structured field/cell equality, extra/wrong-value and negative source-association cases, and complete coverage checks. Saved scores and their historical labels are unchanged.

| Evidence | Native MarkItDown | Docling + bridge | Local adapter v2 |
|---|---|---|---|
| Clean CS / EN cards | 0/6, 0/6; success without OCR | 6/6, 6/6 | 6/6, 6/6; review required |
| Rotated CS / EXIF JPEG | 0/6, 0/6 | 6/6, 6/6 | 6/6, 5/6; review required |
| Blur / glare | 0/6, 0/6 | 6/6, 4/6; glare reported success | 6/6, 4/6; glare low-confidence warning |
| Scanned CS/EN PDF | 0/12; empty success | 11/12; success without warning | 12/12; per-page OCR review |
| Text/table PDF | 14/14, 3/3 rows; page links absent | 14/14, 3/3 rows, both pages | 14/14, 3/3 rows, both pages |
| Two-column PDF | 6/6; no page link | 6/6; order and page correct | 6/6; order and page correct |
| DOCX table | 13/13, 3/3 rows | same | same |
| PPTX / multi-sheet XLSX | 4/4, 14/14; slides/sheets retained | same | same |
| CSV/TSV/TXT/Markdown | strings present; native delimited output lacks scored table/source structure | deterministic bridge preserves rows/lines | deterministic bridge preserves rows/lines |
| Blank image | success without useful OCR | wrapper rejects empty result | explicit failed/empty OCR |
| Protected / malformed PDF | protected fails; malformed falls back to text | both fail | both fail |
| Malformed DOCX | raw-text fallback success | fails | preflight fails |

The EXIF-JPEG local OCR address is `Dlouha …` rather than `Dlouhá …`; glare removes the email and phone. Docling's scanned Czech address has the same accent defect. No card-to-CRM field inference or uncertainty classifier was implemented. Word confidence does not prove an address/name is correct; all OCR evidence remains unreviewed and must not become silently approved contact values. Missing fields remain unresolved at the later proposal stage.

DOCX has no stable rendered page numbering in these engines; preserve document/block/table-cell references rather than inventing pages. The pilot exports Markdown and evidence, not the final production DTO. Docling's workbook JSON includes both sheet groups and pseudo page numbers; the production mapper must use sheet names/cells. MarkItDown retains sheet names and table row relationships, but needs a typed source mapper rather than treating Markdown headings as permanent identifiers.

**R1 confirms a mixed-page PDF omission.** Using the recorded v2 image, the independent probe (`/tmp/niaro-orchestration-20261030/documents-review-mixed-probe/probe.json`) returned `success`, `page:1` and only `SYNTHETIC-TEXT-LAYER-HEADER`, omitting every field of the scanned card below it. The adapter OCRs only pages whose extracted text is empty. A nonempty text layer and page reference therefore do not establish complete reading; mixed pages need coverage or an explicit partial/unsupported outcome before production PDF support is advertised. This separate review probe does not alter the saved corpus or scores.

## Resource result and deployment decision

| Measured configuration | Charged cgroup memory peak | Longest wall time | Sampled scratch peak |
|---|---:|---:|---:|
| Native MarkItDown, main corpus | 115.7 MiB | 1.35 s | 0.09 MiB |
| Local adapter v1, main corpus | 182.8 MiB | 1.85 s | 0.33 MiB |
| Local adapter v2, all 24 under 512 MiB | **305.8 MiB** | **7.35 s** (ten-page scan) | 0.86 MiB |
| Docling, main corpus under 1 GiB | 941.5 MiB | 12.99 s | 1.29 MiB |
| Docling, 12 MP photo under 1 GiB | hits 1,024 MiB; **OOM/137** | 11.22 s to failure | killed before final sample |
| Docling, ten-page scan under 1 GiB | reaches 1,024 MiB | 26.75 s | 0.17 MiB |

The 398,314-byte 12 MP JPEG becomes at least 36,000,000 RGB bytes before copies/rendering/OCR. The ten-page PDF is only 65,388 bytes because it reuses one image; it still requires per-page decoding and OCR. Input bytes therefore do not predict RAM/work. `/proc` maximum RSS and charged cgroup memory are both retained: they differ because shared mappings and file-cache charging differ. Use the cgroup limit for deployment admission, not RSS alone.

The first harness accidentally applied its 2 MiB output target as a **per-file RLIMIT**, including scratch files. Docling's first 12 MP failure was `File too large`, not OOM. It remains in `docling-stress-1g` as superseded evidence. The corrected `docling-stress-64m-file` allows 64 MiB individual scratch files while retaining 256 MiB total scratch and 2 MiB serialized result; it demonstrates the actual OOM. Early missing-TSV-config smoke runs are separately under `results/superseded` and excluded. Output-limit probes fail explicitly; no text prefix is labelled complete.

Current deployment documents approximately 450 MB idle app memory, 1 GB pilot planning, a **2 GiB app limit**, **512 MiB shared `/tmp`** and 1–2 CPUs. Meeting processing already admits two meetings and decodes substantial chunks in that temp budget. No app-plus-meeting peak-load experiment was performed. Arithmetic from idle app memory cannot establish coexistence under 2 GiB, and the unchanged app limit allows it to consume the whole allocation.

Resource options for the next reviewed checkpoint follow; none is selected deployment policy:

- Proposed separate worker budget: keep Niaro's 2 GiB app limit and existing meeting temp unchanged; consider **an additional 512 MiB**, one CPU quota and **256 MiB worker scratch within that memory cap** for one conversion at a time. The combined configured container maxima would be 2.5 GiB before RustFS/OS/other services; a host budget around 4 GiB is a planning option, not a measured minimum. Two CPUs alone do not demonstrate app responsiveness during conversion; aggregate load evidence is still needed.
- Keep all work inside the old total envelope only after aggregate admission and real peak-load evidence. The pilot does not authorize taking 512 MiB away from the app or meetings.
- A larger Docling deployment is a separate resource/quality decision. One GiB demonstrably fails this photo. No 1.5/2 GiB tuning or deployment expansion was selected; the coordinator explicitly bounded further tuning after these results.

Pilot-derived proposal limits are one running job globally; 25 MiB immutable original; at most 20 pages and 20 MP decoded raster; 120 s wall/110 s CPU; 256 MiB scratch; 2 MiB UTF-8 result. These are proposed production bounds, not approved defaults or proof that every file under them fits. Only up to 12 MP and ten scan pages were measured. The canonical 100-page default conflicts with the pilot adapter's 20-page limit and remains unverified. All decoders need aggregate pixel/cell/ZIP expansion admission before allocation, and every engine path needs page/output coverage checks. The pilot raster pixel check follows image conversion/allocation, so it does not prove pre-allocation admission. The Office ZIP preflight caps entries/expanded bytes; it is not complete hostile-document validation.

## Packaging and exact license evidence

| Package measurement | MarkItDown pilot | Docling pilot |
|---|---:|---:|
| Site-packages apparent bytes | 272,398,590 | 1,483,506,310 |
| Docker-reported image bytes | 985,599,545 | 2,622,321,830 |
| `docker save` piped through gzip -1 | 252,992,717 | 617,180,037 |
| Required separately mounted offline assets | 18,482,879 | 402,917,667 |

Images include the pinned Python slim base and common Tesseract/GL runtime packages. MarkItDown image also contains fixture-generation libraries; these measurements are the actual pilot, not an optimized production-image promise. Models are outside image size and must be provisioned/pinned read-only. The revised adapter changes only a small code layer; its exact image size/ID is also recorded. Container Python is 3.12.16; packages were resolved in isolated CPython 3.12.15 environments using compatible cp312 wheels. Installed OS versions are recorded; apt repositories are not snapshot-pinned, so future builds require re-inventory or retained images for byte reproduction.

Code: MarkItDown 0.1.9, Docling/docling-slim 2.145.0, docling-core 2.105.0, docling-parse 7.24.2 and docling-ibm-models 4.0.4 declare MIT. Local OCR is Tesseract 5.5.0 (Apache-2.0) with Leptonica 1.84.1 and distributed codec libraries. PyPDF 6.21.4 is BSD-3-Clause; PDFium/pypdfium2 5.14.0 contains BSD/Apache and bundled third-party notices. Do not describe the whole image as MIT.

Exact 40-package MarkItDown and 103-package Docling environments, versions, license expressions/raw metadata and license-file hashes are in `licenses-markitdown.json` and `licenses-docling.json`; corresponding `license-texts.tar.gz` files retain 101 and 259 collected notice files, including bundled native-code notices. The locks pin every resolved Python version. **R4: distribution-notice coverage is incomplete.** `license_files` is empty for MarkItDown, Magika, cobble, et_xmlfile, flatbuffers and openpyxl in the selected environment; the Docling environment also has gaps for docling, et_xmlfile, latex2mathml, openpyxl and tokenizers. `environment.json` records OS versions, and `licenses-os.json` retains 186 copyright records; referenced full `/usr/share/common-licenses/` texts are not retained. Metadata declarations alone do not supply missing notices. Preserve exact upstream/distribution notices and referenced texts for the selected production package, or record a justified disposition of omissions, before redistribution. The collected inventory includes certifi, Torch and NumPy/SciPy obligations; it remains research evidence, without an adverse license conclusion, legal sign-off or final redistribution approval.

Exact OCR/model assets (URLs, bytes and SHA-256 in `model-assets.json`):

- Tesseract `tessdata_fast` CS/EN/OSD at commit `87416418657359cb625c412a48b6e1d6d41c29bd`: Apache-2.0; the TSV config is from Tesseract 5.5.0. [Upstream models](https://github.com/tesseract-ocr/tessdata_fast).
- Heron at `8f39ad3c0b4c58e9c2d2c84a38465abf757272d8`: Apache-2.0. [Pinned model card](https://huggingface.co/docling-project/docling-layout-heron/blob/8f39ad3c0b4c58e9c2d2c84a38465abf757272d8/README.md).
- Accurate TableFormer from Docling models v2.3.0, resolved commit `fc0f2d45e2218ea24bce5045f58a389aed16dc23`: CDLA-Permissive-2.0 according to that pinned card. [Pinned card](https://huggingface.co/docling-project/docling-models/blob/fc0f2d45e2218ea24bce5045f58a389aed16dc23/README.md). Do not substitute today's `main` license metadata.
- Native MarkItDown's Magika 1.0.3 ONNX assets are shipped in its distribution, whose metadata declares Apache-2.0, and included in package footprint/model hashes. Its missing retained notice remains part of R4. No hosted image model was used.

The packaged Magika model's exact hash is in `embedded-models.json`. Synthetic rendered fixtures use Noto Sans under OFL-1.1; its font hash and copied license are retained separately.

## Enforceable isolation and IPC proposal

The pilot tests fresh **restricted Docker job containers** with read-only root, UID/GID 65532, `--network none`, no capabilities/privilege gain, read-only single input/model mounts, CPU/memory/PID/file/time limits and no `/data`, S3 credentials or Docker socket. `isolation-probe.json` verifies inaccessible networking, absent app data/secrets/runtime socket, enforced cgroup values and an OOM-killed allocation. Docker's [resource controls](https://docs.docker.com/engine/containers/resource_constraints/) supply the hard budget. The harness includes a container kill on wall timeout, but forced timeout, descendant termination, cancellation and supervisor crash recovery were not demonstrated. Containers share the kernel; this is not a VM or an assertion of parser exploit immunity.

**R2 leaves the production worker boundary undecided.** A trusted host launcher under a **dedicated OS user using rootless Podman/OCI** is one proposal, not a demonstrated prerequisite or selected deployment mechanism. A **Compose-managed isolated worker** is a credible simpler option to evaluate, with no app data/credentials/runtime socket, denied parser network, hard container limits and bounded local IPC. Neither option was deployed here; whole-job termination, recovery/freshness and supervisor protection need proof before selection. The host-launcher option additionally needs an installation/upgrade/startup owner, rootless cgroup delegation and UID/socket checks, offline provisioning, restart/orphan cleanup and fail-closed availability on Compose and Dokploy. The next checkpoint should select and probe the boundary without adding a runtime admin socket or relaxing app hardening.

The following are proposed production contract requirements, not implemented behavior. The selected boundary would accept only a fixed versioned job descriptor and length-bounded byte stream, not commands, paths, images or arbitrary mounts. Niaro would reauthorize owner/generation and reserve capacity, supply attachment ID, attempt/generation, digest and limits, and bound spooled originals. The trusted worker side would independently verify length/hash and isolate private input/scratch plus read-only pinned code/models, using an empty allowlisted environment without S3/model/API credentials, Niaro data or parser network access to the app.

Return bounded versioned text/table/source evidence and warnings through a size-limited pipe/socket response; normalized preview bytes, if later included, need a separately capped framed result with parent-owned names/digests. Validate every length, enum, source index and returned byte type in the trusted parent. Do not trust parser-provided filesystem paths. The production sandbox should have **only quota-limited scratch writable** and stream results out, avoiding an unlimited writable output bind. The pilot serializes at most 2 MiB and caps each file, but its host `/out` bind does not enforce total bytes across arbitrarily many malicious files; this must be closed at task 5.1, not claimed solved by this research harness.

The production implementation must keep original/derivative S3 keys and database lineage under Niaro's ownership, recheck tombstones/attempt identity before publishing output, and discard obsolete work into durable deletion. Conversion must not start inference, grant action authority or save CRM data. Whole-job termination/reaping, scratch cleanup and app-crash/retry recovery of the existing durable attempt remain acceptance work. One running job is a proposal; queue/per-owner reservations, busy/failure states and global upload/retention quotas remain the A5 coordinator-owned decision.

## Next accepted checkpoint and gaps

The next checkpoint should revise and independently review A5–A7: consider the conditional MarkItDown/Tesseract preference, select and probe a worker boundary, decide the resource/default limits using aggregate coexistence evidence, define the versioned source/partial contract, and implement task 5.1's enforceable boundary, termination and bounded IPC. Then test the production mapper against this corpus, carrying the confirmed R1 mixed-page omission into acceptance, and expand numeric/date/formula/cache/merged/hidden-sheet, image-in-slide, ZIP expansion/embedded-resource, timeout, cancellation and crash/late-result cases. Exact structured field/cell values, wrong/extra values, table headers and source/omission coverage need separate acceptance evidence beyond F/T/R recall. R3 and R5 are documentation qualifications; R4's final redistribution packaging and R1–R2 production work remain open.

PNG/JPEG, PDF text/scans, DOCX, PPTX, multi-sheet XLSX, CSV/TSV, UTF-8 TXT/Markdown all have executable evidence; optional JSON is explicitly separate. This is small simple-layout coverage: XLSX fixture values are strings, slides contain text, and complex layout/embedded images are not claimed complete. HEIC/HEIF picker normalization, TIFF/WebP/multi-frame inputs, legacy Office, ODF and mail have **no verified support claim**. Some installed libraries advertise them, but they remain disabled/unadvertised pending fixtures. The mandatory initial set remains required even where fidelity or outcome coverage is incomplete.

No app/meeting peak headroom, real customer documents, UI/device capture, S3 ownership/deletion, CRM writes, production integration, final dependency approval or native hostile-parser audit was performed. Research narrows the implementation decision; it does not approve or implement it.
