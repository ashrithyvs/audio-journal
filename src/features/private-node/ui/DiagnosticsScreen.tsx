import React, { useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { ExecutionTarget } from '../../../platform/hybrid-ai/HybridAiGateway';
import { colors } from '../../../theme/colors';
import { PrimaryButton } from '../../app-lock/ui/PrimaryButton';
import { usePrivateNode } from '../application/PrivateNodeContext';
import {
  ANALYZE_CAPABILITY,
  MAX_ANALYZE_INPUT_LENGTH,
} from '../domain/analysisResult';
import { presentFailure } from '../domain/errorPresentation';
import type { Timings } from '../domain/privateNodeState';
import { shortNodeId } from '../domain/untrustedText';
import {
  Body,
  Card,
  FailureNotice,
  Heading,
  Label,
  Page,
  shared,
} from './primitives';

// Developer diagnostics are privacy-safe by construction: they show codes,
// targets, reasons, counts, and durations, never input or output text (LLD §11).

const targets: ExecutionTarget[] = ['auto', 'local', 'node'];
const deadlines = [5_000, 30_000];
const SAMPLE_TEXT =
  'Sample developer text. Plan the garden layout and order tomato seedlings.';

const timingRows: Array<[keyof Timings, string]> = [
  ['sdkInitMs', 'SDK initialization'],
  ['discoveryFirstMs', 'Discovery first result'],
  ['discoverySettledMs', 'Discovery settled'],
  ['pairingToCodeMs', 'Pairing to verification code'],
  ['confirmToPairedMs', 'Confirmation to paired'],
  ['pairingTotalMs', 'Pairing total'],
  ['reconnectMs', 'Secure reconnect'],
  ['firstEventMs', 'First capability event'],
  ['firstResponseMs', 'First capability response'],
];

function Row({
  name,
  value,
  testID,
}: {
  name: string;
  value: string;
  testID?: string;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.name}>{name}</Text>
      <Text style={styles.value} testID={testID}>
        {value}
      </Text>
    </View>
  );
}

function Choice<T extends string | number>({
  options,
  value,
  format,
  onChange,
  testPrefix,
}: {
  options: T[];
  value: T;
  format(option: T): string;
  onChange(option: T): void;
  testPrefix: string;
}) {
  return (
    <View style={[shared.row, styles.choices]}>
      {options.map(option => (
        <PrimaryButton
          key={String(option)}
          label={`${option === value ? '● ' : ''}${format(option)}`}
          secondary={option !== value}
          onPress={() => onChange(option)}
          testID={`${testPrefix}-${option}`}
        />
      ))}
    </View>
  );
}

