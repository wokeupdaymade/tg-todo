// One-click launcher for running the bot on a Windows PC (used by start.bat).
// Starts an HTTPS tunnel for the Mini App, then the bot; restarts the bot if it
// crashes. Closing the console window stops everything.
// Plain .mjs on purpose: it must run (and explain) even on an old Node version.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const isWin = process.platform === 'win32';
let PORT = 8080;
const children = new Set();

const say = (s = '') => console.log(s);
const banner = (lines) => {
  const w = Math.max(...lines.map((l) => l.length)) + 4;
  say('  ' + '='.repeat(w));
  for (const l of lines) say('  ||' + ' ' + l.padEnd(w - 4) + ' ||');
  say('  ' + '='.repeat(w));
};
function fail(msg) {
  say();
  say('  [!] ' + msg.split('\n').join('\n      '));
  say();
  stopAll();
  process.exit(1);
}
function stopAll() {
  for (const c of children) {
    try { isWin ? spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' }) : c.kill(); } catch { /* already gone */ }
  }
  children.clear();
}
process.on('SIGINT', () => { stopAll(); process.exit(0); });
process.on('SIGTERM', () => { stopAll(); process.exit(0); });
process.on('SIGHUP', () => { stopAll(); process.exit(0); }); // Windows: console window closed
process.on('exit', stopAll);

function readEnv(file) {
  const env = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

// `useShell` only for npm (npm.cmd on Windows). Never for paths that may contain spaces,
// like "C:\\Program Files\\nodejs\\node.exe": cmd.exe would split them.
function run(cmd, args, label, useShell = false) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: useShell && isWin });
  if (r.status !== 0) fail(`${label} failed (see the messages above).`);
}

function findExe(name, extra = []) {
  const probe = spawnSync(isWin ? 'where' : 'which', [name], { encoding: 'utf8' });
  if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim().split(/\r?\n/)[0];
  return extra.find((p) => existsSync(p)) || null;
}

function copyToClipboard(text) {
  if (!isWin) return false;
  const r = spawnSync('clip', { input: text });
  return r.status === 0;
}

// 1. Checks ---------------------------------------------------------------------
say();
banner(['Telegram To-Do', 'Close this window to stop the bot.']);
say();

const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 18)) {
  fail(`Node.js ${process.versions.node} is too old. Install Node.js 22 LTS (22.18 or newer)\nfrom https://nodejs.org, then run start.bat again.`);
}

const envFile = join(root, '.env');
if (!existsSync(envFile)) {
  copyFileSync(join(root, '.env.example'), envFile);
  if (isWin) spawn('notepad', [envFile], { detached: true, stdio: 'ignore' }).unref();
  fail('First run: I created the settings file ".env" (it should open in Notepad).\nFill in the 4 lines under "Required" (BOT_TOKEN, ALLOWED_USER_IDS, DEFAULT_TZ, TUNA_API_KEY),\nsave it, then run start.bat again.');
}
// Notepad may save a UTF-8 BOM, which would hide the first setting from Node.
{
  const raw = readFileSync(envFile, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) writeFileSync(envFile, raw.slice(1));
}
const env = readEnv(envFile);
if (!env.BOT_TOKEN || /replace-me/.test(env.BOT_TOKEN)) fail('Put your bot token from @BotFather into BOT_TOKEN in the .env file.');
if ((env.TUNNEL || 'tuna').toLowerCase() === 'tuna' && !env.TUNA_API_KEY) say('  (!) TUNA_API_KEY is empty in .env: Tuna will only work if you logged in with "tuna login" on this machine.');
if (!env.ALLOWED_USER_IDS || env.ALLOWED_USER_IDS === '111111111') fail('Put your Telegram user id (ask @userinfobot) into ALLOWED_USER_IDS in the .env file.');

