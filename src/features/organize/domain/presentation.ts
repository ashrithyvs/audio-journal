import type { OrganizeOutput } from './contract';

// How a result's completeness is told to the user (contract §3.2, UX §7):
// a partial result always says that lower-ranked items were left out, and
// how many of each kind.

const NAMES = {
  sections: ['Work or Personal item', 'Work or Personal items'],
  tasks: ['task', 'tasks'],
  ideas: ['idea', 'ideas'],
  people: ['person', 'people'],
  projects: ['project', 'projects'],
} as const;

/** The disclosure for a partial result; undefined when it is complete. */
export function omissionNotice(output: OrganizeOutput): string | undefined {
  if (output.completeness !== 'partial' || !output.omitted) {
    return undefined;
  }
  const parts = (Object.keys(NAMES) as (keyof typeof NAMES)[])
    .filter(kind => (output.omitted?.[kind] ?? 0) > 0)
    .map(kind => {
      const n = output.omitted![kind]!;
      return `${n} ${NAMES[kind][n === 1 ? 0 : 1]}`;
    });
  return `This result is partial. Some lower-ranked items were omitted to fit: ${parts.join(
    ', ',
  )}.`;
}
