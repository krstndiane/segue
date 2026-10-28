import type { PlanItem } from '@segue/engine';

/**
 * A commitment that can't be kept as planned (can't get there in time, or it
 * overlaps another one). Said in words with an icon, never by colour alone.
 */
export function ConflictNote({ item, className = '' }: { item: Pick<PlanItem, 'conflict'>; className?: string }) {
  if (!item.conflict) return null;
  return (
    <span className={`conflict-note ${className}`.trim()}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
        <path d="M8 1.5 15 14H1L8 1.5Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M8 6v3.6M8 11.6v.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <span>
        <span className="visually-hidden">Heads up: </span>
        {item.conflict}
      </span>
    </span>
  );
}
