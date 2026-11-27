import type { LatLng } from '@segue/engine';

export interface StoryStop {
  id: string;
  /** a short name drawn beside the stop */
  label: string;
  at: LatLng;
}

export interface StoryOption extends StoryStop {
  /** the number shown on the stop and on its button: 1, 2, 3 */
  n: number;
}

interface Props {
  /** 0 the plan · 1 something changes · 2 options · 3 you decided */
  step: number;
  home: StoryStop;
  /** the outdoor stop the rain affects */
  planned: StoryStop;
  /** the commitment that never moves */
  fixed: StoryStop;
  /** options with a place; an option without one happens at home */
  options: StoryOption[];
  /** the option chosen (or being looked at), if it has a place */
  chosen?: StoryOption;
  /** the option chosen happens where you are, with no trip */
  chosenAtHome?: boolean;
}

const W = 320;
const H = 230;
const PAD = 34;
const M_PER_DEG = 111_320;

/**
 * The sample day's route, to scale: real coordinates of the sample places,
 * projected flat. Straight lines between stops, not streets, and the caption
 * says so. It follows the story's step; with reduced motion it changes
 * without animating, and every state is also described in words.
 */
export function StoryMap({ step, home, planned, fixed, options, chosen, chosenAtHome }: Props) {
  // Fit every stop the story can show, so nothing jumps between steps.
  const all = [home, planned, fixed, ...options];
  const lat0 = (Math.min(...all.map((p) => p.at.lat)) + Math.max(...all.map((p) => p.at.lat))) / 2;
  const lng0 = (Math.min(...all.map((p) => p.at.lng)) + Math.max(...all.map((p) => p.at.lng))) / 2;
  const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  const mx = (p: StoryStop) => (p.at.lng - lng0) * kx;
  const my = (p: StoryStop) => -(p.at.lat - lat0) * M_PER_DEG;
  const spanX = Math.max(300, ...all.map((p) => Math.abs(mx(p)) * 2));
  const spanY = Math.max(300, ...all.map((p) => Math.abs(my(p)) * 2));
  const scale = Math.min((W - PAD * 2) / spanX, (H - PAD * 2) / spanY);
  const x = (p: StoryStop) => Math.round(W / 2 + mx(p) * scale);
  const y = (p: StoryStop) => Math.round(H / 2 + my(p) * scale);
  const pt = (p: StoryStop) => `${x(p)},${y(p)}`;

  const raining = step >= 1;
  const choosing = step === 2;
  const decided = step === 3;
  // The stop between home and class: the planned park, or the option chosen.
  const via = step >= 2 ? (chosen ?? (chosenAtHome ? home : planned)) : planned;
  const original = `${pt(home)} ${pt(planned)} ${pt(fixed)}`;
  const detour = `${pt(home)} ${pt(via)} ${pt(fixed)}`;
  const bar = [500, 250, 100].find((m) => m * scale <= W * 0.28) ?? 100;

  const words = [
    step === 0 && `The route: home, then ${planned.label}, then ${fixed.label}.`,
    step === 1 && `Rain over ${planned.label}, the outdoor stop. ${fixed.label} is fixed.`,
    step === 2 && `${options.length} indoor options nearby, numbered. ${fixed.label} stays where it is.`,
    step === 3 && `The new route: home, then ${chosen?.label ?? 'a workout at home'}, then ${fixed.label}, unchanged.`,
  ].find(Boolean) as string;

  return (
    <figure className={`lp-map step-${step}`}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={words}>
        <rect width={W} height={H} rx="14" className="lp-map-bg" />
        {/* the planned route; once Segue looks for options it fades to a dashed memory */}
        <polyline points={original} className={`lp-map-route ${step >= 2 ? 'old' : ''}`} pathLength={1} />
        {step >= 2 && <polyline key={`${via.id}-${step}`} points={detour} className={`lp-map-route new ${decided ? 'set' : ''}`} pathLength={1} />}

        {raining && (
          <g className="lp-map-rain" transform={`translate(${x(planned)} ${y(planned)})`} aria-hidden="true">
            <ellipse cx="0" cy="-30" rx="30" ry="11" className="lp-map-cloud" />
            {[-18, -8, 2, 12, 22].map((dx, i) => (
              <line key={dx} x1={dx} y1={-16 + (i % 2) * 4} x2={dx - 5} y2={-2 + (i % 2) * 4} className="lp-map-drop" style={{ animationDelay: `${i * 0.18}s` }} />
            ))}
          </g>
        )}

        {/* options, numbered as their buttons are */}
        {choosing &&
          options.map((o) => (
            <g key={o.id} className={`lp-map-pt option ${chosen?.id === o.id ? 'on' : ''}`} transform={`translate(${x(o)} ${y(o)})`}>
              <circle r="11" />
              <text textAnchor="middle" dy="4">
                {o.n}
              </text>
            </g>
          ))}
        {decided && chosen && (
          <g className="lp-map-pt option on" transform={`translate(${x(chosen)} ${y(chosen)})`}>
            <circle r="11" />
            <text textAnchor="middle" dy="4">
              ✓
            </text>
          </g>
        )}

        <g className={`lp-map-pt planned ${step >= 1 ? 'hit' : ''} ${decided ? 'gone' : ''}`} transform={`translate(${x(planned)} ${y(planned)})`}>
          <circle r="9" />
          {decided && <line x1="-7" y1="7" x2="7" y2="-7" />}
        </g>
        <g className="lp-map-pt fixed" transform={`translate(${x(fixed)} ${y(fixed)})`}>
          <rect x="-11" y="-11" width="22" height="22" rx="5" />
          {/* a small lock: set times never move */}
          <rect x="-4.5" y="-1" width="9" height="7" rx="1.5" className="lock" />
          <path d="M-2.6 -1v-2.2a2.6 2.6 0 0 1 5.2 0V-1" className="lock-arc" />
        </g>
        <g className="lp-map-pt home" transform={`translate(${x(home)} ${y(home)})`}>
          <circle r="7" />
        </g>

        <text x={x(home) + 12} y={y(home) + 4} className="lp-map-label">
          {home.label}
        </text>
        <text x={x(planned) - 12} y={y(planned) + 4} textAnchor="end" className={`lp-map-label ${decided ? 'muted' : ''}`}>
          {planned.label}
        </text>
        <text x={x(fixed) + 16} y={y(fixed) + 4} className="lp-map-label strong">
          {fixed.label}
          {decided ? ' · unchanged' : ''}
        </text>

        <g transform={`translate(${W - 16 - bar * scale} 22)`} className="lp-map-scale" aria-hidden="true">
          <line x1="0" y1="0" x2={bar * scale} y2="0" />
          <text x={(bar * scale) / 2} y="-5" textAnchor="middle">
            {bar} m
          </text>
        </g>
      </svg>
      <figcaption>To scale. Straight lines between stops, not streets.</figcaption>
    </figure>
  );
}
