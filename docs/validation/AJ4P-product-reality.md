# AJ-4-P: Product Reality Check (Android prototype)

**Date:** 2026-10-12
**Branch:** `aj4/hardening` from `main` `59339e9`. It is not merged, pushed,
or released.
**Status:** a prototype for the owner's exploratory physical-phone trial.
This is not canonical AJ-4, not production hardening, and not release
certification (roadmap §6.0).

**All figures are emulator development measurements, not physical-device
budgets.** The emulator is `aj-api35-4g`, Android SDK built for x86_64,
API 35, 4 GB, 4 vCPU, software GPU. The host is an Intel Core Ultra 7 155U on
AC power. Evidence is in `aj1-artifacts/evidence/aj4p/`, outside the
repository.

## 1. The prototype build

The prototype was built from the accepted `main` plus the one blocker fix
below (`a3b25a5`). It adds no new product scope, and the SDK is unchanged.
The APKs are in `aj4p/apk-a3b25a5/`, with `SHA256SUMS`.

| APK | SHA-256 | Use |
|---|---|---|
| `app-release.apk` | `7df7e740fedf4f8dd734330e30e051d2100fc647e45bedc64674283d39d93efa` | **For the phone trial.** It is R8-minified and Hermes-bundled, and carries `arm64-v8a` and `x86_64` |
| `app-e2e.apk` | `81f7b35838923ebb9be233de169a6b95f0b9eca930ad64e4732d2b153ba64af6` | Emulator only: it feeds a pushed WAV in place of the microphone |

- **ABIs and SDK core.** Each APK packages 21 native libraries for each of
  `arm64-v8a` and `x86_64`. In both ABIs, `libhybrid_ai_core.so` is
  byte-identical to the accepted SDK package built from `c4b302e` (AAR
  `8751a5a7…b1a`).
- **Signing.** Both APKs are signed with the development (debug) key, APK
  Signature Scheme v2, so they can be sideloaded. They are not production
  signed or store-ready; that is deferred.
- **Platform.** Target SDK 35, minimum SDK 26.
- **Superseded builds.** The pre-fix build (`aj4p/apk/`, release
  `bd5bcf15…`) is kept as evidence for the measurements taken on it.

## 2. Does the primary journey work end to end?

**Yes.** The product journey (`e2e/aj4/product-journey.mjs`) passed
**12/12 on the fixed build** (`fixed-journey/`, `e2e` APK `81f7b358…`):

| Step | Result |
|---|---|
| J00 | Clean install; create the PIN |
| J01 | Written entry ("I need to call the bank tomorrow. …") |
| J02 | Voice entry (deterministic speech sample, 15 s) |
| J03 | Final on-device transcript ("…fellow Americans…") |
| J04 | Encrypted playback started and advanced |
| J05 | Paired with the node companion (code, matching six-digit check) |
| J06 | Organized the voice entry, after consent |
| J07 | Organized the written entry |
| J08 | Organized: followed the summary's source to the cited transcript line and audio range (`0:00–0:11`) |
| J09 | Tasks: "Call the bank tomorrow." marked Done |
| J10 | Locked, killed the process, and reopened: after the PIN, the entries, the Organized results, and the Done task were all present |
| J11 | No journal text in the device log or the companion log |

The pre-fix build had passed the same journey 12/12 (`journey/`). Its 15 s
recording did not reach the Finish problem (§8).

## 3. What it feels like on the emulator

- **Launch** (release build, 5 runs each, `am start -W`): **cold 478 ms
  p50** (p95 486, CV 0.07), and **warm 81 ms p50** (p95 90). Unlocking
  follows; the PIN check itself is not timed here.
- **Starting to record:** **38 ms p50** (p95 45) from the tap to the audio
  server opening the input stream. **Starting playback:** **48 ms p50**
  (p95 68) from the tap to the output track. These are device-clock times
  from a logcat marker written just before the tap; the adb round trip is
  included, so they are upper bounds.
- **Navigation** between Diary, Organized, Tasks, and Settings was immediate
  in the automated runs. The automation itself takes about 1 s per screen
  read, so it cannot resolve finer UI latency. On a phone this is a
  hands-on check.
