// Tasks view (UX §7, ADR-020): open tasks grouped by due date against the
// device's current local date, then done and dismissed. Due dates are
// calendar dates (contract §3.3), compared as ISO strings; they never move
// with the device's time zone.

import type { TaskState } from '../ports/DerivationRepository';

export type TaskGroup =
  | 'overdue'
  | 'today'
  | 'upcoming'
  | 'undated'
  | 'done'
  | 'dismissed';

export const TASK_GROUPS: readonly TaskGroup[] = [
  'overdue',
  'today',
  'upcoming',
  'undated',
  'done',
  'dismissed',
];

export const GROUP_TITLES: Record<TaskGroup, string> = {
  overdue: 'Overdue',
  today: 'Today',
  upcoming: 'Upcoming',
  undated: 'No date',
  done: 'Done',
  dismissed: 'Dismissed',
};

/** The group of a task, given today's local ISO date. */
export function taskGroup(
  state: TaskState,
  dueDate: string | undefined,
  today: string,
): TaskGroup {
  if (state === 'done' || state === 'dismissed') {
    return state;
  }
  if (!dueDate) {
    return 'undated';
  }
  return dueDate < today ? 'overdue' : dueDate === today ? 'today' : 'upcoming';
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** "Fri 23 Oct 2026" for an ISO calendar date (no time zone involved). */
export function formatCalendarDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[day]} ${d} ${MONTHS[m - 1]} ${y}`;
}

/** The due label of a task row. */
export function dueLabel(dueDate: string, today: string): string {
  if (dueDate === today) {
    return 'Due today';
  }
  const date = formatCalendarDate(dueDate);
  return dueDate < today ? `Overdue · ${date}` : `Due ${date}`;
}
