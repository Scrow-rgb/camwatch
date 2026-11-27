// Monitor de câmeras (estilo Zabbix) - sem dependências externas.
// Uso: node server.js   -> http://localhost:8080
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFile } = require('child_process');

const crypto = require('crypto');
const sea = require('node:sea');

const IS_SEA = sea.isSea();
const BASE_DIR = process.env.CAMWATCH_HOME || (IS_SEA ? path.dirname(process.execPath) : __dirname); // dados ficam ao lado do .exe
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1'; // use HOST=0.0.0.0 para acessar da rede
const DATA_DIR = path.join(BASE_DIR, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const IS_WIN = process.platform === 'win32';

// ---------- Login ----------
// Na primeira execução gera a senha do usuário "admin", salva só o hash e mostra a senha uma vez.
function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 32).toString('hex'); }
function loadAuth() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* primeira vez */ }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const pw = process.env.CAMWATCH_PASSWORD || crypto.randomBytes(6).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  const cfg = { user: 'admin', salt, hash: hashPw(pw, salt) };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  fs.writeFileSync(path.join(BASE_DIR, 'SENHA-INICIAL.txt'),
    `Usuário: admin\r\nSenha: ${pw}\r\n\r\nApague este arquivo depois de anotar a senha.\r\nPara trocar a senha: apague data\\config.json e abra o programa com a variável CAMWATCH_PASSWORD definida.\r\n`);
  console.log(`\n=== PRIMEIRO ACESSO ===\n Usuário: admin\n Senha:   ${pw}\n (também salva em SENHA-INICIAL.txt)\n=======================\n`);
  return cfg;
}
const AUTH = loadAuth();
const sessions = new Map(); // token -> expira em
const loginFails = new Map(); // ip -> [timestamps]
const safeEq = (a, b) => {
  const h = (v) => crypto.createHash('sha256').update(String(v)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
};
function isLogged(req) {
  const m = /(?:^|;\s*)cw_session=([^;]+)/.exec(req.headers.cookie || '');
  const exp = m && sessions.get(m[1]);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(m[1]); return false; }
  return true;
}

// ---------- Persistência ----------
let db = { nextCameraId: 1, nextProblemId: 1, cameras: [], problems: [] };
try {
  db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
} catch { /* primeira execução */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 2));
    fs.renameSync(DB_FILE + '.tmp', DB_FILE);
  }, 200);
}

// ---------- Estado em memória (não persistido) ----------
// status: unknown | online | offline
const runtime = new Map(); // cameraId -> { status, fails, latency, lastCheck, lastChange, history[], nextCheck, busy, checks, ok }
function rt(id) {
  if (!runtime.has(id)) {
    runtime.set(id, { status: 'unknown', fails: 0, latency: null, lastCheck: null, lastChange: null, history: [], nextCheck: 0, busy: false, checks: 0, ok: 0 });
  }
  return runtime.get(id);
}
// Se havia problema aberto antes de reiniciar, a câmera já nasce "offline".
for (const p of db.problems) {
  if (!p.end) {
    const r = rt(p.cameraId);
    r.status = 'offline';
    r.lastChange = p.start;
    r.fails = 99;
  }
}

// ---------- Verificação ----------
const HOST_RE = /^(?!-)[A-Za-z0-9.\-]{1,253}$/;

function pingIcmp(host, timeoutMs) {
  return new Promise((resolve) => {
    const args = IS_WIN
      ? ['-n', '1', '-w', String(timeoutMs), host]
      : ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), host];
    const started = Date.now();
    execFile('ping', args, { timeout: timeoutMs + 3000, windowsHide: true }, (err, stdout) => {
      const out = String(stdout || '');
      // No Windows, "host inacessível" retorna exit 0; por isso exigimos TTL= na resposta.
      const ok = /TTL=/i.test(out) && !err;
      if (!ok) return resolve({ ok: false });
      const m = out.match(/(?:time|tempo)\s*([=<])\s*(\d+(?:[.,]\d+)?)\s*ms/i);
      let ms = m ? parseFloat(m[2].replace(',', '.')) : Date.now() - started;
      if (m && m[1] === '<') ms = Math.max(0.5, ms - 0.5);
      resolve({ ok: true, ms });
    });
  });
}

function pingTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok ? { ok: true, ms: Date.now() - started } : { ok: false });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

function probe(cam) {
  const timeout = 2000;
  return cam.method === 'tcp' ? pingTcp(cam.ip, cam.port, timeout) : pingIcmp(cam.ip, timeout);
}

async function check(cam) {
  const r = rt(cam.id);
  if (r.busy) return;
  r.busy = true;
  try {
    const res = await probe(cam);
    const now = Date.now();
    r.lastCheck = now;
    r.checks++;
    r.history.push(res.ok ? Math.round(res.ms * 10) / 10 : null);
    if (r.history.length > 40) r.history.shift();

    if (res.ok) {
      r.ok++;
      r.latency = res.ms;
      r.fails = 0;
      if (r.status !== 'online') {
        const wasOffline = r.status === 'offline';
        r.status = 'online';
        r.lastChange = now;
        if (wasOffline) resolveProblem(cam, now);
      }
    } else {
      r.latency = null;
      r.fails++;
      if (r.status !== 'offline' && r.fails >= cam.retries) {
        r.status = 'offline';
        r.lastChange = now;
        openProblem(cam, now);
      }
    }
  } finally {
    r.busy = false;
  }
}

