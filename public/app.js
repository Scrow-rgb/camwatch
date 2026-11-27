'use strict';
const $ = (s, r = document) => r.querySelector(s);
const view = $('#view');
let S = null;               // último estado recebido
let prevStatus = new Map(); // para detectar mudanças e avisar
let route = null;
let updater = () => {};

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtHour(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
function fmtDur(ms) {
  let s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
function dayLabel(ts) {
  const d = new Date(ts), t = new Date();
  const k = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const y = new Date(t); y.setDate(t.getDate() - 1);
  if (k(d) === k(t)) return 'Hoje';
  if (k(d) === k(y)) return 'Ontem';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}
const incText = (p) => {
  const cam = S.cameras.find((c) => c.id === p.cameraId);
  return cam && cam.method === 'tcp' ? `Câmera sem resposta (TCP ${cam.port})` : 'Câmera sem resposta (ping)';
};

// ---------- Rede ----------
async function api(method, url, body) {
  let r;
  try {
    r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Não foi possível falar com o servidor. Verifique se o "node server.js" está rodando e se a página foi aberta por http://localhost:8080 (não pelo arquivo).');
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== '/api/login') { showLogin(); throw new Error('Sessão expirada. Entre novamente.'); }
  if (!r.ok) throw new Error((j.errors || ['Erro']).join(' '));
  return j;
}

// ---------- Login ----------
function showLogin() { $('#login').classList.remove('hidden'); S = null; }
$('#login-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target, box = $('#login-error');
  box.classList.add('hidden');
  try {
    await api('POST', '/api/login', { user: f.user.value, password: f.password.value });
    f.password.value = '';
    $('#login').classList.add('hidden');
    poll();
  } catch (err) { box.textContent = err.message; box.classList.remove('hidden'); }
};
$('#logout').onclick = async () => { await fetch('/api/logout', { method: 'POST' }); showLogin(); };

async function poll() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    if (r.status === 401) { setConn(true); return showLogin(); }
    if (!r.ok) throw new Error('erro ' + r.status);
    S = await r.json();
    $('#whoami').textContent = S.user || '';
    setConn(true);
    detectChanges();
    chrome();
    updater();
  } catch {
    setConn(false);
  }
}
function setConn(ok) {
  $('#conn').className = 'dot ' + (ok ? 'ok' : 'bad');
  $('#conn-text').textContent = ok ? 'conectado' : 'sem conexão com o servidor';
}
function detectChanges() {
  for (const c of S.cameras) {
    const was = prevStatus.get(c.id);
    if (was && was !== c.status) {
      if (c.status === 'offline') toast(`<b>${esc(c.name)}</b> (${esc(c.ip)}) caiu`, true);
      if (c.status === 'online' && was === 'offline') toast(`<b>${esc(c.name)}</b> (${esc(c.ip)}) voltou`, false);
    }
    prevStatus.set(c.id, c.status);
  }
}
function toast(html, bad) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.innerHTML = html;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 8000);
}

// ---------- Cabeçalho / alerta / menu ----------
let alertDismissedFor = -1;
function chrome() {
  const n = S.summary.openProblems;
  const b = $('#badge');
  b.textContent = n; b.classList.toggle('hidden', n === 0);
  document.title = (n ? `(${n}) ` : '') + 'CamWatch';
  const ag = $('#agent-slot');
  if (S.agent.stale) {
    ag.innerHTML = `<div class="alert warn"><div class="alert-ico"><span>!</span></div><div class="alert-body"><b>Agente local sem comunicação.</b> ${S.agent.lastSeen ? 'Último sinal há ' + fmtDur(S.now - S.agent.lastSeen) + '. ' : 'Nenhum sinal recebido ainda. '}Os status abaixo podem estar desatualizados; verifique se o agente está rodando no PC da rede das câmeras.</div></div>`;
  } else ag.innerHTML = '';
  const slot = $('#alert-slot');
  if (n > 0 && alertDismissedFor !== n) {
    const names = S.cameras.filter((c) => c.status === 'offline').map((c) => esc(c.name)).slice(0, 4).join(', ');
    slot.innerHTML = `<div class="alert"><div class="alert-ico"><span>!</span></div><div class="alert-body"><b>${n} ${n === 1 ? 'câmera fora do ar' : 'câmeras fora do ar'}:</b> ${names}${n > 4 ? '…' : ''}</div><button class="x" title="Fechar">×</button></div>`;
    $('.x', slot).onclick = () => { alertDismissedFor = n; slot.innerHTML = ''; };
  } else if (n === 0) {
    slot.innerHTML = ''; alertDismissedFor = -1;
  }
}
setInterval(() => { $('#clock').textContent = fmtTime(Date.now()); }, 1000);

