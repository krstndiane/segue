import type { LatLng } from '@segue/engine';

export interface MapPoint {
  id: string;
  label: string;
  /** short text drawn on the marker: "A", "B", a dot… */
  mark: string;
  at: LatLng;
  kind: 'you' | 'fixed' | 'planned' | 'option' | 'chosen';
}

const M_PER_DEG = 111_320;

/**
 * Where things are, to scale: real coordinates projected flat, with a scale
 * bar. Deliberately not a street map (no tiles, nothing invented between the
 * points), and it says so. Every point is also named in text for screen readers.
 */
export function MiniMap({ points, caption, height = 220 }: { points: MapPoint[]; caption: string; height?: number }) {
  if (!points.length) return null;
  const lat0 = points.reduce((s, p) => s + p.at.lat, 0) / points.length;
  const lng0 = points.reduce((s, p) => s + p.at.lng, 0) / points.length;
  const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  const xy = points.map((p) => ({ ...p, x: (p.at.lng - lng0) * kx, y: -(p.at.lat - lat0) * M_PER_DEG }));
  const W = 360;
  const H = height;
  const pad = 34;
  const spanX = Math.max(400, ...xy.map((p) => Math.abs(p.x) * 2));
  const spanY = Math.max(400, ...xy.map((p) => Math.abs(p.y) * 2));
  const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);
  const px = (x: number) => W / 2 + x * scale;
  const py = (y: number) => H / 2 + y * scale;
  // A round scale bar: 250 m, 500 m or 1 km, whichever fits.
  const bar = [1000, 500, 250, 100].find((m) => m * scale <= W * 0.3) ?? 100;
  const you = xy.find((p) => p.kind === 'you');

  return (
    <figure className="minimap">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Map of ${points.map((p) => p.label).join(', ')}`}>
        <rect width={W} height={H} rx="12" className="minimap-bg" />
        {/* Light rings every 500 m around you, for distance at a glance. */}
        {you &&
          [500, 1000, 1500].map((r) =>
            r * scale < W ? <circle key={r} cx={px(you.x)} cy={py(you.y)} r={r * scale} className="minimap-ring" /> : null,
          )}
        {you &&
          xy
            .filter((p) => p.kind === 'chosen')
            .map((p) => <line key={`l-${p.id}`} x1={px(you.x)} y1={py(you.y)} x2={px(p.x)} y2={py(p.y)} className="minimap-route" />)}
        {xy.map((p) => (
          <g key={p.id} className={`minimap-pt minimap-${p.kind}`} transform={`translate(${px(p.x)} ${py(p.y)})`}>
            {p.kind === 'fixed' ? <rect x="-11" y="-11" width="22" height="22" rx="5" /> : <circle r={p.kind === 'you' ? 7 : 11} />}
            {p.kind === 'planned' && <line x1="-9" y1="9" x2="9" y2="-9" className="minimap-strike" />}
            {p.mark && p.kind !== 'you' && (
              <text textAnchor="middle" dy="4">
                {p.mark}
              </text>
            )}
          </g>
        ))}
        <g transform={`translate(${W - pad - bar * scale} ${H - 14})`} className="minimap-scale">
          <line x1="0" y1="0" x2={bar * scale} y2="0" />
          <line x1="0" y1="-4" x2="0" y2="4" />
          <line x1={bar * scale} y1="-4" x2={bar * scale} y2="4" />
          <text x={(bar * scale) / 2} y="-6" textAnchor="middle">
            {bar >= 1000 ? `${bar / 1000} km` : `${bar} m`}
          </text>
        </g>
      </svg>
      <figcaption>
        <ul className="minimap-legend">
          {points.map((p) => (
            <li key={p.id} className={`minimap-${p.kind}`}>
              <span className="minimap-key" aria-hidden="true">
                {p.kind === 'you' ? '' : p.mark}
              </span>
              {p.label}
            </li>
          ))}
        </ul>
        <span className="muted small">{caption}</span>
      </figcaption>
    </figure>
  );
}