function openProblem(cam, now) {
  if (db.problems.some((p) => p.cameraId === cam.id && !p.end)) return;
  db.problems.push({
    id: db.nextProblemId++,
    cameraId: cam.id,
    name: cam.name,
    ip: cam.ip,
    group: cam.group,
    start: now,
    end: null,
  });
  trimProblems();
  save();
  console.log(`[${new Date(now).toLocaleString('pt-BR')}] CAIU    ${cam.name} (${cam.ip})`);
}

function resolveProblem(cam, now) {
  let changed = false;
  for (const p of db.problems) {
    if (p.cameraId === cam.id && !p.end) { p.end = now; changed = true; }
  }
  save();
  if (changed) console.log(`[${new Date(now).toLocaleString('pt-BR')}] VOLTOU  ${cam.name} (${cam.ip})`);
}

function trimProblems() {
  if (db.problems.length > 5000) db.problems = db.problems.slice(-5000);
}

// Agendador: roda a cada 1s e dispara as verificações vencidas.
setInterval(() => {
  const now = Date.now();
  for (const cam of db.cameras) {
    if (!cam.enabled) continue;
    const r = rt(cam.id);
    if (r.busy || now < r.nextCheck) continue;
    r.nextCheck = now + cam.interval * 1000;
    check(cam).catch((e) => console.error('erro na verificação', cam.ip, e.message));
  }
}, 1000);

// ---------- API ----------
function normalizeCamera(input, existing) {
  const errors = [];
  const name = String(input.name ?? existing?.name ?? '').trim();
  const ip = String(input.ip ?? existing?.ip ?? '').trim();
  const group = String(input.group ?? existing?.group ?? '').trim() || 'Sem grupo';
  const method = (input.method ?? existing?.method ?? 'icmp') === 'tcp' ? 'tcp' : 'icmp';
  const port = Number(input.port ?? existing?.port ?? 554);
  const interval = Number(input.interval ?? existing?.interval ?? 10);
  const retries = Number(input.retries ?? existing?.retries ?? 3);
  const enabled = input.enabled === undefined ? existing?.enabled ?? true : !!input.enabled;

  if (!name) errors.push('Informe o nome da câmera.');
  if (!ip || !HOST_RE.test(ip)) errors.push('IP/host inválido.');
  if (method === 'tcp' && !(port >= 1 && port <= 65535)) errors.push('Porta inválida.');
  if (!(interval >= 2 && interval <= 3600)) errors.push('Intervalo deve ficar entre 2 e 3600 segundos.');
  if (!(retries >= 1 && retries <= 20)) errors.push('Tentativas deve ficar entre 1 e 20.');
  return { errors, value: { name, ip, group, method, port, interval, retries, enabled } };
}

