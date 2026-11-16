// Loads the minified widget HTML produced by `npm run build` (scripts/build.ts).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export type WidgetName = 'preview' | 'creation' | 'reminder';
export type BuiltWidget = { html: string; hash: string };

const dir = fileURLToPath(new URL('../../build/widgets/', import.meta.url));
const cache = new Map<WidgetName, BuiltWidget>();

export function widget(name: WidgetName): BuiltWidget {
  let w = cache.get(name);
  if (!w) {
    let html: string;
    try {
      html = readFileSync(dir + name + '.html', 'utf8');
    } catch {
      throw new Error(`Widget "${name}" is not built. Run "npm run build" first.`);
    }
    w = { html, hash: createHash('sha256').update(html).digest('hex').slice(0, 16) };
    cache.set(name, w);
  }
  return w;
}

/** Byte length of a UTF-8 string. */
export const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