- **While recording,** the app uses about 2–2.2 of 4 emulated cores, for
  live transcription. The UI stayed responsive. Pause, Finish, and the timer
  updated throughout once the Finish fix was in.

## 4. Transcription timings

These are real-time captures through the app (`e2e` build), using read
speech: prefixes of the speech dataset's 10-minute LibriSpeech long form.
The app transcribes on the device with `base.en-q5_1` and 4 threads.
"Stop → final" runs from the Finish tap to the final transcript on screen.
RTF is that time divided by the recording's length, including about 2–4 s
of trailing silence.

| Speech | Runs | Stop → final transcript | RTF | Finish |
|---|---|---|---|---|
| 30 s | 3 | **17.1 / 17.2 / 17.5 s** | 0.50–0.51 | first tap, 3/3 |
| 1 min | 3 | **28.7 / 30.4 / 31.6 s** | 0.44–0.49 | first tap, 3/3 |
| 3 min | 1 | **63.3 s** | 0.34 | first tap |
| 5 min | 1 | **101–117 s** | about 0.33 | see below |
| 10 min | 1 | **190–205 s** (about 3.3 min) | about 0.31–0.33 | see below |

- **5 and 10 minutes.** In these two runs the harness's first Finish tap
  did not register the stop screen within its 15 s window, so it tapped
  again. The ranges cover both readings. A separate single-tap probe on a
  5-minute recording shows the app itself stops on the first tap, with the
  stop screen up within 1.3 s (`finish-probe.json`). The retries were a
  timing artifact of the harness's ~1 s screen reads under load.
- **Live text** appears during recording; the final pass then replaces it.
- **Accuracy** was not re-scored here. The accepted in-app baseline on short
  utterances is WER 5.83% at RTF 0.616 (speech baseline §4).
- **Read across durations.** Short recordings cost relatively more:
  fixed model load and warm-up dominate a 30 s pass. Long ones settle at
  about one third of real time on this emulator. A 10-minute entry waits
  about 3–3.5 minutes after Finish for its final transcript. That is
  acceptable for a journal, but slow, and the main thing to measure on a
  phone.

## 5. Organization timings

This is a confirmation set on the fixed release APK, through the public SDK
to the node companion (`fixed-organize/`): 1 cold and 3 warm runs per
duration. It is the deterministic `aj.rules` engine. Times are in ms,
p50 / p95 over the warm runs.

| Speech | Request | Result | Accepted | First progress | First partial | Completed | On screen |
|---|---|---|---|---|---|---|---|
| 30 s | 1,413 B | 3,259 B | 13 / 24 | 30 / 38 | 30 / 38 | **31 / 39** | **55 / 64** |
| 1 min | 2,588 B | 5,513 B | 16 / 32 | 41 / 45 | 41 / 45 | **43 / 47** | **65 / 66** |
| 3 min | 7,199 B | 18,694 B | 20 / 23 | 37 / 38 | 38 / 38 | **41 / 42** | **77 / 77** |
| 5 min | 12,000 B | 31,827 B | 22 / 31 | 41 / 45 | 42 / 45 | **47 / 48** | **105 / 108** |
| 10 min | 22,970 B | 61,138 B, **partial, 4 omitted** | 31 / 31 | 52 / 54 | 52 / 54 | **60 / 62** | **142 / 158** |

- **Cold runs,** after a restart, add about 13–32 ms.
- **Above the cap:** 30-minute entries and requests over the cap are refused
  as `TOO_LARGE`, and 60-minute entries as `TOO_MANY_UNITS`. 5/5 each were
  typed and nothing was sent. There is no chunking.
- **Agreement.** The figures agree with the accepted 20-warm-run AJ-2
  baseline (AJ-2 performance §5.1) within run-to-run variance.
- **As the user sees it,** in the journey, about 4.3 s passes from tapping
  "Send text" to the stored result on screen. That is almost entirely the
  automation's screen polling: the SDK path itself is under 0.2 s.

## 6. Memory

- **Transcription.** Peak app RSS (MiB, the last run at each length) rises
  with recording length: **438 MB** at 30 s, 549 MB at 1 min, 597 MB at
  3 min, 600 MB at 5 min, and **620 MB** at 10 min (VmHWM 631 MB). This is the on-device speech model plus the
  recording's audio during the final pass. It is the largest memory cost
  in the app.
