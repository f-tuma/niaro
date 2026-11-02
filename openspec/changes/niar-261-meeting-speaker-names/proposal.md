# Proposal

Tracker: **NIAR-261**

## Why

After diarization a transcript reads "Speaker 1 … Speaker 8". People know who spoke and want the meeting to say so: in the transcript, in the notes and in what the assistant reads. The person recording is usually one of those voices too; on a single-track recording nothing tells their turns apart from anyone else's, so "Me" and their tasks stay unattributed.

Two problems had also kept diarization from showing anything useful: the diarizer call gave up after five minutes (fetch's header timeout) while a 24-minute meeting needs about six on the CPU, and the transcriber (gpt-4o-transcribe) times text only per minute-long piece, so each piece took the voice of whoever spoke most of it.

## What Changes

- The owner names a diarized voice on the web (click its label); the name replaces "Speaker N" everywhere in that meeting: transcript, summary, points, decisions, tasks and their owners, open questions, the Markdown copy and the assistant's view. Mobile shows the names.
- "This is me" marks a voice as the owner's own; it reads "Me".
- With "This is me", the owner can also choose "Recognize my voice in later meetings": the server cuts up to 90 s of that voice's turns from the meeting's sound, the diarizer returns its fingerprint (embedding), and the server keeps it for that person only. Later single-track meetings ask the diarizer for each voice's fingerprint, compare them with the person's in memory and label the clearly matching voice "Me". The person can forget their fingerprint at any time.
- The diarizer returns per-voice embeddings on request (`embeddings=1`) and fingerprints one voice (`POST /embed`).
- A long turn splits at sentences where the diarized voice changes (sentences timed by their place in the text).
- The diarizer and converter calls use one node:http POST without fetch's five-minute limit.

## Privacy

A voice fingerprint is biometric data used to identify a person. It is kept only on the person's explicit choice, only for that person, never for other participants (their fingerprints are compared in memory and dropped), and is deleted on request. It never leaves the server; the diarizer is local.

## Non-goals

- Naming voices from the mobile app (shown there, set on the web).
- Renaming owners in Tasks already created from a meeting.
- Recognizing other people across meetings.
- Recognizing the owner on two-track recordings, where their own channel already says "Me".
