import {
  planLiveWindow,
  type LiveWindow,
} from '../src/features/journal/domain/liveTranscript';
import {
  applyProvisional,
  emptyProvisional,
  orderedProvisional,
  retireProvisional,
  type ProvisionalTranscript,
} from '../src/features/journal/domain/transcript';

// Overlapping live windows (LLD §6): the newer window wins where they overlap.

let counter = 0;
const nextId = () => `seg_${(counter += 1)}`;

function apply(
  state: ProvisionalTranscript,
  window: LiveWindow,
  capturedMs = window.endMs,
) {
  const plan = planLiveWindow(state, window, capturedMs, nextId);
  let next = retireProvisional(state, plan.retire);
  for (const update of plan.updates) {
    next = applyProvisional(next, update, capturedMs);
  }
  return { plan, state: next };
}

const text = (state: ProvisionalTranscript) =>
  orderedProvisional(state).map(line => line.text);

beforeEach(() => {
  counter = 0;
});

it('adds a first window as new live rows', () => {
  const { plan, state } = apply(emptyProvisional, {
    startMs: 0,
    endMs: 4_000,
    segments: [
      { t0Ms: 0, t1Ms: 1_800, text: 'I walked' },
      { t0Ms: 1_800, t1Ms: 4_000, text: 'to the' },
    ],
  });
  expect(plan.retire).toEqual([]);
  expect(plan.updates.map(update => update.revision)).toEqual([1, 1]);
  expect(text(state)).toEqual(['I walked', 'to the']);
});

it('lets the newer window replace the overlap without repeating text', () => {
  let { state } = apply(emptyProvisional, {
    startMs: 0,
    endMs: 4_000,
    segments: [
      { t0Ms: 0, t1Ms: 1_800, text: 'I walked' },
      { t0Ms: 1_800, t1Ms: 4_000, text: 'to the' },
    ],
  });
  // The next window starts at 1 500 ms: 'to the' starts inside it and is
  // re-transcribed; 'I walked' ends at 1 800, so new text before that is dropped.
  const second = apply(state, {
    startMs: 1_500,
    endMs: 8_000,
    segments: [
      { t0Ms: 1_500, t1Ms: 1_900, text: 'walked' },
      { t0Ms: 1_900, t1Ms: 5_000, text: 'to the river' },
      { t0Ms: 5_000, t1Ms: 8_000, text: 'this morning' },
    ],
  });
  expect(second.plan.retire).toEqual(['seg_2']);
  state = second.state;
  expect(text(state)).toEqual(['I walked', 'to the river', 'this morning']);
  expect(state.retired).toEqual(['seg_2']);
});

it('never runs ahead of captured audio and ignores empty or malformed text', () => {
  const { state } = apply(
    emptyProvisional,
    {
      startMs: 0,
      endMs: 6_000,
      segments: [
        { t0Ms: 0, t1Ms: 2_000, text: ' ' },
        { t0Ms: 2_000, t1Ms: 5_500, text: 'kept, clamped' },
        { t0Ms: 2_500.5, t1Ms: 3_000, text: 'fractional' },
        { t0Ms: 5_200, t1Ms: 6_000, text: 'ahead' },
      ],
    },
    5_000,
  );
  expect(orderedProvisional(state)).toEqual([
    expect.objectContaining({ text: 'kept, clamped', endMs: 5_000 }),
  ]);
});

it('keeps no live rows for a window that holds only silence markers', () => {
  const { plan } = apply(emptyProvisional, {
    startMs: 0,
    endMs: 8_000,
    segments: [
      { t0Ms: 0, t1Ms: 4_000, text: '[BLANK_AUDIO]' },
      { t0Ms: 4_000, t1Ms: 8_000, text: ' [ Silence ] ' },
    ],
  });
  expect(plan.updates).toEqual([]);
});
