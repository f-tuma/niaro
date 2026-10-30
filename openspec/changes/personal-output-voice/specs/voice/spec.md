# Voice Delta

## MODIFIED Requirements

### Requirement: Voice is a phone app function

Voice requests and spoken replies SHALL be offered by the phone app. The web app SHALL NOT offer voice input or spoken replies, but SHALL offer the person's output-voice preference editor at `/me`. When the server has no transcriber or speech model, the app SHALL keep text input usable.

#### Scenario: Server without voice

- **WHEN** the connected server reports voice as disabled
- **THEN** the app shows voice as unavailable and text input works as before

#### Scenario: Web changes the person's output voice

- **WHEN** the person opens `/me` in the web app
- **THEN** they can edit their own supported output-voice preference for the selected workspace without enabling browser voice input or playback

### Requirement: Reply playback timing

An automatically read reply SHALL hold its text until audio actually starts, for at most 8 seconds from the accepted reply. If audio does not start in time the app SHALL show the text, allow manual playback, and MUST NOT start the late audio. Stop, navigation, backgrounding, changing the spoken-replies on/off preference, a replacing response or a session change SHALL cancel playback. Saving only a personal output voice SHALL affect the next requested synthesis without stopping or restarting existing playback.

#### Scenario: Slow synthesis

- **WHEN** synthesis takes longer than 8 seconds
- **THEN** the reply text is shown and the audio does not start by itself afterwards

#### Scenario: Output voice changed during playback

- **WHEN** the person saves another output voice while audio is already playing
- **THEN** that audio continues with its original voice and no replacement synthesis starts automatically

## ADDED Requirements

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
