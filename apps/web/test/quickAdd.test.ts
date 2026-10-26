import { describe, expect, it } from 'vitest';
import { parseQuickAdd } from '../src/lib/quickAdd';

// 9:00 AM local, whatever the machine's time zone
const morning = new Date(2026, 9, 19, 9, 0);
const evening = new Date(2026, 9, 19, 19, 0);

describe('quick add', () => {
  it('reads a duration, a window and the kind of place', () => {
    const { block, chips } = parseQuickAdd('Gym 1h after 5pm', morning);
    expect(block).toMatchObject({ title: 'Gym', category: 'gym', maxMinutes: 60, earliest: '17:00', priority: 'should', date: '2026-10-19' });
    expect(block.fixedStart).toBeUndefined();
    expect(chips).toEqual(expect.arrayContaining(['1 h', 'After 5 PM', 'Gym', 'Today only']));
  });

  it('makes a set-time event with a place', () => {
    const { block } = parseQuickAdd('Lunch with Ana 12:30 at Greenbelt', morning);
    expect(block).toMatchObject({ title: 'Lunch with Ana', fixedStart: '12:30', fixedEnd: '13:15', fixedPlace: 'Greenbelt' });
  });

  it('reads ranges, borrowing am/pm from the end', () => {
    expect(parseQuickAdd('Standup 9:30-10am', morning).block).toMatchObject({ title: 'Standup', fixedStart: '09:30', fixedEnd: '10:00' });
    expect(parseQuickAdd('Class 1-3pm', morning).block).toMatchObject({ fixedStart: '13:00', fixedEnd: '15:00', minMinutes: 120 });
  });

  it('guesses the hour people mean without am/pm', () => {
    expect(parseQuickAdd('Groceries before 8', morning).block.latest).toBe('20:00');
    expect(parseQuickAdd('Coffee after 10', morning).block.earliest).toBe('10:00');
    expect(parseQuickAdd('Coffee after 10', evening).block.earliest).toBe('22:00');
    expect(parseQuickAdd('Run at 5', morning).block.fixedStart).toBe('17:00');
  });

  it('picks up needs, priority and routines', () => {
    const { block, chips } = parseQuickAdd('must deep work 2h wifi quiet every day', morning);
    // Asking for Wi-Fi is what makes it need a place.
    expect(block).toMatchObject({ priority: 'must', category: 'cafe', maxMinutes: 120, minMinutes: 90 });
    expect(block.requirements).toEqual(expect.arrayContaining(['wifi', 'quiet']));
    expect(block.date).toBeUndefined();
    expect(chips).toContain('Every day');
  });

  it('understands other ways to say how long', () => {
    expect(parseQuickAdd('Read half an hour', morning).block.maxMinutes).toBe(30);
    expect(parseQuickAdd('Write 1h30', morning).block.maxMinutes).toBe(90);
    expect(parseQuickAdd('Walk 1.5 hours', morning).block.maxMinutes).toBe(90);
    expect(parseQuickAdd('Call mom 20 min', morning).block).toMatchObject({ title: 'Call mom', maxMinutes: 20, category: 'none' });
  });

  it('gives meals a sensible window', () => {
    expect(parseQuickAdd('Lunch', morning).block).toMatchObject({ earliest: '11:00', latest: '14:30', category: 'restaurant' });
  });

  it('keeps what it does not understand and says so', () => {
    const r = parseQuickAdd('figure out the thing for the landlord about the leaky sink', morning);
    expect(r.block.title).toBe('Figure out the thing for the landlord about the leaky sink');
    expect(r.confident).toBe(false);
    expect(parseQuickAdd('Laundry', morning).confident).toBe(true);
  });
});

describe('work and study happen anywhere unless you say otherwise', () => {
  const morning = new Date('2026-10-20T09:00:00+08:00');
  it('writing, studying and emails need no place', () => {
    for (const text of ['Write report 2h', 'Study for two hours', 'Emails 30 min', 'Code review 1h']) {
      const { block, chips } = parseQuickAdd(text, morning);
      expect(block.category).toBe('none');
      expect(block.requirements).toEqual([]);
      expect(chips).not.toContain('Café');
    }
  });
  it('a café, Wi-Fi or quiet makes it a place to find', () => {
    expect(parseQuickAdd('Study at a café 2h', morning).block).toMatchObject({ category: 'cafe', requirements: ['wifi', 'power'] });
    expect(parseQuickAdd('Work 2h with wifi', morning).block).toMatchObject({ category: 'cafe', requirements: ['wifi'] });
    expect(parseQuickAdd('Study somewhere quiet 2h', morning).block).toMatchObject({ category: 'library', requirements: ['quiet'] });
    expect(parseQuickAdd('Study at the library', morning).block.category).toBe('library');
    expect(parseQuickAdd('Coffee with Ana', morning).block.category).toBe('cafe');
  });
});
