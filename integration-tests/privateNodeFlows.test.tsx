import React from 'react';
import { AppState } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';

import { AppRoot } from '../src/app/AppRoot';
import {
  EXPIRED_CODE,
  FakeHybridAiGateway,
  NODE_ID,
  pairedRecord,
  VALID_CODE,
} from '../test/FakeHybridAiGateway';
import { makeTestServices } from '../test/makeTestServices';
import {
  DIARY_COPY,
  flush,
  openDiagnostics,
  openNodeScreen,
  PIN,
  renderUnlocked,
  tab,
} from '../test/renderApp';

const candidate = (nodeId: string, instanceName: string) => ({
  nodeId,
  instanceName,
  endpointCount: 1,
  protocols: ['1.0'],
  pairingOpen: true,
});

describe('SDK lifecycle', () => {
  it('does not start the SDK until the journal is unlocked (AJ-FR-035)', async () => {
    const gateway = new FakeHybridAiGateway();
    const view = await render(
      <AppRoot
        services={makeTestServices({ configuredPin: PIN, hybridAI: gateway })}
      />,
    );
    await view.findByText('Welcome back');
    expect(gateway.calls).not.toContain('initialize');
    await fireEvent.changeText(view.getByTestId('unlock-pin'), PIN);
    await fireEvent.press(view.getByText('Unlock'));
    await view.findByText(DIARY_COPY);
    await flush();
    expect(gateway.calls).toContain('initialize');
    expect(gateway.policy).toEqual({ allowLocal: true, allowNode: true });
  });

  it('shows an unavailable SDK without blocking the journal and retries', async () => {
    const gateway = new FakeHybridAiGateway();
    gateway.initResult = {
      state: 'unavailable',
      code: 'SDK_INITIALIZATION_FAILED',
      packageVersion: '0.1.0-m5',
    };
    const { view } = await renderUnlocked(gateway);
    await openNodeScreen(view).catch(() => {});
    expect(await view.findByText('Private AI is unavailable')).toBeTruthy();
    gateway.initResult = {
      state: 'ready',
      capabilityCount: 0,
      packageVersion: '0.1.0-m5',
    };
    await fireEvent.press(view.getByText('Try again'));
    expect(await view.findByText('No node paired')).toBeTruthy();
  });

  it('reconnects an active paired node after unlock', async () => {
    const gateway = new FakeHybridAiGateway();
    gateway.paired = [pairedRecord()];
    const { view } = await renderUnlocked(gateway);
    await openNodeScreen(view);
    expect(await view.findByText('Connected')).toBeTruthy();
    expect(view.getByText('Paired · Active')).toBeTruthy();
    expect(gateway.calls).toContain('connect');
  });
});

describe('discovery', () => {
  it('shows searching, empty, and untrusted candidate states', async () => {
    const { view, gateway } = await renderUnlocked();
    await openNodeScreen(view);
    await fireEvent.press(view.getByTestId('start-discovery'));
    expect(view.getByText('Searching this network…')).toBeTruthy();
    expect(view.getByText('No nodes found yet.')).toBeTruthy();
    await act(async () => {
      gateway.emitDiscovery({
        type: 'found',
        candidate: candidate(NODE_ID, 'Study PC'),
      });
    });
    expect(view.getByText('⁨Study PC⁩')).toBeTruthy();
    expect(view.getByText('Unverified')).toBeTruthy();
    expect(view.queryByText(/Paired ·/)).toBeNull();
    await fireEvent.press(view.getByTestId('stop-discovery'));
    expect(gateway.calls).toContain('stopDiscovery');
  });

  it('explains denied local-network permission and keeps code pairing available', async () => {
    const gateway = new FakeHybridAiGateway();
    gateway.discoveryFailure = { code: 'DISCOVERY_PERMISSION_DENIED' };
    const { view } = await renderUnlocked(gateway);
    await openNodeScreen(view);
    await fireEvent.press(view.getByTestId('start-discovery'));
    expect(await view.findByText('Local network access is off')).toBeTruthy();
    expect(view.getByText('Open settings')).toBeTruthy();
    expect(view.getByTestId('pair-node')).toBeTruthy();
  });

  it('offers a retry after a discovery failure', async () => {
    const gateway = new FakeHybridAiGateway();
    gateway.discoveryFailure = { code: 'DISCOVERY_FAILED' };
    const { view } = await renderUnlocked(gateway);
    await openNodeScreen(view);
    await fireEvent.press(view.getByTestId('start-discovery'));
    expect(await view.findByText('Couldn’t search nearby')).toBeTruthy();
    gateway.discoveryFailure = undefined;
    await fireEvent.press(view.getByText('Search again'));
    expect(view.getByText('Searching this network…')).toBeTruthy();
  });

  it('identifies a spoofed candidate claiming the paired identity', async () => {
    const gateway = new FakeHybridAiGateway();
    gateway.paired = [pairedRecord()];
    const { view } = await renderUnlocked(gateway);
    await openNodeScreen(view);
    await fireEvent.press(view.getByTestId('start-discovery'));
    await act(async () => {
      gateway.emitDiscovery({
        type: 'found',
        candidate: candidate(NODE_ID, 'Study PC'),
      });
      gateway.emitDiscovery({
        type: 'found',
        candidate: candidate('b'.repeat(32), 'Study PC'),
      });
    });
    expect(
      view.getAllByText('Unverified · Possible impersonation'),
    ).toHaveLength(2);
    expect(
      view.getByText(
        'Claims to be your paired node. Not verified until it proves its key.',
      ),
    ).toBeTruthy();
    expect(view.getByText('Connected')).toBeTruthy();
  });
});

