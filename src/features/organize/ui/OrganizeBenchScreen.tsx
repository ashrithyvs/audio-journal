import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

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
import { useOrganize } from '../application/OrganizeContext';
import {
  benchScenarios,
  runScenario,
  type BenchControl,
  type BenchSample,
} from '../bench/runner';
import { deviceContext } from '../domain/request';

// Developer organize benchmark (the AJ-2 organize performance suite). Every
// request goes through the app's HybridAiGateway, i.e. the packaged SDK's
// public API, with synthetic transcripts that are never stored. Each sample
// is written to the device log as one `AJ_ORGANIZE_PERF` JSON line of sizes,
// codes, and durations for the Android harness. It is separate from the load
// lab (SDK capability load) and the transcription benchmarks.

const now = () => globalThis.performance?.now?.() ?? Date.now();

function emit(kind: string, payload: unknown) {
  console.log(`${kind} ${JSON.stringify(payload)}`);
}

export function OrganizeBenchScreen() {
  const organize = useOrganize();
  const { gateway } = usePrivateNode();
  const [status, setStatus] = useState('idle');
  const [count, setCount] = useState('20');
  const [last, setLast] = useState<BenchSample>();
  const control = useRef<BenchControl>({ stopped: false });
  const presented = useRef<((at: number) => void) | undefined>(undefined);

  // A sample counts as visible on the first frame after it is committed.
  useEffect(() => {
    const resolve = presented.current;
    if (last && resolve) {
      presented.current = undefined;
      requestAnimationFrame(() => resolve(now()));
    }
  }, [last]);

  const setup = useMemo(() => {
    if (!organize) {
      return undefined;
    }
    const keyHex = organize.services.randomHex(32);
    const base = {
      crypto: organize.services.crypto,
      keyHex,
      context: deviceContext(),
    };
    return { base, scenarios: benchScenarios(base) };
  }, [organize]);

  if (!organize || !setup) {
    return (
      <Page testID="organize-bench-screen">
        <Card>
          <Body>The journal is not open.</Body>
        </Card>
      </Page>
    );
  }

  const running = status.startsWith('running');
  const run = async (id: string) => {
    const scenario = setup.scenarios.find(s => s.id === id);
    const total = Math.max(1, Math.min(200, Number.parseInt(count, 10) || 1));
    if (!scenario || running) {
      return;
    }
    control.current = { stopped: false };
    setStatus(`running ${id} 0/${total}`);
    try {
      await runScenario(
        scenario,
        total,
        {
          ...setup.base,
          gateway,
          derivations: organize.derivations,
          now,
          present: sample =>
            new Promise<number>(resolve => {
              presented.current = resolve;
              setLast(sample);
            }),
          log: emit,
        },
        control.current,
        done => setStatus(`running ${id} ${done}/${total}`),
      );
      setStatus(control.current.stopped ? `stopped ${id}` : `done ${id}`);
    } catch (error) {
      emit('AJ_ORGANIZE_PERF_ERROR', {
        scenario: id,
        error: error instanceof Error ? error.name : 'error',
      });
      setStatus(`error ${id}`);
    }
  };

  return (
    <Page testID="organize-bench-screen">
      <Card>
        <Heading>Organize benchmark</Heading>
        <Body>
          journal.organize@1 through the public SDK with synthetic transcripts.
          Nothing is stored; persistence is rehearsed and rolled back.
          Development baselines only.
        </Body>
        <Text style={styles.status} testID="bench-status">
          {status}
        </Text>
        {last ? (
          <Text style={styles.meta} testID="bench-last">
            {`${last.scenario} #${last.run}: ${last.outcome}${
              last.code ? ` ${last.code}` : ''
            } in ${Math.round(last.terminalMs ?? last.buildMs)} ms`}
          </Text>
        ) : null}
        <Label>Runs per scenario</Label>
        <TextInput
          accessibilityLabel="Runs per scenario"
          editable={!running}
          keyboardType="number-pad"
          onChangeText={setCount}
          style={styles.input}
          testID="bench-count"
          value={count}
        />
        <View style={[shared.row, shared.action]}>
          {setup.scenarios.map(scenario => (
            <PrimaryButton
              key={scenario.id}
              label={scenario.label}
              disabled={running}
              secondary
              onPress={() => {
                run(scenario.id);
              }}
              testID={`bench-run-${scenario.id}`}
            />
          ))}
        </View>
        <View style={shared.action}>
          <PrimaryButton
            label="Stop"
            disabled={!running}
            onPress={() => {
              control.current.stopped = true;
            }}
            testID="bench-stop"
          />
        </View>
      </Card>
    </Page>
  );
}

const styles = StyleSheet.create({
  status: {
    color: colors.ink,
    fontSize: 15,
    fontVariant: ['tabular-nums'],
    marginTop: 12,
  },
  meta: { color: colors.muted, fontSize: 13, marginTop: 6 },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    color: colors.ink,
    marginTop: 6,
    padding: 10,
  },
});
