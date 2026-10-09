import {
  ERROR_CODES,
  LOCAL_REASONS,
  NODE_REASONS,
} from '@hybrid-ai/react-native';

import { checkAnalysisOutput } from '../src/features/private-node/domain/analysisResult';
import { assessCandidates } from '../src/features/private-node/domain/candidatePresentation';
import { presentConnection } from '../src/features/private-node/domain/connectionPresentation';
import { presentFailure } from '../src/features/private-node/domain/errorPresentation';
import {
  displayUntrustedName,
  shortNodeId,
} from '../src/features/private-node/domain/untrustedText';
import { NODE_ID, pairedRecord } from '../test/FakeHybridAiGateway';

describe('SDK error mapping (packaged 0.1.0-m5 tables)', () => {
  // Codes only an application request path can produce; each still maps to a
  // specific, non-generic presentation.
  const generic = new Set([
    'INVALID_ARGUMENT',
    'SCHEMA_VALIDATION_FAILED',
    'EXECUTION_FAILED',
    'REGISTRY_CONFLICT',
    'IDEMPOTENCY_CONFLICT',
  ]);

  it.each(ERROR_CODES.filter(code => !generic.has(code)))(
    'maps %s to specific copy and keeps the code',
    code => {
      const presented = presentFailure({ code });
      expect(presented.code).toBe(code);
      expect(presented.title).not.toBe('Something went wrong');
    },
  );

  it.each([...generic])('maps %s to a safe generic retry', code => {
    expect(presentFailure({ code })).toMatchObject({ code, action: 'retry' });
  });

  it('degrades an unknown future code to a retry without its message', () => {
    expect(presentFailure({ code: 'SOMETHING_NEW' })).toEqual({
      code: 'SOMETHING_NEW',
      title: 'Something went wrong',
      message: 'Nothing was changed. Try again.',
      action: 'retry',
    });
  });

  it.each(NODE_REASONS)(
    'explains NO_ELIGIBLE_TARGET with node reason %s',
    nodeReason => {
      const presented = presentFailure({
        code: 'NO_ELIGIBLE_TARGET',
        nodeReason,
      });
      expect(presented.code).toBe('NO_ELIGIBLE_TARGET');
      expect(presented.title).not.toBe('Something went wrong');
    },
  );

  it('keeps local reasons available for diagnostics', () => {
    expect(LOCAL_REASONS).toContain('local_not_advertised');
  });

  it('routes recovery to the right action', () => {
    expect(presentFailure({ code: 'NODE_TRUST_REVOKED' }).action).toBe(
      'forget_and_repair',
    );
    expect(presentFailure({ code: 'PAIRING_BOOTSTRAP_EXPIRED' }).action).toBe(
      'new_code',
    );
    expect(presentFailure({ code: 'DISCOVERY_PERMISSION_DENIED' }).action).toBe(
      'open_settings',
    );
    expect(
      presentFailure({
        code: 'NO_ELIGIBLE_TARGET',
        nodeReason: 'node_policy_disabled',
      }).action,
    ).toBe('review_policy');
  });
});

describe('discovery candidates are never trusted', () => {
  const candidate = (nodeId: string, instanceName: string) => ({
    nodeId,
    instanceName,
    endpointCount: 1,
    protocols: ['1.0'],
    pairingOpen: true,
  });

  it('flags paired-identity claims, conflicts, and look-alike names', () => {
    const views = assessCandidates(
      [
        candidate(NODE_ID, 'Study PC'),
        candidate('b'.repeat(32), 'Study​ PC'),
        candidate('c'.repeat(32), 'Kitchen'),
        candidate('d'.repeat(32), 'Twin'),
        candidate('d'.repeat(32), 'Twin'),
      ],
      [pairedRecord()],
    );
    expect(views.map(view => view.assessment)).toEqual([
      'claims_paired_identity',
      'lookalike_name',
      'unpaired',
      'conflicting_identity',
      'conflicting_identity',
    ]);
    expect(views.every(view => view.trusted === false)).toBe(true);
  });

  it('flags look-alike names among unpaired candidates', () => {
    expect(
      assessCandidates(
        [
          candidate('a'.repeat(32), 'Study PC'),
          candidate('b'.repeat(32), 'study pc'),
        ],
        [],
      ).map(view => view.assessment),
    ).toEqual(['lookalike_name', 'lookalike_name']);
  });
});

describe('untrusted node names', () => {
  it('removes controls and bidi overrides and isolates the result', () => {
    expect(displayUntrustedName('Study‮ PC\u0007')).toBe('⁨Study PC⁩');
  });

  it('bounds length and names empty values', () => {
    expect(displayUntrustedName('x'.repeat(100))).toHaveLength(50);
    expect(displayUntrustedName('​')).toBe('⁨Unnamed node⁩');
  });

  it('shortens node IDs for display', () => {
    expect(shortNodeId(NODE_ID)).toBe('a1b2c3d4');
  });
});

describe('connection presentation', () => {
  it('describes each state with text, not color alone', () => {
    const active = pairedRecord();
    expect(presentConnection('none', undefined, false).label).toBe(
      'No node paired',
    );
    expect(presentConnection('connected', active, false).label).toBe(
      'Connected',
    );
    expect(presentConnection('reconnecting', active, false)).toMatchObject({
      label: 'Reconnecting…',
      canReconnect: true,
    });
    expect(presentConnection('connected', active, true).label).toBe(
      'Connecting securely…',
    );
    expect(presentConnection('authentication_failed', active, false).tone).toBe(
      'danger',
    );
    expect(
      presentConnection('connected', pairedRecord({ state: 'revoked' }), false),
    ).toMatchObject({
      label: 'Trust revoked',
      canReconnect: false,
    });
  });
});

describe('document.analyze@1 result validation', () => {
  it('accepts a schema-valid result and reports only its shape', () => {
    expect(
      checkAnalysisOutput({
        summary: 'Plan the garden.',
        topics: ['garden', 'tomato'],
      }),
    ).toEqual({ valid: true, summaryLength: 16, topicCount: 2 });
  });

  it.each([
    null,
    'text',
    [],
    { unexpected: true },
    { summary: 'x'.repeat(81), topics: [] },
    { summary: 'ok', topics: ['short'] },
    { summary: 'ok', topics: ['garden', 'garden'] },
    {
      summary: 'ok',
      topics: ['garden1', 'garden2', 'garden3', 'garden4', 'garden5'],
    },
    { summary: 'ok', topics: [], extra: 1 },
  ])('rejects %p', output => {
    expect(checkAnalysisOutput(output).valid).toBe(false);
  });
});
