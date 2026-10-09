import { performance } from 'node:perf_hooks';

import { assessCandidates } from '../src/features/private-node/domain/candidatePresentation';
import {
  initialPrivateNodeState,
  privateNodeReducer,
  type PrivateNodeState,
} from '../src/features/private-node/domain/privateNodeState';
import { pairedRecord } from '../test/FakeHybridAiGateway';

// Development-only bounds on this host: presentation work for discovery must
// stay negligible next to network settling (G4-A: ~1 s for small LANs).
const candidates = Array.from({ length: 64 }, (_, index) => ({
  nodeId: index.toString(16).padStart(32, '0'),
  instanceName: `Node ${index % 16}`,
  endpointCount: 1,
  protocols: ['1.0'],
  pairingOpen: index % 2 === 0,
}));

function p95(samples: number[]) {
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length * 0.95)];
}

it('assesses 64 discovery candidates well under a frame', () => {
  const paired = [
    pairedRecord({ nodeId: candidates[3].nodeId, nodeName: 'Node 3' }),
  ];
  const samples: number[] = [];
  for (let run = 0; run < 200; run += 1) {
    const started = performance.now();
    assessCandidates(candidates, paired);
    samples.push(performance.now() - started);
  }
  expect(p95(samples)).toBeLessThan(4);
});

it('reduces a 64-service discovery storm quickly', () => {
  const samples: number[] = [];
  for (let run = 0; run < 50; run += 1) {
    const started = performance.now();
    let state: PrivateNodeState = privateNodeReducer(initialPrivateNodeState, {
      type: 'DISCOVERY_STARTED',
      at: 0,
    });
    for (const [index, candidate] of candidates.entries()) {
      state = privateNodeReducer(state, {
        type: 'DISCOVERY_UPDATE',
        at: index,
        update: { type: 'found', candidate },
      });
      state = privateNodeReducer(state, {
        type: 'DISCOVERY_UPDATE',
        at: index,
        update: { type: 'updated', candidate },
      });
    }
    samples.push(performance.now() - started);
    expect(state.discovery.candidates).toHaveLength(64);
  }
  expect(p95(samples)).toBeLessThan(20);
});
