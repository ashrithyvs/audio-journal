import React from 'react';
import { ScrollView, Text, View } from 'react-native';

import { journalStyles } from '../../journal/ui/journalStyles';
import { usePrivateNode } from '../../private-node/application/PrivateNodeContext';
import {
  useOrganize,
  useOrganizeSnapshot,
} from '../application/OrganizeContext';
import {
  useNewestDerivations,
  useScopeHistory,
  useScopeStates,
} from '../application/useOrganized';
import type { SourceRef } from '../domain/contract';
import { scopeKeyOf } from '../domain/scope';
import { DerivationCard } from './DerivationCard';
import { RunStatus, styles as shared } from './organizeShared';

// The Organized view (UX §7, ADR-020): the newest revision of every scope,
// with stale items marked, partial results disclosed, explicit Reorganize
// (always with consent), and each scope's history.

export function OrganizedScreen({
  onOpenSource,
  onOpenHistory,
}: {
  onOpenSource(source: SourceRef): void;
  onOpenHistory(scopeKey: string): void;
}) {
  const organize = useOrganize();
  const load = useNewestDerivations();
  const derivations = load.phase === 'ready' ? load.value : [];
  const states = useScopeStates(derivations);
  const snapshot = useOrganizeSnapshot(organize?.controller);
  const { state, activeNode } = usePrivateNode();
  const ready = state.sdk.phase === 'ready' && activeNode !== undefined;
  const busy = snapshot.phase === 'running' || snapshot.phase === 'preparing';

  return (
    <ScrollView
      contentContainerStyle={journalStyles.content}
      style={journalStyles.page}
      testID="organized-screen"
    >
      <Text style={journalStyles.kicker}>ORGANIZED</Text>
      <Text style={journalStyles.title}>Organized</Text>
      <Text style={[journalStyles.muted, shared.gap]}>
        Views over your journal, made by your Private AI Node only when you ask.
        Your entries are never changed.
      </Text>
      {load.phase === 'loading' ? (
        <Text style={[journalStyles.muted, shared.gap]}>Loading…</Text>
      ) : load.phase === 'failed' ? (
        <Text style={journalStyles.error} testID="organized-failed">
          Organized results could not be opened right now.
        </Text>
      ) : derivations.length === 0 ? (
        <Text
          style={[journalStyles.muted, shared.gap]}
          testID="organized-empty"
        >
          Nothing organized yet. Open an entry and choose Organize.
        </Text>
      ) : null}
      {derivations.map((derivation, index) => {
        const scope = derivation.entryIds;
        const mine =
          organize !== undefined &&
          scopeKeyOf(organize.controller.scope) === derivation.scopeKey &&
          snapshot.phase !== 'idle';
        const scopeState = states.get(derivation.id);
        return (
          <DerivationCard
            key={derivation.id}
            derivation={derivation}
            testID={`organized-${index}`}
            staleness={scopeState?.staleness}
            entries={scopeState?.entries}
            onOpenSource={onOpenSource}
            onOpenHistory={() => onOpenHistory(derivation.scopeKey)}
            onReorganize={() => {
              organize?.controller.prepare(scope);
            }}
            reorganizeDisabled={!ready || busy}
            footer={
              mine && organize ? (
                <View testID={`organized-${index}-run`}>
                  <RunStatus
                    view={snapshot}
                    controller={organize.controller}
                    nodeName={activeNode?.nodeName ?? 'your node'}
                  />
                </View>
              ) : null
            }
          />
        );
      })}
    </ScrollView>
  );
}

/** Every revision of one scope, newest first; older ones are read-only. */
export function OrganizedHistoryScreen({
  scopeKey,
  onOpenSource,
}: {
  scopeKey: string;
  onOpenSource(source: SourceRef): void;
}) {
  const load = useScopeHistory(scopeKey);
  const revisions = load.phase === 'ready' ? load.value : [];
  const states = useScopeStates(revisions);
  return (
    <ScrollView
      contentContainerStyle={journalStyles.content}
      style={journalStyles.page}
      testID="organized-history"
    >
      <Text style={journalStyles.title}>History</Text>
      <Text style={[journalStyles.muted, shared.gap]}>
        Every result kept for these entries, newest first. Earlier results are
        never changed.
      </Text>
      {revisions.map(derivation => (
        <DerivationCard
          key={derivation.id}
          derivation={derivation}
          testID={`history-revision-${derivation.revision}`}
          staleness={states.get(derivation.id)?.staleness}
          entries={states.get(derivation.id)?.entries}
          onOpenSource={onOpenSource}
        />
      ))}
    </ScrollView>
  );
}
