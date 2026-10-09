// Application-side validation of the generic `document.analyze@1` result used
// by AJ-3 diagnostics (AJ-FR-043). Output is untrusted until it passes here,
// and diagnostics keep only its shape, never its text (LLD §11).

export const ANALYZE_CAPABILITY = { id: 'document.analyze', version: '1' };
export const MAX_ANALYZE_INPUT_LENGTH = 4000;

export interface AnalysisCheck {
  valid: boolean;
  summaryLength?: number;
  topicCount?: number;
}

export function checkAnalysisOutput(output: unknown): AnalysisCheck {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    return { valid: false };
  }
  const record = output as Record<string, unknown>;
  const keys = Object.keys(record);
  const { summary, topics } = record;
  const valid =
    keys.every(key => key === 'summary' || key === 'topics') &&
    typeof summary === 'string' &&
    summary.length <= 80 &&
    Array.isArray(topics) &&
    topics.length <= 4 &&
    new Set(topics).size === topics.length &&
    topics.every(
      topic =>
        typeof topic === 'string' && topic.length >= 6 && topic.length <= 64,
    );
  return valid
    ? {
        valid,
        summaryLength: (summary as string).length,
        topicCount: (topics as unknown[]).length,
      }
    : { valid: false };
}