- **Organization.** About **0.21–0.23 GB** RSS with no transcription
  running (AJ-2 rehearsal mode).
- **Stability session.** Memory reached a plateau (§7). No leak trend was
  seen in 18 minutes.
- **Physical phones.** About 0.6 GB is acceptable on 6–8 GB phones. On 3–4 GB
  phones the app could be killed in the background during long final
  passes, which is a physical-device check (§11). The recording itself is
  sealed incrementally and is not lost (AJ-1).

## 7. Short stability check

`e2e/aj4/stability.mjs` ran **18 minutes** on the fixed `e2e` APK
(`fixed-stability/`). In each cycle it:

- wrote an entry;
- recorded the speech sample and waited for its final transcript;
- organized the entry through the companion;
- opened Organized and Tasks;
- every other cycle, locked and unlocked.

| Result | Value |
|---|---|
| Cycles | 11 |
| Operations | 49: 11 writes, 11 recordings with transcription, 11 organizes, 11 navigations, 5 lock/unlocks |
| Failures | **0** |
| Crashes and ANRs (device log) | **0** |
| Finish retries | 0 |
| App memory, start → end | RSS 207 → 457 MB; PSS 78 → 325 MB |

The jump happens on the first transcription, when the speech model loads:
RSS 441 MB after cycle 1. It then levels off at about 457–467 MB from
cycle 4 and ends lower than its peak (467 MB). **There is no growth trend.** This is
a short check, not a soak or leak certification.

## 8. Problems found

**Blocker, found and fixed: Finish moved off screen during longer
recordings** (`a3b25a5`).

- **Symptom.** The live transcript box sat above Pause and Finish and grew
  without bound. After about a minute of speech on the emulator, Finish
  had moved below the fold. On a 3-minute recording it was fully off screen,
  so finishing meant scrolling to a button that kept moving. In the
  automated runs, one tap in three missed at 1 minute, and no tap could
  reach it at 3 minutes. On a phone's smaller screen it would happen sooner.
- **Fix.** The box shows only the latest ~200 characters, cut at a word
  boundary after "…" (`liveTail`; UX §5). The full live text is still
  stored, and the entry shows the final transcript.
- **Proof.** On the fixed build, every recording up to 3 minutes stopped on
  the first Finish tap in the ladder, as did all 11 in the stability
  session. A single-tap probe on a 5-minute recording reached the stop
  screen within 1.3 s.
- **Tests.** Unit `journalLiveTail` (3) and the extended `journalLive`
  integration test, which checks the bounded tail and that Finish is
  rendered.

**Not product defects; tooling and environment, recorded for
reproducibility:**

