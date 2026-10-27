# Meeting recording

The Meetings tab can start a manual recording without a calendar event. After
**Stop and process**, the client uploads audio to its pinned authenticated server
and workspace. The resulting record has three parts: one continuous complete
transcript, one compact unified meeting summary, and individual tasks arising from
the whole meeting. Important points are part of the summary. Minute chunks are
internal transcription checkpoints and source locations; they are not transcript
pages or independent meeting summaries.

Extraction uses a closed Mastra agent with no chat memory or business tools. Its
single structured call receives **all original transcript segments in order**,
with the meeting's title, local date and weekday, time zone and (when known)
attendees and companies. It writes structured notes: one summary, important
points, **decisions**, **action items** and **open questions**. An action item
is what the person recording still has to resolve or follow up on, such as
arranging the next meeting; another participant's own commitment counts only
when the person has to follow up on it. Each one has an `owner` ("me" for the
person recording, else the name as said), `due` (the deadline as said), a
`dueDate` the server resolves from it with the same calendar arithmetic as
`internal_datetime_resolve` (relative to the meeting's date in the workspace's
time zone; a local `YYYY-MM-DD`, or a local time with offset when a time was
said), `at` (seconds into the meeting of its first quote) and one or two
sentences of `context`. The model consolidates repeated mentions, applies
explicit later corrections/cancellations, and combines owner/deadline evidence
across segments. No CRM write or message is sent by meeting processing.

Every item keeps verbatim source quotes, checked tolerantly against the
original transcript. A quote is compared exactly, then after normalizing
Unicode, accents, case, whitespace, quote marks and dashes and removing
"Me:"/"Others:" speaker labels ("Já:"/"Ostatní:" in Czech; also in a neighbouring minute), then by the
most similar window of words in its own minute (similarity ≥ 0.85). A found
quote is replaced by the exact original words. A quote that cannot be found is
dropped; an item is dropped only when none of its sources is left. An owner or
deadline that appears in none of the item's quotes is cleared. None of this
fails the meeting. The model's raw answer is saved before this check, so a
retry never pays for the extraction again.

Action items are published directly as open items in [Tasks](human-tasks.md).
Each one's detail is its context (or first quote) and "From the meeting
"<title>" (<date>)."; a resolved deadline is saved as the item's `dueDate`.

From a ready meeting, explicitly select one open task to open a configured
process. In its form, map compatible fields from the summary, key points, the
complete unified meeting task list, the selected task with its source quotes, or
the full transcript. Choosing the task-list source is an explicit process input;
it does not merge the entries into one Human Task. Each human follow-up remains a
separate item in Tasks. Process setup and start are bound to the meeting digest
and the selected task's open revision. If the task is closed or its source
changes before preparation or execution, the server refuses the stale request.
Starting a process authorizes only that process run. External writes still need
the existing separate native action approval for the exact action revision;
neither transcript text nor resolving a task grants it.

A recording starts with a provisional "Meeting · date" title and the server
names it from the finished summary. The owner can rename it
(`PATCH /meetings/:id`); processing never replaces a name the person gave.

