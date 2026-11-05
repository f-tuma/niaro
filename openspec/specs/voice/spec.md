# voice Specification

## Purpose

Voice lets a person using the phone app speak a chat request or an answer to the assistant's question instead of typing it, and optionally hear the assistant's reply read aloud, while the server keeps transcripts as untrusted text that never acts on its own.

## Requirements

### Requirement: Voice is a phone app function

Voice requests and spoken replies SHALL be offered by the phone app. The web app SHALL NOT offer voice input or spoken replies. When the server has no transcriber or speech model, the app SHALL keep text input usable.

#### Scenario: Server without voice

- **WHEN** the connected server reports voice as disabled
- **THEN** the app shows voice as unavailable and text input works as before

### Requirement: Voice input capabilities

The server SHALL report voice input at authenticated `GET /v1/{workspace}/voice` as profile `agent-voice/5` with `enabled`, the engine and model, where audio is processed (`connected_server` for the local engine, `cloud` otherwise), the languages `en` and `cs`, and a maximum of 120 seconds. A cloud engine SHALL name the model of the voice input role or of the server profile's configuration; no model is built in.

#### Scenario: Cloud transcription disclosed

- **WHEN** the workspace's voice input role has a cloud model
- **THEN** the capabilities say `processing: "cloud"` and name the model

#### Scenario: Server profile without a model

- **WHEN** the server's own cloud voice profile has no configured model
- **THEN** voice input through it is unavailable

### Requirement: Spoken reply capabilities

The server SHALL report spoken replies at authenticated `GET /v1/{workspace}/voice/speech` as profile `agent-speech/1` with `enabled`, the model, `processing: "cloud"` and a maximum text length of 2,000 characters.

#### Scenario: No speech model

- **WHEN** the workspace has no speech model
- **THEN** spoken replies are reported with `enabled: false`

### Requirement: Capture

Recording SHALL start only when the person taps the microphone in the composer and microphone permission is granted. Capture SHALL stop on detected speech followed by 1.8 seconds of quiet, on Done, or at the 120-second maximum. Speech detection SHALL adapt to the ambient noise floor, and missing level readings MUST NOT count as silence. Ten seconds without speech SHALL discard the recording.

#### Scenario: Nothing said

- **WHEN** the person taps the microphone and says nothing for ten seconds
- **THEN** the recording is discarded and nothing is sent

### Requirement: Capture interruption

Starting a voice request SHALL interrupt the person's pending request. Cancel, leaving chat, changing the question, backgrounding the app or losing the connection SHALL stop capture and discard the draft.

#### Scenario: App backgrounded

- **WHEN** the app goes to the background while recording
- **THEN** capture stops and the draft is discarded

### Requirement: Transcription request

`POST /v1/{workspace}/voice/transcriptions` SHALL accept a strict JSON body with profile, requestId, language (the interface and review locale), a context (a conversation, or a question identity of conversation, work item, input request and expected revision), audio `{mimeType, base64}` of WAV, MP4/AAC or WebM up to 8 MiB decoded, and an optional `stopReason` (`user`, `silence`, `limit`). Unknown properties SHALL be refused.

#### Scenario: Unsupported format

- **WHEN** the audio's MIME type is not WAV, MP4/AAC or WebM
- **THEN** the request is refused before transcription

### Requirement: Transcription result

The transcriber SHALL detect the spoken language from the audio and keep it without translation; the request's language MUST NOT constrain it. The answer SHALL echo the authenticated scope, requestId, language and context with the text (at most 4,000 characters) and its review reasons.

#### Scenario: Czech speech in an English interface

- **WHEN** a person with an English interface speaks Czech
- **THEN** the transcript is Czech text

### Requirement: Context checked around transcription

The server SHALL check authentication, conversation ownership and, for a question, that the question is still open at the expected revision with its work item waiting for input, both before transcription and again before answering. Disconnecting or cancelling SHALL abort the request.

#### Scenario: Question answered elsewhere

- **WHEN** the question is answered on another device while its voice reply is transcribed
- **THEN** the server answers `409 voice_context_changed` and no transcript is returned

### Requirement: Transcripts are data only

Transcription MUST NOT run a command, create an event or receipt, answer a question or approve anything. Only text the app then sends as an ordinary chat message or question answer SHALL enter the conversation, and approvals SHALL stay separate actions.

#### Scenario: Spoken approval

- **WHEN** a person says "yes, approve it" while an approval is pending
- **THEN** the transcript is sent as a message and the approval still requires its own explicit action

### Requirement: Conditional review

