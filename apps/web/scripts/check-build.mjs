/**
 * After `vite build`: features that are still in development must not be in
 * a production build. Fails the build (and CI, and Vercel) if they are.
 * Set VITE_ASSISTANT=on for a build that should include the assistant.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
// Text that only the assistant's own code contains (the header's hidden button label isn't enough to count).
const MARKERS = ['assistant-input', 'answer from your plan, its reasons'];

async function files(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else if (/\.(js|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

if (process.env.VITE_ASSISTANT === 'on') {
  console.log('check-build: assistant switched on for this build, skipping the check');
} else {
  const found = [];
  for (const f of await files(dist)) {
    const text = await readFile(f, 'utf8');
    for (const m of MARKERS) if (text.includes(m)) found.push(`${f.slice(dist.length)}: "${m}"`);
  }
  if (found.length) {
    console.error(`check-build: the planning assistant is in this production build:\n  ${found.join('\n  ')}`);
    process.exit(1);
  }
  console.log('check-build: no in-development features in the build');
}
