import { describe, expect, it } from 'vitest';
import type { UsernameAvailability } from '@segue/schemas';
import { localUsernameState, UsernameChecker, type UsernameState } from '../src/lib/usernameCheck';

/** A checker with a hand-cranked clock and answers the test controls. */
function rig() {
  const states: UsernameState[] = [];
  const asked: string[] = [];
  const pending: { name: string; signal: AbortSignal; ok: (a: UsernameAvailability) => void; fail: (e: Error) => void }[] = [];
  const timers: { fn: () => void; ms: number; id: number; live: boolean }[] = [];
  const checker = new UsernameChecker({
    onState: (s) => states.push(s),
    ask: (name, signal) =>
      new Promise((ok, fail) => {
        asked.push(name);
        pending.push({ name, signal, ok, fail });
      }),
    setTimer: (fn, ms) => {
      const t = { fn, ms, id: timers.length, live: true };
      timers.push(t);
      return t.id;
    },
    clearTimer: (id) => void (timers[id as number]!.live = false),
  });
  const tick = () => timers.filter((t) => t.live).forEach((t) => ((t.live = false), t.fn()));
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const last = () => states[states.length - 1]!;
  return { checker, states, asked, pending, timers, tick, flush, last };
}
const answer = (username: string, available: boolean, extra: Partial<UsernameAvailability> = {}): UsernameAvailability => ({ username, available, reason: available ? null : 'taken', ...extra });

describe('username messages without the server', () => {
  it('says nothing alarming before a meaningful value', () => {
    expect(localUsernameState('')?.status).toBe('empty');
    expect(localUsernameState('d')).toMatchObject({ status: 'hint' });
    expect(localUsernameState('di')).toMatchObject({ status: 'hint', message: expect.stringContaining('3 to 20') });
  });
  it('names the exact problem for malformed input', () => {
    expect(localUsernameState('2dia')).toMatchObject({ status: 'invalid', message: 'Username must start with a letter.' });
    expect(localUsernameState('dia aviles')).toMatchObject({ status: 'invalid', message: 'Only letters, numbers and underscores are allowed.' });
    expect(localUsernameState('dia__x')?.message).toBe("Consecutive underscores aren't allowed.");
    expect(localUsernameState('dia_')?.message).toBe("Username can't start or end with an underscore.");
    expect(localUsernameState('a'.repeat(21))?.message).toMatch(/3 to 20/);
    expect(localUsernameState('admin')).toMatchObject({ status: 'reserved', message: 'This username is reserved.' });
  });
  it('needs a server check only for a well-formed name', () => {
    expect(localUsernameState('dia_aviles')).toBeNull();
  });
  it("accepts the person's own name unchanged, even an older one that breaks today's rules", () => {
    expect(localUsernameState('Dia_Aviles', 'dia_aviles')?.status).toBe('yours');
    expect(localUsernameState('old__name', 'old__name')?.status).toBe('yours');
  });
});

describe('username availability checker', () => {
  it('waits for a pause in typing and asks once', async () => {
    const r = rig();
    for (const t of ['dia', 'dia_', 'dia_a', 'dia_av']) r.checker.update(t);
    expect(r.asked).toEqual([]);
    expect(r.last().status).toBe('checking');
    r.tick();
    expect(r.asked).toEqual(['dia_av']);
    r.pending[0]!.ok(answer('dia_av', true));
    await r.flush();
    expect(r.last()).toMatchObject({ status: 'available', message: 'Username is available.' });
  });

  it('does not ask while the name is malformed, reserved or its own', () => {
    const r = rig();
    r.checker.update('2dia');
    r.checker.update('admin');
    r.checker.update('Mine', 'mine');
    r.tick();
    expect(r.asked).toEqual([]);
  });

  it('ignores an old answer that arrives after a newer one', async () => {
    const r = rig();
    r.checker.update('first_name');
    r.tick();
    r.checker.update('second_name');
    r.tick();
    expect(r.pending[0]!.signal.aborted).toBe(true);
    r.pending[1]!.ok(answer('second_name', true));
    await r.flush();
    r.pending[0]!.ok(answer('first_name', false, { suggestions: ['x_y_z'] })); // late
    await r.flush();
    expect(r.last()).toMatchObject({ status: 'available' });
  });

  it('shows a taken name with checked suggestions', async () => {
    const r = rig();
    r.checker.update('dia');
    r.tick();
    r.pending[0]!.ok(answer('dia', false, { suggestions: ['dia2026', 'dia_notes'] }));
    await r.flush();
    expect(r.last()).toMatchObject({ status: 'taken', message: 'Username is already taken.', suggestions: ['dia2026', 'dia_notes'] });
  });

  it('reports a failed check and can try again', async () => {
    const r = rig();
    r.checker.update('dia_a');
    r.tick();
    r.pending[0]!.fail(new Error('offline'));
    await r.flush();
    expect(r.last()).toMatchObject({ status: 'error', message: 'Unable to check availability. Please try again.' });
    r.checker.retry();
    r.tick();
    expect(r.asked).toEqual(['dia_a', 'dia_a']);
  });

  it('shows a conflict from saving and looks up fresh suggestions', async () => {
    const r = rig();
    r.checker.update('dia_a', undefined);
    r.checker.markTaken('dia_a');
    expect(r.last()).toMatchObject({ status: 'taken', message: 'That username was just taken. Pick another one.' });
    r.pending[r.pending.length - 1]!.ok(answer('dia_a', false, { suggestions: ['dia_a2026'] }));
    await r.flush();
    expect(r.last()).toMatchObject({ status: 'taken', suggestions: ['dia_a2026'], message: 'That username was just taken. Pick another one.' });
  });

  it('stops answering after it is disposed', async () => {
    const r = rig();
    r.checker.update('dia_a');
    r.tick();
    const before = r.states.length;
    r.checker.dispose();
    r.pending[0]!.ok(answer('dia_a', true));
    await r.flush();
    expect(r.states.length).toBe(before);
  });
});
