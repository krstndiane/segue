import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AlternativeOption, AlternativeTrigger, Place, PlaceCategory } from '@segue/engine';
import type { AlternativesOutcome } from '../lib/alternatives';
import { answer, describeOptions, describePlaces, snapshotFor, type AssistantAction, type AssistantButton, type AssistantContext, type AssistantReply, type Topic } from '../lib/assistant';
import type { AssistantAiAnswer } from '../lib/social';

interface Message {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  bullets?: string[];
  buttons?: AssistantButton[];
  /** a confirmation waiting for an answer */
  confirm?: AssistantButton;
  tone?: 'error';
}

interface Props {
  ctx: Omit<AssistantContext, 'options'>;
  /** AI wording is available (server has it on, and you're signed in) */
  ai: boolean;
  online: boolean;
  onClose: () => void;
  runOptions: (blockId: string, trigger?: AlternativeTrigger, maxMinutes?: number) => Promise<AlternativesOutcome>;
  findPlaces: (category: Exclude<PlaceCategory, 'none'>) => Promise<{ places: Place[]; source: 'server' | 'device' }>;
  /** apply an option; returns what changed, in words */
  useOption: (option: AlternativeOption) => string;
  move: (blockId: string, hhmm: string) => string;
  replan: () => void;
  openItem: (blockId: string) => void;
  askAi: (body: unknown) => Promise<AssistantAiAnswer>;
}

const STARTERS = ["What's next?", 'Do I have free time this afternoon?', "Why doesn't something fit?", 'Reorganize the rest of my day'];

/**
 * Ask about your day. A side panel on wide screens, full screen on phones,
 * over the page rather than squeezing it. Answers come from the plan; nothing
 * changes without a "Yes" here.
 */
