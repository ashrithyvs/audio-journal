import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors } from '../../../theme/colors';
import { PrimaryButton } from '../../app-lock/ui/PrimaryButton';
import { usePrivateNode } from '../application/PrivateNodeContext';
import { presentFailure } from '../domain/errorPresentation';
import { displayUntrustedName } from '../domain/untrustedText';
import {
  Body,
  Card,
  FailureNotice,
  Heading,
  Label,
  Page,
  shared,
} from './primitives';

function secondsLeft(expiresAt: number): number {
  return Math.max(0, Math.floor(expiresAt - Date.now() / 1000));
}

export function PairNodeScreen({ onDone }: { onDone(): void }) {
  const node = usePrivateNode();
  const { pairing } = node.state;
  const [code, setCode] = useState('');
  // Re-renders the countdown; the remaining time always uses the current clock.
  const [, setTick] = useState(0);

  useEffect(() => {
    if (pairing.phase !== 'ready') {
      return;
    }
    const timer = setInterval(() => setTick(tick => tick + 1), 1_000);
    return () => clearInterval(timer);
  }, [pairing.phase]);

  // Leaving the screen abandons any unfinished ceremony.
  const { cancelPairing, resetPairing } = node;
  useEffect(() => () => cancelPairing(), [cancelPairing]);

  const checkCode = () => {
    const entered = code;
    // The code is a one-time secret: it leaves the field as soon as it is used.
    setCode('');
    node.inspectCode(entered);
  };

  const startOver = () => {
    resetPairing();
    setCode('');
  };

  return (
    <Page testID="pair-node-screen">
      {pairing.phase === 'idle' ||
      pairing.phase === 'cancelled' ||
      pairing.phase === 'inspecting' ? (
        <Card>
          <Heading>Pair a Private AI Node</Heading>
          <Body>
            On your Private AI Node, show a pairing QR code. Paste the code’s
            text below. Only pair with a node you control.
          </Body>
          {pairing.phase === 'cancelled' ? (
            <Body>Pairing was cancelled. Nothing was paired.</Body>
          ) : null}
          <Label>Pairing code</Label>
          <TextInput
            accessibilityLabel="Pairing code"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            importantForAutofill="no"
            onChangeText={setCode}
            onSubmitEditing={() => code.trim() && checkCode()}
            placeholder="hybrid-ai-pair:…"
            placeholderTextColor={colors.muted}
            returnKeyType="go"
            style={styles.input}
            testID="pairing-code-input"
            value={code}
          />
          <View style={shared.action}>
            {pairing.phase === 'inspecting' ? (
              <ActivityIndicator color={colors.moss} />
            ) : (
              <PrimaryButton
                label="Check code"
                disabled={!code.trim()}
                onPress={checkCode}
                testID="check-code"
              />
            )}
          </View>
        </Card>
      ) : null}

      {pairing.phase === 'ready' ? (
        <Card testID="pairing-summary">
          <Heading>Pair with this node?</Heading>
          <Label>Name shown by the code</Label>
          <Text style={styles.name}>
            {displayUntrustedName(pairing.summary.nodeName)}
          </Text>
          {secondsLeft(pairing.summary.expiresAt) > 0 ? (
            <>
              <Body>
                Code expires in {secondsLeft(pairing.summary.expiresAt)} s.
              </Body>
              <View style={[shared.row, shared.action]}>
                <PrimaryButton
                  label="Pair"
                  onPress={node.beginPairing}
                  testID="begin-pairing"
                />
                <PrimaryButton label="Cancel" secondary onPress={startOver} />
              </View>
            </>
          ) : (
            // Defense in depth: the SDK and node also reject stale codes.
            <FailureNotice
              presentation={presentFailure({
                code: 'PAIRING_BOOTSTRAP_EXPIRED',
              })}
              actionLabel="Enter a new code"
              onAction={startOver}
              testID="pairing-code-expired"
            />
          )}
        </Card>
      ) : null}

      {pairing.phase === 'pairing' ? (
        <Card testID="pairing-progress">
          <Heading>Connecting securely…</Heading>
          <Body>Checking the node’s identity against the code.</Body>
          <View style={shared.action}>
            <ActivityIndicator color={colors.moss} />
          </View>
          <View style={shared.action}>
            <PrimaryButton
              label="Cancel pairing"
              secondary
              onPress={node.cancelPairing}
              testID="cancel-pairing"
            />
          </View>
        </Card>
      ) : null}

      {pairing.phase === 'confirming' ? (
        <Card testID="pairing-confirmation">
          <Heading>Compare the codes</Heading>
          <Body>
            Check that your node shows exactly this code. Pair only if they
            match.
          </Body>
          <Text
            accessibilityLabel={`Verification code ${pairing.verificationCode
              .split('')
              .join(' ')}`}
            style={styles.code}
            testID="verification-code"
          >
            {pairing.verificationCode}
          </Text>
          <Label>Name reported by the node (unverified)</Label>
          <Text style={styles.name}>
            {displayUntrustedName(pairing.nodeName)}
          </Text>
          {pairing.decision ? (
            <View style={shared.action}>
              <ActivityIndicator color={colors.moss} />
              <Body>
                {pairing.decision.choice === 'confirm'
                  ? 'Waiting for the node to approve…'
                  : 'Declining…'}
              </Body>
            </View>
          ) : (
            <View style={[shared.row, shared.action]}>
              <PrimaryButton
                label="Codes match"
                onPress={node.confirmPairing}
                testID="confirm-code"
              />
              <PrimaryButton
                label="Codes don’t match"
                secondary
                onPress={node.rejectPairing}
                testID="reject-code"
              />
            </View>
          )}
        </Card>
      ) : null}

      {pairing.phase === 'paired' ? (
        <Card testID="pairing-complete">
          <Heading>Paired</Heading>
          <Body>
            {displayUntrustedName(pairing.node.nodeName)} is now your active
            Private AI Node.
          </Body>
          <View style={shared.action}>
            <PrimaryButton
              label="Done"
              onPress={() => {
                resetPairing();
                onDone();
              }}
              testID="pairing-done"
            />
          </View>
        </Card>
      ) : null}

      {pairing.phase === 'failed' ? (
        <Card testID="pairing-failed">
          <Heading>Not paired</Heading>
          <FailureNotice
            presentation={presentFailure(pairing.failure)}
            actionLabel="Enter a new code"
            onAction={startOver}
            testID="pairing-failure"
          />
        </Card>
      ) : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  input: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 14,
    marginTop: 8,
    minHeight: 48,
    paddingHorizontal: 12,
  },
  name: { color: colors.ink, fontSize: 16, marginTop: 4 },
  code: {
    color: colors.ink,
    fontFamily: 'monospace',
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: 6,
    marginTop: 14,
    textAlign: 'center',
  },
});
