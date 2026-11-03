import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * The winding road under "How it works", with a motorcycle on it.
 *
 * One path is the authority for everything: it's drawn through the actual
 * centres of the four step circles (measured from the page, so it fits every
 * screen), the road's layers all use it, and the motorcycle is placed on it
 * with getPointAtLength and turned to its tangent. Nothing moves in a straight
 * line, and nothing is a hard-coded pixel position.
 *
 * The motorcycle moves only when a step is chosen: it rides from wherever it
 * is to that step, forwards or backwards, and stops beside its circle (never
 * on the number). Choosing again while it rides redirects it from where it is.
 * Nothing moves on load, on scroll or on a timer. With reduced motion it is
 * simply placed at the chosen step.
 *
 * While riding it writes to the SVG and the step classes directly, so React
 * doesn't re-render 60 times a second.
 */

interface Geometry {
  d: string;
  width: number;
  height: number;
  /** distance along the path to each step's centre */
  stops: number[];
  total: number;
}

/** A smooth curve through every point (Catmull-Rom, as cubic Béziers), and the command index where each point is reached. */
function smoothPath(pts: { x: number; y: number }[]): { d: string; ends: string[] } {
  const f = (n: number) => Math.round(n * 10) / 10;
  let d = `M ${f(pts[0]!.x)} ${f(pts[0]!.y)}`;
  const ends: string[] = [d];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C ${f(c1.x)} ${f(c1.y)}, ${f(c2.x)} ${f(c2.y)}, ${f(p2.x)} ${f(p2.y)}`;
    ends.push(d);
  }
  return { d, ends };
}

const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
/** How far short of a circle the motorcycle stops (on the side it arrived from), so it never covers the number. */
const PARK = 34;
const TRAIL = 70;

export function RoadRide({ wrap, step }: { wrap: RefObject<HTMLDivElement | null>; step: number }) {
  const [geo, setGeo] = useState<Geometry | null>(null);
  const measure = useRef<SVGPathElement>(null);
  const road = useRef<SVGPathElement>(null);
  const bike = useRef<SVGGElement>(null);
  const trail = useRef<SVGPathElement>(null);
  const geoRef = useRef<Geometry | null>(null);
  const raf = useRef(0);
  /** where the motorcycle is now (distance along the road), and which way it faces (1 forward, -1 back) */
  const at = useRef<number | null>(null);
  const dir = useRef(1);
  /** the step it's riding to, or resting at */
  const target = useRef(step);
  const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // The road through the circles' real centres; again whenever the layout changes size.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const build = () => {
      const box = el.getBoundingClientRect();
      const dots = [...el.querySelectorAll<HTMLElement>('.lp-step-dot')].map((d) => {
        const r = d.getBoundingClientRect();
        return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2 };
      });
      if (dots.length !== 4 || box.width === 0) return;
      const amp = box.width < 560 ? 8 : 14;
      const tail = Math.min(dots[0]!.x, box.width < 560 ? 34 : 70);
      const pts = [
        { x: dots[0]!.x - tail, y: dots[0]!.y + amp * 0.8 },
        dots[0]!,
        { x: (dots[0]!.x + dots[1]!.x) / 2, y: dots[0]!.y - amp },
        dots[1]!,
        { x: (dots[1]!.x + dots[2]!.x) / 2, y: dots[1]!.y + amp },
        dots[2]!,
        { x: (dots[2]!.x + dots[3]!.x) / 2, y: dots[2]!.y - amp },
        dots[3]!,
        { x: dots[3]!.x + Math.min(box.width - dots[3]!.x, tail), y: dots[3]!.y + amp * 0.8 },
      ];
      const { d, ends } = smoothPath(pts);
      const m = measure.current;
      if (!m || typeof m.getTotalLength !== 'function') return;
      const lengthTo = (prefix: string) => {
        m.setAttribute('d', prefix);
        return m.getTotalLength();
      };
      // The dots are points 1, 3, 5 and 7.
      const stops = [1, 3, 5, 7].map((i) => lengthTo(ends[i]!));
      const total = lengthTo(d);
      const g = { d, width: box.width, height: box.height, stops, total };
      geoRef.current = g;
      setGeo(g);
    };
    build();
    const ro = new ResizeObserver(() => build());
    ro.observe(el);
    return () => ro.disconnect();
  }, [wrap]);

  /** Where it rests for a step: just short of the circle, on the side it came from. */
  const restFor = (i: number, facing: number) => {
    const g = geoRef.current!;
    return Math.max(0, Math.min(g.total, g.stops[i]! - facing * PARK));
  };

  /** Put the motorcycle at a distance along the road, facing the way it goes. */
  function place(pos: number, facing: number) {
    const g = geoRef.current;
    const p = road.current;
    const b = bike.current;
    if (!g || !p || !b) return;
    at.current = pos;
    const a = p.getPointAtLength(Math.max(0, Math.min(g.total, pos)));
    const n = p.getPointAtLength(Math.max(0, Math.min(g.total, pos + 2)));
    const prev = p.getPointAtLength(Math.max(0, Math.min(g.total, pos - 2)));
    const angle = (Math.atan2(n.y - prev.y, n.x - prev.x) * 180) / Math.PI + (facing < 0 ? 180 : 0);
    const scale = g.width < 560 ? 1.05 : 1.4;
    b.setAttribute('transform', `translate(${a.x.toFixed(2)} ${a.y.toFixed(2)}) rotate(${angle.toFixed(2)}) scale(${scale})`);
    b.dataset.at = String(Math.round(pos));
    b.dataset.facing = facing > 0 ? 'forward' : 'back';
    const t = trail.current;
    if (t) {
      // The trail is the stretch just behind the motorcycle.
      const from = facing > 0 ? pos - TRAIL : pos;
      t.style.strokeDasharray = `${TRAIL} ${g.total + TRAIL}`;
      t.style.strokeDashoffset = String(-from);
    }
  }

  const lis = () => [...(wrap.current?.querySelectorAll<HTMLElement>('.lp-steps > li') ?? [])];

  /** Glow on the step it reached, briefly. */
  function arrive(i: number) {
    const li = lis()[i];
    if (!li) return;
    li.classList.remove('lit');
    void li.offsetWidth; // restart the glow if it was already showing
    li.classList.add('lit');
    window.setTimeout(() => li.classList.remove('lit'), 1100);
  }

  /** Ride from wherever it is now to step i. A new choice mid-ride starts from where it is, so it never jumps. */
  function rideTo(i: number) {
    const g = geoRef.current;
    if (!g || at.current === null) return;
    cancelAnimationFrame(raf.current);
    const from = at.current;
    const facing = g.stops[i]! >= from ? 1 : -1;
    const to = restFor(i, facing);
    if (reduced() || Math.abs(to - from) < 1) {
      place(to, facing);
      dir.current = facing;
      wrap.current?.classList.remove('riding');
      arrive(i);
      return;
    }
    dir.current = facing;
    wrap.current?.classList.add('riding');
    const ms = Math.max(550, Math.min(2200, Math.abs(to - from) * 1.9));
    const start = performance.now();
    const tick = (now: number) => {
      const u = Math.min(1, (now - start) / ms);
      place(from + (to - from) * ease(u), facing);
      if (u < 1) {
        raf.current = requestAnimationFrame(tick);
        return;
      }
      wrap.current?.classList.remove('riding');
      arrive(i);
    };
    raf.current = requestAnimationFrame(tick);
  }

  // First layout: parked at the current step, facing along the road. A new layout (resize): put it back at its step.
  useEffect(() => {
    if (!geo) return;
    if (at.current === null || !wrap.current?.classList.contains('riding')) place(restFor(target.current, dir.current), dir.current);
  }, [geo]); // eslint-disable-line react-hooks/exhaustive-deps

  // The only thing that moves it: a different step being chosen.
  useEffect(() => {
    if (target.current === step) return;
    target.current = step;
    rideTo(step);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  return (
    <svg className="lp-road" width={geo?.width ?? 0} height={geo?.height ?? 0} viewBox={geo ? `0 0 ${geo.width} ${geo.height}` : undefined} aria-hidden="true" focusable="false">
        <defs>
          <filter id="lp-road-glow" x="-10%" y="-200%" width="120%" height="500%">
            <feGaussianBlur stdDeviation="5" />
          </filter>
          <radialGradient id="lp-headlight" cx="0" cy="0.5" r="1">
            <stop offset="0" stopColor="#fff6cf" stopOpacity="0.95" />
            <stop offset="1" stopColor="#ffd36e" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="lp-trail" x1="0" x2="1">
            <stop offset="0" stopColor="#ffe9a8" stopOpacity="0" />
            <stop offset="1" stopColor="#fff3c4" stopOpacity="1" />
          </linearGradient>
        </defs>
        {/* a hidden copy used only to measure distances along the same geometry */}
        <path ref={measure} d={geo?.d} fill="none" stroke="none" />
        {geo && (
          <>
            <path className="lp-road-glow" d={geo.d} filter="url(#lp-road-glow)" />
            <path className="lp-road-edge" d={geo.d} />
            <path ref={road} className="lp-road-surface" d={geo.d} />
            <path className="lp-road-lane" d={geo.d} />
            <path ref={trail} className="lp-road-trail" d={geo.d} filter="url(#lp-road-glow)" />
            <g ref={bike} className="lp-bike" data-at="">
              {/* the headlight, on the road ahead */}
              <path className="lp-bike-beam" d="M 18 0 L 62 -15 Q 70 0 62 15 Z" fill="url(#lp-headlight)" />
              {/* a small motorcycle seen from above, pointing along the road */}
              <g stroke="#fbf4e4" strokeWidth="0.7" strokeLinejoin="round">
                {/* wheels */}
                <rect x="-16" y="-2.3" width="9.5" height="4.6" rx="2.3" fill="#0b1029" />
                <rect x="8.5" y="-2.1" width="8" height="4.2" rx="2.1" fill="#0b1029" />
                {/* frame and tank */}
                <path d="M -11 -3.2 Q -3 -5.2 8 -3 L 10 0 L 8 3 Q -3 5.2 -11 3.2 Z" fill="#1a2556" />
                {/* handlebar with grips */}
                <path d="M 7.2 -7.2 L 9.2 -7.2 L 9.2 7.2 L 7.2 7.2 Z" fill="#0b1029" />
              </g>
              <circle cx="8.2" cy="-7.4" r="1.15" fill="#fbf4e4" />
              <circle cx="8.2" cy="7.4" r="1.15" fill="#fbf4e4" />
              {/* rider: shoulders, then the helmet with a road-yellow stripe */}
              <ellipse cx="-4" cy="0" rx="3.6" ry="5.4" fill="#0b1029" stroke="#fbf4e4" strokeWidth="0.7" />
              <circle cx="-2.6" cy="0" r="3.1" fill="#fbf4e4" stroke="#0b1029" strokeWidth="0.8" />
              <path d="M -3.4 -2.9 L -3.4 2.9" stroke="#ffd36e" strokeWidth="1.5" strokeLinecap="round" />
              {/* tail light and headlight */}
              <circle cx="-16.6" cy="0" r="1" fill="#ff6b5a" />
              <circle cx="17" cy="0" r="1.5" fill="#fff6cf" />
            </g>
          </>
        )}
    </svg>
  );
}
