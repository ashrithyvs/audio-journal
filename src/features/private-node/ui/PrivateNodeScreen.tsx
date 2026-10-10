import React from 'react';
import {
  ActivityIndicator,
  Linking,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';

import { colors } from '../../../theme/colors';
import { PrimaryButton } from '../../app-lock/ui/PrimaryButton';
import { usePrivateNode } from '../application/PrivateNodeContext';
import { assessmentCopy } from '../domain/candidatePresentation';
import { presentConnection } from '../domain/connectionPresentation';
import { presentFailure } from '../domain/errorPresentation';
import { displayUntrustedName, shortNodeId } from '../domain/untrustedText';
import {
  Body,
  Card,
  FailureNotice,
  Gap,
  Heading,
  Label,
  Page,
  Pill,
  shared,
} from './primitives';

export function PrivateNodeScreen({ onPair }: { onPair(): void }) {
  const node = usePrivateNode();
  const { state, activeNode, focus, candidates } = node;
  const { link, discovery, sdk, policy } = state;

  if (sdk.phase !== 'ready') {
    return (
      <Page testID="private-node-screen">
        <Card>
          <Heading>Private AI Node</Heading>
          {sdk.phase === 'unavailable' ? (
            <FailureNotice
              presentation={presentFailure({ code: sdk.code })}
              actionLabel="Try again"
              onAction={node.retryInitialization}
              testID="sdk-unavailable"
            />
          ) : (
            <View style={shared.action}>
              <ActivityIndicator color={colors.moss} />
              <Body>Starting private AI…</Body>
            </View>
          )}
        </Card>
      </Page>
    );
  }

  const connection = presentConnection(
    link.status.state,
    focus,
    link.operation === 'connecting',
    link.mark,
  );
  // Trust failed: the one recovery is to forget that exact node and pair again
  // (UX §7.1, AJ3-REV-001). Several failed nodes each get their own action.
  const revoked =
    connection.repairNodeId !== undefined || focus.untrusted.length > 1;
  const linkFailure = link.failure && presentFailure(link.failure);

  const forgetAndRepair = async (nodeId: string) => {
    await node.forget(nodeId);
    onPair();
  };

  return (
    <Page testID="private-node-screen">
      <Card testID="node-status-card">
        <Heading>Private AI Node</Heading>
        <Pill
          label={connection.label}
          tone={connection.tone}
          testID="node-connection-state"
        />
        <Body>{connection.detail}</Body>
        {focus.node ? (
          <>
            <Label>{focus.node.active ? 'Active node' : 'Affected node'}</Label>
            <Text style={styles.activeName}>
              {displayUntrustedName(focus.node.nodeName)}
            </Text>
            <Body>ID {shortNodeId(focus.node.nodeId)}</Body>
          </>
        ) : null}
        {link.notice === 'forgotten_confirmed' ? (
          <Body>
            Node forgotten. The node confirmed it removed this device.
          </Body>
        ) : null}
        {link.notice === 'forgotten_unconfirmed' ? (
          <Body>
            Node forgotten on this device. The node couldn’t be reached to
            confirm, so also remove this device on the node.
          </Body>
        ) : null}
        {linkFailure && !revoked ? (
          // One Reconnect only: the status action below offers it when it
          // applies (AJ-3 report F3).
          <FailureNotice
            presentation={linkFailure}
            actionLabel={connection.canReconnect ? undefined : 'Reconnect'}
            onAction={connection.canReconnect ? undefined : node.reconnect}
            testID="link-failure"
          />
        ) : null}
        <View style={[shared.row, shared.action]}>
          {connection.repairNodeId ? (
            <PrimaryButton
              label="Forget and pair again"
              onPress={() => forgetAndRepair(connection.repairNodeId!)}
              testID="forget-and-repair"
            />
          ) : null}
          {!revoked && connection.canReconnect ? (
            <PrimaryButton
              label="Reconnect"
              onPress={node.reconnect}
              disabled={link.operation !== 'idle'}
              testID="reconnect"
            />
          ) : null}
          {!activeNode && !revoked ? (
            <PrimaryButton
              label="Pair a node"
              onPress={onPair}
              testID="pair-node"
            />
          ) : null}
        </View>
      </Card>

      <Card testID="paired-nodes-card">
        <Heading>Paired nodes</Heading>
        {state.paired.length === 0 ? (
          <Body>No nodes are paired with this device.</Body>
        ) : (
          state.paired.map(paired => (
            <View
              key={paired.nodeId}
              testID={`paired-${shortNodeId(paired.nodeId)}`}
            >
              <Gap />
              <Text style={styles.name}>
                {displayUntrustedName(paired.nodeName)}
              </Text>
              <Pill
                label={
                  paired.state === 'paired'
                    ? paired.active
                      ? 'Paired · Active'
                      : 'Paired'
                    : paired.state === 'revoked'
                    ? 'Revoked'
                    : paired.state === 'forgetting'
                    ? 'Forgetting…'
                    : 'Key unavailable'
                }
                tone={paired.state === 'paired' ? 'good' : 'danger'}
              />
              <View style={[shared.row, shared.action]}>
                {!paired.active && paired.state === 'paired' ? (
                  <PrimaryButton
                    label="Make active"
                    secondary
                    onPress={() => node.makeActive(paired.nodeId)}
                  />
                ) : null}
                {focus.untrusted.includes(paired) ? (
                  <PrimaryButton
                    label="Forget and pair again"
                    secondary
                    disabled={link.operation !== 'idle'}
                    onPress={() => forgetAndRepair(paired.nodeId)}
                    testID={`forget-and-repair-${shortNodeId(paired.nodeId)}`}
                  />
                ) : (
                  <PrimaryButton
                    label="Forget"
                    secondary
                    disabled={link.operation !== 'idle'}
                    onPress={() => node.forget(paired.nodeId)}
                    testID="forget-node"
                  />
                )}
              </View>
            </View>
          ))
        )}
        {state.paired.length > 0 ? (
          <View style={shared.action}>
            <PrimaryButton
              label="Pair another node"
              secondary
              onPress={onPair}
            />
          </View>
        ) : null}
      </Card>

      <Card testID="discovery-card">
        <Heading>Nearby nodes</Heading>
        <Body>
          Nodes announced on this network are unverified. Finding one never
          pairs it; pairing needs the code shown on your own node.
        </Body>
        {discovery.phase === 'searching' ? (
          <View style={shared.action}>
            <ActivityIndicator color={colors.moss} />
            <Body>Searching this network…</Body>
          </View>
        ) : null}
        {discovery.phase === 'failed' && discovery.failure ? (
          <FailureNotice
            presentation={presentFailure(discovery.failure)}
            actionLabel={
              discovery.failure.code === 'DISCOVERY_PERMISSION_DENIED'
                ? 'Open settings'
                : 'Search again'
            }
            onAction={
              discovery.failure.code === 'DISCOVERY_PERMISSION_DENIED'
                ? () => Linking.openSettings()
                : node.startDiscovery
            }
            testID="discovery-failure"
          />
        ) : null}
        {discovery.phase !== 'idle' &&
        discovery.phase !== 'failed' &&
        candidates.length === 0 ? (
          <Body>
            {discovery.phase === 'searching'
              ? 'No nodes found yet.'
              : 'No nodes found nearby. You can still pair with a code.'}
          </Body>
        ) : null}
        {candidates.map(({ candidate, assessment }, index) => (
          <View
            key={`${candidate.nodeId}-${index}`}
            testID={`candidate-${assessment}`}
          >
            <Gap />
            <Text style={styles.name}>
              {displayUntrustedName(candidate.instanceName)}
            </Text>
            <Pill
              label={
                assessment === 'unpaired'
                  ? 'Unverified'
                  : 'Unverified · Possible impersonation'
              }
              tone={assessment === 'unpaired' ? 'neutral' : 'warning'}
            />
            <Body>{assessmentCopy[assessment]}</Body>
            <Body>
              ID {shortNodeId(candidate.nodeId)} ·{' '}
              {candidate.pairingOpen ? 'Pairing open' : 'Pairing closed'}
            </Body>
          </View>
        ))}
        <View style={shared.action}>
          {discovery.phase === 'searching' ? (
            <PrimaryButton
              label="Stop searching"
              secondary
              onPress={node.stopDiscovery}
              testID="stop-discovery"
            />
          ) : (
            <PrimaryButton
              label="Search nearby"
              secondary
              onPress={node.startDiscovery}
              testID="start-discovery"
            />
          )}
        </View>
      </Card>

      <Card testID="policy-card">
        <Heading>AI routing</Heading>
        <Body>
          These settings only restrict where AI requests may run. There is no
          cloud fallback.
        </Body>
        <PolicySwitch
          label="Use Private AI Node"
          value={policy.allowNode}
          onChange={allowNode => node.setPolicy({ ...policy, allowNode })}
          testID="policy-allow-node"
        />
        <PolicySwitch
          label="Use on-device AI"
          value={policy.allowLocal}
          onChange={allowLocal => node.setPolicy({ ...policy, allowLocal })}
          testID="policy-allow-local"
        />
      </Card>
    </Page>
  );
}

function PolicySwitch({
  label,
  value,
  onChange,
  testID,
}: {
  label: string;
  value: boolean;
  onChange(value: boolean): void;
  testID: string;
}) {
  return (
    <View style={styles.switchRow}>
      <Text style={styles.name}>
        {label}: {value ? 'On' : 'Off'}
      </Text>
      <Switch
        accessibilityLabel={label}
        onValueChange={onChange}
        testID={testID}
        thumbColor={colors.white}
        trackColor={{ false: colors.border, true: colors.moss }}
        value={value}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  activeName: { color: colors.ink, fontSize: 16, marginTop: 4 },
  name: { color: colors.ink, fontSize: 15 },
  switchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 14,
  },
});