// 1b. One copy at a time ----------------------------------------------------------------
// Another open start.bat window? Then don't fight it.
mkdirSync(join(root, 'data'), { recursive: true });
const lockFile = join(root, 'data', 'launcher.pid');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
if (existsSync(lockFile)) {
  const other = Number(readFileSync(lockFile, 'utf8'));
  if (other && other !== process.pid && alive(other)) {
    fail('The bot is already running in another start.bat window.\nUse that window, or close it and run start.bat again.');
  }
}
writeFileSync(lockFile, String(process.pid));
process.on('exit', () => { try { if (readFileSync(lockFile, 'utf8') === String(process.pid)) writeFileSync(lockFile, ''); } catch { /* */ } });

const portFree = (port) => new Promise((resolve) => {
  const srv = createServer().once('error', () => resolve(false)).once('listening', () => srv.close(() => resolve(true)));
  srv.listen(port);
});
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** PID of the process listening on a TCP port (Windows), and whether it is node.exe. */
function listenerOnPort(port) {
  if (!isWin) return null;
  const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout || '';
  // Listening sockets have a remote address of 0.0.0.0:0 / [::]:0. (The state word is translated on non-English Windows.)
  const re = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+(?:0\\.0\\.0\\.0:0|\\[::\\]:0)\\s+\\S+\\s+(\\d+)\\s*$`, 'i');
  const m = out.split(/\r?\n/).map((l) => re.exec(l)).find(Boolean);
  if (!m) return null;
  const pid = Number(m[1]);
  const name = (spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout || '').split(',')[0].replace(/"/g, '').trim();
  return { pid, isNode: /^node(\.exe)?$/i.test(name) };
}

/** A bot left over from an earlier run (its window is gone) holds the port: stop it. Otherwise pick another port. */
async function choosePort() {
  if (await portFree(PORT)) return;
  let ours = null;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(2000) });
    const j = await r.json();
    if (j && j.ok === true) {
      if (j.pid) ours = j.pid;                       // this version reports its process id
      else { const l = listenerOnPort(PORT); if (l?.isNode) ours = l.pid; } // older versions: ask netstat
    }
  } catch { /* not ours */ }
  if (ours) {
    say(`  A copy of the bot from an earlier run is still running (process ${ours}); stopping it...`);
    if (isWin) spawnSync('taskkill', ['/PID', String(ours), '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(ours); } catch { /* gone */ } }
    for (let i = 0; i < 20 && !(await portFree(PORT)); i++) await sleepMs(250);
    if (await portFree(PORT)) return;
  }
  for (let p = 8081; p <= 8099; p++) {
    if (await portFree(p)) { say(`  Port ${PORT} is used by another program; using port ${p} instead.`); PORT = p; return; }
  }
  fail(`Ports 8080-8099 are all in use. Close some programs and run start.bat again.`);
}
await choosePort();

// 2. Install & build --------------------------------------------------------------
if (!existsSync(join(root, 'node_modules'))) {
  say('  Installing dependencies (first run only)...');
  run('npm', ['install', '--no-audit', '--no-fund'], 'npm install', true);
}
say('  Building...');
run(process.execPath, ['scripts/build.ts'], 'Build');

// 3. Proxy: only for the bot's Telegram traffic, never for the tunnel ---------------------
// TELEGRAM_PROXY in .env (or HTTP(S)_PROXY set in start.bat) is used by the bot to reach Telegram.
// Tunnel clients must connect directly: the variables are removed from their environment.
const PROXY_KEY = /^(https?|all|no)_proxy$|^node_use_env_proxy$/i;
function withoutProxy(base) {
  const e = { ...base };
  for (const k of Object.keys(e)) if (PROXY_KEY.test(k)) delete e[k];
  return e;
}
const pickEnv = (...names) => { for (const n of names) for (const k of Object.keys(process.env)) if (k.toLowerCase() === n && process.env[k]) return process.env[k]; return ''; };
const telegramProxy = (env.TELEGRAM_PROXY || pickEnv('https_proxy', 'http_proxy')).trim();
const tunnelEnv = withoutProxy(process.env);
function botEnv() {
  const e = withoutProxy(process.env);
  if (telegramProxy) Object.assign(e, { HTTP_PROXY: telegramProxy, HTTPS_PROXY: telegramProxy, NO_PROXY: 'localhost,127.0.0.1,::1', NODE_USE_ENV_PROXY: '1' });
  return e;
}
if (telegramProxy) {
  say(`  Telegram traffic goes through the proxy ${telegramProxy}; the tunnel connects directly.`);
  if (maj < 24 && !(maj === 22 && min >= 21)) say('  (!) Your Node.js may be too old to use a proxy: install Node.js 24 LTS or newer if Telegram cannot be reached.');
}

// 4. Tunnel (gives the Mini App the HTTPS address Telegram requires) ------------------------
// TUNNEL=tuna (default) | cloudflared | ngrok
const TUNNEL = (env.TUNNEL || 'tuna').toLowerCase();
const tunaSubFile = join(root, 'data', 'tuna-subdomain.txt');

function installWithWinget(id, name, extraPaths) {
  let exe = findExe(name, extraPaths);
  if (!exe && isWin) {
    say(`  ${name} not found; installing it with winget (one time)...`);
    spawnSync('winget', ['install', '--id', id, '-e', '--accept-source-agreements', '--accept-package-agreements'], { stdio: 'inherit' });
    exe = findExe(name, extraPaths);
  }
  return exe;
}

async function startTunnel() {
  if (TUNNEL === 'cloudflared') return startCloudflared();
  if (TUNNEL === 'ngrok') return startNgrok();
  return startTuna();
}

async function startTuna(retry = true) {
  const local = process.env.LOCALAPPDATA || '';
  const tuna = installWithWinget('yuccastream.tuna', 'tuna', [
    join(local, 'Microsoft', 'WinGet', 'Links', 'tuna.exe'), join(local, 'Microsoft', 'WindowsApps', 'tuna.exe'),
  ]);
  if (!tuna) fail('Tuna is not installed (or a new window is needed after installing it).\nRun:  winget install --id yuccastream.tuna\nthen start.bat again.');
  const saved = existsSync(tunaSubFile) ? readFileSync(tunaSubFile, 'utf8').trim() : '';
  const sub = (env.TUNA_SUBDOMAIN || saved).trim().replace(/\..*$/, ''); // accept "name" or "name.ru.tuna.am"
  const tEnv = { ...tunnelEnv, TUNA_TUI: '0', TUNA_INSPECT: 'false', TUNA_NO_PROMPT: '1', TUNA_LOG: 'stdout', TUNA_LOG_FORMAT: 'text' };
  if (env.TUNA_API_KEY) tEnv.TUNA_API_KEY = env.TUNA_API_KEY.trim();
  const args = ['http', String(PORT)];
  if (sub) args.push(`--subdomain=${sub}`);
  say(`  Starting tunnel (Tuna${sub ? ', ' + sub : ''})...`);
  const p = spawn(tuna, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: tEnv });
  children.add(p);
  const { url, log } = await waitForTunnel(p, 'tuna', /Forwarding\s+(https:\/\/[^\s"]+)/i, /Forwarding\s+https:/i, (m) => m[1].replace(/\/+$/, ''));
  if (!sub) {
    // Tuna suggests the account's free permanent subdomain when started without one: remember it and use it.
    const m = /--subdomain=([a-z0-9-]+)/i.exec(log) || /permanent free domain:\s*([a-z0-9-]+)\./i.exec(log);
    if (m && retry) {
      writeFileSync(tunaSubFile, m[1]);
      say(`  Found your free permanent Tuna address (${m[1]}); switching to it...`);
      p.expectedExit = true;
      p.kill();
      children.delete(p);
      await sleepMs(1500);
      return startTuna(false);
    }
    say('  (!) No permanent Tuna address found: this one changes on every start.\n      Put TUNA_SUBDOMAIN=<name> in .env (the "Free" domain in your Tuna dashboard) to keep it fixed.');
  }
  return url;
}

async function startCloudflared() {
  const cf = installWithWinget('Cloudflare.cloudflared', 'cloudflared', ['C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe']);
  if (!cf) fail('cloudflared is not installed. Run:  winget install --id Cloudflare.cloudflared\nthen start.bat again.');
  say('  Starting tunnel (cloudflared)... this can take up to a minute');
  // http2 runs over TCP 443, which gets through networks that block or throttle QUIC/UDP.
  const p = spawn(cf, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://localhost:${PORT}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: tunnelEnv });
  children.add(p);
  // The address is printed before the connection to Cloudflare exists: wait for both.
  return (await waitForTunnel(p, 'cloudflared', /https:\/\/[a-z0-9-]+\.trycloudflare\.com/, /Registered tunnel connection/i, (m) => m[0])).url;
}

async function startNgrok() {
  const ngrok = installWithWinget('Ngrok.Ngrok', 'ngrok', [join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ngrok.exe')]);
  if (!ngrok) fail('ngrok is not installed. Install it from https://ngrok.com/download, then run start.bat again.');
  const domain = (env.NGROK_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const args = ['http', String(PORT), '--log=stdout'];
  if (domain) args.push(`--url=${domain}`);
  if (env.NGROK_AUTHTOKEN) args.push(`--authtoken=${env.NGROK_AUTHTOKEN.trim()}`);
  say(`  Starting tunnel (ngrok${domain ? ', ' + domain : ''})...`);
  const p = spawn(ngrok, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: tunnelEnv });
  children.add(p);
  return (await waitForTunnel(p, 'ngrok', /url=(https:\/\/[^\s"]+)/i, /started tunnel/i, (m) => m[1].replace(/\/+$/, ''))).url;
}

const HINTS = {
  tuna: (log) => /api.?key|unauthori|not logged|login|401|403|token/i.test(log)
    ? 'Tuna needs your API key. In the Tuna dashboard (https://my.tuna.am) create an API key with tunnel access\n(it starts with tak_) and add this line to .env:\n    TUNA_API_KEY=tak_...\nthen run start.bat again.\n\n'
    : /subdomain|domain/i.test(log)
      ? 'Tuna refused the subdomain. Copy the "Free" domain name exactly from the Domains page of your Tuna dashboard\ninto TUNA_SUBDOMAIN in .env (just the name, e.g. brave-otter-4821), or delete data\\tuna-subdomain.txt.\n\n'
      : '',
  ngrok: (log) => /ERR_NGROK_(4018|105|107)|authtoken/i.test(log)
    ? 'ngrok needs your account token: add NGROK_AUTHTOKEN=... to .env.\n\n'
    : /ERR_NGROK_9009/i.test(log) ? 'ngrok refuses to run through a proxy on the free plan. Remove proxy_url from your ngrok.yml.\n\n' : '',
  cloudflared: () => '',
};
const TIMEOUT_HINT = {
  tuna: 'Tuna could not connect within 90 seconds. Check the VPS internet connection; Tuna must be able to reach\nits servers directly (it never uses the Telegram proxy).\n\n',
  cloudflared: 'cloudflared could not connect to Cloudflare within 90 seconds. Your internet provider may be blocking\nor slowing Cloudflare.\n\n',
  ngrok: 'ngrok could not connect to its servers within 90 seconds.\n\n',
};

function waitForTunnel(proc, name, urlRe, readyRe, toUrl) {
  return new Promise((resolve) => {
    let log = '', done = false;
    const logFile = join(root, 'data', 'tunnel.log');
    writeFileSync(logFile, `--- ${new Date().toISOString()} ${name}\n`);
    const timer = setTimeout(() => fail(TIMEOUT_HINT[name] + 'Its output (also saved in data\\tunnel.log):\n' + log.slice(-1500)), 90_000);
    const onData = (d) => {
      const chunk = d.toString();
      log += chunk;
      try { appendFileSync(logFile, chunk); } catch { /* */ }
      if (done) return;
      const m = urlRe.exec(log);
      if (m && readyRe.test(log)) { done = true; clearTimeout(timer); resolve({ url: toUrl(m), log }); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => {
      if (proc.expectedExit) return;
      children.delete(proc);
      if (done) { onTunnelLost(name, code); return; }
      clearTimeout(timer);
      fail(`${HINTS[name](log)}The tunnel stopped (exit code ${code}). Its output (also in data\\tunnel.log):\n` + log.slice(-1500));
    });
  });
}

// If the tunnel dies later (network hiccup), bring it back; restart the bot if the address changed.
let restartingTunnel = false;
async function onTunnelLost(name, code) {
  if (restartingTunnel) return;
  restartingTunnel = true;
  say(`\n  The tunnel (${name}) stopped (code ${code}). Reconnecting in 10 seconds...\n`);
  await sleepMs(10_000);
  try {
    const url = await startTunnel();
    if (url !== publicUrl) {
      say(`  The address changed to ${url}; restarting the bot with it.`);
      publicUrl = url;
      writeFileSync(lastFile, publicUrl);
      restartBot();
    } else say('  Tunnel reconnected.');
  } finally { restartingTunnel = false; }
}

let publicUrl = await startTunnel();
mkdirSync(join(root, 'data'), { recursive: true });
const lastFile = join(root, 'data', 'last-public-url.txt');
const last = existsSync(lastFile) ? readFileSync(lastFile, 'utf8').trim() : '';
writeFileSync(lastFile, publicUrl);
say();
if (publicUrl !== last) {
  const copied = copyToClipboard(publicUrl);
  banner([
    'New Mini App address:',
    publicUrl,
    copied ? '(copied to the clipboard)' : '',
    'The "Open App" buttons in the chat update by themselves.',
    'Optional: paste it in @BotFather > your bot > Bot Settings >',
    'Configure Mini App, for the Open button in the bot\'s profile.',
  ].filter(Boolean));
} else {
  say(`  Mini App address unchanged: ${publicUrl}`);
}
say();

// 5. Bot (restarted automatically if it crashes) ---------------------------------------
let quickFails = 0;
let currentBot = null;
function startBot() {
  const started = Date.now();
  const bot = spawn(process.execPath, ['--env-file=.env', '--disable-warning=ExperimentalWarning', 'src/main.ts'], {
    cwd: root, stdio: 'inherit',
    env: { ...botEnv(), PUBLIC_URL: publicUrl, PORT: String(PORT) }, // these win over .env
  });
  currentBot = bot;
  children.add(bot);
  bot.on('exit', (code) => {
    children.delete(bot);
    if (bot.expectedExit) { startBot(); return; }
    if (Date.now() - started < 20_000) quickFails++; else quickFails = 0;
    if (quickFails >= 2) fail('The bot keeps stopping right after it starts. Check the error above (often a wrong BOT_TOKEN or a typo in .env).');
    say(`\n  The bot stopped (code ${code}). Restarting in 5 seconds...\n`);
    setTimeout(startBot, 5000);
  });
}
function restartBot() {
  if (!currentBot) return startBot();
  currentBot.expectedExit = true;
  currentBot.kill();
}
say('  Starting the bot... (send /start to it in Telegram)');
say();
startBot();

// 6. Self-check: can the Mini App actually be reached through the tunnel? ------------------
(async () => {
  const deadline = Date.now() + 90_000;
  let lastErr = '';
  await sleepMs(3000);
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${publicUrl}/healthz`, { headers: { 'tuna-skip-browser-warning': '1', 'ngrok-skip-browser-warning': '1' }, signal: AbortSignal.timeout(8000) });
      const j = await r.json().catch(() => null);
      if (r.ok && j && j.ok) { say(`\n  [OK] The Mini App is reachable: ${publicUrl}\n`); return; }
      lastErr = `HTTP ${r.status}`;
    } catch (e) { lastErr = e?.cause?.code || e?.message || String(e); }
    await sleepMs(4000);
  }
  say();
  banner([
    'WARNING: could not reach the Mini App through the tunnel',
    `(${publicUrl} -> ${lastErr})`,
    'The bot works in the chat, but "Open App" may show an error.',
    'Try restarting start.bat. Tunnel used: ' + TUNNEL + '.',
    'Tunnel log: data\\tunnel.log',
  ]);
  say();
})();