- uiautomator can wedge on the emulator ("UiAutomationService already
  registered"); a reboot clears it.
- The new worktree needed `npm ci` in `node-companion/`.
- Harness selector fixes: the source link's label is drawn by a child node,
  and Settings has to be popped to its home screen before "Lock now".

## 9. Known functional limitations

- **Organization is deterministic `aj.rules`, not a language model.** It
  finds explicit patterns ("I need to …", "Remember to …", names, simple
  work and personal cues), so results are literal and rule-like. Quality
  and speed with a model-backed engine are unmeasured future work.
- **Organization is node-only.** Without a paired companion the journal
  works fully, but nothing is organized.
- **One request per entry.** Entries above the 61,108-byte request cap,
  about 26.5 minutes of speech, are refused with a typed reason and never
  truncated. 30- and 60-minute entries are refused (§5). There is no
  chunking (O-7).
- **Partial results.** From about 10 minutes of speech, the result exceeds
  the output budget. It is shown as explicitly **partial**, with the counts
  of what was left out (amendment A1).
- **Pairing.** The companion is not advertised on the LAN for discovery, so
  pairing uses the `hybrid-ai-pair:` code, which carries its address. There
  is no camera QR scan.
- **Cancellation edge.** A cancel that arrives before the node has returned
  the job ID cannot reach the node (the SDK's documented limitation). The
  app still stores nothing.
- **Due dates** come only from explicit English phrases; "next Friday" and
  numeric dates are deliberately not interpreted (contract §3.3).
- **Biometric unlock** appears only when the device has an enrolled
  biometric. Backup and restore work, but the PIN, biometrics, and node
  pairing are not carried in a backup.

## 10. Emulator limitations

- There is no real microphone. Speech comes from a pushed WAV (`e2e` build)
  played at real-time pace. The release build on the emulator records
  silence. Real-microphone capture, noise, and levels are unmeasured.
- An x86_64 virtual CPU (4 vCPU) with a software GPU. Transcription speed,
  UI smoothness, and memory differ on phone SoCs (`arm64-v8a`), which were
  built but never executed.
- No thermal or battery signal: the emulator reports no thermal zones and
  no meaningful battery drain.
- The node is reached over `adb reverse` to 127.0.0.1, not over Wi-Fi.
- UI timing is read through uiautomator at about 1 s resolution, so
  sub-second UI latency was measured only for audio start and launch.

## 11. To check on a physical phone

On the owner's phone, in order of importance:

1. **Transcription speed and heat on a real SoC:** stop-to-final for 1, 3,
   and 10 minutes, and whether the phone gets hot or throttles during and
   after a 10-minute recording.
2. **Real-microphone quality:** accuracy with the owner's voice, accent,
   and ambient noise; levels; pause and resume.
3. **Memory:** the app reached about 0.6 GB RSS on the emulator during long
   final passes. Check that it is not killed in the background on a
   mid-range phone.
4. **Pairing over Wi-Fi:** the companion on a PC (`--endpoint <LAN IP>`),
   the firewall, the code entry, and reconnecting after the phone sleeps or
   changes network.
5. **Lifecycle:** a phone call during recording (audio focus), leaving the
   app, and screen-off during a long final pass; check that the recording is
   kept and resumes or finalizes.
6. **Biometrics,** if enrolled; relock behavior.
7. **Battery** over a day of normal use.
8. **Backup to and restore from** the phone's storage or cloud folder
   through the system picker.
9. **UI feel:** scrolling a long Diary, the Organized cards, the Tasks
   groups, the size of the source links, and text that fits the screen.

The full production-readiness inventory (crash injection, hostile inputs,
soak, deep API 26/28) is deferred (AJ-4 progress §8).

## 12. Readiness for the owner's physical-phone trial

**Ready for the owner's exploratory physical-phone trial**, with the notes
below.

- **The core journey works end to end** on the emulator (§2): written and
  voice entries, the final transcript, playback, pairing, consented
  organization, Organized and Tasks with source navigation, task state,
  and persistence across lock and process death.
- **The one blocker found,** Finish moving off screen during longer
  recordings, is fixed and verified (§8).
- **No crash, failure, or memory growth** in the short stability check
  (§7).
- **The main risk to check on the phone is waiting time.** A 10-minute
  entry needs about 3–3.5 minutes after Finish for its final transcript on
  the emulator. Phone SoCs could be faster (`arm64` NEON) or slower and
  thermally limited. §11 lists the physical checks in order.
- **Install `app-release.apk`** (`7df7e740…`), not the `e2e` build. Follow
  the [tester guide](../testing/AJ4P-tester-guide.md). The companion has to
  run on a computer on the same Wi-Fi.
- **Not claimed:** canonical AJ-4, production readiness, release, or any
  physical-device performance. The AJ-4-E hardening inventory is deferred
  (AJ-4 progress §8).

## 13. Reused, not rerun

These accepted results were reused, not rerun. No production input they
cover changed in AJ-4-P, apart from the bounded live-text display, which
none of them exercises:

- **AJ-3 S00–S19:** 20/20, fresh, on the final AJ-2 build with the
  `c4b302e` packages (`aj2-sdkaj5/aj3/`).
- **The full AJ-2 organization matrix:** 126 measured runs, refusals,
  cancellation, and deadline (`aj2-sdkaj5/perf/`,
  [AJ-2 performance](AJ2-organize-performance.md)).
- **API 26 and 28:** the paired organize smoke with TLS 1.2 and EMS, with
  device logs (`aj2-sdkaj5/privacy-api26-28/`).
- **Backup and restore,** hostile-archive vectors, crash recovery, and the
  privacy scans: AJ-1 and AJ-2 evidence, and AJ-2 progress §10.1.
- **In-app speech accuracy** on short utterances: WER 5.83%, RTF 0.616
  ([speech baseline](speech-and-load-baseline.md)).