describe('pairing', () => {
  async function enterCode(
    view: Awaited<ReturnType<typeof render>>,
    code: string,
  ) {
    await fireEvent.press(view.getByTestId('pair-node'));
    await fireEvent.changeText(
      await view.findByTestId('pairing-code-input'),
      code,
    );
    await fireEvent.press(view.getByTestId('check-code'));
  }

  it('pairs only after the user confirms the verification code', async () => {
    const { view, gateway } = await renderUnlocked();
    await openNodeScreen(view);
    await enterCode(view, VALID_CODE);
    expect(await view.findByText('Pair with this node?')).toBeTruthy();
    // The one-time code leaves the input as soon as it is checked.
    expect(view.queryByDisplayValue(VALID_CODE)).toBeNull();
    await fireEvent.press(view.getByTestId('begin-pairing'));
    expect(view.getByText('Connecting securely…')).toBeTruthy();
    await act(async () => {
      gateway.emitPairing({
        type: 'confirmationRequired',
        nodeName: 'Study‮ PC',
        verificationCode: '493436',
      });
    });
    expect(view.getByTestId('verification-code').props.children).toBe('493436');
    expect(view.getByText('⁨Study PC⁩')).toBeTruthy();
    expect(gateway.paired).toEqual([]);
    await fireEvent.press(view.getByTestId('confirm-code'));
    expect(gateway.calls).toContain('confirmPairing');
    expect(view.getByText('Waiting for the node to approve…')).toBeTruthy();
    await act(async () => {
      gateway.emitPairing({ type: 'paired', node: pairedRecord() });
    });
    expect(view.getByText('Paired')).toBeTruthy();
    await flush();
    expect(gateway.calls).toContain('connect');
    expect(gateway.lastPairingCode).toBe(VALID_CODE);
    await fireEvent.press(view.getByTestId('pairing-done'));
    expect(await view.findByText('Connected')).toBeTruthy();
  });

  it('rejects an expired code with a new-code action', async () => {
    const { view, gateway } = await renderUnlocked();
    await openNodeScreen(view);
    await enterCode(view, EXPIRED_CODE);
    expect(await view.findByText('This pairing code has expired')).toBeTruthy();
    expect(view.getByText('Code: PAIRING_BOOTSTRAP_EXPIRED')).toBeTruthy();
    expect(gateway.calls).not.toContain('pair');
    await fireEvent.press(view.getByText('Enter a new code'));
    expect(view.getByTestId('pairing-code-input')).toBeTruthy();
  });

  it('rejects an invalid code', async () => {
    const { view } = await renderUnlocked();
    await openNodeScreen(view);
    await enterCode(view, 'not a code');
    expect(
      await view.findByText('That isn’t a valid pairing code'),
    ).toBeTruthy();
  });

  it('declines on a code mismatch and can be cancelled while connecting', async () => {
    const { view, gateway } = await renderUnlocked();
    await openNodeScreen(view);
    await enterCode(view, VALID_CODE);
    await fireEvent.press(await view.findByTestId('begin-pairing'));
    await act(async () => {
      gateway.emitPairing({
        type: 'confirmationRequired',
        nodeName: 'Study PC',
        verificationCode: '1',
      });
    });
    await fireEvent.press(view.getByTestId('reject-code'));
    expect(await view.findByText('Pairing was declined')).toBeTruthy();
    await fireEvent.press(view.getByText('Enter a new code'));
    await fireEvent.changeText(
      view.getByTestId('pairing-code-input'),
      VALID_CODE,
    );
    await fireEvent.press(view.getByTestId('check-code'));
    await fireEvent.press(await view.findByTestId('begin-pairing'));
    await fireEvent.press(view.getByTestId('cancel-pairing'));
    expect(
      await view.findByText('Pairing was cancelled. Nothing was paired.'),
    ).toBeTruthy();
    expect(gateway.paired).toEqual([]);
  });
});