// ---------- Peças de UI ----------
function spark(h) {
  const w = 80, ht = 18;
  if (!h || !h.length) return '';
  const vals = h.filter((v) => v != null);
  const max = Math.max(5, ...vals);
  const step = w / Math.max(1, h.length - 1);
  let pts = '', ticks = '';
  h.forEach((v, i) => {
    const x = (i * step).toFixed(1);
    if (v == null) ticks += `<line x1="${x}" x2="${x}" y1="1" y2="${ht - 1}" stroke="#d64e4e" stroke-width="2"/>`;
    else pts += `${x},${(ht - 2 - (v / max) * (ht - 4)).toFixed(1)} `;
  });
  return `<svg class="spark" width="${w}" height="${ht}" viewBox="0 0 ${w} ${ht}"><polyline fill="none" stroke="#0275b8" stroke-width="1.2" points="${pts}"/>${ticks}</svg>`;
}
function availBadge(c) {
  const label = c.method === 'tcp' ? 'TCP' : 'PING';
  const cls = c.status === 'online' ? 'ok' : c.status === 'offline' ? 'bad' : 'off';
  return `<span class="avail ${cls}">${label}</span>`;
}
function statusText(c) {
  if (c.status === 'online') return '<span class="st-res">Online</span>';
  if (c.status === 'offline') return '<span class="st-inc">Fora do ar</span>';
  if (c.status === 'disabled') return '<span class="muted">Desativada</span>';
  return '<span class="muted">Aguardando</span>';
}
function widget(title, bodyId, extra = '') {
  return `<div class="widget"><div class="w-head"><span class="w-title">${title}</span>${extra}</div><div class="w-body" id="${bodyId}"></div></div>`;
}
// Incidente resolvido continua aparecendo (piscando) por 2 minutos nos incidentes ativos.
const RESOLVED_SHOW_MS = 2 * 60 * 1000;
const recentlyResolved = (p) => p.end && S.now - p.end < RESOLVED_SHOW_MS;
function incidentRows(list, withCheck) {
  if (!list.length) return `<tr><td class="empty" colspan="9">Nenhum incidente.</td></tr>`;
  return list.map((p) => {
    const open = !p.end;
    return `<tr class="${recentlyResolved(p) ? 'blink-res' : ''}">
      ${withCheck ? '<td><input type="checkbox"></td>' : ''}
      <td>${fmtTime(p.start)}</td>
      <td class="sev sev-dis">Desastre</td>
      <td>${p.end ? fmtTime(p.end) : ''}</td>
      <td class="${open ? 'st-inc' : 'st-res'}">${open ? 'Incidente' : 'Resolvido'}</td>
      <td><a class="ent" href="#/cameras?q=${encodeURIComponent(p.name)}">${esc(p.name)}</a> <span class="muted">${esc(p.ip)}</span></td>
      <td>${esc(incText(p))}</td>
      <td>${fmtDur((p.end || S.now) - p.start)}</td>
      <td><span class="tag">${esc(p.group || 'Sem grupo')}</span></td>
    </tr>`;
  }).join('');
}
function eventRows(limit) {
  const ev = [];
  for (const p of S.problems) {
    ev.push({ t: p.start, down: true, p });
    if (p.end) ev.push({ t: p.end, down: false, p });
  }
  ev.sort((a, b) => b.t - a.t);
  const list = ev.slice(0, limit);
  if (!list.length) return `<tr><td class="empty" colspan="5">Nenhum evento registrado ainda.</td></tr>`;
  let out = '', lastDay = '';
  for (const e of list) {
    const day = dayLabel(e.t);
    if (day !== lastDay) {
      out += `<tr class="mark"><td class="time">${day}</td><td colspan="4"></td></tr>`;
      lastDay = day;
    }
    out += `<tr>
      <td class="time">${fmtHour(e.t)}</td>
      <td><a class="ent" href="#/cameras?q=${encodeURIComponent(e.p.name)}">${esc(e.p.name)}</a> <span class="muted">${esc(e.p.ip)}</span></td>
      <td class="${e.down ? 'st-inc' : 'st-res'}">${e.down ? 'Incidente' : 'Resolvido'}</td>
      <td>${e.down ? 'Câmera caiu' : 'Câmera voltou'}</td>
      <td>${e.down ? '' : fmtDur(e.p.end - e.p.start) + ' fora'}</td>
    </tr>`;
  }
  return out;
}
const evHead = '<tr><th>Hora</th><th>Host</th><th>Status</th><th>Evento</th><th>Detalhe</th></tr>';