function snapshot() {
  const now = Date.now();
  const cameras = db.cameras.map((c) => {
    const r = rt(c.id);
    const status = !c.enabled ? 'disabled' : r.status;
    return {
      ...c,
      status,
      latency: r.latency,
      lastCheck: r.lastCheck,
      lastChange: r.lastChange,
      fails: r.fails,
      history: r.history,
      availability: r.checks ? Math.round((r.ok / r.checks) * 1000) / 10 : null,
    };
  });
  const open = db.problems.filter((p) => !p.end);
  return {
    now,
    cameras,
    problems: db.problems.slice(-500).reverse(),
    summary: {
      total: cameras.length,
      online: cameras.filter((c) => c.status === 'online').length,
      offline: cameras.filter((c) => c.status === 'offline').length,
      unknown: cameras.filter((c) => c.status === 'unknown').length,
      disabled: cameras.filter((c) => c.status === 'disabled').length,
      openProblems: open.length,
    },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { reject(new Error('corpo muito grande')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('JSON inválido')); }
    });
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'cameras', id, 'check']
  try {
    if (req.method === 'POST' && parts[1] === 'login') {
      const ip = req.socket.remoteAddress;
      const recent = (loginFails.get(ip) || []).filter((t) => t > Date.now() - 15 * 60000);
      if (recent.length >= 5) return send(res, 429, { errors: ['Muitas tentativas. Aguarde 15 minutos.'] });
      const b = await readBody(req);
      const ok = safeEq(b.user ?? '', AUTH.user) && safeEq(hashPw(String(b.password ?? ''), AUTH.salt), AUTH.hash);
      if (!ok) {
        recent.push(Date.now()); loginFails.set(ip, recent);
        await new Promise((r) => setTimeout(r, 500));
        return send(res, 401, { errors: ['Usuário ou senha incorretos.'] });
      }
      loginFails.delete(ip);
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, Date.now() + 7 * 86400000);
      res.setHeader('Set-Cookie', `cw_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}`);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && parts[1] === 'logout') {
      const m = /(?:^|;\s*)cw_session=([^;]+)/.exec(req.headers.cookie || '');
      if (m) sessions.delete(m[1]);
      res.setHeader('Set-Cookie', 'cw_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return send(res, 200, { ok: true });
    }
    if (!isLogged(req)) return send(res, 401, { errors: ['Não autenticado.'] });

    if (req.method === 'GET' && parts[1] === 'state') return send(res, 200, { ...snapshot(), user: AUTH.user, agent: { lastSeen: Date.now(), stale: false } });

    if (parts[1] === 'cameras') {
      if (req.method === 'POST' && parts.length === 2) {
        const { errors, value } = normalizeCamera(await readBody(req));
        if (errors.length) return send(res, 400, { errors });
        const cam = { id: db.nextCameraId++, ...value, created: Date.now() };
        db.cameras.push(cam);
        rt(cam.id).nextCheck = 0;
        save();
        return send(res, 201, cam);
      }
      if (req.method === 'POST' && parts[2] === 'import') {
        // Importação em lote. Com dryRun:true só valida e devolve a prévia.
        const b = await readBody(req);
        const list = Array.isArray(b.cameras) ? b.cameras.slice(0, 2000) : [];
        const keyOf = (c) => `${c.ip.toLowerCase()}|${c.method}|${c.method === 'tcp' ? c.port : ''}`;
        const seen = new Set(db.cameras.map(keyOf));
        const rows = [], toAdd = [];
        list.forEach((item, i) => {
          const line = Number(item.line) || i + 2;
          const { errors, value } = normalizeCamera(item || {});
          if (errors.length) return rows.push({ line, name: String(item?.name ?? ''), ip: String(item?.ip ?? ''), status: 'erro', msg: errors.join(' ') });
          const k = keyOf(value);
          if (seen.has(k)) return rows.push({ line, name: value.name, ip: value.ip, status: 'duplicada', msg: 'Já cadastrada (mesmo IP).' });
          seen.add(k); toAdd.push(value);
          rows.push({ line, name: value.name, ip: value.ip, status: 'ok', msg: '' });
        });
        if (!b.dryRun) {
          for (const v of toAdd) {
            const cam = { id: db.nextCameraId++, ...v, created: Date.now() };
            db.cameras.push(cam);
            rt(cam.id).nextCheck = 0;
          }
          if (toAdd.length) save();
        }
        return send(res, 200, { added: b.dryRun ? 0 : toAdd.length, rows });
      }
      const id = Number(parts[2]);
      const cam = db.cameras.find((c) => c.id === id);
      if (!cam) return send(res, 404, { errors: ['Câmera não encontrada.'] });

      if (req.method === 'PUT' && parts.length === 3) {
        const { errors, value } = normalizeCamera(await readBody(req), cam);
        if (errors.length) return send(res, 400, { errors });
        Object.assign(cam, value);
        const r = rt(cam.id);
        r.nextCheck = 0;
        if (!cam.enabled) {
          // Desabilitar fecha o problema aberto para não ficar "preso".
          resolveProblem(cam, Date.now());
          r.status = 'unknown'; r.fails = 0;
        }
        save();
        return send(res, 200, cam);
      }
      if (req.method === 'DELETE' && parts.length === 3) {
        resolveProblem(cam, Date.now());
        db.cameras = db.cameras.filter((c) => c.id !== id);
        runtime.delete(id);
        save();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && parts[3] === 'check') {
        rt(cam.id).nextCheck = 0; // verificação imediata no próximo ciclo
        return send(res, 200, { ok: true });
      }
    }
    send(res, 404, { errors: ['Rota não encontrada.'] });
  } catch (e) {
    send(res, 400, { errors: [e.message] });
  }
}

// ---------- Arquivos estáticos ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const name = path.normalize(rel).replace(/^[\\/]+/, '').replace(/\\/g, '/');
  let buf = null;
  try {
    if (IS_SEA) { buf = Buffer.from(sea.getRawAsset(name)); } // arquivos embutidos no .exe
    else {
      const file = path.join(PUBLIC_DIR, name);
      if (file.startsWith(PUBLIC_DIR)) buf = fs.readFileSync(file);
    }
  } catch { buf = null; }
  if (!buf) { res.writeHead(404); return res.end('Não encontrado'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
  res.end(buf);
});

let tries = 0, currentPort = PORT;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && tries++ < 10) { currentPort++; return server.listen(currentPort, HOST); }
  console.error('Não foi possível iniciar o servidor:', e.message);
  setTimeout(() => process.exit(1), 15000);
});
server.on('listening', () => {
  const shown = `http://localhost:${server.address().port}`;
  console.log(`CamWatch rodando em ${shown}`);
  if (typeof global.__camwatchReady === 'function') global.__camwatchReady(server.address().port);
  console.log('Deixe esta janela aberta: se fechar, o monitoramento para.');
  if (IS_SEA && IS_WIN && !process.env.NO_BROWSER) execFile('cmd', ['/c', 'start', '', shown], { windowsHide: true }, () => {});
});
server.listen(currentPort, HOST);
