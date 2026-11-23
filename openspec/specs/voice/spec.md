# voice Specification

## Purpose

Voice lets a person using the phone app speak a chat request or an answer to the assistant's question instead of typing it, and optionally hear the assistant's reply read aloud, while the server keeps transcripts as untrusted text that never acts on its own.

## Requirements

### Requirement: Voice is a phone app function

Voice requests and spoken replies SHALL be offered by the phone app. The web app SHALL NOT offer voice input or spoken replies, but SHALL offer the person's output-voice preference editor at `/me`. When the server has no transcriber or speech model, the app SHALL keep text input usable.

#### Scenario: Server without voice

- **WHEN** the connected server reports voice as disabled
- **THEN** the app shows voice as unavailable and text input works as before

#### Scenario: Web changes the person's output voice

- **WHEN** the person opens `/me` in the web app
- **THEN** they can edit their own supported output-voice preference for the selected workspace without enabling browser voice input or playback

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

An automatically read reply SHALL hold its text until audio actually starts, for at most 8 seconds from the accepted reply. If audio does not start in time the app SHALL show the text, allow manual playback, and MUST NOT start the late audio. Stop, navigation, backgrounding, turning spoken replies on or off, a replacing response or a session change SHALL cancel playback. Saving only a personal output voice SHALL affect the next requested synthesis without stopping or restarting current playback.

#### Scenario: Slow synthesis

- **WHEN** synthesis takes longer than 8 seconds
- **THEN** the reply text is shown and the audio does not start by itself afterwards

#### Scenario: Output voice changed during playback

- **WHEN** the person saves another output voice while audio is already playing
- **THEN** that audio continues with its original voice and no replacement synthesis starts automatically

### Requirement: Personal output voice editor

The phone app's own settings and the web app's `/me` page SHALL offer a text-labelled output-voice preference for the authenticated person in the selected organization/workspace. Both editors SHALL offer Server default and only server-advertised alternatives. They SHALL show loading, unavailable, unsupported, save-error and conflict states with EN/CS text and accessible labels.

#### Scenario: Same person on two surfaces

- **WHEN** a person saves an advertised output voice in mobile settings and opens web `/me` for the same organization/workspace
- **THEN** the web editor shows that acknowledged saved choice and its current effective voice

#### Scenario: No alternatives verified

- **WHEN** the current route has no reviewed output-voice catalogue
- **THEN** both editors show Server default and a concise explanation, without an inert alternative picker or invented options

#### Scenario: Speech unavailable

- **WHEN** the workspace has no usable speech route
- **THEN** the editors report speech unavailable, keep text usable and permit clearing a stale choice to Server default

#### Scenario: Both mobile voice capabilities disabled with stale choice

- **WHEN** actual VoiceSettings has both input and speech capabilities disabled and receives a supported output-settings snapshot with stale saved catalogue intent
- **THEN** its output editor remains reachable independently of the combined unavailable-services branch and Reset clears that saved intent to Server default without any provider call

### Requirement: Output editor immediate save lifecycle

The mobile picker SHALL start one save on a different option tap without extra confirmation, stay open with choices disabled and retain acknowledged state until same-scope success applies its snapshot and closes it. Failure SHALL keep it open with prior selection and contextual error. The web Select SHALL save on value change, retain acknowledged state and disable changes until success, using its normal popup lifecycle.

#### Scenario: Immediate mobile option save

- **WHEN** the person taps a different advertised option in the mobile picker
- **THEN** exactly one settings POST starts without extra Save confirmation, the picker stays open with choices disabled and its prior acknowledged display until same-scope success applies the returned snapshot and closes it

#### Scenario: Mobile save fails

- **WHEN** the option-tap save fails
- **THEN** the picker stays open with the prior acknowledged selection and a concise contextual error, without showing optimistic success

#### Scenario: Web selection save

- **WHEN** the person changes the web Select to another advertised option
- **THEN** one POST starts without extra Save confirmation, the popup follows its normal lifecycle, and the field disables changes and retains acknowledged state until same-scope success applies its returned snapshot or failure shows a contextual error with the prior selection

#### Scenario: Web reset with default already effective

- **WHEN** a stale saved catalogue choice falls back to Server default already displayed by the web Select
- **THEN** a concise explicit Reset action is reachable without relying on a Select value-change event, uses the same save lifecycle and disappears once the stale intent is cleared, without an always-duplicate button or permanent helper prose

### Requirement: Output preference has no audio side effect

