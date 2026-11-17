// JSON API client. Auth: "Authorization: tma <initData>", verified server-side.
import { initData } from './tg.ts';

export type ApiTask = { id: number; title: string; date: string; time: string | null; completed_at: number | null; version: number };
export type ServerState = { now: number; today: string; nowMinutes: number; tz: string; tasks: ApiTask[] };
export type Mutation = { task: ApiTask; state: ServerState };

export class ApiError extends Error {
  status: number;
  body: { error?: string; task?: ApiTask | null };
  constructor(status: number, body: ApiError['body']) { super(body.error || `HTTP ${status}`); this.status = status; this.body = body; }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `tma ${initData()}`,
      // Free Tuna / ngrok addresses show a warning page to browsers; these headers skip it for API calls.
      'tuna-skip-browser-warning': '1',
      'ngrok-skip-browser-warning': '1',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: unknown = null;
  try { json = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new ApiError(res.status, (json as ApiError['body']) || {});
  return json as T;
}

export const api = {
  state: () => req<ServerState>('GET', './api/state'),
  history: (cursor: string | null) => req<{ tasks: ApiTask[]; cursor: string | null }>('GET', `./api/history${cursor ? `?cursor=${cursor}` : ''}`),
  create: (t: { title: string; date: string; time: string | null }) => req<Mutation>('POST', './api/tasks', t),
  update: (id: number, version: number, patch: Partial<Pick<ApiTask, 'title' | 'date' | 'time'>>) =>
    req<Mutation>('PATCH', `./api/tasks/${id}`, { version, ...patch }),
  action: (id: number, action: 'complete' | 'uncomplete' | 'delete' | 'undelete', version?: number) =>
    req<Mutation>('POST', `./api/tasks/${id}/${action}`, version === undefined ? {} : { version }),
};