export function DiagnosticsScreen({
  onOpenLoadLab,
  onOpenOrganizeBench,
}: {
  onOpenLoadLab?(): void;
  onOpenOrganizeBench?(): void;
}) {
  const node = usePrivateNode();
  const { state } = node;
  const { request, sdk, link, timings } = state;
  const [text, setText] = useState(SAMPLE_TEXT);
  const [execution, setExecution] = useState<ExecutionTarget>('auto');
  const [deadline, setDeadline] = useState(30_000);
  const running = request.phase === 'running';

  return (
    <Page testID="diagnostics-screen">
      <Card>
        <Heading>Hybrid AI SDK</Heading>
        <Row
          name="State"
          value={
            sdk.phase === 'ready'
              ? 'ready'
              : sdk.phase === 'unavailable'
              ? `unavailable (${sdk.code})`
              : sdk.phase
          }
          testID="diag-sdk-state"
        />
        <Row
          name="Node link"
          value={link.status.state}
          testID="diag-link-state"
        />
        <Row
          name="Node ID"
          value={link.status.nodeId ? shortNodeId(link.status.nodeId) : '—'}
        />
        <Row
          name="Policy"
          value={`local ${state.policy.allowLocal ? 'on' : 'off'} · node ${
            state.policy.allowNode ? 'on' : 'off'
          }`}
          testID="diag-policy"
        />
        <Label>Capabilities</Label>
        {state.capabilities.length === 0 ? (
          <Body>None registered.</Body>
        ) : (
          state.capabilities.map(capability => (
            <Row
              key={`${capability.id}@${capability.version}`}
              name={`${capability.id}@${capability.version}`}
              value={`${capability.targets.join('+') || 'none'}${
                capability.nodeStale ? ' · node stale' : ''
              }`}
              testID={`diag-capability-${capability.id}`}
            />
          ))
        )}
      </Card>

      {onOpenLoadLab ? (
        <Card>
          <Heading>Load lab</Heading>
          <Body>
            Load, latency, and failure-path runs through the public SDK.
          </Body>
          <View style={shared.action}>
            <PrimaryButton
              label="Open load lab"
              secondary
              onPress={onOpenLoadLab}
              testID="open-load-lab"
            />
          </View>
        </Card>
      ) : null}

      {onOpenOrganizeBench ? (
        <Card>
          <Heading>Organize benchmark</Heading>
          <Body>
            journal.organize@1 performance with synthetic transcripts through
            the public SDK. Separate from the load lab.
          </Body>
          <View style={shared.action}>
            <PrimaryButton
              label="Open organize benchmark"
              secondary
              onPress={onOpenOrganizeBench}
              testID="open-organize-bench"
            />
          </View>
        </Card>
      ) : null}

      <Card testID="diag-request-card">
        <Heading>
          Test request · {ANALYZE_CAPABILITY.id}@{ANALYZE_CAPABILITY.version}
        </Heading>
        <Body>
          Developer input only. It is sent to the selected target and never
          shown in diagnostics.
        </Body>
        <Label>Input</Label>
        <TextInput
          accessibilityLabel="Diagnostic input"
          autoCorrect={false}
          editable={!running}
          maxLength={MAX_ANALYZE_INPUT_LENGTH}
          multiline
          onChangeText={setText}
          style={styles.input}
          testID="diag-input"
          value={text}
        />
        <Label>Target</Label>
        <Choice<ExecutionTarget>
          options={targets}
          value={execution}
          format={option => option}
          onChange={setExecution}
          testPrefix="diag-target"
        />
        <Label>Deadline</Label>
        <Choice<number>
          options={deadlines}
          value={deadline}
          format={option => `${option / 1000} s`}
          onChange={setDeadline}
          testPrefix="diag-deadline"
        />
        <View style={[shared.row, shared.action]}>
          {running ? (
            <>
              <ActivityIndicator color={colors.moss} />
              <PrimaryButton
                label="Cancel request"
                secondary
                onPress={node.cancelRequest}
                testID="diag-cancel"
              />
            </>
          ) : (
            <PrimaryButton
              label={
                request.phase === 'failed' ? 'Retry request' : 'Run request'
              }
              disabled={sdk.phase !== 'ready' || !text.trim()}
              onPress={() => {
                // Fire and forget: the request reports through state.
                node.runRequest({ text, execution, timeoutMs: deadline });
              }}
              testID="diag-run"
            />
          )}
        </View>

        <Label>Last request</Label>
        {request.phase === 'idle' ? (
          <Body>No request yet.</Body>
        ) : (
          <>
            <Row
              name="Phase"
              value={request.phase}
              testID="diag-request-phase"
            />
            <Row name="Request ID" value={request.requestId} />
            <Row name="Requested target" value={request.execution} />
            <Row
              name="Events"
              value={String(request.events)}
              testID="diag-request-events"
            />
            <Row
              name="First event"
              value={
                request.firstEventMs === undefined
                  ? '—'
                  : `${Math.round(request.firstEventMs)} ms`
              }
            />
            {request.phase === 'completed' ? (
              <>
                <Row
                  name="Target"
                  value={request.target}
                  testID="diag-request-target"
                />
                <Row
                  name="Routing reason"
                  value={request.routingReason}
                  testID="diag-request-reason"
                />
                <Row name="Total" value={`${Math.round(request.totalMs)} ms`} />
                <Row
                  name="Result"
                  value={
                    request.check.valid
                      ? `valid · ${request.check.topicCount} topics`
                      : 'discarded · invalid format'
                  }
                  testID="diag-request-result"
                />
              </>
            ) : null}
            {request.phase === 'cancelled' ? (
              <Row name="Total" value={`${Math.round(request.totalMs)} ms`} />
            ) : null}
            {request.phase === 'failed' ? (
              <>
                <FailureNotice
                  presentation={presentFailure(request.failure)}
                  testID="diag-request-failure"
                />
                <Row
                  name="Local reason"
                  value={request.failure.localReason ?? '—'}
                />
                <Row
                  name="Node reason"
                  value={request.failure.nodeReason ?? '—'}
                  testID="diag-request-node-reason"
                />
              </>
            ) : null}
          </>
        )}
      </Card>

      <Card testID="diag-timings">
        <Heading>Timings</Heading>
        <Body>
          Development baselines from this session, not production budgets.
        </Body>
        {timingRows.map(([key, name]) => (
          <Row
            key={key}
            name={name}
            value={
              timings[key] === undefined
                ? '—'
                : `${Math.round(timings[key]!)} ms`
            }
            testID={`diag-timing-${key}`}
          />
        ))}
      </Card>
    </Page>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  name: { color: colors.muted, flexShrink: 1, fontSize: 13, paddingRight: 12 },
  value: { color: colors.ink, flexShrink: 1, fontSize: 13, textAlign: 'right' },
  choices: { marginTop: 8 },
  input: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 14,
    marginTop: 8,
    minHeight: 72,
    padding: 12,
    textAlignVertical: 'top',
  },
});