export function AssistantPanel(props: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [topic, setTopic] = useState<Topic>({});
  const [options, setOptions] = useState<AlternativesOutcome | null>(null);
  const nextId = useRef(1);
  const input = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const close = useRef(props.onClose);
  close.current = props.onClose;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, []);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [messages, busy]);

  const ctx = (): AssistantContext => ({ ...props.ctx, options });
  const push = (m: Omit<Message, 'id'>) => setMessages((list) => [...list, { ...m, id: nextId.current++ }]);
  const say = (r: AssistantReply, tone?: 'error') => {
    push({ role: 'assistant', text: r.text, bullets: r.bullets, buttons: r.buttons, tone });
    if (r.topic) setTopic(r.topic);
  };

  /** Look something up (options, places), then say what was found. */
  async function run(action: AssistantAction) {
    if (action.type === 'options') {
      const o = await props.runOptions(action.blockId, action.trigger, action.maxMinutes);
      setOptions(o);
      return describeOptions(o, { ...ctx(), options: o });
    }
    if (action.type === 'find-places') {
      const found = await props.findPlaces(action.category);
      return describePlaces(found.places, action.category, ctx(), { openNow: action.openNow, source: found.source });
    }
    return null;
  }

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setText('');
    push({ role: 'user', text: q });
    setBusy(true);
    try {
      let reply = answer(q, ctx(), topic);
      if (reply.run) {
        // Offline, both of these fall back to what the phone has, and say so.
        const found = await run(reply.run);
        if (found) reply = { ...found, topic: { ...reply.topic, ...found.topic } };
      }
      // With AI on, the same facts in more natural words; the actions stay Segue's own.
      if (props.ai && props.online && !reply.run) {
        try {
          const history = messages.slice(-6).map((m) => ({ role: m.role, text: [m.text, ...(m.bullets ?? [])].join('\n').slice(0, 400) }));
          const ai = await props.askAi({ question: q, draft: [reply.text, ...(reply.bullets ?? [])].join('\n').slice(0, 2000), snapshot: snapshotFor(ctx()), history });
          const extra = ai.action ? aiButton(ai.action, ctx()) : undefined;
          reply = { ...reply, text: ai.answer, bullets: undefined, buttons: reply.buttons ?? (extra ? [extra] : undefined) };
        } catch {
          // The plain answer is already right; keep it.
        }
      }
      say(reply);
    } catch {
      say({ text: props.online ? "Couldn't check that just now. Try again in a moment." : "You're offline, and that needs a connection. Your plan and its reasons still work." }, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function press(b: AssistantButton, messageId: number) {
    if (b.confirm) {
      setMessages((list) => list.map((m) => (m.id === messageId ? { ...m, confirm: b } : m)));
      return;
    }
    await act(b.action);
  }

  async function act(action: AssistantAction) {
    try {
      switch (action.type) {
        case 'replan':
          props.replan();
          say({ text: 'The proposal is open. Nothing changes until you tap “Use this plan”.' });
          return;
        case 'open-item':
          props.openItem(action.blockId);
          return;
        case 'move':
          say({ text: props.move(action.blockId, action.hhmm) });
          return;
        case 'use-option': {
          const o = options?.result.options.find((x) => x.id === action.optionId);
          if (!o) {
            say({ text: "That option isn't current any more. Ask again and I'll check what works now." }, 'error');
            return;
          }
          say({ text: props.useOption(o) });
          setOptions(null);
          return;
        }
        default: {
          setBusy(true);
          const r = await run(action);
          if (r) say(r);
        }
      }
    } catch {
      say({ text: "That didn't work, so nothing changed. Try again." }, 'error');
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void ask(text);
  }

  return (
    <div className="assistant-panel" role="dialog" aria-modal="false" aria-labelledby="assistant-title">
      <div className="assistant-head">
        <div>
          <h2 id="assistant-title">Ask about your day</h2>
          <p className="muted small">{props.ai ? 'Answers come from your plan, worded by AI.' : 'Answers come straight from your plan.'}{props.online ? '' : ' Offline: live checks are paused.'}</p>
        </div>
        <button type="button" className="icon-button" onClick={props.onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="assistant-log" ref={log} aria-live="polite">
        {messages.length === 0 && (
          <div className="assistant-empty">
            <p className="muted">Ask why something moved, what fits, or what to do instead. I won't change anything without asking.</p>
            <div className="chips">
              {STARTERS.map((s) => (
                <button key={s} type="button" className="chip" onClick={() => void ask(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`assistant-msg ${m.role}${m.tone ? ` ${m.tone}` : ''}`}>
            <span className="visually-hidden">{m.role === 'user' ? 'You said: ' : 'Segue: '}</span>
            <p>{m.text}</p>
            {m.bullets && m.bullets.length > 0 && (
              <ul>
                {m.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
            {m.confirm ? (
              <div className="assistant-confirm" role="group" aria-label="Confirm">
                <p>{m.confirm.confirm}</p>
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    const c = m.confirm!;
                    setMessages((list) => list.map((x) => (x.id === m.id ? { ...x, confirm: undefined, buttons: undefined } : x)));
                    void act(c.action);
                  }}
                >
                  Yes
                </button>
                <button type="button" className="text-button" onClick={() => setMessages((list) => list.map((x) => (x.id === m.id ? { ...x, confirm: undefined } : x)))}>
                  Cancel
                </button>
              </div>
            ) : (
              m.buttons &&
              m.buttons.length > 0 && (
                <div className="assistant-actions">
                  {m.buttons.map((b) => (
                    <button key={b.label} type="button" className="ghost" disabled={busy} onClick={() => void press(b, m.id)}>
                      {b.label}
                    </button>
                  ))}
                </div>
              )
            )}
          </div>
        ))}
        {busy && (
          <p className="assistant-msg assistant pending muted" role="status">
            Checking…
          </p>
        )}
      </div>

      <form className="assistant-form" onSubmit={submit}>
        <label htmlFor="assistant-input" className="visually-hidden">
          Ask about your day
        </label>
        <input
          id="assistant-input"
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Can I still make it to the gym?"
          maxLength={500}
          autoComplete="off"
        />
        <button type="submit" className="primary" disabled={!text.trim() || busy}>
          Ask
        </button>
      </form>
    </div>
  );
}

function aiButton(a: AssistantAiAnswer['action'] & object, ctx: AssistantContext): AssistantButton | undefined {
  switch (a.type) {
    case 'replan':
      return { label: 'Show me the proposal', action: { type: 'replan' } };
    case 'open-item':
      return a.blockId ? { label: 'Details', action: { type: 'open-item', blockId: a.blockId } } : undefined;
    case 'options':
      return a.blockId ? { label: 'See other options', action: { type: 'options', blockId: a.blockId } } : undefined;
    case 'use-option': {
      const o = ctx.options?.result.options.find((x) => x.id === a.optionId);
      return o ? { label: 'Use this', action: { type: 'use-option', optionId: o.id }, confirm: `Change ${o.title} to ${o.label}?` } : undefined;
    }
  }
  return undefined;
}
