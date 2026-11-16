// HTTPS is terminated by the reverse proxy (Caddy); this serves the Mini App's
// static files and its JSON API on plain HTTP behind it.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../log.ts';
import { localNow } from '../time.ts';
import type { Task } from '../tasks.ts';
import type { Ctx } from '../services/context.ts';
import { ConflictError, NotFoundError, ValidationError, type TaskService } from '../services/tasks.ts';
import { verifyInitData } from './auth.ts';

const STATIC_DIR = fileURLToPath(new URL('../../build/webapp/', import.meta.url));
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.map': 'application/json',
};

class HttpError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) { super(String(status)); this.status = status; this.body = body; }
}

export const publicTask = (t: Task) => ({ id: t.id, title: t.title, date: t.date, time: t.time, completed_at: t.completed_at, version: t.version });

export type ApiDeps = { ctx: Ctx; tasks: TaskService; botToken: string; allowed: Set<number> };

export function stateFor(deps: ApiDeps, userId: number) {
  const now = deps.ctx.now();
  const tz = deps.tasks.tz(userId);
  const ln = localNow(now, tz);
  return { now, today: ln.date, nowMinutes: ln.minutes, tz, tasks: deps.tasks.listActive(userId).map(publicTask) };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16 * 1024) throw new HttpError(413, { error: 'too large' });
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error();
    return v;
  } catch { throw new HttpError(400, { error: 'invalid json' }); }
}

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(json);
}

const optVersion = (b: Record<string, unknown>) => (typeof b.version === 'number' ? b.version : undefined);

export async function handleApi(deps: ApiDeps, method: string, path: string, query: URLSearchParams, authHeader: string | undefined,
  body: () => Promise<Record<string, unknown>>): Promise<{ status: number; body: unknown }> {
  const m = /^tma (.+)$/.exec(authHeader || '');
  const auth = m ? verifyInitData(m[1], deps.botToken, deps.ctx.now()) : null;
  if (!auth) throw new HttpError(401, { error: 'unauthorized' });
  if (!deps.allowed.has(auth.user.id)) throw new HttpError(403, { error: 'forbidden' });
  const userId = auth.user.id;
  deps.tasks.ensureUser(userId);
  const { tasks } = deps;

  if (method === 'GET' && path === '/api/state') return { status: 200, body: stateFor(deps, userId) };

  if (method === 'GET' && path === '/api/history') {
    const c = /^(\d+)_(\d+)$/.exec(query.get('cursor') || '');
    const limit = Math.min(Math.max(Number(query.get('limit')) || 40, 1), 100);
    const rows = tasks.listHistory(userId, c ? { completedAt: Number(c[1]), id: Number(c[2]) } : null, limit);
    const last = rows[rows.length - 1];
    return { status: 200, body: { tasks: rows.map(publicTask), cursor: rows.length === limit && last ? `${last.completed_at}_${last.id}` : null } };
  }

  if (method === 'POST' && path === '/api/tasks') {
    const b = await body();
    const task = await tasks.create(userId, { title: b.title as string, date: b.date as string, time: (b.time ?? null) as string | null });
    return { status: 201, body: { task: publicTask(task), state: stateFor(deps, userId) } };
  }

  const tm = /^\/api\/tasks\/(\d+)(?:\/(complete|uncomplete|delete|undelete))?$/.exec(path);
  if (tm) {
    const id = Number(tm[1]);
    const b = await body();
    let task: Task;
    if (!tm[2] && method === 'PATCH') {
      const patch: { title?: string; date?: string; time?: string | null } = {};
      if ('title' in b) patch.title = b.title as string;
      if ('date' in b) patch.date = b.date as string;
      if ('time' in b) patch.time = b.time as string | null;
      task = await tasks.update(userId, id, optVersion(b), patch);
    } else if (tm[2] && method === 'POST') {
      const v = optVersion(b);
      task = tm[2] === 'complete' ? await tasks.complete(userId, id, v)
        : tm[2] === 'uncomplete' ? await tasks.uncomplete(userId, id, v)
        : tm[2] === 'delete' ? await tasks.remove(userId, id, v)
        : await tasks.undelete(userId, id, v);
    } else throw new HttpError(405, { error: 'method not allowed' });
    return { status: 200, body: { task: publicTask(task), state: stateFor(deps, userId) } };
  }
  throw new HttpError(404, { error: 'not found' });
}

export function startHttp(deps: ApiDeps, port: number): Server {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) {
        const r = await handleApi(deps, req.method || 'GET', url.pathname, url.searchParams, req.headers.authorization, () => readJson(req));
        return send(res, r.status, r.body);
      }
      if (url.pathname === '/healthz') return send(res, 200, { ok: true });
      return await serveStatic(url.pathname, res);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, e.body);
      if (e instanceof ValidationError) return send(res, 400, { error: e.message });
      if (e instanceof NotFoundError) return send(res, 404, { error: e.message });
      if (e instanceof ConflictError) return send(res, 409, { error: 'conflict', task: e.current ? publicTask(e.current) : null });
      log.error(`http ${req.method} ${url.pathname} failed`, e);
      return send(res, 500, { error: 'internal error' });
    }
  });
  server.listen(port, () => log.info(`http listening on :${port}`));
  return server;
}

async function serveStatic(pathname: string, res: ServerResponse) {
  let rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = join(STATIC_DIR, rel);
  if (!file.startsWith(STATIC_DIR)) throw new HttpError(404, { error: 'not found' });
  let target = file;
  try {
    const s = await stat(target);
    if (!s.isFile()) throw new Error();
  } catch {
    target = join(STATIC_DIR, 'index.html'); // SPA fallback
  }
  const data = await readFile(target);
  const isHtml = target.endsWith('.html');
  res.writeHead(200, {
    'content-type': TYPES[extname(target)] || 'application/octet-stream',
    'cache-control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  });
  res.end(data);
}