Opening, selecting or saving an output-voice setting SHALL NOT record audio, synthesize a preview, discover provider capabilities, send a workflow command, change input transcription, toggle spoken replies or change model/provider routing. A saved choice SHALL be used only by the next independently requested speech synthesis.

#### Scenario: Person saves a choice

- **WHEN** the person taps a text-labelled mobile catalogue option or changes the web Select
- **THEN** only the personal preference is saved and there are no synthesis, preview, recording or provider-discovery calls

### Requirement: Output preference resource negotiation

Personal output settings SHALL use authenticated GET/POST `/v1/{workspace}/voice/output-settings?profile=agent-output-voice/1`. The server SHALL reject missing or unsupported query profiles with 406 `output_voice_profile_unsupported`. Clients SHALL discover support by GET before POST and SHALL distinguish unsupported preferences from authentication, network and malformed-response failures.

#### Scenario: Old server

- **WHEN** the preference resource returns 404 or profile-specific 406
- **THEN** the new client treats only the preference feature as unsupported and retains existing speech capability/playback behavior

#### Scenario: Expired authentication

- **WHEN** the preference read returns 401 or 403
- **THEN** the client follows existing authorization handling and does not report the preference feature as unsupported

### Requirement: Legacy speech compatibility

The existing `agent-speech/1` capabilities, synthesis request and synthesis result SHALL retain their exact strict field sets and limits. The new personal catalogue and preference fields SHALL appear only on the explicitly negotiated settings resource. Synthesis clients SHALL NOT supply arbitrary voice, model, provider or source-text fields.

#### Scenario: Old strict client reads speech capabilities

- **WHEN** an existing client reads `voice/speech` from the updated server
- **THEN** its original strict `agent-speech/1` schema accepts the unchanged response shape

#### Scenario: Injected speech voice

- **WHEN** a speech request includes an additional raw voice or provider field
- **THEN** the server rejects the payload before provider dispatch

### Requirement: Bounded personal settings contract

The negotiated resource SHALL return the authenticated scope, personal revision, catalogue revision, route identity, availability, current Server default label, at most 32 labelled opaque options, saved intent and effective choice with a fallback reason. Updates SHALL accept only profile, mutation requestId, expectedRevision, catalogueRevision and a default-or-opaque-option choice; unknown fields SHALL be refused.

#### Scenario: Removed saved option

- **WHEN** a previously saved option is no longer available
- **THEN** the resource distinguishes the stale saved label from effective Server default and reports `saved-choice-unavailable`

#### Scenario: Client supplies a different actor

- **WHEN** a settings update includes an organization, workspace, actor, scope or raw provider voice target in its body
- **THEN** the strict payload is refused and no preference is changed

### Requirement: Personal output preference isolation

Output preferences SHALL persist under organization, workspace and authenticated user identity and SHALL be readable/writable only by that user under current workspace authorization. Owner and administrator roles SHALL NOT grant access to another person's preference. Signing out or switching account/workspace SHALL discard client display ownership and in-flight completions, without copying preferences between identities.

#### Scenario: Another member

- **WHEN** another member of the same workspace opens their own settings
- **THEN** they see their own preference or Server default and cannot read or change the first person's choice

#### Scenario: Organization membership removed

- **WHEN** the person's organization membership is deleted and they later rejoin
- **THEN** that membership's saved output preference is gone and the editor starts from Server default

#### Scenario: Workspace access revoked

- **WHEN** workspace membership is revoked while a settings request is outstanding
- **THEN** further access is refused and any late completion cannot update another active identity's editor

### Requirement: Output preference conflict and uncertainty

A settings save SHALL validate current personal and catalogue revisions before committing. Stale personal revision SHALL return 409 `output_voice_conflict`; stale catalogue SHALL return 409 `output_voice_catalogue_changed`; an unadvertised well-formed option under the current catalogue SHALL return 422 `output_voice_choice_unavailable`. Failed or uncertain saves SHALL NOT be shown as acknowledged or automatically replayed.

#### Scenario: Concurrent devices

- **WHEN** a second device saves from an older personal revision
- **THEN** it receives a conflict, refetches current state and does not silently overwrite the first save

#### Scenario: Save response lost

- **WHEN** the client cannot determine whether its save committed
- **THEN** it keeps the last acknowledged display with an uncertainty state and first reconciles through passive GET; only a deliberate retry may reuse the pending requestId and exact body, with no automatic POST replay

#### Scenario: Catalogue changes during save

- **WHEN** the editor receives a catalogue-change conflict for its selection
- **THEN** it refetches current state and requires a new explicit selection rather than automatically reapplying the prior choice