function setPage(title, crumbs) {
  $('#title').textContent = title;
  $('#crumbs').innerHTML = crumbs.map((c, i) => i === crumbs.length - 1 ? `<span class="cur">${esc(c)}</span>` : `<a href="#/dashboard">${esc(c)}</a><span>/</span>`).join('');
}

// ---------- Telas ----------
function pageDashboard() {
  setPage('Dashboard', ['Início', 'Dashboard']);
  view.innerHTML = `<div class="grid">
    <div class="col">
      ${widget('Incidentes ativos', 'w-prob')}
      ${widget('Eventos recentes', 'w-ev')}
    </div>
    <div class="col">
      ${widget('Disponibilidade das câmeras', 'w-sum')}
      ${widget('Câmeras por grupo', 'w-grp')}
    </div>
  </div>`;
  updater = () => {
    const sm = S.summary;
    const open = S.problems.filter((p) => !p.end || recentlyResolved(p));
    $('#w-prob').innerHTML = `<table><tr><th>Hora</th><th>Severidade</th><th>Host</th><th>Incidente</th><th>Status</th><th>Duração</th></tr>${
      open.length ? open.map((p) => `<tr class="${p.end ? 'blink-res' : ''}"><td>${fmtTime(p.start)}</td><td class="sev sev-dis">Desastre</td>
        <td><a class="ent" href="#/cameras?q=${encodeURIComponent(p.name)}">${esc(p.name)}</a> <span class="muted">${esc(p.ip)}</span></td>
        <td>${esc(incText(p))}</td><td class="${p.end ? 'st-res' : 'st-inc'}">${p.end ? 'Resolvido' : 'Incidente'}</td><td>${fmtDur((p.end || S.now) - p.start)}</td></tr>`).join('')
        : '<tr><td class="empty" colspan="6">Tudo certo: nenhuma câmera fora do ar.</td></tr>'}</table>`;
    $('#w-ev').innerHTML = `<table class="tl">${evHead}${eventRows(15)}</table>`;
    const pct = (n) => (sm.total ? (n / sm.total) * 100 : 0);
    $('#w-sum').innerHTML = `<div class="tiles">
        <div class="tile ok"><b>${sm.online}</b>Online</div>
        <div class="tile bad"><b>${sm.offline}</b>Fora do ar</div>
        <div class="tile na"><b>${sm.unknown}</b>Aguardando</div>
        <div class="tile off"><b>${sm.disabled}</b>Desativadas</div>
      </div>
      <div class="bar"><i style="width:${pct(sm.online)}%;background:var(--avail-ok)"></i><i style="width:${pct(sm.offline)}%;background:var(--avail-bad)"></i><i style="width:${pct(sm.unknown)}%;background:var(--sev-na)"></i></div>
      <div class="muted">${sm.total} ${sm.total === 1 ? 'câmera' : 'câmeras'} no total</div>`;
    $('#w-sum').classList.add('pad');
    const groups = {};
    for (const c of S.cameras) {
      const g = (groups[c.group] ||= { on: 0, off: 0, n: 0 });
      g.n++; if (c.status === 'online') g.on++; if (c.status === 'offline') g.off++;
    }
    const keys = Object.keys(groups).sort();
    $('#w-grp').classList.add('pad');
    $('#w-grp').innerHTML = keys.length ? keys.map((k) => `<div class="grp"><span>${esc(k)}</span><span><span class="cnt" style="background:var(--avail-ok)">${groups[k].on}</span> <span class="cnt ${groups[k].off ? '' : 'gray'}" ${groups[k].off ? 'style="background:var(--avail-bad)"' : ''}>${groups[k].off}</span> <span class="muted">/ ${groups[k].n}</span></span></div>`).join('')
      : '<div class="muted">Nenhuma câmera cadastrada. <a href="#/cameras">Cadastrar</a></div>';
  };
}

