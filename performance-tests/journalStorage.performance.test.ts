import { performance } from 'node:perf_hooks';

import { CaptureController } from '../src/features/journal/application/CaptureController';
import { currentTranscript } from '../src/features/journal/domain/transcript';
import { FakeRecordingService } from '../test/journal/FakeRecordingService';
import { openJournal, readyVoiceEntry } from '../test/sqlite/journalFixtures';

// Development measurements on the host with plain SQLite, not SQLCipher on a
// device. Thresholds only catch order-of-magnitude regressions; they are not
// product budgets (no ADR freezes them). Each test prints one AJ1_PERF line so
// validation evidence records the measured values, not just pass/fail.

const percentile = (samples: number[], p: number) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

const round = (value: number) => Math.round(value * 1000) / 1000;

function report(name: string, metrics: Record<string, number>) {
  const rounded = Object.fromEntries(
    Object.entries(metrics).map(([key, value]) => [key, round(value)]),
  );
  process.stdout.write(`AJ1_PERF ${JSON.stringify({ name, ...rounded })}\n`);
}

it('pages a 5,000-entry timeline with p95 under 20 ms', async () => {
  const context = await openJournal();
  await context.db.transaction(async tx => {
    for (let index = 0; index < 5_000; index += 1) {
      await tx.run(
        `INSERT INTO journal_entries (id, kind, status, created_at, updated_at, source_text)
          VALUES (?, 'written', 'ready', ?, ?, ?)`,
        [context.ids.next('ent'), index, index, `entry ${index} `.repeat(20)],
      );
    }
  });
  const samples: number[] = [];
  let before: { createdAt: number; id: string } | undefined;
  for (let page = 0; page < 100; page += 1) {
    const started = performance.now();
    const rows = await context.journal.listTimeline({ limit: 50, before });
    samples.push(performance.now() - started);
    const last = rows[rows.length - 1];
    before = { createdAt: last.createdAt, id: last.id };
  }
  report('timeline_page_50_of_5000', {
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
  });
  expect(percentile(samples, 0.95)).toBeLessThan(20);
  await context.db.close();
});

it('stores and renders a 60-minute transcript with corrections quickly', async () => {
  const context = await openJournal();
  const { recordingId } = await readyVoiceEntry(context, 3_600_000);
  // ~1 segment per 3 s, roughly what whisper.cpp emits for speech.
  const segments = Array.from({ length: 1_200 }, (_, index) => ({
    startMs: index * 3_000,
    endMs: index * 3_000 + 2_900,
    text: `segment ${index} with ordinary spoken words in it`,
  }));
  const saveStarted = performance.now();
  await context.transcripts.saveEngineRevision({
    recordingId,
    modelId: 'base.en-q5_1',
    segments,
    createdAt: 1,
  });
  const saveMs = performance.now() - saveStarted;

  const correctionSamples: number[] = [];
  let view = await context.transcripts.current(recordingId);
  for (let index = 0; index < 50; index += 1) {
    const started = performance.now();
    await context.transcripts.correct(
      view.lines[index * 20].segmentId,
      `fixed ${index}`,
      2,
    );
    correctionSamples.push(performance.now() - started);
  }
  const records = await context.transcripts.records(recordingId);
  const viewStarted = performance.now();
  view = currentTranscript(records);
  const viewMs = performance.now() - viewStarted;

  report('transcript_60min_1200_segments', {
    saveRevisionMs: saveMs,
    correctionP50Ms: percentile(correctionSamples, 0.5),
    correctionP95Ms: percentile(correctionSamples, 0.95),
    currentViewMs: viewMs,
  });
  expect(view.lines).toHaveLength(1_200);
  expect(saveMs).toBeLessThan(500);
  expect(percentile(correctionSamples, 0.95)).toBeLessThan(50);
  expect(viewMs).toBeLessThan(50);
  await context.db.close();
});

it('runs 200 repeated capture sessions without per-session cost growth', async () => {
  const context = await openJournal();
  const recorder = new FakeRecordingService();
  let clock = 1_760_000_000_000;
  const controller = new CaptureController({
    journal: context.journal,
    recorder,
    ids: context.ids,
    now: () => clock,
    progressIntervalMs: 5_000,
  });
  const sessionMs: number[] = [];
  const heapStart = process.memoryUsage().heapUsed;
  for (let session = 0; session < 200; session += 1) {
    const started = performance.now();
    await controller.start();
    // 30 s of capture as 1 s progress events.
    for (let second = 0; second < 30; second += 1) {
      clock += 1_000;
      recorder.capture(1_000);
    }
    await controller.finish();
    controller.acknowledge();
    sessionMs.push(performance.now() - started);
  }
  const heapGrowthMb = (process.memoryUsage().heapUsed - heapStart) / 1024 ** 2;
  const firstTen = sessionMs.slice(0, 10);
  const lastTen = sessionMs.slice(-10);
  const mean = (values: number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;

  const ready = await context.db.get<{ n: number }>(
    "SELECT count(*) AS n FROM recordings WHERE state = 'ready'",
  );
  report('repeated_sessions_200x30s', {
    sessionP50Ms: percentile(sessionMs, 0.5),
    sessionP95Ms: percentile(sessionMs, 0.95),
    firstTenMeanMs: mean(firstTen),
    lastTenMeanMs: mean(lastTen),
    heapGrowthMb,
  });
  expect(ready?.n).toBe(200);
  expect(percentile(sessionMs, 0.95)).toBeLessThan(100);
  // No accumulation: late sessions cost about the same as early ones.
  expect(mean(lastTen)).toBeLessThan(mean(firstTen) * 3 + 5);
  await context.db.close();
});
