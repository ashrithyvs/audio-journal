// Jobs, idempotency, events, and retention (SDK ADR-021; ADR-022 pairing
// scope), plus the journal.organize@1 request-key replay (contract §9).
// Everything here is in memory: job inputs and results are never written to
// disk and are gone after retention, process exit, or revocation.

import { randomBytes } from 'node:crypto';

import {
  ContractError,
  MESSAGE_CAP,
  sha256,
  validateInput,
} from './contract.mjs';
import { ENGINE, organize } from './engine.mjs';
import { byteLength, canonical, own } from './json.mjs';
import { padToCap } from './testPad.mjs';

export const RETENTION_MS = 15 * 60_000;
export const MAX_JOBS = 32;
export const MAX_EVENTS = 64;
export const MAX_IDEMPOTENCY = 4096;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const CAPABILITY_ID = /^[a-z0-9]+(\.[a-z0-9]+){1,4}$/;
const VERSION = /^[0-9]{1,2}\.[0-9]{1,2}\.[0-9]{1,2}$/;

export class WireError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The published job-request shape (job-request.schema.json). */
function checkJobRequest(body) {
  const keys =
    body && typeof body === 'object' && !Array.isArray(body)
      ? Object.keys(body)
      : null;
  const want = [
    'requestId',
    'idempotencyKey',
    'capability',
    'input',
    'deadlineMs',
    'stream',
  ];
  const ok =
    keys &&
    keys.length === want.length &&
    want.every(k => own(body, k)) &&
    typeof body.requestId === 'string' &&
    REQUEST_ID.test(body.requestId) &&
    typeof body.idempotencyKey === 'string' &&
    IDEMPOTENCY_KEY.test(body.idempotencyKey) &&
    body.capability &&
    typeof body.capability === 'object' &&
    !Array.isArray(body.capability) &&
    Object.keys(body.capability).length === 2 &&
    typeof body.capability.id === 'string' &&
    CAPABILITY_ID.test(body.capability.id) &&
    typeof body.capability.version === 'string' &&
    VERSION.test(body.capability.version) &&
    body.input &&
    typeof body.input === 'object' &&
    !Array.isArray(body.input) &&
    Object.keys(body.input).length <= 32 &&
    Number.isInteger(body.deadlineMs) &&
    body.deadlineMs >= 1 &&
    body.deadlineMs <= 120_000 &&
    typeof body.stream === 'boolean';
  if (!ok)
    throw new WireError(
      400,
      'SCHEMA_VALIDATION_FAILED',
      'Job request does not match the protocol',
    );
}

export class JobStore {
  /**
   * `stageDelayMs` slows each engine stage (tests of deadlines and
   * cancellation only); `padResults` grows results to the exact output cap
   * (device boundary tests only, src/testPad.mjs); `monotonic` and `timers`
   * are injectable for tests.
   */
  constructor({
    monotonic = () => performance.now(),
    stageDelayMs = 0,
    padResults = false,
    log = () => {},
  } = {}) {
    this.monotonic = monotonic;
    this.stageDelayMs = stageDelayMs;
    this.padResults = padResults;
    this.log = log;
    this.jobs = new Map();
    this.idempotency = new Map();
    this.replays = new Map();
  }

  purge() {
    const now = this.monotonic();
    for (const [id, job] of this.jobs) {
      if (now - job.createdMono >= RETENTION_MS) {
        this.end(
          job,
          'failed',
          { code: 'EXECUTION_FAILED', message: 'Job is no longer retained' },
          true,
        );
        this.jobs.delete(id);
      }
    }
    for (const [key, replay] of this.replays)
      if (now - replay.at >= RETENTION_MS) this.replays.delete(key);
  }