let incFilter = { status: 'all', q: '' };
function pageIncidentes() {
  setPage('Incidentes', ['Monitoramento', 'Incidentes']);
  view.innerHTML = `
    <div style="padding:4px 4px 0;display:flex;justify-content:flex-end"><button class="btn" id="csv">Exportar para CSV</button></div>
    <form class="filter" id="f">
      <div class="filter-tab"><svg class="ico" style="width:14px;height:14px" viewBox="0 0 24 24"><path d="M22 3H2l8 9.46V19l4 2v-8.54z"/></svg> Filtro</div>
      <div class="filter-body">
        <div class="f-row"><label>Status</label><div class="seg" id="seg"></div></div>
        <div class="f-row"><label>Câmera</label><input name="q" size="28" placeholder="nome ou IP"></div>
      </div>
      <div class="f-actions"><button class="btn primary" type="submit">Aplicar</button><button class="btn" type="button" id="clr">Limpar</button></div>
    </form>
    <div class="tbl-wrap" style="margin:4px"><table class="tl-none"><thead><tr><th><input type="checkbox"></th><th>Hora</th><th>Severidade</th><th>Recuperação</th><th>Status</th><th>Host</th><th>Incidente</th><th>Duração</th><th>Etiquetas</th></tr></thead><tbody id="tb"></tbody></table>
    <div class="pager" id="cnt"></div></div>`;
  const f = $('#f');
  f.q.value = incFilter.q;
  const drawSeg = () => {
    $('#seg').innerHTML = [['all', 'Todos'], ['open', 'Ativos'], ['done', 'Resolvidos']].map(([k, l]) => `<button type="button" data-k="${k}" class="${incFilter.status === k ? 'on' : ''}">${l}</button>`).join('');
  };
  drawSeg();
  $('#seg').onclick = (e) => { const k = e.target.dataset.k; if (k) { incFilter.status = k; drawSeg(); updater(); } };
  f.onsubmit = (e) => { e.preventDefault(); incFilter.q = f.q.value.trim().toLowerCase(); updater(); };
  $('#clr').onclick = () => { incFilter = { status: 'all', q: '' }; f.q.value = ''; drawSeg(); updater(); };
  const filtered = () => S.problems.filter((p) =>
    (incFilter.status === 'all' || (incFilter.status === 'open' ? (!p.end || recentlyResolved(p)) : !!p.end)) &&
    (!incFilter.q || (p.name + ' ' + p.ip).toLowerCase().includes(incFilter.q)));
  $('#csv').onclick = () => {
    const rows = [['Hora', 'Recuperacao', 'Status', 'Camera', 'IP', 'Grupo', 'Duracao']];
    for (const p of filtered()) rows.push([fmtTime(p.start), fmtTime(p.end), p.end ? 'Resolvido' : 'Incidente', p.name, p.ip, p.group, fmtDur((p.end || S.now) - p.start)]);
    const csv = '﻿' + rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'incidentes.csv'; a.click();
  };
  updater = () => {
    const l = filtered();
    $('#tb').innerHTML = incidentRows(l, true);
    $('#cnt').textContent = `Exibindo ${l.length} de ${S.problems.length} encontrados`;
  };
}