### Requirement: Output preference mutation replay

Settings choice equality SHALL compare saved intent, not effective fallback. Same intent SHALL be a no-op; Server default SHALL clear stale custom intent. Exact retries of the last committed mutation ID and payload SHALL return current state without another write; ID reuse with changed payload SHALL conflict. Older mutations SHALL NOT overwrite newer revisions. These guarantees SHALL NOT imply durable speech-synthesis deduplication.

#### Scenario: Same acknowledged intent selected

- **WHEN** the person selects the same acknowledged saved intent, including Server default when no custom intent is saved
- **THEN** the editor sends no POST and does not increase the personal revision

#### Scenario: Clear stale intent while default is effective

- **WHEN** the person selects Server default or Reset while stale saved catalogue intent is already falling back to default
- **THEN** one settings save clears the stale custom intent instead of treating effective-choice equality as a no-op

#### Scenario: Exact last mutation repeated

- **WHEN** the immediately last successful settings mutation is repeated byte-for-byte after a lost response
- **THEN** the server returns current state without increasing the preference revision again

#### Scenario: An older save arrives after a newer save

- **WHEN** an older mutation is delivered after a different preference revision committed
- **THEN** it cannot overwrite the newer choice

### Requirement: Effective output voice fallback

An absent/default, invalid, removed or incompatible saved choice SHALL resolve to the current workspace Server default without changing that workspace setting. Invalid saved choices SHALL be explained honestly. A disabled speech route SHALL remain unavailable. Provider/model/method or compatibility-generation changes SHALL invalidate saved catalogue choices; switching away and back SHALL NOT silently revive an old choice.

#### Scenario: Current default changes

- **WHEN** the administrator changes the server voice while a person follows Server default
- **THEN** that person's effective label and next requested synthesis follow the new server voice

#### Scenario: Explicit valid voice survives a default-only edit

- **WHEN** only the configured Server default changes and the person's explicit catalogue voice is still compatible
- **THEN** that person's effective explicit voice remains selected

#### Scenario: Route switched away and back

- **WHEN** the speech provider, model or method changes and later returns to its prior value
- **THEN** a prior personal catalogue choice remains invalid until the person explicitly selects a current option again

### Requirement: Output voice revalidated at speech dispatch

For each requested synthesis the server SHALL resolve the person's current effective voice, freeze it for that invocation, and validate current authorization, assistant-message text, route, model/provider revisions and allowed voice before every provider dispatch and before returning audio. Changes after admission SHALL fail closed rather than silently switching voice/provider. Existing cancellation, concurrency and provider quota guards SHALL remain in force.

#### Scenario: Route changes before dispatch

- **WHEN** a held synthesis has its provider, model, method or privacy policy changed before transport dispatch
- **THEN** that pinned request fails before the paid call and no alternative provider or voice is tried automatically

#### Scenario: Preference changes during the existing verbatim retry

- **WHEN** a reader retries once for a nonverbatim transcript while the person's preference changes
- **THEN** it retains its original voice pin, revalidates the allowed voice and uses no more than the existing two provider attempts

#### Scenario: Source or authorization invalidated after dispatch

- **WHEN** the source assistant text or authorization becomes invalid before audio is returned
- **THEN** the audio is withheld and a late client completion cannot resume stopped playback

### Requirement: Output editor completion ownership

Both editors SHALL bind reads and saves to the current session and server/workspace/user identity, ignore late responses after identity changes and prevent an earlier read from replacing a later acknowledged revision. On conflict or catalogue change they SHALL refetch and require an explicit selection before another save; they SHALL NOT claim success from an optimistic local label.

#### Scenario: Late read after account switch

- **WHEN** an old-account read completes after another account becomes active, even if transport ignores abort
- **THEN** its options and saved voice are discarded

#### Scenario: Earlier read follows a successful save

- **WHEN** an earlier settings read resolves after a later save was acknowledged
- **THEN** it does not rewind the visible preference revision

### Requirement: Output editor dismissal and reconciliation

Mobile scrim, back and swipe dismissal SHALL remain available during saving, cancel client waiting and invalidate completion ownership without claiming server rollback. Reopening or returning to settings SHALL reconcile through passive GET.

#### Scenario: Dismiss while saving

- **WHEN** the person dismisses the saving mobile picker through scrim, back or swipe and the old save later completes despite abort
- **THEN** that completion cannot update or reopen the dismissed picker, no server rollback is claimed and reopening or returning to settings reads current state before another mutation
