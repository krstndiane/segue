import { describe, expect, it } from 'vitest';
import { syncedWhen } from '../src/components/CalendarConnection';
import { participantsWords } from '../src/components/together/Plans';

const ana = { id: 'a', displayName: 'Ana', username: 'ana', avatarUrl: null } as never;

describe('Last synced, in words', () => {
  const now = new Date(2026, 10, 4, 15, 0);
  it('says today, yesterday, or the date', () => {
    expect(syncedWhen(new Date(2026, 10, 4, 9, 5).toISOString(), now)).toMatch(/^today at 9:05\sAM$/);
    expect(syncedWhen(new Date(2026, 10, 3, 21, 0).toISOString(), now)).toMatch(/^yesterday at 9:00\sPM$/);
    expect(syncedWhen(new Date(2026, 9, 28, 8, 15).toISOString(), now)).toMatch(/^Oct 28 at 8:15\sAM$/);
  });
});

describe('participants on a shared plan', () => {
  it('counts the owner and everyone going, never who', () => {
    expect(participantsWords({ goingCount: 0, author: ana, mine: false })).toBe('Just Ana so far');
    expect(participantsWords({ goingCount: 0, author: ana, mine: true })).toBe('Just you so far');
    expect(participantsWords({ goingCount: 2, author: ana, mine: false })).toBe('3 participants');
  });
  it('says nothing when the server sent no count', () => {
    expect(participantsWords({ goingCount: undefined, author: ana, mine: false })).toBeNull();
  });
});