let camFilter = { q: '', group: '', status: '' };
function pageCameras() {
  setPage('Câmeras', ['Monitoramento', 'Câmeras']);
  const hq = decodeURIComponent((location.hash.split('?q=')[1] || ''));
  if (hq) camFilter.q = hq;
  view.innerHTML = `
    <div style="padding:4px 4px 0;display:flex;justify-content:flex-end;gap:6px"><button class="btn" id="import">Importar CSV</button><button class="btn primary" id="new">Criar câmera</button></div>
    <form class="filter" id="f">
      <div class="filter-tab"><svg class="ico" style="width:14px;height:14px" viewBox="0 0 24 24"><path d="M22 3H2l8 9.46V19l4 2v-8.54z"/></svg> Filtro</div>
      <div class="filter-body">
        <div class="f-row"><label>Nome / IP</label><input name="q" size="28"></div>
        <div class="f-row"><label>Grupo</label><select name="group"></select></div>
        <div class="f-row"><label>Status</label><select name="status"><option value="">Qualquer</option><option value="online">Online</option><option value="offline">Fora do ar</option><option value="unknown">Aguardando</option><option value="disabled">Desativada</option></select></div>
      </div>
      <div class="f-actions"><button class="btn primary" type="submit">Aplicar</button><button class="btn" type="button" id="clr">Limpar</button></div>
    </form>
    <div class="tbl-wrap" style="margin:4px"><table><thead><tr><th>Nome</th><th>Interface</th><th>Disp.</th><th>Grupo</th><th>Status</th><th>Latência</th><th>Gráfico</th><th>Uptime</th><th>Incidentes</th><th>Ações</th></tr></thead><tbody id="tb"></tbody></table>
    <div class="pager" id="cnt"></div></div>`;
  const f = $('#f');
  f.q.value = camFilter.q; f.status.value = camFilter.status;
  const fillGroups = () => {
    const gs = [...new Set(S ? S.cameras.map((c) => c.group) : [])].sort();
    f.group.innerHTML = '<option value="">Todos</option>' + gs.map((g) => `<option ${g === camFilter.group ? 'selected' : ''}>${esc(g)}</option>`).join('');
    $('#groups').innerHTML = gs.map((g) => `<option value="${esc(g)}">`).join('');
  };
  f.onsubmit = (e) => { e.preventDefault(); camFilter = { q: f.q.value.trim().toLowerCase(), group: f.group.value, status: f.status.value }; updater(); };
  $('#clr').onclick = () => { camFilter = { q: '', group: '', status: '' }; f.q.value = ''; f.group.value = ''; f.status.value = ''; updater(); };
  $('#new').onclick = () => openForm();
  $('#import').onclick = openImport;
  $('#tb').onclick = async (e) => {
    const btn = e.target.closest('button[data-a]'); if (!btn) return;
    const cam = S.cameras.find((c) => c.id === Number(btn.dataset.id));
    if (!cam) return;
    if (btn.dataset.a === 'edit') openForm(cam);
    if (btn.dataset.a === 'check') { await api('POST', `/api/cameras/${cam.id}/check`); toast(`Verificando ${esc(cam.name)}…`); setTimeout(poll, 1500); }
    if (btn.dataset.a === 'del' && confirm(`Excluir a câmera "${cam.name}"?`)) { await api('DELETE', `/api/cameras/${cam.id}`); poll(); }
  };
  let groupsKey = '';
  updater = () => {
    const key = S.cameras.map((c) => c.group).join('|');
    if (key !== groupsKey) { groupsKey = key; fillGroups(); }
    const l = S.cameras.filter((c) =>
      (!camFilter.q || (c.name + ' ' + c.ip).toLowerCase().includes(camFilter.q)) &&
      (!camFilter.group || c.group === camFilter.group) &&
      (!camFilter.status || c.status === camFilter.status));
    const count = (id) => S.problems.filter((p) => p.cameraId === id).length;
    $('#tb').innerHTML = l.length ? l.map((c) => {
      const n = count(c.id), openN = S.problems.some((p) => p.cameraId === c.id && !p.end);
      return `<tr>
        <td><span class="ent">${esc(c.name)}</span></td>
        <td>${esc(c.ip)}${c.method === 'tcp' ? ':' + c.port : ''}</td>
        <td>${availBadge(c)}</td>
        <td><span class="tag">${esc(c.group)}</span></td>
        <td>${statusText(c)}${c.status === 'offline' && c.lastChange ? ` <span class="muted">há ${fmtDur(S.now - c.lastChange)}</span>` : ''}</td>
        <td>${c.latency != null ? c.latency.toFixed(c.latency < 10 ? 1 : 0) + ' ms' : '<span class="muted">—</span>'}</td>
        <td>${spark(c.history)}</td>
        <td>${c.availability != null ? c.availability + '%' : '<span class="muted">—</span>'}</td>
        <td><span class="cnt ${n ? '' : 'gray'}" ${n ? `style="background:var(--avail-bad)"` : ''}>${n}</span>${openN ? ' <span class="st-inc">ativo</span>' : ''}</td>
        <td class="acts"><button class="btn sm" data-a="check" data-id="${c.id}">Verificar</button><button class="btn sm" data-a="edit" data-id="${c.id}">Editar</button><button class="btn sm danger" data-a="del" data-id="${c.id}">Excluir</button></td>
      </tr>`;
    }).join('') : `<tr><td class="empty" colspan="10">${S.cameras.length ? 'Nenhuma câmera com esse filtro.' : 'Nenhuma câmera cadastrada. Clique em "Criar câmera".'}</td></tr>`;
    $('#cnt').textContent = `Exibindo ${l.length} de ${S.cameras.length} encontrados`;
  };
}

