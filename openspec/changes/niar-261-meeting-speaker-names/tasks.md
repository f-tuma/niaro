# Tasks

## 1. Diarizer

- [x] 1.1 `embeddings=1` on `/diarize` returns unit-length per-voice embeddings; `POST /embed` fingerprints the voice that speaks most in a WAV.
- [x] 1.2 Calibrate on a Czech council recording: own voice 0.91–0.96 across halves, others at most 0.58; threshold 0.75 with a 0.15 lead.

## 2. Server

- [x] 2.1 `voiceNames` and `selfVoice` on a meeting; `POST meetings/:id/speakers`; `GET`/`DELETE meetings/voice-profile`.
- [x] 2.2 `niaro_voice_profile` per owner; enrolment cuts up to 90 s of the voice's turns with ffmpeg and calls `/embed`; at least 10 s of speech.
- [x] 2.3 Single-track processing asks for embeddings when the owner has a fingerprint and labels the matching voice "Me" before the record is made.
- [x] 2.4 Long turns split at sentences by diarized voice; bounded by the record's turn limit.
- [x] 2.5 Diarizer and converter POSTs without fetch's header timeout.

## 3. Clients

- [x] 3.1 Web: speaker labels open a naming dialog with "This is me", "Recognize my voice" and "Forget my voice"; names in notes, transcript, Markdown copy.
- [x] 3.2 Mobile: names shown in the record view.
- [x] 3.3 Assistant meeting tools read names.

## 4. Verification

- [x] 4.1 `tests/meeting-voices.node.ts`; existing meeting, diarization and web meeting suites.
- [x] 4.2 Dev server: two excerpts of a real recording; naming, "This is me" with fingerprint, the second excerpt labels the owner "Me", forgetting deletes the fingerprint.
