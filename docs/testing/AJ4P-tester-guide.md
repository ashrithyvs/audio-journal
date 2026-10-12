# Audio Journal Prototype: Tester Guide (AJ-4-P)

This guide covers the exploratory trial of the Audio Journal Android prototype
on an emulator or a physical phone. It is a **development prototype**: it is
signed with the development (debug) key, it is not a store build, and it is not
production-hardened. See the
[product reality check](../validation/AJ4P-product-reality.md) for what was
measured and what is known not to work.

**Status:** an Android emulator-validated prototype checkpoint, accepted by
the owner on 2026-10-12. It is **not** canonical AJ-4, production
acceptance, or a release.

- Every figure is an **emulator development measurement**.
- **Physical Android and iOS are untested.**
- Organization uses the **deterministic `aj.rules` engine, not a model**.
- **Canonical AJ-4 and production hardening remain open.**

## 1. What you need

- An Android phone running Android 8.0 (API 26) or later, `arm64-v8a`. Most
  phones from 2017 onwards qualify. An x86_64 Android emulator also works.
- The accepted prototype APK, `app-release.apk`, from the evidence folder
  `aj1-artifacts/evidence/aj4p/apk-a3b25a5/`. Before installing, check
  that its SHA-256 is
  `7df7e740fedf4f8dd734330e30e051d2100fc647e45bedc64674283d39d93efa`
  (also listed in `SHA256SUMS` in the same folder). The folder
  `aj4p/apk/` holds the superseded pre-fix build; do not install it.
- For organization, a computer on the same Wi-Fi network running the
  Audio Journal node companion (§4), with Node.js 22.11 or later.

## 2. Install

1. On the phone, allow installing from your computer or file manager. Android
   asks the first time you open an APK. With USB debugging you can instead
   run `adb install -r app-release.apk`.
2. Open **Audio Journal**.
3. Choose a PIN on **Create your private space**, enter it again, and tap
   **Protect my journal**. The PIN encrypts the journal on this phone. There
   is no account, and the PIN cannot be recovered. A forgotten PIN means
   starting over unless you made a backup (§7).
4. Optionally tap **Turn on biometric unlock** in Settings. It appears only
   when the phone has a fingerprint or face enrolled. The unlock screen then
   offers **Use biometrics**, and your PIN still works.

The journal locks when you leave the app or tap **Lock now** in Settings.
Unlock it with your PIN.

## 3. Write and record

- **Write:** on **Diary**, tap **Write**, type an entry, and save it.
- **Record:** on **Diary**, tap **Record** and allow microphone access the
  first time.
  - You can pause and resume during the recording. Finish to save it.
  - The audio is encrypted on the phone and never leaves it.
  - While you speak, a live transcript appears. After you finish, the phone
    makes a **final transcript** on the device. On the emulator this took
    about half the recording's length (§ timings in the report); physical
    phones still need measuring.
  - Open the entry to **Play** the recording.
- **Correct:** tap a transcript line to correct it. Corrections are marked
  "Edited by you".

Everything above works with no node and no network.

## 4. Start the node companion (on the computer)

The companion runs the organization step. It is a separate program in the
Audio Journal repository, `node-companion/`. It never receives audio, only
the transcript text you choose to send.

```sh
cd node-companion
npm ci
# Find the computer's Wi-Fi address (for example 192.168.1.20), then:
node bin/aj-companion.mjs serve --port 38443 --endpoint 192.168.1.20:38443
```

Keep it running. Allow incoming TCP port 38443 in the computer's firewall.
State, including the node key and the pairing table, is kept in
`~/.audio-journal-companion`.

## 5. Pair the phone with the companion

1. In a second terminal on the computer, run:

   ```sh
   node bin/aj-companion.mjs pair
   ```

   It prints a pairing code that starts with `hybrid-ai-pair:` and is valid
   for 2 minutes.
2. On the phone, open **Settings → Manage Private AI Node → Pair a node**,
   and paste or type the code. Scanning the code with the camera is not
   available in this prototype.
3. The phone and the terminal each show a six-digit code. If they match,
   confirm on both. If they differ, reject.
4. The node shows as **Connected**.

The prototype does not discover the companion automatically on the network;
the code carries its address. To remove the node, use **Forget** in the same
screen, or run `node bin/aj-companion.mjs pairings` and then `revoke <id>`
on the computer.

## 6. Organize, Organized, and Tasks

1. Open an entry and tap **Organize with my node**.
2. Read the consent sheet. It shows what text will leave the phone, that it
   goes only to your node, and that audio stays on the phone. Tap **Send
   text**, or decline.
3. The result appears under the entry. Organizing changes nothing in the
   entry itself.
4. **Organized** lists every result. Each item has a **Source** link back to
   the exact transcript line, and for voice entries to the exact audio range,
   with **Play this part**.
   - An item whose source changed later (for example, after a correction) is
     marked "Source changed since organized". **Reorganize** asks for
     consent again.
   - **History** keeps earlier results.
5. **Tasks** groups tasks as Overdue, Today, Upcoming, No date, Done, and
   Dismissed.
   - Due dates come only from explicit words such as "today", "tomorrow",
     "Friday", or "14 November".
   - Use **Done**, **Dismiss**, and **Restore**.

The organization engine in this prototype is **deterministic rules
(`aj.rules`), not a language model**. It finds sentences such as "I need
to …", "Remember to …", "We should …", names, and simple work or personal
cues. Expect literal, rule-like results. A model-backed engine is future
work.

## 7. Back up and restore

- **Back up:** open **Settings → Backup & restore → Create backup**, choose
  a backup password (at least 12 characters) or a 24-word recovery key, and
  save the file where you like. The backup is encrypted with that secret. It does not include your PIN, biometrics,
  or node pairing.
- **Restore:** on a fresh install (or after clearing the app's data), choose
  **Restore backup** and the file, and enter its password. Then set a new
  PIN and pair the node again. The old PIN does not carry over.

## 8. What to try, and what to report

Please try daily-journal use: a few written and spoken entries, organizing
some of them, and working through the tasks.

Report what feels slow, confusing, or wrong, with the time and what you did.
In particular, note:

- how long recording takes to start, and how long the final transcript takes;
- how transcription quality holds up with your voice, accent, and
  background noise;
- whether pairing on your Wi-Fi works;
- battery or heat during long recordings.

Do not include journal content in reports unless you choose to. The app
never puts journal text in its logs.

## 9. Test data for the emulator

- **Deterministic speech:** the `e2e` build (`app-e2e.apk`) replaces the
  microphone with a WAV pushed to
  `/sdcard/Android/data/com.audiojournal/files/test-audio/input.wav`.
  - The file is 16 kHz mono 16-bit, played at real-time pace, then silence.
  - Examples are whisper.cpp's `jfk.wav` (`e2e/aj2/lib/voice.mjs`) and
    prefixes of the speech dataset's 10-minute long form
    (`e2e/speech/prepare-dataset.mjs`; `e2e/aj4/prototype-perf.mjs`).
- **The emulator microphone** records silence with `-no-audio`.
- **The automated journeys:**
  - `e2e/aj4/product-journey.mjs` (the full product path);
  - `e2e/aj4/stability.mjs` (repeated use);
  - the AJ-1, AJ-2, and AJ-3 suites listed in their validation reports.