function pageEventos() {
  setPage('Eventos', ['Monitoramento', 'Eventos']);
  view.innerHTML = `<div class="tbl-wrap" style="margin:4px"><table class="tl"><thead>${evHead}</thead><tbody id="tb"></tbody></table></div>`;
  updater = () => { $('#tb').innerHTML = eventRows(300); };
}

// ---------- Modal de câmera ----------
const form = $('#cam-form');
let editingId = null;
function openForm(cam) {
  editingId = cam ? cam.id : null;
  $('#modal-title').textContent = cam ? 'Editar câmera' : 'Nova câmera';
  $('#form-errors').classList.add('hidden');
  form.name.value = cam?.name ?? '';
  form.ip.value = cam?.ip ?? '';
  form.group.value = cam?.group && cam.group !== 'Sem grupo' ? cam.group : '';
  form.method.value = cam?.method ?? 'icmp';
  form.port.value = cam?.port ?? 554;
  form.interval.value = cam?.interval ?? 10;
  form.retries.value = cam?.retries ?? 3;
  form.enabled.checked = cam ? cam.enabled : true;
  syncPort();
  $('#modal').classList.remove('hidden');
  form.name.focus();
}
const syncPort = () => $('#port-label').classList.toggle('hidden', form.method.value !== 'tcp');
form.method.onchange = syncPort;
$('#cancel').onclick = () => $('#modal').classList.add('hidden');
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#modal').classList.add('hidden'); });
form.onsubmit = async (e) => {
  e.preventDefault();
  const body = {
    name: form.name.value, ip: form.ip.value, group: form.group.value, method: form.method.value,
    port: Number(form.port.value), interval: Number(form.interval.value), retries: Number(form.retries.value), enabled: form.enabled.checked,
  };
  try {
    await api(editingId ? 'PUT' : 'POST', editingId ? `/api/cameras/${editingId}` : '/api/cameras', body);
    $('#modal').classList.add('hidden');
    poll(); setTimeout(poll, 2500);
  } catch (err) {
    const box = $('#form-errors'); box.textContent = err.message; box.classList.remove('hidden');
  }
};