**Upload audio file** on the Meetings page (native app) brings in a recording
made elsewhere: M4A/MP4/3GP, MP3, WAV, OGG/Opus or WebM, at most 64 MB and two
hours (the web app also takes call videos; see [web app](#web-app)). The file is copied into the app's own recordings, gets the same
provisional title, and is uploaded and processed like a recording; a failed
upload stays under "On this device" for retry. The picker's temporary copy is
always deleted. The server decodes each type with its own explicit demuxer
(`mov`, `mp3`, `wav`, `ogg`, `matroska`); a file whose content does not match its
type fails visibly as `meeting_audio_invalid`.

## Web app

**Meetings** in the web app's sidebar (`/meetings`) lists the same meetings as
the app, newest first: name, date · length, the number of open tasks on the
right and a badge only for work in progress and failures. The search looks
in names, summaries and transcripts on the server (`?q=`, case and accents
ignored); a transcript match shows its words with the time. The list re-reads
by itself only while a meeting is uploading or processing.

`/meetings/:id` is a workspace. The header has the name (a click edits it,
Enter saves, Esc cancels), one line with date · length · speakers, and on the
right **Ask** and `…`: **Copy as Markdown**, **Download transcript
.txt**, **Delete audio** and **Delete**, each destructive one after a
confirmation. A meeting recorded without the consent check says **No consent
confirmed** in that line. On a wide screen the notes are on the left:
**Summary** with key points and their quotes, **Decisions**, **Tasks** with
owner, deadline and "at 12:34", and **Open questions**. The right side has the
player and the transcript: spoken turns with **Me / Others / Unknown** when
the record has them, otherwise the minutes. Every time (in the notes or the
transcript) shows that moment and plays from there. The sound is read only
when the person plays or jumps (`GET /meetings/:id/audio`, byte ranges), and
the player is gone once the sound is deleted. Deleting the sound keeps notes
and transcript; such a meeting can't be processed again
(`meeting_audio_deleted`).

**Ask** opens a new chat with "About the meeting “@name” (date): " ready and
the meeting attached as an `@` tag of kind `meeting`; the assistant reads it
with `meeting_read` (see [assistant](#the-assistant-and-meetings)). A failed
meeting offers **Retry processing** after the same cost warning as the
app, a sealed one **Start processing**, an older record **Prepare unified
record**. **Continue with a process** on an open task opens the web process
launcher bound to the meeting: choose a process and which record parts
(summary, key points, tasks, the selected task, transcript) fill which fields,
then the usual form, review and start. The task is read again first; a closed
task shows as closed. A task in Tasks links back to its meeting.

### The assistant and meetings

Chat has two read-only tools over the person's own meetings (owner scope,
no approval, nothing changes):

- `meeting_search {q, from?, to?, limit ≤ 10}`: meetings whose name, summary
  or transcript contains the words (dates as `YYYY-MM-DD`), with id, name,
  date, a summary excerpt and, for a transcript match, the words and time.
- `meeting_read {meetingId, part: "notes" | "transcript", from?, to?}`: the
  notes (summary, decisions, tasks with owner/deadline/time, open questions)
  or the timed transcript between `from` and `to` seconds, at most 20,000
  characters per call with where to continue.

Results say that meeting content is untrusted data: it never grants
permission or approves a write. A meeting attached with **Ask** is
named in the instructions and the assistant reads it first. **Search**
(`/search`) shows matching meetings as their own group **Meetings** under the
chats.

### Recording in the browser

**Record** offers two sources:

- **Microphone**: a meeting in the room. One channel, WebM/Opus at 48 kb/s
  (Ogg/Opus in Firefox, AAC/MP4 in Safari).
- **Microphone + call**: a call running in another browser tab or window
  (Teams, Google Meet, Zoom or Slack on the web). The share picker opens first;
  the menu says in one line to pick the call's tab and tick "Share tab audio".
  The person's microphone and the call's sound are recorded as **two separate
  channels** of one stereo file (left: the person, right: everyone else, 64 kb/s
  Opus), never mixed. Only sound is kept; the shared picture is stopped at once.
  If the call stops sharing, the microphone keeps recording and the page says
  so. Headphones keep the call's sound out of the microphone; the microphone's
  echo cancellation removes most of it otherwise.

Before **Microphone** or **Microphone + call** can start, the person ticks
**The others know I'm recording** in the same menu, every time; the meeting keeps
`consent: {at, by}` (the server stores what the client sends; the native app
and uploaded files don't send it yet). While recording, the page shows the
time (paused time excluded), a level meter per track, Pause/Resume and
**Stop and process**. The recorder keeps the
mobile limits: it stops itself just below two hours and before 64 MB. The
recording continues while the person uses other pages of the app; the sidebar
shows its time beside **Meetings**. On stop it uploads in the same 256 KiB
blocks as the app, seals and starts processing. A failed upload keeps the
recording under **Not sent yet** with progress, **Send again** (it
continues from the server's confirmed offset under the same id), **Save
file** and **Discard**. Like the chat caches, a recording lives only in the
page's memory: closing or reloading the page while recording or with an unsent
recording asks the browser's leave confirmation, and an unsent recording is
lost after leaving. Uploads only go to the account that recorded them.

**Add recording** brings in a recording made elsewhere: M4A/MP4/MOV/3GP,
MP3, WAV, OGG/Opus or WebM/MKV, including the video recordings Teams, Zoom,
Google Meet and Slack let you download. Video is fine: the server decodes only
the sound. A file over 64 MB in the MP4 family (a typical one-hour video) is
reduced in the browser to its sound track, copied without re-encoding, so only
the audio (tens of MB) is uploaded. Fragmented MP4s, other large videos and
sound tracks still over 64 MB are refused with "The file is larger than 64 MB";
export the audio first. Recordings over two hours fail on the server as
`meeting_audio_invalid`.

### Two-track recordings on the server

A two-track recording is created with `speakerChannels: "self-others"`. The
server requires exactly two channels (otherwise `meeting_audio_invalid`) and
transcribes each channel on its own; a silent channel costs nothing. With
timestamped transcription (below) both channels' timed segments are merged
into **utterances** in the order they started, each with speaker `me` or
`others`, so the transcript is turn by turn. Each minute's segment then has
one "Me: …" / "Others: …" ("Já"/"Ostatní" in Czech) line per change of
speaker. In the minute-by-minute fallback each channel of a minute is one
recognition, so a minute has one line per speaker, the one who spoke first in
that minute first. The whole-meeting extraction is told which label is the
person recording, so it can tell the person's own commitments from the
others' requests. "Others" is everyone in the call together, unless the
optional [speaker diarization](#speaker-diarization) tells their voices apart.

The `speakerChannels` field is new in `niaro-meetings/1`. A mobile app built
before it cannot read a list that contains a two-track meeting; update app and
server together.

A browser's MediaRecorder writes a WebM without a duration or seek index. The
server then copies the audio stream (no re-encoding) into a private working
file and measures and chunks that; the sealed upload and its digest never
change.

### Speaker diarization

Optional: a separate service, `services/diarizer`, tells the voices of a
recording apart, so the transcript reads "Speaker 1", "Speaker 2" ("Mluvčí 1"
in Czech) instead of one "Others". It runs the open
`pyannote/speaker-diarization-community-1` model (pyannote.audio 4, MIT code,
CC-BY-4.0 model) on the CPU next to the server; meeting sound never leaves the
machine.

- **Install.** The service is the compose profile `diarization` in
  `compose.yml` and `compose.dokploy.yml`. It needs a Hugging Face token
  (`HF_TOKEN`, read access) of an account that accepted the model's terms on
  its Hugging Face page; the model (about 30 MB) is downloaded once into the
  `diarizer-models` volume. `DIARIZER_TOKEN` is a shared secret: the service
  requires it as a bearer token and compose passes it to Niaro as
  `NIARO_DIARIZATION_TOKEN`. The image is about 2 GB (CPU PyTorch); give the
  container 4 GB (`DIARIZER_MEMORY`). Without the profile nothing is built or
  started, and removing the `diarizer` service from the file is safe.
- **Turn on.** Administration → Settings → Meetings → **Tell voices apart**,
  with the service's address (default `http://diarizer:8000`,
  `meetings.diarization` in the profile). The row shows whether the service
  answers and its model is loaded. A model that failed to download (terms not
  yet accepted, no network) is tried again every five minutes.
- **What it does.** After timestamped transcription the server extracts the
  diarized track as a 16 kHz mono WAV (a two-track recording: the others'
  channel only, since the person recording is already "Me"; otherwise the
  whole mix) and sends it to the service, one meeting at a time. Each turn of
  that track takes the voice that spoke most of its time, or the nearest one
  within a second; voices are numbered in the order they first speak, at most 20. Utterances keep `speaker` and gain `voice`; minute segments read "Me:
  …" / "Speaker 2: …". The minute-by-minute fallback has no turns and stays
  without voices.
- **Failures.** Diarization only adds detail: if the service is off,
  unreachable, still loading or fails, the meeting is finished without
  voices and the server logs "Meeting diarization failed". Turning it on
  applies to meetings processed from then on (reprocess a meeting to add
  voices to it).
- **Speed.** On a CPU an hour of sound takes a few minutes; `DIARIZER_THREADS`
  limits the cores (0 = all). Voices are numbers, not names.

### Recordings from Teams, Meet, Zoom and Slack

The assistant never imports these services' own transcripts; their audio goes
through the same transcription. Today that works by downloading the recording
from the service and adding it with **Add recording**, or by recording the call
in the browser.

Importing a recording directly from a connected service is not possible with
the current setup (checked October 2026):

- The Microsoft 365 service is the hosted `@softeria/ms-365-mcp-server` 0.156.2
  with the `calendar,mail` presets. Its sign-in requests only
  `Calendars.ReadWrite Mail.ReadWrite Mail.Send`.
- No Google Drive or Google Calendar service is configured.
- A service action's result is limited to 64 KB (12 MB transport limit), so
  recording bytes can't travel through a service action anyway.

What it would take for Teams:

1. Run the hosted server with `--org-mode` and the `teams` and `files`
   presets, rediscover and enable the read actions `list-online-meetings`
   (finding a meeting by its calendar `joinUrl`), `list-meeting-recordings`,
   `get-meeting-recording`, and for OneDrive "Recordings" `list-folder-files` /
   `search-onedrive-files` and `get-download-url`.
2. Delegated Graph permissions `OnlineMeetings.Read`,
   `OnlineMeetingRecording.Read.All` (meeting recordings) and/or `Files.Read`
   (recordings saved in the person's OneDrive), with tenant admin consent;
   people reconnect Microsoft 365 afterwards. `CallRecords.Read.All` is
   application-only and not needed.
3. A server endpoint that lists recordings through the person's own connection
   (`CatalogController.invoke`) and then streams the file itself: from
   `get-download-url`'s short-lived URL for OneDrive files, or from Graph's
   `…/recordings/{id}/content` with the person's token. It must stream with a
   size limit, extract the audio with ffmpeg and feed the existing upload
   pipeline. Nothing streams a service file today.

For Google Meet the equivalent is a Google Drive service with `drive.readonly`
(Meet saves recordings to "Meet Recordings" in the organizer's Drive), and the
same streaming endpoint. Zoom and Slack would need their own services
(Zoom `cloud_recording:read`, Slack `files:read`).

### Live meeting bot (design only)

Two-track browser recording separates the person from everyone else. Separate
audio per participant, and calls the person doesn't run in a browser, need a
bot that joins the call. Nothing of this is built or signed up for.

- **Provider.** A meeting-bot API (Recall.ai or similar) joins Zoom, Teams,
  Meet and Slack huddles as a visible participant and delivers separate audio
  per participant, either streamed live (websocket) or as files after the
  call, with participant names from the platform. Building our own bot would
  mean a headless client per platform (Zoom Meeting SDK, Teams media bots on
  Azure, Meet's limited Media API), which is not realistic here.
- **Flow.** The person picks a calendar event with an online meeting (the
  calendar already gives the join URL) and asks the assistant to attend; the
  server creates the bot with the join URL and a per-meeting webhook secret.
  Webhooks report joining, waiting room, recording permission and the end of
  the call. Per-participant audio comes in as separate tracks; each track is
  stored like a meeting upload and transcribed per chunk with the speaker's
  name, so the transcript is turn by turn. Processing, tasks and processes
  stay as they are.
- **Needs.** A provider account and API key stored like other service
  credentials; a public HTTPS webhook (the server's public origin) verified by
  signature; per-workspace enablement and a budget (providers bill per bot
  hour, on top of our own STT; check current prices before enabling); retention so
  the provider deletes media after delivery; and a data-processing agreement,
  since call audio leaves the server.
- **Consent.** The bot joins under a clear name ("Assistant – recording"), the
  platform shows its recording notice, the host may have to admit it, and the
  person starting it confirms that the participants agreed. A meeting with
  external participants should require an explicit confirmation each time.

## Native application

Run `pnpm android` or `pnpm ios` to rebuild the development client after this
change. A JavaScript reload cannot add native background recording permissions.
Android requires microphone and notification permission. iOS requires microphone
permission and the audio background mode. The recorder writes mono AAC at 64 kbps
into the native documents directory; it stops natively before two hours. Only an
explicit Record action can open the microphone.

A recording can be paused and resumed in the app. Paused time is not recorded or
counted toward the two-hour limit; the microphone and file stay with the meeting,
and Stop still saves it. On Android the recording shows a notification "Recording
a meeting" with its elapsed time and Pause/Resume and Stop buttons, also on the
lock screen without unlocking. The local module `modules/meeting-notification`
replaces expo-audio's generic foreground-service notification (same id) on its
own silent channel "Meeting recording". Its buttons only ask the app to act, so
Stop there saves and uploads the meeting exactly like Stop in the app. A failed
notification never stops a recording. iOS shows its own recording indicator.

Device QA without a server: `MEETING_RECORDER_QA=1` serves
`spikes/meeting-recorder` instead of the app (see its README). On the Android 37
emulator a recording kept running for 90 s with the screen off and Doze forced;
pause, resume and stop worked from the PIN-locked lock screen; paused time was
excluded; a recording killed while paused was recovered with its exact length.
`ffprobe` confirmed the files (AAC mono 44.1 kHz, 64 kb/s). OEM battery savers
on physical phones are not covered by the emulator.

The device saves a destination-scoped recovery journal before starting capture.
Navigation between tabs keeps recording active. Switching the authenticated
connection interrupts capture and never sends the old recording to a new account.
Interrupted files stay available for recovery, playback, upload, or explicit
deletion. Upload failures keep the same asset ID. Playback shares the audio owner
with voice requests and stops when the app leaves the foreground.

## Server artifacts and recovery

The separately versioned `niaro-meetings/1` interface exposes list/detail, create,
binary blocks, seal, process, full record (`/<meeting-id>/record`), and delete under `/v1/<workspace>/meetings`,
plus rename (`PATCH /<meeting-id>`), the sound (`GET /<meeting-id>/audio`,
`Range` supported) and its deletion (`DELETE /<meeting-id>/audio`, ready
meetings only). The list takes `q` (at most 200 characters; adds `matches`)
and `include=tasks` (adds `openTasks` per meeting); without them it is
unchanged. The optional meeting fields `consent` and `audioDeletedAt` are new:
like `speakerChannels`, an app built before them can't read a list that has
them, so update app and server together. Every
operation uses the existing device authentication and full connection/server/
workspace/user scope. Each upload block is at most 256 KiB. Replaying a confirmed
block requires identical bytes. Sealing requires the complete file and calculates
an immutable SHA-256 digest. Limits are 64 MiB per asset, 100 recordings / 512 MiB
per scope, 1,000 assets total, two processing jobs at once, and two hours of audio.

Raw audio resides in the private identity data directory under `meeting-audio`
with private file permissions. The identity SQLite database holds metadata,
confirmed block hashes, independently committed transcript excerpts, saved
transcription chunks, utterances, and a whole-record inference checkpoint (the
model's raw answer). Back up the whole identity directory, including audio,
together with the existing workflow and native Mastra databases. Explicit
deletion removes the active audio and its derived artifacts; existing
operational backups follow their own retention.

### Audio retention

The sound of a meeting counts toward the per-person cap (512 MiB) until it is
deleted; transcripts, records and tasks never count. Once a meeting is Ready,
its sound is kept for `administration.identity.meetings.audioRetentionDays`
days (default 30; `0` keeps it forever). A sweep at server start and then
daily deletes older sound of Ready meetings (measured from when they became
Ready) and marks the meeting `audioDeletedAt`; the transcript, utterances,
record and tasks stay. A meeting without its sound cannot be transcribed
again (`meeting_audio_deleted`); preparing a record from a complete
transcript still works.

### Transcription pipeline

Speech-to-text uses the workspace's catalog model and the OpenRouter
provider:

- **Timestamped (preferred).** When the workspace's voice model is a
  speech-to-text model (Direct transcription), or **Model choice → Voice
  input → Meetings** names one (`meetingTranscriptionModelId`, a catalog model
  of kind `transcription`, for example `openai/gpt-4o-transcribe`; check what
  OpenRouter currently lists), the server sends chunks of 5 minutes
  (`meetings.chunkSeconds`, 120–600) with 2 s of overlap to
  `POST /api/v1/audio/transcriptions` with `response_format: "verbose_json"`
  (segment timestamps; word timestamps are used when returned) and
  `provider: { zdr: true, data_collection: "deny" }`. Only zero-data-retention
  endpoints that do not collect data are used; if the model has none, the
  request fails rather than dropping the flags. Each request carries a short
  `prompt`: the meeting's title, attendee and company names when known, the
  server's `meetings.glossary` and the last ~200 characters of the previous
  chunk when that one is already transcribed. A provider that refuses the
  prompt or timestamps (HTTP 400) is asked again without them; without
  timestamps a chunk is one turn. Chunks are FLAC (MP3 at 64 kb/s if FLAC is
  too large), each request at most 12 MB (OpenRouter takes 25 MB) and 60 s.
  Up to three chunks of a meeting run at once. Each finished chunk is saved,
  so a retry pays only for missing ones. Chunks are stitched by their
  timestamps: segments and words in time already covered by the previous
  chunk are dropped, and repeated words at a seam are removed. The result is
  the meeting's **utterances** (`{start, end, speaker, text}`, speaker `me`,
  `others` or `unknown`, at most 6,000) and the detected language when the
  provider says it.
- **Minute by minute (fallback).** Otherwise each sixty-second chunk goes
  through the workspace's voice transcriber (the chat-completions interpreter
  or the legacy server profile), as before.

Both produce the same sixty-second minute segments, which the record, quotes
and older clients use; with timestamps they are derived from the utterances
(an utterance belongs to the minute it starts in). A minute that is digital
silence is never sent: a chunk's silent minutes at either end are trimmed,
and an all-silent chunk costs nothing. An explicit no-speech result is
preserved as an empty excerpt. A transcriber length limit fails visibly
rather than truncating the transcript. Uncertainty/repetition flags remain
visible.

**Concurrency and retries.** Meeting chunks and chat voice share one fair
speech queue (4 slots). Chat voice always goes first and meeting chunks may
hold at most 3 slots, so dictating a message during processing waits briefly
instead of failing as busy (only more than 16 waiting chat requests are
refused with `voice_busy`). A chunk that fails as busy, rate limited (429), a
server error (5xx) or a timeout is tried again after 1 s and 4 s; the third
failure fails the meeting as `meeting_transcription_failed`.

**Costs.** Timestamped transcription with `openai/gpt-4o-transcribe` costs
about $0.36 per hour of speech at list price, `gpt-4o-mini-transcribe` about
half; with silence trimming and one record extraction a typical meeting comes
to roughly **$0.25 per hour**. Check current OpenRouter prices before
enabling. A two-track recording pays for each channel's speech separately.

Server settings, all optional (owners and administrators can change them in
administration → Settings; the profile's values are the defaults):

```json
"administration": {
  "identity": {
    "meetings": {
      "audioRetentionDays": 30,
      "chunkSeconds": 300,
      "glossary": ["Niaro", "Acme s.r.o."]
    }
  }
}
```

A meeting may carry `attendees` (up to 30 names) and `companies` (up to 10)
from its client; both only help the transcriber spell names.

The `niaro-meeting-record/2` projection always returns the entire saved
transcript in one string, and for a meeting transcribed with timestamps its
`utterances` and `detectedLanguage`. Its `analysis` has `version: 2` with
`decisions`, `openQuestions` and per-task `owner`, `dueDate`, `at` and
`context`; records made before have none of these and still read the same
way (`assignee`, `due` and every older field stay), and a `/1` record still
parses. Its completeness flag requires positive duration and contiguous
segment time coverage through the final audio interval. Non-silent recognition
failure cannot be converted into confirmed silence; only explicit trusted
no-speech evidence can save an empty interval.

The transcript reader offers a reversible reading view that tidies spacing and
removes common non-lexical fillers and obvious adjacent stutters without
intervening punctuation. It preserves meaningful repetition, including
negation, affirmation, emphasis, and corrections separated by punctuation. It
does not rewrite the stored transcript or evidence quotes; users can switch back
to the original at any time. More ambitious language-model editing remains
separate work because it could alter meaning or break source attribution.

Task rows are conservatively reconciled after source validation: only matching
text, exact assignee and deadline, and overlapping source evidence can merge.
The merged citation list must fit the four-source contract; otherwise the rows
stay separate so evidence is never dropped. Text cleanup is limited to Unicode
normalization, whitespace, and case for matching. Existing published records are
not rewritten. The Tasks card shows a source excerpt and links back to the full
meeting, where every citation remains available.

Whole-record synthesis is bounded to 1,000,000 input characters, 80 tasks, 40
decisions, 40 open questions and 96,000 structured output characters (the provider's own context/output/budget
limits also apply). The complete source is never shortened to fit these limits.
That one model call may run for up to 15 minutes and send up to 4 MiB; other
model calls (chat, processes, designer) stop after 110 seconds, before the phone
stops waiting. A provider call that runs out of time fails as
`integration_timeout`; `integration_cancelled` means the caller stopped waiting
(a closed request or an interruption).
A failure preserves the transcript, publishes no partial list of open items, and
shows a processing error. Unknown assignees and deadlines stay unspecified.

The checkpoint key covers the complete input, immutable audio digest, algorithm
version and configured model/provider identity and revisions. Record publication,
all open items, and Ready status share one transaction. Publication retry
reuses a committed model result and cannot reopen or reset later decisions.
Model calls use the existing provider allowance and inference budget ledger; STT
uses the existing voice provider allowance. Paid calls with lost results are
never automatically replayed on boot. After interruption, an explicit retry may
repeat a charge for an uncommitted result. Saved transcripts are reused.

Older Ready recordings without a unified record show their complete transcript
and an explicit **Prepare unified record** action. Neither reading them nor
starting the server runs a model or silently migrates their analyses.

## Verification and remaining acceptance

`pnpm test:meetings` exercises durable uploads, two-track and live-WebM
recordings, video files, scoped access, dropped replies,
server restart, disk-audio normalization, native Mastra extraction with synthetic
provider replies, silence, partial recovery, and mobile capture/view contracts.
`NIARO_PLAYWRIGHT_MODULE=<installed-playwright/index.mjs> node --import tsx
scripts/meetings-web-qa.mjs` renders EN/CS meeting views at mobile and desktop sizes.
These fixtures do not record real participants or call paid providers.

Physical acceptance remains open: Android/iOS start/stop,
notification permission, screen lock/background, phone interruption, force-stop
recovery, unstable upload, storage exhaustion, and an actual sixty-minute meeting.
Also validate transcription/extraction quality with a consented recording. Speaker diarization is optional (see Speaker diarization); validate it on a consented recording with several remote participants. Naming the voices is a separate improvement.