A transcript without review reasons SHALL be sent automatically. A transcript flagged `uncertain`, `repetition` or `limit` SHALL be shown for editing and sent only on Send text. A recording that hit the 120-second limit SHALL always be flagged `limit`, and a transcriber that returns text without quality evidence SHALL always be flagged `uncertain`. Repetition SHALL be flagged when, with at least six words, fewer than 60% of word triples are unique.

#### Scenario: Clear request

- **WHEN** a short request is transcribed with no review reasons
- **THEN** it is sent as a message without review

#### Scenario: Recording limit

- **WHEN** capture stopped at 120 seconds
- **THEN** the transcript waits for the person to review and send it

### Requirement: Speech filtering before paid transcription

Before a cloud transcription request, the server SHALL detect speech locally; audio without detected speech SHALL be refused with `voice_empty` without a provider request. Empty or non-lexical results SHALL also be `voice_empty`. Cloud transcription SHALL request zero-data-retention endpoints that do not collect data where the provider supports it, and send only the audio and a transcription prompt, never conversation history or business data.

#### Scenario: Background noise only

- **WHEN** a recording contains only noise or a tone
- **THEN** the server answers `voice_empty` and makes no paid request

### Requirement: Transcription failures

Voice errors SHALL use stable codes: `voice_unavailable` when no transcriber is configured, `voice_busy` (429) when more than 16 chat voice requests already wait, `voice_model_limit` when the provider allowance is exhausted, `voice_processing_failed` for a failed or malformed provider answer, and `voice_cancelled` when aborted. A failed transcription SHALL allow an explicit retry.

#### Scenario: Provider allowance exhausted

- **WHEN** the provider's request allowance is used up
- **THEN** transcription fails with `voice_model_limit`

#### Scenario: Sent and refused

- **WHEN** a spoken message is sent and the server refuses it
- **THEN** the chat shows it as a failed message with Try again and the composer stays empty

### Requirement: Failed transcript stays in its chat

A transcript that could not be sent at all SHALL stay for review; one that was sent and then failed SHALL stay in its chat as a failed message with Try again and SHALL NOT be put into the composer.

#### Scenario: Sent transcript refused

- **WHEN** a transcript was sent and the server refused it
- **THEN** it stays in its chat as a failed message with Try again and the composer stays empty

### Requirement: Voice before meetings

Chat voice SHALL share the speech queue with meeting transcription (see `meetings`) and go first, so dictation waits briefly for a slot instead of failing as busy.

#### Scenario: Meeting processing in progress

- **WHEN** a person dictates while meetings are being transcribed
- **THEN** the dictation is transcribed ahead of waiting meeting chunks

### Requirement: Spoken replies

When spoken replies are on in the app's voice settings and the workspace has a speech model, the app SHALL read aloud the assistant's reply to a voice request sent in the foreground. Another device's replies and history SHALL NOT be read automatically.

#### Scenario: Reply to a voice request

- **WHEN** spoken replies are on and the assistant answers a voice request
- **THEN** the app plays the reply's audio

### Requirement: Speech synthesis request

`POST /v1/{workspace}/voice/speech` with `agent-speech/1`, requestId, conversationId, messageId and language SHALL synthesize only an existing assistant message of that conversation with at most 2,000 characters and answer WAV or MP3 audio with the authenticated scope.

#### Scenario: Message changed

- **WHEN** the message is not an assistant message of that conversation or its text changes during synthesis
- **THEN** the server answers `409 speech_context_changed` and no audio is returned

#### Scenario: Too long

- **WHEN** the reply is empty or longer than 2,000 characters
- **THEN** the server answers `413 speech_too_long`

#### Scenario: Busy

- **WHEN** the same person already has a synthesis running, or eight are running on the server
- **THEN** the server answers `429 speech_busy`

### Requirement: Verbatim reading

A spoken reply MUST read the text as written. When the speech model reports what it spoke, the server SHALL compare it with the text (added numbers are never accepted) and SHALL retry once and then refuse with `speech_unavailable` rather than play a paraphrase. An endpoint without zero data retention SHALL be refused with `speech_privacy_unavailable` when zero data retention is required.

#### Scenario: Paraphrased audio

- **WHEN** the speech model speaks a different number than the reply text contains, twice
- **THEN** no audio is played and the reply stays as text

### Requirement: Reply playback timing

An automatically read reply SHALL hold its text until audio actually starts, for at most 8 seconds from the accepted reply. If audio does not start in time the app SHALL show the text, allow manual playback, and MUST NOT start the late audio. Stop, navigation, backgrounding, changing preferences, a replacing response or a session change SHALL cancel playback.

#### Scenario: Slow synthesis

- **WHEN** synthesis takes longer than 8 seconds
- **THEN** the reply text is shown and the audio does not start by itself afterwards
