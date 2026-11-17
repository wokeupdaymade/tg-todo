// One-click launcher for running the bot on a Windows PC (used by start.bat).
// Starts an HTTPS tunnel for the Mini App, then the bot; restarts the bot if it
// crashes. Closing the console window stops everything.
// Plain .mjs on purpose: it must run (and explain) even on an old Node version.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  fail('First run: I created the settings file ".env" (it should open in Notepad).\nFill in BOT_TOKEN, ALLOWED_USER_IDS and DEFAULT_TZ, save it, then run start.bat again.');
}
// Notepad may save a UTF-8 BOM, which would hide the first setting from Node.
{
  const raw = readFileSync(envFile, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) writeFileSync(envFile, raw.slice(1));
}
const env = readEnv(envFile);
if (!env.BOT_TOKEN || /replace-me/.test(env.BOT_TOKEN)) fail('Put your bot token from @BotFather into BOT_TOKEN in the .env file.');
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

// 3. Tunnel (gives the Mini App the HTTPS address Telegram requires) ------------------
async function startTunnel() {
  if (env.NGROK_DOMAIN) {
    const domain = env.NGROK_DOMAIN.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    let ngrok = findExe('ngrok');
    if (!ngrok && isWin) {
      say('  ngrok not found; installing it with winget (one time)...');
      spawnSync('winget', ['install', '--id', 'Ngrok.Ngrok', '-e', '--accept-source-agreements', '--accept-package-agreements'], { stdio: 'inherit' });
      ngrok = findExe('ngrok', [join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ngrok.exe')]);
    }
    if (!ngrok) fail('ngrok is not installed (or a new window is needed after installing it).\nInstall it from https://ngrok.com/download, then run start.bat again.');
    say(`  Starting tunnel (ngrok, ${domain})...`);
    const p = spawn(ngrok, ['http', `--url=${domain}`, String(PORT), '--log=stdout'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(p);
    return await waitForUrl(p, () => `https://${domain}`, /started tunnel|url=https:/i);
  }
  let cf = findExe('cloudflared', ['C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe']);
  if (!cf && isWin) {
    say('  cloudflared not found; installing it with winget (one time)...');
    spawnSync('winget', ['install', '--id', 'Cloudflare.cloudflared', '-e', '--accept-source-agreements', '--accept-package-agreements'], { stdio: 'inherit' });
    cf = findExe('cloudflared', ['C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe']);
  }
  if (!cf) fail('cloudflared is not installed. Run:  winget install --id Cloudflare.cloudflared\nthen start.bat again.');
  say('  Starting tunnel (cloudflared)...');
  const p = spawn(cf, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(p);
  return await waitForUrl(p, (m) => m[0], /https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
}

function waitForUrl(proc, toUrl, re) {
  return new Promise((resolve) => {
    let log = '';
    const timer = setTimeout(() => fail('The tunnel did not start within 60 seconds. Its output:\n' + log.slice(-1500)), 60_000);
    const onData = (d) => {
      log += d.toString();
      const m = re.exec(log);
      if (m) { clearTimeout(timer); resolve(toUrl(m)); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => {
      const hint = /ERR_NGROK_4018|authtoken/i.test(log)
        ? 'ngrok needs your account token once. Copy the command from https://dashboard.ngrok.com/get-started/your-authtoken\n(it looks like: ngrok config add-authtoken 2abc...), run it in a terminal, then start.bat again.\n\n'
        : /ERR_NGROK_(313|320|15013)|domain/i.test(log)
          ? 'ngrok refused the address in NGROK_DOMAIN. Copy it exactly from https://dashboard.ngrok.com/domains\n(only the part like your-name.ngrok-free.app).\n\n'
          : '';
      fail(`${hint}The tunnel stopped (exit code ${code}). Its output:\n` + log.slice(-1500));
    });
  });
}

const publicUrl = await startTunnel();
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

// 4. Bot (restarted automatically if it crashes) ---------------------------------------
let quickFails = 0;
function startBot() {
  const started = Date.now();
  const bot = spawn(process.execPath, ['--env-file=.env', '--disable-warning=ExperimentalWarning', 'src/main.ts'], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, PUBLIC_URL: publicUrl, PORT: String(PORT) }, // these win over .env
  });
  children.add(bot);
  bot.on('exit', (code) => {
    children.delete(bot);
    if (Date.now() - started < 20_000) quickFails++; else quickFails = 0;
    if (quickFails >= 2) fail('The bot keeps stopping right after it starts. Check the error above (often a wrong BOT_TOKEN or a typo in .env).');
    say(`\n  The bot stopped (code ${code}). Restarting in 5 seconds...\n`);
    setTimeout(startBot, 5000);
  });
}
say('  Starting the bot... (send /start to it in Telegram)');
say();
startBot();