// ---------- Importação em lote (CSV) ----------
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const COLS = {
  name: ['nome', 'name', 'camera', 'descricao'], ip: ['ip', 'host', 'endereco', 'endereco ip'], group: ['grupo', 'group', 'local', 'localizacao'],
  method: ['metodo', 'method', 'tipo'], port: ['porta', 'port'], interval: ['intervalo', 'interval'], retries: ['tentativas', 'falhas', 'retries'], enabled: ['ativo', 'enabled', 'monitorar'],
};
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const count = (ch) => first.split(ch).length - 1;
  const delim = [';', '\t', ','].sort((a, b) => count(b) - count(a))[0];
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((v) => v.trim())) rows.push(row); else if (row.length > 1) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}
// Exportação de hosts do Zabbix (zbx_export_hosts.xml): usa o nome e o IP da 1ª interface.
// Grupo principal: o primeiro que começa com "CFTV"; senão o primeiro que não seja o genérico "Cameras".
function xmlToCameras(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('XML inválido.');
  const kids = (el, tag) => [...el.children].filter((c) => c.tagName === tag);
  const val = (el, tag) => (kids(el, tag)[0]?.textContent || '').trim();
  const root = doc.documentElement;
  const hostsEl = kids(root, 'hosts')[0];
  if (!hostsEl) throw new Error('Este XML não parece ser uma exportação de hosts do Zabbix.');
  return kids(hostsEl, 'host').map((h, i) => {
    const ifaces = kids(kids(h, 'interfaces')[0] || h, 'interface');
    const ifc = ifaces.find((x) => val(x, 'ip')) || ifaces[0];
    const groups = kids(kids(h, 'groups')[0] || h, 'group').map((g) => val(g, 'name')).filter(Boolean);
    const group = groups.find((g) => /^cftv/i.test(g)) || groups.find((g) => norm(g) !== 'cameras') || groups[0] || '';
    const item = { line: i + 1, name: val(h, 'name') || val(h, 'host'), ip: ifc ? (val(ifc, 'ip') || val(ifc, 'dns')) : '', method: 'icmp' };
    if (group) item.group = group;
    if (val(h, 'status') === 'DISABLED') item.enabled = false;
    return item;
  });
}
function csvToCameras(text) {
  if (text.trimStart().startsWith('<')) return xmlToCameras(text); // trimStart também remove o BOM
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const head = rows[0].map(norm);
  const idx = {};
  for (const [k, names] of Object.entries(COLS)) { const i = head.findIndex((h) => names.includes(h)); if (i >= 0) idx[k] = i; }
  let start = 1;
  if (idx.name === undefined && idx.ip === undefined) { // sem cabeçalho: ordem padrão
    ['name', 'ip', 'group', 'method', 'port', 'interval', 'retries', 'enabled'].forEach((k, i) => { idx[k] = i; });
    start = 0;
  }
  const out = [];
  for (let r = start; r < rows.length; r++) {
    const get = (k) => (idx[k] === undefined ? '' : String(rows[r][idx[k]] ?? '').trim());
    const item = { line: r + 1, name: get('name'), ip: get('ip') };
    if (get('group')) item.group = get('group');
    if (get('method')) item.method = /tcp|porta/.test(norm(get('method'))) ? 'tcp' : 'icmp';
    if (get('port')) item.port = Number(get('port'));
    if (get('interval')) item.interval = Number(get('interval'));
    if (get('retries')) item.retries = Number(get('retries'));
    if (get('enabled')) item.enabled = !/^(nao|não|n|0|false|no|inativo)$/.test(norm(get('enabled')));
    out.push(item);
  }
  return out;
}
let importList = [];
function openImport() {
  importList = [];
  $('#imp-file').value = '';
  $('#imp-error').classList.add('hidden');
  $('#imp-sum').textContent = '';
  $('#imp-rows').innerHTML = '<tr><td class="empty" colspan="4">Escolha um arquivo CSV.</td></tr>';
  $('#imp-go').disabled = true; $('#imp-go').textContent = 'Importar';
  $('#import-modal').classList.remove('hidden');
}
const closeImport = () => $('#import-modal').classList.add('hidden');
$('#imp-cancel').onclick = closeImport;
$('#import-modal').addEventListener('mousedown', (e) => { if (e.target.id === 'import-modal') closeImport(); });
$('#imp-template').onclick = () => {
  const csv = '﻿nome;ip;grupo;metodo;porta;intervalo;tentativas;ativo\r\nPortaria - Câmera 01;192.168.1.10;Matriz;ping;;10;3;sim\r\nEstacionamento - Câmera 02;192.168.1.11;Matriz;tcp;554;10;3;sim\r\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'modelo-cameras.csv'; a.click();
};
$('#imp-file').onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const err = $('#imp-error'); err.classList.add('hidden');
  try {
    importList = csvToCameras(await file.text());
    if (!importList.length) throw new Error('O arquivo está vazio.');
    if (importList.length > 2000) throw new Error('Máximo de 2000 câmeras por arquivo.');
    const r = await api('POST', '/api/cameras/import', { cameras: importList, dryRun: true });
    const ok = r.rows.filter((x) => x.status === 'ok').length;
    const bad = r.rows.length - ok;
    $('#imp-sum').innerHTML = `<b>${ok}</b> pronta(s) para importar${bad ? `, <b>${bad}</b> ignorada(s) (erro ou duplicada)` : ''}.`;
    const tag = { ok: '<span class="st-res">Pronta</span>', erro: '<span class="st-inc">Erro</span>', duplicada: '<span class="muted">Duplicada</span>' };
    $('#imp-rows').innerHTML = r.rows.map((x) => `<tr><td>${x.line}</td><td>${esc(x.name)}</td><td>${esc(x.ip)}</td><td>${tag[x.status]}${x.msg ? ' <span class="muted">' + esc(x.msg) + '</span>' : ''}</td></tr>`).join('');
    $('#imp-go').disabled = ok === 0;
    $('#imp-go').textContent = ok ? `Importar ${ok} câmera${ok > 1 ? 's' : ''}` : 'Importar';
  } catch (ex) {
    $('#imp-rows').innerHTML = '<tr><td class="empty" colspan="4">—</td></tr>';
    $('#imp-go').disabled = true; $('#imp-sum').textContent = '';
    err.textContent = ex.message; err.classList.remove('hidden');
  }
};
$('#imp-go').onclick = async () => {
  $('#imp-go').disabled = true;
  try {
    const r = await api('POST', '/api/cameras/import', { cameras: importList, dryRun: false });
    closeImport();
    toast(`<b>${r.added}</b> câmera(s) importada(s).`);
    poll(); setTimeout(poll, 2500);
  } catch (ex) { const err = $('#imp-error'); err.textContent = ex.message; err.classList.remove('hidden'); $('#imp-go').disabled = false; }
};
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeImport(); });

// ---------- Roteamento ----------
const pages = { dashboard: pageDashboard, incidentes: pageIncidentes, cameras: pageCameras, eventos: pageEventos };
function go() {
  const name = (location.hash.replace(/^#\//, '').split('?')[0]) || 'dashboard';
  route = pages[name] ? name : 'dashboard';
  document.querySelectorAll('#menu a').forEach((a) => a.classList.toggle('active', a.dataset.r === route));
  updater = () => {};
  pages[route]();
  if (S) updater();
}
window.addEventListener('hashchange', go);
go();
poll();
setInterval(poll, 3000);