  submit(pairingId, body) {
    checkJobRequest(body);
    if (
      body.capability.id !== 'journal.organize' ||
      !body.capability.version.startsWith('1.')
    ) {
      throw new WireError(
        404,
        'CAPABILITY_NOT_FOUND',
        'Capability is not served by this node',
      );
    }
    this.purge();
    const key = `${pairingId} ${body.idempotencyKey}`;
    const identity = canonical({
      capability: body.capability,
      deadlineMs: body.deadlineMs,
      input: body.input,
      stream: body.stream,
    });
    const record = this.idempotency.get(key);
    if (record) {
      if (record.identity !== identity)
        throw new WireError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'Key reused for a different request',
        );
      return {
        status: 200,
        body: this.response(record.jobId, record.requestId),
      };
    }
    if (this.idempotency.size >= MAX_IDEMPOTENCY)
      throw new WireError(
        503,
        'NODE_UNAVAILABLE',
        'Idempotency records are full',
      );
    if (this.jobs.size >= MAX_JOBS) {
      const oldestDone = [...this.jobs.values()]
        .filter(j => TERMINAL.has(j.state))
        .sort((a, b) => a.createdMono - b.createdMono)[0];
      if (!oldestDone)
        throw new WireError(503, 'NODE_UNAVAILABLE', 'All job slots are busy');
      this.jobs.delete(oldestDone.jobId);
    }
    const jobId = randomBytes(16).toString('hex');
    const job = {
      jobId,
      pairingId,
      requestId: body.requestId,
      input: body.input,
      state: 'accepted',
      sequence: 0,
      events: [],
      listeners: new Set(),
      createdMono: this.monotonic(),
      deadlineMono: this.monotonic() + body.deadlineMs,
      timer: null,
    };
    this.jobs.set(jobId, job);
    this.idempotency.set(key, { identity, jobId, requestId: body.requestId });
    this.emit(job, 'accepted', {});
    job.timer = setTimeout(
      () =>
        this.end(job, 'failed', {
          code: 'DEADLINE_EXCEEDED',
          message: 'Deadline exceeded',
        }),
      body.deadlineMs,
    );
    job.timer.unref?.();
    setImmediate(() => this.run(job));
    return { status: 201, body: this.response(jobId, body.requestId) };
  }

  response(jobId, requestId) {
    return {
      jobId,
      requestId,
      state: 'accepted',
      eventsPath: `/v1/jobs/${jobId}/events`,
    };
  }

  live(job) {
    if (TERMINAL.has(job.state)) return false;
    if (this.monotonic() >= job.deadlineMono) {
      this.end(job, 'failed', {
        code: 'DEADLINE_EXCEEDED',
        message: 'Deadline exceeded',
      });
      return false;
    }
    return true;
  }

  async run(job) {
    const pause = () =>
      this.stageDelayMs
        ? new Promise(r => setTimeout(r, this.stageDelayMs))
        : Promise.resolve();
    if (!this.live(job)) return;
    let input;
    try {
      input = validateInput(job.input);
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      this.log({ event: 'input-rejected', code: error.code });
      this.end(job, 'failed', {
        code: 'SCHEMA_VALIDATION_FAILED',
        message: `Input rejected: ${error.code}`,
      });
      return;
    }
    const inputSha256 = sha256(canonical(input));
    const replayKey = `${job.pairingId} ${input.requestKey}`;
    const replay = this.replays.get(replayKey);
    if (replay && replay.inputSha256 !== inputSha256) {
      this.end(job, 'failed', {
        code: 'EXECUTION_FAILED',
        message: 'requestKey reused for a different input',
      });
      return;
    }
    let output = replay?.output;
    if (!output) {
      const stages = [];
      let counts = null;
      try {
        output = organize(input, {
          step: (stage, fraction) => stages.push([stage, fraction]),
          partial: c => {
            counts = c;
          },
        });
        if (this.padResults) output = padToCap(output, input);
      } catch (error) {
        this.log({ event: 'engine-failed', reason: error.code ?? 'error' });
        this.end(job, 'failed', {
          code: 'EXECUTION_FAILED',
          message: 'Organization failed',
        });
        return;
      }
      // Stream what the engine did, stage by stage, checking cancellation
      // and the deadline in between.
      for (const [stage, fraction] of stages) {
        if (!this.live(job)) return;
        this.emit(job, 'progress', { stage, fraction });
        if (stage === 'extracting' && counts)
          this.emit(job, 'partial', { delta: { counts } });
        await pause();
      }
      this.replays.set(replayKey, {
        inputSha256,
        output,
        at: this.monotonic(),
      });
      if (this.replays.size > MAX_JOBS)
        this.replays.delete(this.replays.keys().next().value);
    }
    if (!this.live(job)) return;
    this.end(job, 'completed', output);
  }

  /** Appends one event if the stream has room; terminal events always fit. */
  emit(job, type, data) {
    const terminal = TERMINAL.has(type);
    if (!terminal && job.sequence >= MAX_EVENTS - 1) return;
    let event = { data, sequence: job.sequence + 1, type };
    if (Buffer.byteLength(canonical(event), 'utf8') > MESSAGE_CAP) {
      if (!terminal) return;
      event = {
        data: {
          code: 'EXECUTION_FAILED',
          message: 'Result exceeds the message budget',
        },
        sequence: job.sequence + 1,
        type: 'failed',
      };
    }
    job.sequence = event.sequence;
    job.events.push(event);
    if (type === 'progress' && job.state === 'accepted') job.state = 'running';
    if (type === 'partial') job.state = 'streaming';
    if (TERMINAL.has(event.type)) {
      job.state = event.type;
      if (event.type === 'completed') job.output = event.data.output;
      if (event.type === 'failed') job.error = event.data;
      if (event.type === 'cancelled') job.reason = event.data.reason;
      clearTimeout(job.timer);
    }
    const text = canonical(event);
    for (const conn of job.listeners) {
      conn.sendText(text);
      if (TERMINAL.has(event.type)) conn.close(1000);
    }
  }

  end(job, type, data, silent = false) {
    if (TERMINAL.has(job.state)) return;
    if (type === 'completed') this.emit(job, 'completed', { output: data });
    else if (type === 'cancelled')
      this.emit(job, 'cancelled', { reason: data });
    else this.emit(job, 'failed', data);
    // Counts and durations only, never content (contract §10).
    if (!silent)
      this.log({
        event: 'job-ended',
        state: job.state,
        sequence: job.sequence,
        inputBytes: job.input === undefined ? null : byteLength(job.input),
        lastMessageBytes: byteLength(job.events.at(-1)),
        ms: Math.round(this.monotonic() - (job.createdMono ?? 0)),
      });
  }

  find(pairingId, jobId) {
    this.purge();
    const job = this.jobs.get(jobId);
    // Another pairing's job is indistinguishable from an absent one.
    if (!job || job.pairingId !== pairingId)
      throw new WireError(404, 'JOB_NOT_RETAINED', 'Job is no longer retained');
    return job;
  }

  status(pairingId, jobId) {
    const job = this.find(pairingId, jobId);
    const body = {
      jobId,
      requestId: job.requestId,
      state: job.state,
      sequence: job.sequence,
    };
    if (job.state === 'completed') body.output = job.output;
    if (job.state === 'failed') body.error = job.error;
    if (job.state === 'cancelled') body.reason = job.reason;
    return body;
  }

  cancel(pairingId, jobId) {
    const job = this.find(pairingId, jobId);
    this.end(job, 'cancelled', 'Cancelled by the device');
    return { jobId, state: job.state };
  }

  subscribe(pairingId, jobId, afterSequence, conn) {
    const job = this.find(pairingId, jobId);
    for (const event of job.events)
      if (event.sequence > afterSequence) conn.sendText(canonical(event));
    if (TERMINAL.has(job.state)) {
      conn.close(1000);
      return;
    }
    job.listeners.add(conn);
    conn.onClose = () => job.listeners.delete(conn);
  }

  /** Revocation: the pairing's jobs are cancelled and its streams closed. */
  revokePairing(pairingId) {
    for (const job of this.jobs.values()) {
      if (job.pairingId !== pairingId) continue;
      this.end(job, 'cancelled', 'Pairing revoked');
      for (const conn of job.listeners) conn.close(1000);
    }
    for (const key of [...this.idempotency.keys()])
      if (key.startsWith(`${pairingId} `)) this.idempotency.delete(key);
    for (const key of [...this.replays.keys()])
      if (key.startsWith(`${pairingId} `)) this.replays.delete(key);
  }
}

export { ENGINE };