describe('paired node status, recovery, and trust', () => {
  it('retries a failed secure reconnect', async () => {
    const gateway = new FakeHybridAiGateway();
    gateway.paired = [pairedRecord()];
    gateway.connectFailure = { code: 'NODE_UNAVAILABLE' };
    gateway.linkStatus = { state: 'unavailable', nodeId: NODE_ID };
    const { view } = await renderUnlocked(gateway);
    await openNodeScreen(view);
    expect(await view.findByText('Private AI Node unavailable')).toBeTruthy();
    expect(view.getByText('Unavailable')).toBeTruthy();
    // One Reconnect, not one per notice and status (AJ-3 report F3).
    expect(view.getAllByText('Reconnect')).toHaveLength(1);
    gateway.connectFailure = undefined;
    await fireEvent.press(view.getByTestId('reconnect'));
    expect(await view.findByText('Connected')).toBeTruthy();
  });

  it.each([
    ['Unavailable', 'NODE_UNAVAILABLE', 'unavailable', 1, false],
    [
      'Identity check failed',
      'NODE_AUTHENTICATION_FAILED',
      'authentication_failed',
      1,
      false,
    ],
    ['Connected', undefined, undefined, 0, false],
    ['Trust revoked', 'NODE_TRUST_REVOKED', undefined, 0, true],
    ['Pairing key unavailable', 'CREDENTIAL_UNAVAILABLE', undefined, 0, true],
  ] as const)(
    '%s offers one recovery action (UX §7.1, AJ-3 report F3)',
    async (label, code, status, reconnects, repair) => {
      const gateway = new FakeHybridAiGateway();
      gateway.paired = [pairedRecord()];
      if (code) {
        gateway.connectFailure = { code };
      }
      if (status) {
        gateway.linkStatus = { state: status, nodeId: NODE_ID };
      }
      const { view } = await renderUnlocked(gateway);
      await openNodeScreen(view);
      expect(view.getByTestId('node-connection-state')).toHaveTextContent(
        label,
      );
      expect(view.queryAllByText('Reconnect')).toHaveLength(reconnects);
      expect(view.queryAllByTestId('reconnect')).toHaveLength(reconnects);
      expect(view.queryByTestId('forget-and-repair') !== null).toBe(repair);
    },
  );

  it('shows revoked trust and recovers by forgetting then pairing again', async () => {
    const gateway = new FakeHybridAiGateway();
    gateway.paired = [pairedRecord()];
    gateway.connectFailure = { code: 'NODE_TRUST_REVOKED' };
    const { view } = await renderUnlocked(gateway);
    await openNodeScreen(view);
    expect(await view.findByText('Trust revoked')).toBeTruthy();
    expect(view.queryByTestId('reconnect')).toBeNull();
    gateway.connectFailure = undefined;
    await fireEvent.press(view.getByTestId('forget-and-repair'));
    expect(await view.findByTestId('pairing-code-input')).toBeTruthy();
    expect(gateway.calls).toContain('forget');
    expect(gateway.paired).toEqual([]);
  });

  it('forgets a node and reports an unconfirmed node-side removal', async () => {
    const gateway = new FakeHybridAiGateway();
    gateway.paired = [pairedRecord()];
    gateway.forgetConfirmed = false;
    const { view } = await renderUnlocked(gateway);
    await openNodeScreen(view);
    await view.findByText('Connected');
    await fireEvent.press(view.getByTestId('forget-node'));
    expect(
      await view.findByText(/couldn’t be reached to\s+confirm/),
    ).toBeTruthy();
    expect(view.getByText('No node paired')).toBeTruthy();
  });

  it('applies the routing policy through the SDK', async () => {
    const { view, gateway } = await renderUnlocked();
    await openNodeScreen(view);
    await fireEvent(
      view.getByTestId('policy-allow-node'),
      'valueChange',
      false,
    );
    expect(view.getByText('Use Private AI Node: Off')).toBeTruthy();
    expect(gateway.policy).toEqual({ allowLocal: true, allowNode: false });
  });
});

