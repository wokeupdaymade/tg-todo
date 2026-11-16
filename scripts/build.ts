// Build: minify the in-chat widgets (with a hard compressed-size gate) and
// bundle the Mini App. Output goes to build/.
import { build, transform } from 'esbuild';
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = root + 'build/';
const WIDGET_LIMIT = 3800; // Telegram's hard limit is 4096 bytes after zlib level 9; keep a margin.

/** Exact server-side count uses Python's zlib; fall back to Node's (can differ by a few dozen bytes). */
function compressedSize(html: string): number {
  // On Windows "python3" is often a Microsoft Store stub: don't call it there.
  if (process.platform === 'win32') return deflateSync(Buffer.from(html), { level: 9 }).length;
  try {
    const n = execFileSync('python3', ['-I', '-c', 'import sys,zlib; print(len(zlib.compress(sys.stdin.buffer.read(), 9)))'], { input: html, stdio: ['pipe', 'pipe', 'ignore'] });
    return Number(String(n).trim());
  } catch {
    return deflateSync(Buffer.from(html), { level: 9 }).length;
  }
}

async function buildWidget(name: string): Promise<{ raw: number; compressed: number }> {
  const src = readFileSync(`${root}src/widgets/src/${name}.html`, 'utf8');
  const style = /<style>([\s\S]*?)<\/style>/.exec(src)?.[1] ?? '';
  const script = /<script>([\s\S]*?)<\/script>/.exec(src)?.[1] ?? '';
  const body = src.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script>[\s\S]*?<\/script>/, '').replace(/>\s+</g, '><').trim();
  const css = (await transform(style, { loader: 'css', minify: true })).code.trim();
  // Top-level names stay intact (inline onclick handlers reference them).
  const js = (await transform(script, { loader: 'js', minify: true, target: 'es2020' })).code.trim();
  if (/<\/script/i.test(js)) throw new Error(`${name}: script contains </script`);
  const html = `<style>${css}</style>${body}<script>${js}</script>`;
  if (html.includes('\u0000')) throw new Error(`${name}: NUL character`);
  const raw = Buffer.byteLength(html);
  const compressed = compressedSize(html);
  if (raw > 32768 || compressed > WIDGET_LIMIT) {
    throw new Error(`${name}: widget too large (${raw} B raw, ${compressed} B compressed; limit ${WIDGET_LIMIT})`);
  }
  writeFileSync(`${out}widgets/${name}.html`, html);
  return { raw, compressed };
}

async function buildWebapp() {
  const dir = `${out}webapp/`;
  const result = await build({
    entryPoints: { app: `${root}webapp/src/main.tsx` },
    bundle: true, minify: true, sourcemap: true, format: 'esm', target: ['es2020', 'safari15'],
    outdir: dir, entryNames: '[name]-[hash]', metafile: true,
    jsx: 'automatic', jsxImportSource: 'preact',
    loader: { '.css': 'css' },
    logLevel: 'warning',
  });
  const outputs = Object.keys(result.metafile.outputs).map((p) => p.split('/').pop()!);
  const js = outputs.find((f) => /^app-.*\.js$/.test(f));
  const css = outputs.find((f) => /^app-.*\.css$/.test(f));
  const tpl = readFileSync(`${root}webapp/index.html`, 'utf8')
    .replace('<!--CSS-->', css ? `<link rel="stylesheet" href="./${css}">` : '')
    .replace('<!--JS-->', `<script type="module" src="./${js}"></script>`);
  writeFileSync(dir + 'index.html', tpl);
  return readdirSync(dir).length;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out + 'widgets', { recursive: true });
for (const name of ['preview', 'creation', 'reminder']) {
  const s = await buildWidget(name);
  console.log(`widget ${name.padEnd(9)} ${String(s.raw).padStart(5)} B raw  ${String(s.compressed).padStart(4)} B zlib-9 (limit ${WIDGET_LIMIT})`);
}
const files = await buildWebapp();
console.log(`webapp: ${files} files in build/webapp`);
