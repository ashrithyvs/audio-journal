# AJ-RI-2 Transcription Consumer Architecture

**Status:** Frozen design (2026-10-13). Implementation waits for an accepted
`GRI-1` baseline and a hash-pinned RI-2 candidate SDK/model pack.
**Controlling decisions:** AJ ADR-021, AJ ADR-022, SDK ADR-027.

Audio Journal keeps microphone capture, encrypted AJR1 files, vault keys,
recording lifecycle, transcript validation/revisions, live/final UX, and
durable persistence. It removes all production whisper.cpp, ggml, JNI runtime,
and model-asset ownership from the AJ-RI-2 candidate build.

The native AJ adapter opens a read-only AJR1-backed PCM source after unlock and
registers it on the same packaged SDK runtime that performs
`audio.transcribe@1`. The source exposes 16 kHz mono s16le frames through
bounded reads. No path, recording key, plaintext file, or audio buffer crosses
React Native JavaScript or a node request. Lock cancels the SDK request and
closes the source, which zeroes its key.

Final transcription is one explicit-local SDK request over a sealed recording
of at most 180 seconds. Longer recordings remain stored and playable but are
not transcribed by the RI prototype; the UI gives a typed unsupported-duration
message without truncation. Failure, cancellation, lock, or process death
never changes the recording and stores no partial engine revision. Existing
startup policy may queue a fresh final pass after unlock.

Live text remains provisional. The app schedules bounded snapshots through the
same SDK capability, initially preserving the provisional 8-second window and
4-second cadence. Busy snapshots may be skipped. Final sealed output
supersedes the live rows. The app retains its documented non-speech filter and
validates every returned segment before persistence.

The selected model is delivered as a separate SDK-defined, hash-pinned model
pack outside the AAR. AJ's deployment consumes it as a packaged dependency and
copies it to app-private SDK model storage; AJ code does not choose an
unapproved runtime/model or download weights. Candidate package use before
`GRI-2` is validation only and does not authorize an AJ main merge or release.

AJ-RI-2 validation uses real 30-, 60-, and 180-second public/consented speech,
the exact candidate package/profile/artifact identities, SDK WER and
performance evidence, and AJ durability/lock/process-death journeys. Boundary
checks require the AJ APK/IPA and production source to contain no app-owned
Whisper/ggml runtime or model assets. Android emulator validation is the first
profile; Swift/native iOS parity remains unverified until `GRI-6-I`.
