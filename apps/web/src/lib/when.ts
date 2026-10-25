/** Dates and times for notes and invitations, on this device's clock. */
import { clock } from './format';
import { localDate } from './model';
import { dayLabel, relativeDay } from './days';

/** "YYYY-MM-DD" + "HH:MM" on this device's clock → ISO; null if either is missing. */
export function toIso(date: string, time: string): string | null {
  if (!date || !time) return null;
  const d = new Date(`${date}T${time}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** ISO → this device's "YYYY-MM-DD" and "HH:MM". */
export function fromIso(iso: string | null | undefined): { date: string; time: string } {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  return { date: localDate(d), time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` };
}

/** "Today", "Tomorrow" or "Sat, Oct 31". */
export function dayWords(key: string, today = localDate()): string {
  return relativeDay(key, today) ?? dayLabel(key, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "Sat, Oct 31 · 3:00 – 5:00 PM", or "Time to be decided". */
export function whenWords(startsAt: string | null, endsAt: string | null, today = localDate()): string {
  if (!startsAt) return 'Time to be decided';
  const day = dayWords(localDate(new Date(startsAt)), today);
  return `${day} · ${clock(startsAt)}${endsAt ? ` – ${clock(endsAt)}` : ''}`;
}

/** The device's time zone name, e.g. "Asia/Manila". */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