describe('diagnostics request', () => {
  it('shows target, routing reason, and a validated result without content', async () => {
    const gateway = new FakeHybridAiGateway();
    gateway.paired = [pairedRecord()];
    const { view } = await renderUnlocked(gateway);
    await openDiagnostics(view);
    await fireEvent.press(view.getByTestId('diag-run'));
    expect(view.getByText('running')).toBeTruthy();
    expect(gateway.lastRequest).toMatchObject({
      capability: 'document.analyze',
      version: '1',
      execution: 'auto',
      timeoutMs: 30_000,
    });
    await act(async () => {
      gateway.emitRun({ type: 'accepted' });
      gateway.emitRun({
        type: 'completed',
        output: { summary: 'Private summary text', topics: ['garden'] },
        target: 'node',
        routingReason: 'only_eligible_node',
      });
    });
    expect(view.getByTestId('diag-request-target').props.children).toBe('node');
    expect(view.getByTestId('diag-request-reason').props.children).toBe(
      'only_eligible_node',
    );
    expect(view.getByText('valid · 1 topics')).toBeTruthy();
    expect(view.queryByText(/Private summary text/)).toBeNull();
  });

  it('shows typed failure reasons and retries', async () => {
    const { view, gateway } = await renderUnlocked();
    await openDiagnostics(view);
    await fireEvent.press(view.getByTestId('diag-target-node'));
    await fireEvent.press(view.getByTestId('diag-run'));
    await act(async () => {
      gateway.emitRun({
        type: 'failed',
        failure: { code: 'NO_ELIGIBLE_TARGET', nodeReason: 'node_not_paired' },
      });
    });
    expect(view.getByText('No Private AI Node is paired')).toBeTruthy();
    expect(view.getByTestId('diag-request-node-reason').props.children).toBe(
      'node_not_paired',
    );
    await fireEvent.press(view.getByText('Retry request'));
    expect(gateway.lastRequest?.execution).toBe('node');
  });

  it('cancels a running request and honors the selected deadline', async () => {
    const { view, gateway } = await renderUnlocked();
    await openDiagnostics(view);
    await fireEvent.press(view.getByTestId('diag-deadline-5000'));
    await fireEvent.press(view.getByTestId('diag-run'));
    expect(gateway.lastRequest?.timeoutMs).toBe(5_000);
    await fireEvent.press(view.getByTestId('diag-cancel'));
    expect(await view.findByText('cancelled')).toBeTruthy();
    expect(gateway.running).toBe(0);
  });

  it('discards a malformed result', async () => {
    const { view, gateway } = await renderUnlocked();
    await openDiagnostics(view);
    await fireEvent.press(view.getByTestId('diag-run'));
    await act(async () => {
      gateway.emitRun({
        type: 'completed',
        output: { unexpected: true },
        target: 'node',
        routingReason: 'explicit_node',
      });
    });
    expect(view.getByText('discarded · invalid format')).toBeTruthy();
  });
});

describe('lock lifecycle', () => {
  it('relocks on background and cancels pairing, discovery, and requests', async () => {
    const listeners: Array<(state: string) => void> = [];
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _type: string,
      listener: (state: string) => void,
    ) => {
      listeners.push(listener);
      return { remove: () => {} };
    }) as never);
    try {
      const gateway = new FakeHybridAiGateway();
      gateway.paired = [pairedRecord()];
      const { view } = await renderUnlocked(gateway);
      await openDiagnostics(view);
      await fireEvent.press(view.getByTestId('diag-run'));
      await fireEvent.press(tab(view, 'Settings'));
      await fireEvent.press(await view.findByTestId('open-private-node'));
      await fireEvent.press(view.getByTestId('start-discovery'));
      await fireEvent.press(view.getByText('Pair another node'));
      await fireEvent.changeText(
        await view.findByTestId('pairing-code-input'),
        VALID_CODE,
      );
      await fireEvent.press(view.getByTestId('check-code'));
      await fireEvent.press(await view.findByTestId('begin-pairing'));
      await act(async () => {
        listeners.forEach(listener => listener('background'));
      });
      expect(await view.findByText('Welcome back')).toBeTruthy();
      expect(gateway.calls).toEqual(
        expect.arrayContaining(['cancelPairing', 'stopDiscovery', 'cancel']),
      );
      expect(gateway.running).toBe(0);
      expect(gateway.discovering).toBe(false);
      // Trust and the connection survive locking.
      expect(gateway.paired).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
