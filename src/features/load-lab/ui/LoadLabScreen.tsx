import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors } from '../../../theme/colors';
import { PrimaryButton } from '../../app-lock/ui/PrimaryButton';
import { usePrivateNode } from '../../private-node/application/PrivateNodeContext';
import {
  Body,
  Card,
  Heading,
  Label,
  Page,
  shared,
} from '../../private-node/ui/primitives';
import { NativeTranscriptionService } from '../../transcription/adapters/NativeTranscriptionService';
import { type RunControl, runWorkload } from '../domain/runner';
import { runSpeechPlan, type SpeechPlan } from '../domain/speechPlan';
import type { WorkloadResult } from '../domain/stats';
import {
  localSuite,
  mixedWorkload,
  nodeSuite,
  type Workload,
} from '../domain/workloads';

// Developer load lab. Every request goes through the app's HybridAiGateway,
// i.e. the packaged SDK's public API. Results are codes, counts, and durations;
// each is also written to the device log as one `AJ_LOAD` JSON line so the
// Android harness can collect them alongside memory and CPU samples.

const now = () => globalThis.performance?.now?.() ?? Date.now();

function emit(kind: string, payload: unknown) {
  console.log(`${kind} ${JSON.stringify(payload)}`);
}

type Status =
  | { phase: 'idle' }
  | {
      phase: 'running';
      label: string;
      workload: string;
      done: number;
      total: number;
    }
  | { phase: 'done'; label: string; passed: boolean }
  | { phase: 'stopped'; label: string };

