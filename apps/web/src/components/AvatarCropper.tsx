/**
 * Position a profile photo inside a circle, then make a small square copy.
 * Drag (or use the arrow keys) to move, the slider (or + and −) to zoom.
 * Only the cropped 512 px copy is ever uploaded; the original stays on the phone.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Sheet } from './Sheet';

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const PHOTO_MAX_SOURCE_BYTES = 15 * 1024 * 1024;
const VIEW = 256;
const OUT = 512;
const MAX_ZOOM = 4;

/** Why a chosen file can't be used, in plain words; null if it looks fine. */
export function photoProblem(file: { type: string; size: number }): string | null {
  if (!PHOTO_TYPES.includes(file.type)) return 'Use a JPEG, PNG or WebP photo.';
  if (file.size > PHOTO_MAX_SOURCE_BYTES) return 'That photo is too large. Pick one under 15 MB.';
  return null;
}

/** The part of the picture to keep, in source pixels, for a zoom level and a drag offset (view pixels from centre). */
export function cropRect(w: number, h: number, zoom: number, ox: number, oy: number) {
  const base = VIEW / Math.min(w, h);
  const scale = base * zoom;
  const size = VIEW / scale;
  return { sx: w / 2 - ox / scale - size / 2, sy: h / 2 - oy / scale - size / 2, size };
}

/** Keeps the picture covering the whole circle. */
export function clampOffset(w: number, h: number, zoom: number, ox: number, oy: number) {
  const scale = (VIEW / Math.min(w, h)) * zoom;
  const mx = Math.max(0, (w * scale - VIEW) / 2);
  const my = Math.max(0, (h * scale - VIEW) / 2);
  return { x: Math.min(mx, Math.max(-mx, ox)) || 0, y: Math.min(my, Math.max(-my, oy)) || 0 };
}

function toBlob(canvas: HTMLCanvasElement, type: string, q: number) {
  return new Promise<Blob | null>((ok) => canvas.toBlob(ok, type, q));
}

export function AvatarCropper({ file, onCancel, onDone }: { file: File; onCancel: () => void; onDone: (photo: Blob) => void }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const el = new Image();
    el.onload = () => setImg(el);
    el.onerror = () => setFailed(true);
    el.src = url;
    return () => URL.revokeObjectURL(url);
  }, [url]);

  const w = img?.naturalWidth ?? 1;
  const h = img?.naturalHeight ?? 1;
  const scale = (VIEW / Math.min(w, h)) * zoom;

  function move(x: number, y: number, z = zoom) {
    setPos(clampOffset(w, h, z, x, y));
  }
  function setZ(z: number) {
    const next = Math.min(MAX_ZOOM, Math.max(1, z));
    setZoom(next);
    move(pos.x, pos.y, next);
  }
  function down(e: PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: pos.x, oy: pos.y };
  }
  function dragMove(e: PointerEvent) {
    const d = drag.current;
    if (d && d.id === e.pointerId) move(d.ox + e.clientX - d.x, d.oy + e.clientY - d.y);
  }
  function key(e: KeyboardEvent) {
    const step = e.shiftKey ? 24 : 8;
    const k = e.key;
    if (k === 'ArrowLeft') move(pos.x + step, pos.y);
    else if (k === 'ArrowRight') move(pos.x - step, pos.y);
    else if (k === 'ArrowUp') move(pos.x, pos.y + step);
    else if (k === 'ArrowDown') move(pos.x, pos.y - step);
    else if (k === '+' || k === '=') setZ(zoom + 0.2);
    else if (k === '-') setZ(zoom - 0.2);
    else return;
    e.preventDefault();
  }

  async function save() {
    if (!img) return;
    setBusy(true);
    try {
      const { sx, sy, size } = cropRect(w, h, zoom, pos.x, pos.y);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = OUT;
      const c = canvas.getContext('2d');
      if (!c) throw new Error('no canvas');
      c.fillStyle = '#fff';
      c.fillRect(0, 0, OUT, OUT);
      c.drawImage(img, sx, sy, size, size, 0, 0, OUT, OUT);
      let blob = await toBlob(canvas, 'image/webp', 0.86);
      if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', 0.86);
      for (let q = 0.7; blob && blob.size > 1_800_000 && q > 0.3; q -= 0.15) blob = await toBlob(canvas, blob.type, q);
      if (!blob || blob.size > 1_900_000) throw new Error('too big');
      onDone(blob);
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <Sheet title="Adjust your photo" onClose={onCancel}>
      <div className="form cropper">
        {failed ? (
          <p className="error" role="alert">
            Couldn't use that photo. Try a different JPEG, PNG or WebP.
          </p>
        ) : (
          <>
            <div
              className="crop-view"
              style={{ width: VIEW, height: VIEW }}
              tabIndex={0}
              role="group"
              aria-label="Photo position. Drag, or use the arrow keys to move and plus and minus to zoom."
              onPointerDown={down}
              onPointerMove={dragMove}
              onPointerUp={() => (drag.current = null)}
              onPointerCancel={() => (drag.current = null)}
              onKeyDown={key}
            >
              {img && (
                <img
                  src={url}
                  alt=""
                  draggable={false}
                  style={{ width: w * scale, height: h * scale, transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))` }}
                />
              )}
              <span className="crop-ring" aria-hidden="true" />
            </div>
            <label className="field">
              <span>Zoom</span>
              <input type="range" min={1} max={MAX_ZOOM} step={0.05} value={zoom} onChange={(e) => setZ(Number(e.target.value))} />
            </label>
            {!img && <p className="muted small">Loading your photo…</p>}
          </>
        )}
        <div className="row-actions">
          <button type="button" className="primary" disabled={!img || busy || failed} onClick={() => void save()}>
            {busy ? 'Preparing…' : 'Use this photo'}
          </button>
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </Sheet>
  );
}
