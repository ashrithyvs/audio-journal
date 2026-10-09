import type {
  DiscoveryCandidate,
  PairedNodeRecord,
} from '../../../platform/hybrid-ai/HybridAiGateway';

// Discovery results are hints from the local network. None is ever presented
// as paired or trusted; trust exists only after the SDK authenticates a node
// with the key the user paired with. Classification helps the user notice
// impersonation attempts before they act.
export type CandidateAssessment =
  /** Announces the ID of a node this device paired with; still unverified. */
  | 'claims_paired_identity'
  /** Several announcements claim the same node ID. */
  | 'conflicting_identity'
  /** Reuses a paired node's name with a different node ID. */
  | 'lookalike_name'
  | 'unpaired';

export interface CandidateView {
  candidate: DiscoveryCandidate;
  assessment: CandidateAssessment;
  /** Always false: discovery never creates trust. */
  trusted: false;
}

const normalized = (name: string) =>
  name
    .normalize('NFKC')
    .replace(/[\s​-‏⁠-⁯]+/g, '')
    .toLowerCase();

export function assessCandidates(
  candidates: DiscoveryCandidate[],
  paired: PairedNodeRecord[],
): CandidateView[] {
  const idCounts = new Map<string, number>();
  const instanceIds = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    idCounts.set(candidate.nodeId, (idCounts.get(candidate.nodeId) ?? 0) + 1);
    const ids =
      instanceIds.get(normalized(candidate.instanceName)) ?? new Set();
    ids.add(candidate.nodeId);
    instanceIds.set(normalized(candidate.instanceName), ids);
  }
  const pairedIds = new Set(paired.map(node => node.nodeId));
  const pairedNames = new Map(
    paired.map(node => [normalized(node.nodeName), node.nodeId]),
  );

  return candidates.map(candidate => {
    const name = normalized(candidate.instanceName);
    let assessment: CandidateAssessment = 'unpaired';
    if ((idCounts.get(candidate.nodeId) ?? 0) > 1) {
      assessment = 'conflicting_identity';
    } else if (pairedIds.has(candidate.nodeId)) {
      assessment = 'claims_paired_identity';
    } else if (
      pairedNames.has(name) &&
      pairedNames.get(name) !== candidate.nodeId
    ) {
      assessment = 'lookalike_name';
    } else if ((instanceIds.get(name)?.size ?? 0) > 1) {
      assessment = 'lookalike_name';
    }
    return { candidate, assessment, trusted: false };
  });
}

export const assessmentCopy: Record<CandidateAssessment, string> = {
  claims_paired_identity:
    'Claims to be your paired node. Not verified until it proves its key.',
  conflicting_identity:
    'More than one device claims this identity. Possible impersonation.',
  lookalike_name:
    'Uses the same name as another node but a different identity. Possible impersonation.',
  unpaired: 'Not paired. Pair only with the code shown on your own node.',
};
