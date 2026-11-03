import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * The winding road under "How it works", with a motorcycle that rides it.
 *
 * One path is the authority for everything: it's drawn through the actual
 * centres of the four step circles (measured from the page, so it fits every
 * screen), the road's layers all use it, and the motorcycle is placed on it
 * with getPointAtLength and turned to its tangent. Nothing moves in a straight
 * line, and nothing is a hard-coded pixel position.
 *
 * The ride runs once, when the section first comes into view; "Ride again"
 * replays it. With reduced motion there is no ride: the road is drawn and the
 * motorcycle waits at the start.
 *
 * It writes to the SVG and the step classes directly while riding, so React
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
/** How far before the destination circle the motorcycle stops, so it never covers the number. */
const PARK_BEFORE = 36;
/** How far before Step 1 it starts. */
const START_BEFORE = 30;
const TRAIL = 70;

export function RoadRide({ wrap }: { wrap: RefObject<HTMLDivElement | null> }) {
  const [geo, setGeo] = useState<Geometry | null>(null);
  const measure = useRef<SVGPathElement>(null);
  const road = useRef<SVGPathElement>(null);
  const bike = useRef<SVGGElement>(null);
  const trail = useRef<SVGPathElement>(null);
  const geoRef = useRef<Geometry | null>(null);
  const raf = useRef(0);
  const state = useRef<'waiting' | 'riding' | 'done'>('waiting');
  const [done, setDone] = useState(false);
  const reduced = useRef(typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);

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

  /** Put the motorcycle at a distance along the road, facing the way it goes. */
  function place(at: number) {
    const g = geoRef.current;
    const p = road.current;
    const b = bike.current;
    if (!g || !p || !b) return;
    const a = p.getPointAtLength(Math.max(0, Math.min(g.total, at)));
    const n = p.getPointAtLength(Math.max(0, Math.min(g.total, at + 2)));
    const prev = p.getPointAtLength(Math.max(0, Math.min(g.total, at - 2)));
    const angle = (Math.atan2(n.y - prev.y, n.x - prev.x) * 180) / Math.PI;
    const scale = g.width < 560 ? 1.05 : 1.4;
    b.setAttribute('transform', `translate(${a.x.toFixed(2)} ${a.y.toFixed(2)}) rotate(${angle.toFixed(2)}) scale(${scale})`);
    b.dataset.at = String(Math.round(at));
    const t = trail.current;
    if (t) {
      t.style.strokeDasharray = `${TRAIL} ${g.total + TRAIL}`;
      t.style.strokeDashoffset = String(-(at - TRAIL));
    }
  }

  const steps = () => [...(wrap.current?.querySelectorAll<HTMLElement>('.lp-steps > li') ?? [])];

  // Where the motorcycle waits before the ride (or for good, with reduced motion), and after it.
  useEffect(() => {
    if (!geo) return;
    if (state.current === 'waiting') place(geo.stops[0]! - START_BEFORE);
    if (state.current === 'done') place(geo.stops[3]! - PARK_BEFORE);
  }, [geo]); // eslint-disable-line react-hooks/exhaustive-deps

  function ride() {
    const g = geoRef.current;
    if (!g || reduced.current) return;
    cancelAnimationFrame(raf.current);
    state.current = 'riding';
    setDone(false);
    const lis = steps();
    lis.forEach((li) => li.classList.remove('lit', 'arrived', 'passed'));
    wrap.current?.classList.add('riding');
    // Legs: start → 1 → 2 → 3 → just before 4. Each eases in and out, so it slows past every milestone.
    const legs = () => {
      const s = geoRef.current!.stops;
      const pts = [s[0]! - START_BEFORE, s[0]!, s[1]!, s[2]!, s[3]! - PARK_BEFORE];
      return pts.slice(0, -1).map((from, i) => ({ from, to: pts[i + 1]!, ms: i === 0 ? 650 : 1150 }));
    };
    let leg = 0;
    let legStart = performance.now();
    const light = (i: number) => {
      const li = lis[i];
      if (!li) return;
      li.classList.add('lit', 'passed');
      if (i === 3) li.classList.add('arrived');
      else setTimeout(() => li.classList.remove('lit'), 900);
    };
    const tick = (now: number) => {
      const L = legs();
      const cur = L[leg]!;
      const u = Math.min(1, (now - legStart) / cur.ms);
      place(cur.from + (cur.to - cur.from) * ease(u));
      if (u >= 1) {
        // Reaching the end of a leg is reaching a milestone (the last one stops just short of the circle).
        light(leg === 0 ? 0 : leg);
        if (leg === L.length - 1) {
          state.current = 'done';
          wrap.current?.classList.remove('riding');
          setDone(true);
          return;
        }
        leg++;
        legStart = now;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }

  // Ride once, the first time the road is properly in view. Scrolling around afterwards doesn't restart it.
  useEffect(() => {
    const el = wrap.current;
    if (!el || !geo || reduced.current || state.current !== 'waiting') return;
    if (!('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && state.current === 'waiting') {
          io.disconnect();
          ride();
        }
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [geo !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  return (
    <>
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
      {done && (
        <button
          type="button"
          className="lp-ride-again"
          onClick={() => {
            state.current = 'waiting';
            ride();
          }}
        >
          Ride again
        </button>
      )}
    </>
  );
}
