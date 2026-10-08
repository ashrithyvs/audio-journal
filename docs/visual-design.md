# Visual Design

**Status:** Proposed v0.1 design direction for product review. This document
refines the interaction rules in `ux-design.md`; it does not represent an
implemented UI.

## 1. Design concept: Quiet Archive

The app should feel like a private notebook with the reliability of a recorder,
not like a chatbot or productivity dashboard. The visual language combines:

- warm paper-like surfaces;
- dark botanical ink and muted moss accents;
- restrained terracotta only for active recording and destructive attention;
- editorial typography for dates and entry titles;
- simple system typography for controls and dense transcript text;
- generous whitespace, soft separators, and very few floating cards.

Avoid gradients, neon “AI” effects, glassmorphism, chat bubbles, gamification,
streaks, mood scores, and dashboards of synthetic metrics.

## 2. Color tokens

### Light appearance

| Token | Value | Use |
|---|---|---|
| Canvas | `#F5F1E8` | App background; warm paper rather than pure white. |
| Surface | `#FFFCF6` | Sheets, entry surfaces, and input regions. |
| Ink | `#252822` | Primary text and high-emphasis icons. |
| Muted ink | `#6C7167` | Metadata and secondary labels. |
| Moss | `#526B57` | Primary action, selected state, playback progress. |
| Pale moss | `#DDE5D9` | Gentle selected/organized state backgrounds. |
| Record | `#C85D43` | Recording state and destructive confirmation only. |
| Divider | `#DDD6C8` | Hairlines and structural separation. |

### Dark appearance

| Token | Value | Use |
|---|---|---|
| Canvas | `#171A17` | Main background. |
| Surface | `#21251F` | Elevated/sheet surfaces. |
| Ink | `#F0EBDD` | Primary content. |
| Muted ink | `#A9AEA4` | Metadata. |
| Moss | `#9DB89D` | Primary action and active progress. |
| Pale moss | `#303B31` | Selected/organized surfaces. |
| Record | `#E07A5F` | Recording/destructive state. |
| Divider | `#3B4038` | Structural separation. |

Color is never the only status signal. Record/pause/lock/task states also use
labels, shapes, and accessible announcements.

## 3. Typography

- **Display/date/title:** a licensed editorial serif with a Newsreader-like
  character; use a platform serif fallback until the font choice is approved.
- **UI/transcript/body:** platform system sans for legibility and native feel.
- **Numbers/timers:** tabular numerals.
- Default body size 16–17, transcript 17–18 with relaxed line height, metadata
  12–13, screen title 30–34. Dynamic type can expand layouts rather than clip.

The serif appears only in dates, entry titles, and short reflective headings.
Controls, tasks, settings, and transcripts remain sans-serif.

## 4. Shape, spacing, and motion

- Base spacing unit: 4; common gaps 8, 12, 16, 24, and 32.
- Horizontal screen inset: 20 on compact phones, 24 on larger phones.
- Controls use 14–18 corner radii; full-round shapes are reserved for record,
  play, avatars/status dots, and compact toggles.
- Entry list items use separators or subtle surface changes rather than every
  item becoming a shadowed card.
- Motion is brief and functional: recording pulse, transcript insertion,
  bottom-sheet transition, and source-range highlight. Respect reduced motion.

## 5. Navigation

The stable bottom navigation contains:

1. **Journal** — contains an explicit **Diary / Organized** switch. Diary is the
   chronological source timeline; Organized contains Work, Personal, Ideas,
   People, and Projects as derived views.
2. **Record** — centered primary capture action, visually distinct but not oversized.
3. **Tasks** — derived tasks with source links.
4. **Settings** — lock, node, storage/privacy, and diagnostics.

Entry detail and organization are pushed/modal flows, not permanent tabs.
Search belongs in Journal. Organized sections remain derived views of the same
source entries rather than a separate AI-owned database.

## 6. Core screens

### Lock