export function LoadLabScreen() {
  const { gateway, state } = usePrivateNode();
  const [status, setStatus] = useState<Status>({ phase: 'idle' });
  const [results, setResults] = useState<WorkloadResult[]>([]);
  const control = useRef<RunControl>({ stopped: false });
  const policy = useRef(state.policy);
  policy.current = state.policy;

  const transcriber = useRef(new NativeTranscriptionService()).current;
  const evalDirectory = useRef('');
  useEffect(() => {
    // Creating the directory lets the harness push fixtures into it.
    evalDirectory.current = transcriber.available
      ? transcriber.evalDirectory()
      : '';
  }, [transcriber]);

  // Leaving the screen (or locking the app) stops the run.
  useEffect(
    () => () => {
      control.current.stopped = true;
    },
    [],
  );

  const run = useCallback(
    async (label: string, plan: Workload[], soakMs?: number) => {
      control.current = { stopped: false };
      const current = control.current;
      setResults([]);
      const collected: WorkloadResult[] = [];
      const started = now();
      emit('AJ_LOAD_START', {
        label,
        workloads: plan.map(item => item.id),
        soakMs,
      });
      let round = 0;
      do {
        for (const workload of plan) {
          if (current.stopped) break;
          round += 1;
          setStatus({
            phase: 'running',
            label,
            workload: `${workload.id} ${workload.title}`,
            done: 0,
            total: workload.requests,
          });
          const result = await runWorkload(gateway, workload, {
            now,
            appPolicy: policy.current,
            control: current,
            onProgress: done => {
              if (done % 25 === 0 || done === workload.requests) {
                setStatus(previous =>
                  previous.phase === 'running'
                    ? { ...previous, done }
                    : previous,
                );
              }
            },
          });
          const tagged = soakMs
            ? { ...result, id: `${result.id}#${round}` }
            : result;
          emit('AJ_LOAD', tagged);
          collected.push(tagged);
          setResults([...collected]);
        }
      } while (soakMs && !current.stopped && now() - started < soakMs);
      const passed = collected.every(result => result.passed);
      emit('AJ_LOAD_DONE', {
        label,
        stopped: current.stopped,
        passed,
        workloads: collected.length,
        wallMs: Math.round(now() - started),
      });
      setStatus(
        current.stopped
          ? { phase: 'stopped', label }
          : { phase: 'done', label, passed },
      );
    },
    [gateway],
  );

  const runSpeech = useCallback(async () => {
    control.current = { stopped: false };
    const current = control.current;
    setResults([]);
    let plan: SpeechPlan;
    try {
      plan = JSON.parse(await transcriber.readEvalFile('plan.json'));
    } catch {
      setStatus({ phase: 'stopped', label: 'speech: no plan.json' });
      emit('AJ_SPEECH_DONE', { error: 'NO_PLAN' });
      return;
    }
    emit('AJ_SPEECH_START', {
      runId: plan.runId,
      model: plan.model,
      items: plan.items.length,
      concurrency: plan.concurrency,
      sdkStage: plan.sdkStage,
    });
    const summary = await runSpeechPlan(plan, {
      transcriber,
      gateway,
      evalDirectory: evalDirectory.current,
      now,
      control: current,
      // Full results (with fixture transcripts) stay in the eval directory only.
      record: result =>
        transcriber.appendEvalFile(
          `results/${plan.runId}.jsonl`,
          JSON.stringify(result),
        ),
      onProgress: (done, total) => {
        setStatus({
          phase: 'running',
          label: 'speech',
          workload: plan.model,
          done,
          total,
        });
        if (done % 10 === 0) emit('AJ_SPEECH_PROGRESS', { done, total });
      },
    });
    // Numbers only: the summary carries no transcript text.
    emit('AJ_SPEECH_DONE', summary);
    setStatus({
      phase: 'done',
      label: `speech ${plan.model}`,
      passed: summary.failed === 0,
    });
  }, [gateway, transcriber]);

  const ready = state.sdk.phase === 'ready';
  const running = status.phase === 'running';
  const nodeConnected = state.link.status.state === 'connected';

  return (
    <Page testID="load-lab-screen">
      <Card>
        <Heading>Load lab</Heading>
        <Body>
          Synthetic requests through the Hybrid AI public API. Results show
          codes, counts, and durations only.
        </Body>
        <Text style={styles.status} testID="load-status">
          {status.phase === 'running'
            ? `running ${status.workload} ${status.done}/${status.total}`
            : status.phase === 'done'
            ? `done ${status.label} ${status.passed ? 'PASS' : 'FAIL'}`
            : status.phase === 'stopped'
            ? `stopped ${status.label}`
            : 'idle'}
        </Text>
        <Text style={styles.meta} testID="load-local-models">
          Local models:{' '}
          {state.sdk.phase === 'ready'
            ? state.sdk.localModels
            : state.sdk.phase}
        </Text>
        {running ? (
          <View style={[shared.row, shared.action]}>
            {/* Static while running: an animated spinner keeps the compositor busy
                and skews on-device benchmarks. */}
            <Text style={styles.meta}>Running…</Text>
            <PrimaryButton
              label="Stop"
              secondary
              onPress={() => {
                control.current.stopped = true;
              }}
              testID="load-stop"
            />
          </View>
        ) : (
          <View style={[shared.row, shared.action]}>
            <PrimaryButton
              label="Run local suite"
              disabled={!ready}
              onPress={() => {
                run('local-suite', localSuite);
              }}
              testID="load-run-local"
            />
            <PrimaryButton
              label="Run node suite"
              secondary
              disabled={!ready || !nodeConnected}
              onPress={() => {
                run('node-suite', nodeSuite);
              }}
              testID="load-run-node"
            />
            <PrimaryButton
              label="Run speech plan"
              secondary
              disabled={!transcriber.available}
              onPress={() => {
                runSpeech();
              }}
              testID="load-run-speech"
            />
            <PrimaryButton
              label="Soak 10 min"
              secondary
              disabled={!ready}
              onPress={() => {
                run('soak', [mixedWorkload], 10 * 60_000);
              }}
              testID="load-run-soak"
            />
          </View>
        )}
      </Card>
      {results.map(result => (
        <Card key={result.id} testID={`load-result-${result.id}`}>
          <Heading>
            {result.passed ? 'PASS' : 'FAIL'} · {result.id} {result.title}
          </Heading>
          <Label>
            {result.capability} · {result.target} · c{result.concurrency}
          </Label>
          <Body>
            {result.completed}/{result.requests} ok · {result.cancelled}{' '}
            cancelled · {result.failed} failed · {result.throughputPerSecond}{' '}
            req/s
          </Body>
          {result.latencyMs ? (
            <Body>
              latency p50 {result.latencyMs.p50} · p95 {result.latencyMs.p95} ·
              p99 {result.latencyMs.p99} · max {result.latencyMs.max} ms
            </Body>
          ) : null}
          {Object.keys(result.failureCodes).length ? (
            <Body>codes {JSON.stringify(result.failureCodes)}</Body>
          ) : null}
          {Object.keys(result.routingReasons).length ? (
            <Body>reasons {JSON.stringify(result.routingReasons)}</Body>
          ) : null}
          <Body>violations {JSON.stringify(result.violations)}</Body>
        </Card>
      ))}
    </Page>
  );
}

const styles = StyleSheet.create({
  status: { color: colors.ink, fontSize: 15, fontWeight: '700', marginTop: 12 },
  meta: { color: colors.muted, fontSize: 13, marginTop: 6 },
});