Calm blank surface, small journal mark, “Your journal is locked,” biometric
action when available, and an always-visible “Use PIN instead.” No entry data,
recent titles, task counts, or node status appears.

### Diary

Date is the visual anchor. A short prompt such as “What do you want to remember?”
leads into recent raw entries. Voice/written entry types, duration, transcript
availability, and organized state appear as quiet metadata—not achievement badges.

### Organized

The second half of Journal. It shows derived material grouped first by **Work**
and **Personal**, then Ideas, People, and Projects when present. A section can
summarize several entries, but always shows its source count and source links.
Organized mode never replaces or filters entries out of Diary.

### Recording

Full-focus composition: time, level/waveform, live transcript, pause/resume, and
finish. Active recording uses terracotta. A small safety line confirms “Saved
on this device.” Transcription failure changes that line without obstructing capture.

### Entry detail

Audio player and original source are primary. Transcript segments follow and
highlight with playback. “Organize entry” is a secondary moss action. Derived
summary/tasks sit below a clear “Organized from this entry” boundary and each
offers “View source.”

### Organize review

A bottom sheet names the exact selection and private destination. Users choose
desired outputs (summary, tasks, ideas, people/projects) and confirm. The sheet
states that transcript text—not audio—is sent by default. It never resembles a
generic prompt composer.

### Tasks

Simple grouped checklist (Today, Upcoming, Later/No date). Each derived task has
a compact source action such as “Oct 8 · 1:31–2:18.” Selecting it opens the
source-reference sheet with constrained audio playback and highlighted transcript.
Completion does not modify the entry.

### Task source reference

A focused sheet/screen shows the task, originating diary entry, exact audio range,
mini waveform with the cited region emphasized, “Play source,” matching transcript
highlight, and “Open full entry.” This is a first-class trust interaction, not
hidden provenance metadata.

### Settings

Sections: Privacy & Lock, Private AI Node, Storage, Appearance, Accessibility,
Backup & Restore, and Developer Diagnostics. Pairing status is factual; it does
not dominate the app.

### Backup & restore

Shows the last verified backup and two actions: Create backup and Restore backup.
Create backup explains the encrypted snapshot, included content, estimated size,
portable backup password/recovery key, and OS-chosen destination. Restore previews
archive date, entry/recording/task counts, version, and required storage before
confirming an empty-vault restore. Progress never reveals entry titles.

## 7. Component inventory

- `JournalHeader`, `EntryRow`, `EntryTypeIcon`, `RecordingButton`
- `RecordingTimer`, `AudioMeter`, `LiveTranscript`, `CaptureSafetyStatus`
- `AudioPlayer`, `TranscriptSegment`, `SourceLink`
- `TaskSourceSheet`, `SourceExcerptPlayer`, `SourceRangeHighlight`
- `OrganizeSheet`, `OutputKindOption`, `PrivateNodeDisclosure`
- `TaskRow`, `TaskGroup`, `NodeStatusRow`
- `BackupStatus`, `BackupCreateSheet`, `BackupSecretField`, `RestorePreview`
- `LockScreen`, `PinPad`, `BiometricAction`, `PrivacyCurtain`
- `EmptyState`, `InlineError`, `DeveloperDiagnosticRow`

Components expose semantic states and accessibility labels. They do not consume
raw SDK events or database rows directly.

## 8. Empty and failure states

- Empty Today: one sentence and the record/write actions; no illustration needed.
- No node: journal stays normal; Organize explains how to pair or retry later.
- STT unavailable: “Recording safely. Transcript can be created later.”
- Invalid AI result: keep prior/source view and offer retry without showing raw data.
- Locked/key unavailable: fail closed with clear local-reset consequences.

## 9. Design acceptance criteria

- Recording can be started within one action from Today.
- The screen never presents AI work as more important than source audio/text.
- Lock and app-switcher states leak no journal content.
- Every derived item has an obvious source affordance.
- All primary flows work at large text sizes and without relying on color.
- Dark and light appearances preserve the same hierarchy and privacy behavior.
- No screen requires an account or public cloud concept.
