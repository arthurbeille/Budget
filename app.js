'use strict';

/* =====================================================================
   Budget — appli web au-dessus du Google Sheet "Finance"
   Données : API Apps Script (voir apps-script/Code.gs), cache local + file
   d'attente hors ligne. Sans configuration, l'appli tourne en mode démo.
   ===================================================================== */

const TYPES = ['Dépense', 'Revenu', 'Épargne', 'Prime'];
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
  'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const BIG_EXPENSE = 150; // € — au-delà, une dépense n'entre pas dans le rythme quotidien
const MOIS_COURT = ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'];
const KEY = { config: 'budget.config', cache: 'budget.cache', outbox: 'budget.outbox' };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ------------------------------------------------------------------ Stockage local

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* stockage indisponible */ }
  },
  remove(key) { try { localStorage.removeItem(key); } catch { /* idem */ } },
};

// ------------------------------------------------------------------ État

const now = new Date();
const state = {
  config: store.get(KEY.config, { apiUrl: '', token: '' }),
  data: store.get(KEY.cache, null),
  outbox: store.get(KEY.outbox, []),
  tab: 'mois',
  month: { y: now.getFullYear(), m: now.getMonth() }, // m : 0-11
  filter: { q: '', type: '', category: '', allMonths: false },
  showEmptyCats: false,
  syncing: false,
  lastError: '',
};

const isDemo = () => !state.config.apiUrl;


// ------------------------------------------------------------------ Formatage

const eur = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const eur0 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const fmt = n => eur.format(n);
const fmt0 = n => eur0.format(Math.round(n));
const fmtShort = n => (Math.abs(n) >= 1000 ? (n / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' k€' : fmt0(n));

const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayIso = () => iso(new Date());
const monthKey = (y, m) => `${y}-${pad(m + 1)}`;
const monthLabel = (y, m) => `${MOIS[m]} ${y}`;
const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();
const addMonths = ({ y, m }, k) => { const d = new Date(y, m + k, 1); return { y: d.getFullYear(), m: d.getMonth() }; };

function dayLabel(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = Math.round((t - date) / 864e5);
  if (diff === 0) return "Aujourd'hui";
  if (diff === 1) return 'Hier';
  const label = date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parseAmount = s => { const n = parseFloat(String(s).replace(/\s|€/g, '').replace(',', '.')); return isNaN(n) ? 0 : n; };

// ------------------------------------------------------------------ Données dérivées

const txs = () => state.data.transactions;
const cats = () => state.data.categories;
const catByName = name => cats().find(c => c.name === name);
const emojiFor = (tx) => {
  if (tx.type === 'Revenu') return '💶';
  if (tx.type === 'Prime') return '🎉';
  if (tx.type === 'Épargne') return '🐷';
  return catByName(tx.category)?.emoji || '•';
};

function monthTx(y, m) {
  const k = monthKey(y, m);
  return txs().filter(t => t.date.startsWith(k));
}

function monthSummary(y, m) {
  const list = monthTx(y, m);
  const sum = type => list.filter(t => t.type === type).reduce((a, t) => a + t.amount, 0);
  const spent = sum('Dépense');
  const income = sum('Revenu') + sum('Prime');
  const saved = sum('Épargne');
  const byCat = {};
  for (const t of list) if (t.type === 'Dépense') byCat[t.category] = (byCat[t.category] || 0) + t.amount;
  const budget = cats().reduce((a, c) => a + (c.budget || 0), 0);
  return { list, spent, income, saved, byCat, budget };
}

// ------------------------------------------------------------------ API

class ApiError extends Error {}

async function api(action, payload = {}) {
  const res = await fetch(state.config.apiUrl, {
    method: 'POST',
    // text/plain évite la requête préliminaire CORS, non supportée par Apps Script
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, token: state.config.token, ...payload }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  if (!json.ok) throw new ApiError(json.error || 'Erreur API');
  return json;
}

function persist() {
  store.set(KEY.cache, state.data);
  store.set(KEY.outbox, state.outbox);
}

async function sync({ silent = false } = {}) {
  if (isDemo() || state.syncing) return;
  state.syncing = true; setSync('Synchro…');
  try {
    await flushOutbox();
    const res = await api('getAll');
    const pending = txs().filter(t => t.pending);
    state.data = { transactions: [...res.transactions, ...pending], categories: res.categories };
    state.lastError = '';
    persist();
    setSync('');
    render();
  } catch (e) {
    state.lastError = e.message;
    setSync(e instanceof ApiError ? '⚠ ' + e.message : 'Hors ligne');
    if (!silent) toast(e instanceof ApiError ? e.message : 'Hors ligne — les modifications seront envoyées plus tard');
  } finally {
    state.syncing = false;
  }
}

/** Envoie les opérations en attente, dans l'ordre. S'arrête à la première erreur réseau. */
async function flushOutbox() {
  while (state.outbox.length) {
    const op = state.outbox[0];
    try {
      if (op.op === 'add') {
        const { transaction } = await api('add', { transaction: stripTx(op.tx) });
        replaceTxId(op.tx.id, transaction.id);
      } else if (op.op === 'update') {
        await api('update', { transaction: stripTx(op.tx) });
        const t = txs().find(x => x.id === op.tx.id); if (t) delete t.pending;
      } else if (op.op === 'delete') {
        await api('delete', { id: op.id });
      }
    } catch (e) {
      if (!(e instanceof ApiError)) throw e; // réseau : on réessaiera
      toast('Opération refusée : ' + e.message);
    }
    state.outbox.shift();
    persist();
  }
}

const stripTx = ({ pending, ...t }) => t;

function replaceTxId(tmpId, realId) {
  const t = txs().find(x => x.id === tmpId);
  if (t) { t.id = realId; delete t.pending; }
  for (const op of state.outbox) {
    if (op.tx?.id === tmpId) op.tx.id = realId;
    if (op.id === tmpId) op.id = realId;
  }
}

function queue(op) {
  if (isDemo()) { persist(); return; }
  state.outbox.push(op);
  persist();
  sync({ silent: true });
}

// ------------------------------------------------------------------ Mutations

function saveTx(tx) {
  const existing = txs().find(t => t.id === tx.id);
  if (existing) {
    Object.assign(existing, tx, { pending: !isDemo() });
    // Ajout pas encore envoyé : on modifie l'ajout plutôt que d'empiler une mise à jour
    const pendingAdd = state.outbox.find(o => o.op === 'add' && o.tx.id === tx.id);
    if (pendingAdd) { pendingAdd.tx = { ...existing }; persist(); sync({ silent: true }); }
    else queue({ op: 'update', tx: { ...existing } });
  } else {
    const t = { ...tx, id: 'tmp-' + Date.now().toString(36), pending: !isDemo() };
    txs().push(t);
    queue({ op: 'add', tx: { ...t } });
  }
  render();
}

function deleteTx(id) {
  state.data.transactions = txs().filter(t => t.id !== id);
  const i = state.outbox.findIndex(o => o.op === 'add' && o.tx.id === id);
  if (i >= 0) { state.outbox.splice(i, 1); persist(); }
  else { state.outbox = state.outbox.filter(o => o.tx?.id !== id); queue({ op: 'delete', id }); }
  render();
}

async function saveCategories(list) {
  if (isDemo()) { state.data.categories = list; persist(); render(); toast('Budgets enregistrés (démo)'); return; }
  try {
    const res = await api('saveCategories', { categories: list });
    state.data.categories = res.categories; persist(); render();
    toast('Budgets enregistrés');
  } catch (e) {
    toast('Échec : ' + e.message);
  }
}

// ------------------------------------------------------------------ Rendu

function render() {
  const { y, m } = state.month;
  $('#monthTitle').textContent = monthLabel(y, m);
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
  const view = $('#view');
  const views = { mois: viewMonth, historique: viewHistory, stats: viewStats, reglages: viewSettings };
  view.innerHTML = views[state.tab]();
  if (state.tab === 'stats') drawMonthlyChart();
  if (state.tab === 'reglages') bindSettings();
}

function demoBanner() {
  return isDemo()
    ? `<div class="banner">Mode démo : données fictives. <button data-goto="reglages">Connecter mon Google Sheet</button></div>`
    : '';
}

function viewMonth() {
  const { y, m } = state.month;
  const s = monthSummary(y, m);
  const left = s.budget - s.spent;
  const ratio = s.budget ? s.spent / s.budget : 0;

  // Rythme : part du mois écoulée (mois en cours seulement)
  const t = new Date();
  const isCurrent = t.getFullYear() === y && t.getMonth() === m;
  const elapsed = isCurrent ? t.getDate() / daysIn(y, m) : null;
  // Projection : dépenses déjà faites + rythme des dépenses courantes (hors grosses dépenses ponctuelles comme le loyer)
  const daily = s.list.filter(x => x.type === 'Dépense' && x.amount < BIG_EXPENSE).reduce((a, x) => a + x.amount, 0) / t.getDate();
  const projection = isCurrent && t.getDate() >= 3 ? s.spent + daily * (daysIn(y, m) - t.getDate()) : null;

  const meterCls = ratio > 1 ? 'over' : (elapsed != null && ratio > elapsed + 0.1) || ratio > 0.85 ? 'warn' : '';

  const rows = categoryRows(s);
  const visible = rows.filter(r => r.spent > 0 || state.showEmptyCats);
  const hidden = rows.length - rows.filter(r => r.spent > 0).length;

  const recent = [...s.list].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);

  return `
    ${demoBanner()}
    <section class="card" aria-label="Budget du mois">
      <div class="hero-label">${left >= 0 ? 'Reste à dépenser' : 'Budget dépassé de'}</div>
      <div class="hero-value ${left < 0 ? 'over' : ''}">${fmt(Math.abs(left))}</div>
      <div class="meter ${meterCls}" role="meter" aria-valuemin="0" aria-valuemax="${s.budget}" aria-valuenow="${s.spent}" aria-label="Dépensé sur budget">
        <i style="width:${Math.min(ratio, 1) * 100}%"></i>
        ${elapsed != null ? `<span class="pace" style="left:${elapsed * 100}%" title="Aujourd'hui"></span>` : ''}
      </div>
      <div class="hero-sub">
        <span>${fmt(s.spent)} dépensés sur ${fmt0(s.budget)}</span>
        ${projection != null ? `<span>Projection : <b>${fmt0(projection)}</b></span>` : ''}
      </div>
    </section>

    <div class="tiles">
      <div class="tile"><div class="k">Revenus</div><div class="v">${fmt0(s.income)}</div></div>
      <div class="tile"><div class="k">Épargne</div><div class="v">${fmt0(s.saved)}</div></div>
      <div class="tile"><div class="k">Solde</div><div class="v">${fmt0(s.income - s.spent - s.saved)}</div></div>
    </div>

    <h2 class="section-title">Catégories
      ${hidden ? `<button id="toggleEmpty">${state.showEmptyCats ? 'Masquer' : `+ ${hidden} sans dépense`}</button>` : ''}
    </h2>
    <section class="card list-card cat-list">
      ${visible.length ? visible.map(catRow).join('') : '<div class="empty">Aucune dépense ce mois-ci</div>'}
    </section>

    ${recent.length ? `
      <h2 class="section-title">Dernières opérations <button data-goto="historique">Tout voir</button></h2>
      <section class="card list-card">${recent.map(txRow).join('')}</section>` : ''}
  `;
}

function categoryRows(s) {
  const names = cats().map(c => c.name);
  for (const n of Object.keys(s.byCat)) if (!names.includes(n)) names.push(n);
  return names.map(name => {
    const c = catByName(name);
    const budget = c?.budget || 0;
    const spent = s.byCat[name] || 0;
    return { name, emoji: c?.emoji || '•', budget, spent, ratio: budget ? spent / budget : (spent ? Infinity : 0) };
  }).sort((a, b) => (b.ratio - a.ratio) || (b.spent - a.spent));
}

function catRow(r) {
  let leftTxt, cls = '';
  if (!r.budget) { leftTxt = r.spent ? 'hors budget' : '—'; cls = r.spent ? 'warn' : ''; }
  else if (r.spent > r.budget) { leftTxt = `+${fmt0(r.spent - r.budget)} de dépassement`; cls = 'over'; }
  else { leftTxt = `${fmt0(r.budget - r.spent)} restants`; cls = r.ratio > 0.85 ? 'warn' : ''; }
  const meterCls = r.ratio > 1 ? 'over' : r.ratio > 0.85 ? 'warn' : '';
  return `
    <button class="cat-row" data-cat="${esc(r.name)}">
      <span class="emoji" aria-hidden="true">${esc(r.emoji)}</span>
      <span class="name">${esc(r.name)}</span>
      <span class="amt">${fmt(r.spent)} <small>/ ${fmt0(r.budget)}</small></span>
      <span class="meter ${meterCls}" aria-hidden="true"><i style="width:${Math.min(r.ratio, 1) * 100}%"></i></span>
      <span class="left ${cls}">${leftTxt}</span>
    </button>`;
}

function txRow(t) {
  const sign = t.type === 'Dépense' ? '−' : t.type === 'Épargne' ? '' : '+';
  const cls = t.type === 'Revenu' || t.type === 'Prime' ? 'in' : t.type === 'Épargne' ? 'save' : '';
  const title = t.note || (t.type === 'Dépense' ? t.category : t.type);
  const sub = t.type === 'Dépense' ? (t.note ? t.category : '') : t.type;
  return `
    <button class="tx ${t.pending ? 'pending' : ''}" data-tx="${esc(t.id)}">
      <span class="emoji" aria-hidden="true">${esc(emojiFor(t))}</span>
      <span><div class="t1">${esc(title)}</div>${sub || t.pending ? `<div class="t2">${esc(sub)}${t.pending ? ' · en attente' : ''}</div>` : ''}</span>
      <span class="val ${cls}">${sign}${fmt(t.amount)}</span>
    </button>`;
}

function viewHistory() {
  const f = state.filter;
  const { y, m } = state.month;
  const q = f.q.trim().toLowerCase();
  let list = f.allMonths ? [...txs()] : monthTx(y, m);
  if (f.type) list = list.filter(t => t.type === f.type);
  if (f.category) list = list.filter(t => t.category === f.category);
  if (q) list = list.filter(t => (t.note + ' ' + t.category + ' ' + t.type).toLowerCase().includes(q) || String(t.amount).includes(q));
  list.sort((a, b) => b.date.localeCompare(a.date));

  const groups = [];
  for (const t of list) {
    const g = groups[groups.length - 1];
    if (g && g.date === t.date) g.items.push(t); else groups.push({ date: t.date, items: [t] });
  }
  const total = list.filter(t => t.type === 'Dépense').reduce((a, t) => a + t.amount, 0);

  return `
    ${demoBanner()}
    <input class="search" id="search" type="search" placeholder="Rechercher (note, catégorie, montant)" value="${esc(f.q)}" autocomplete="off">
    <div class="chips" role="toolbar" aria-label="Filtres">
      <button class="chip ${f.allMonths ? 'active' : ''}" data-allmonths>Tous les mois</button>
      <button class="chip ${!f.type ? 'active' : ''}" data-type="">Tout</button>
      ${TYPES.map(t => `<button class="chip ${f.type === t ? 'active' : ''}" data-type="${t}">${t}</button>`).join('')}
      ${f.category ? `<button class="chip active" data-clearcat>${esc(f.category)} ✕</button>` : ''}
    </div>
    <div class="day-head"><span>${list.length} opération${list.length > 1 ? 's' : ''}</span><span>Dépenses : ${fmt(total)}</span></div>
    ${groups.length ? groups.map(g => {
      const dayTotal = g.items.filter(t => t.type === 'Dépense').reduce((a, t) => a + t.amount, 0);
      return `<div class="day-head"><span>${dayLabel(g.date)}</span><span>${dayTotal ? fmt(dayTotal) : ''}</span></div>
        <section class="card list-card">${g.items.map(txRow).join('')}</section>`;
    }).join('') : '<div class="empty">Aucune opération</div>'}
  `;
}

function viewStats() {
  const { y, m } = state.month;
  const s = monthSummary(y, m);
  const months = Array.from({ length: 6 }, (_, i) => addMonths(state.month, i - 5));
  const series = months.map(mm => ({ ...mm, ...monthSummary(mm.y, mm.m) }));
  const withData = series.filter(x => x.list.length);
  const avgSpent = withData.length ? withData.reduce((a, x) => a + x.spent, 0) / withData.length : 0;
  const totalIncome = withData.reduce((a, x) => a + x.income, 0);
  const totalSaved = withData.reduce((a, x) => a + x.saved, 0);
  const savingRate = totalIncome ? totalSaved / totalIncome : null;

  // Moyenne des 3 derniers mois par catégorie, pour calibrer les budgets
  const last3 = months.slice(-3).map(mm => monthSummary(mm.y, mm.m));
  const n3 = last3.filter(x => x.list.length).length || 1;
  const catNames = [...new Set([...cats().map(c => c.name), ...last3.flatMap(x => Object.keys(x.byCat))])];
  const calib = catNames.map(name => {
    const avg = last3.reduce((a, x) => a + (x.byCat[name] || 0), 0) / n3;
    const budget = catByName(name)?.budget || 0;
    return { name, avg, budget, gap: budget - avg };
  }).filter(r => r.avg || r.budget).sort((a, b) => a.gap - b.gap);

  const breakdown = Object.entries(s.byCat).sort((a, b) => b[1] - a[1]);
  const max = breakdown[0]?.[1] || 1;

  return `
    ${demoBanner()}
    <div class="tiles">
      <div class="tile"><div class="k">Dépense moy./mois</div><div class="v">${fmt0(avgSpent)}</div></div>
      <div class="tile"><div class="k">Budget mensuel</div><div class="v">${fmt0(s.budget)}</div></div>
      <div class="tile"><div class="k">Taux d'épargne</div><div class="v">${savingRate == null ? '—' : Math.round(savingRate * 100) + ' %'}</div></div>
    </div>

    <h2 class="section-title">Dépenses par mois</h2>
    <section class="card">
      <div id="monthlyChart" data-series='${esc(JSON.stringify(series.map(x => ({ label: MOIS_COURT[x.m], full: monthLabel(x.y, x.m), spent: x.spent, budget: x.budget, current: x.y === y && x.m === m }))))}'></div>
      <div class="legend">
        <span><i></i>Dans le budget</span><span><i class="over"></i>Au-dessus du budget</span><span><i class="ref"></i>Budget (${fmt0(s.budget)})</span>
      </div>
      <details><summary>Voir le tableau</summary>
        <table class="data"><thead><tr><th>Mois</th><th>Dépenses</th><th>Revenus</th><th>Épargne</th></tr></thead>
        <tbody>${series.map(x => `<tr><td style="text-transform:capitalize">${monthLabel(x.y, x.m)}</td><td>${fmt0(x.spent)}</td><td>${fmt0(x.income)}</td><td>${fmt0(x.saved)}</td></tr>`).join('')}</tbody></table>
      </details>
    </section>

    <h2 class="section-title"><span>Répartition · <span style="text-transform:none">${monthLabel(y, m)}</span></span></h2>
    <section class="card">
      ${breakdown.length ? breakdown.map(([name, v]) => `
        <div class="hbar"><span class="n">${esc(catByName(name)?.emoji || '•')} ${esc(name)}</span>
        <span><span class="b" style="display:block;width:${v / max * 100}%"></span></span>
        <span class="v">${fmt0(v)}</span></div>`).join('') : '<div class="empty">Aucune dépense</div>'}
    </section>

    <h2 class="section-title">Budgets vs moyenne 3 mois</h2>
    <section class="card">
      <p class="note" style="margin:0 0 8px">Pour ajuster des budgets réalistes. Négatif = tu dépenses plus que prévu en moyenne.</p>
      <table class="data">
        <thead><tr><th>Catégorie</th><th>Moy.</th><th>Budget</th><th>Écart</th></tr></thead>
        <tbody>${calib.map(r => `<tr><td>${esc(r.name)}</td><td>${fmt0(r.avg)}</td><td>${fmt0(r.budget)}</td>
          <td style="color:${r.gap < 0 ? 'var(--critical)' : 'inherit'}">${r.gap < 0 ? '−' : '+'}${fmt0(Math.abs(r.gap))}</td></tr>`).join('')}</tbody>
      </table>
    </section>
  `;
}

function drawMonthlyChart() {
  const host = $('#monthlyChart');
  if (!host) return;
  const data = JSON.parse(host.dataset.series);
  const W = Math.max(host.clientWidth, 280), H = 190;
  const pad = { t: 12, r: 4, b: 22, l: 40 };
  const budget = data[data.length - 1].budget;
  const maxV = Math.max(budget, ...data.map(d => d.spent), 1);
  const nice = niceMax(maxV);
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const yOf = v => pad.t + ih - v / nice * ih;
  const step = iw / data.length;
  const bw = Math.min(36, step * 0.56);

  const ticks = [0, nice / 2, nice];
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Dépenses des 6 derniers mois">`;
  for (const v of ticks) {
    svg += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${yOf(v)}" y2="${yOf(v)}"/>`;
    svg += `<text x="${pad.l - 6}" y="${yOf(v) + 4}" text-anchor="end">${fmtShort(v)}</text>`;
  }
  data.forEach((d, i) => {
    const x = pad.l + step * i + (step - bw) / 2;
    const h = Math.max(d.spent / nice * ih, d.spent ? 2 : 0);
    const y0 = pad.t + ih;
    const r = Math.min(4, h);
    // barre avec coins arrondis en haut seulement, ancrée à la ligne de base
    if (h > 0) svg += `<path class="bar ${d.spent > d.budget ? 'over' : ''} ${d.current ? '' : 'dim'}" d="M${x},${y0} V${y0 - h + r} Q${x},${y0 - h} ${x + r},${y0 - h} H${x + bw - r} Q${x + bw},${y0 - h} ${x + bw},${y0 - h + r} V${y0} Z"/>`;
    svg += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle" style="${d.current ? 'fill:var(--text);font-weight:600' : ''}">${d.label}</text>`;
    svg += `<rect class="hit" data-i="${i}" x="${pad.l + step * i}" y="${pad.t}" width="${step}" height="${ih}"/>`;
  });
  if (budget) svg += `<line class="ref" x1="${pad.l}" x2="${W - pad.r}" y1="${yOf(budget)}" y2="${yOf(budget)}"/>`;
  svg += '</svg>';
  host.innerHTML = svg;

  const tip = $('#tooltip');
  const show = (el) => {
    const d = data[+el.dataset.i];
    const box = el.getBoundingClientRect();
    const svgBox = host.firstChild.getBoundingClientRect();
    const scale = svgBox.height / H;
    tip.innerHTML = `<b style="text-transform:capitalize">${d.full}</b> · ${fmt(d.spent)}${d.budget ? ` (${Math.round(d.spent / d.budget * 100)} % du budget)` : ''}`;
    tip.style.left = Math.min(Math.max(box.left + box.width / 2, 110), innerWidth - 110) + 'px';
    tip.style.top = (svgBox.top + yOf(d.spent) * scale) + 'px';
    tip.hidden = false;
  };
  $$('.hit', host).forEach(el => {
    el.addEventListener('pointerenter', () => show(el));
    el.addEventListener('pointerdown', () => show(el));
    el.addEventListener('pointerleave', () => { tip.hidden = true; });
  });
}

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const k of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (k * p >= v) return k * p;
  return 10 * p;
}

function viewSettings() {
  const c = state.config;
  return `
    <h2 class="section-title">Connexion au Google Sheet</h2>
    <section class="card">
      <label class="field"><span>URL du script (…/exec)</span>
        <input class="input" id="apiUrl" type="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(c.apiUrl)}" autocomplete="off"></label>
      <label class="field"><span>Jeton (donné par setup() dans Apps Script)</span>
        <input class="input" id="apiToken" type="password" value="${esc(c.token)}" autocomplete="off"></label>
      <div class="row">
        <button class="btn" id="saveConn">Enregistrer</button>
        ${c.apiUrl ? '<button class="btn secondary" id="syncNow">Synchroniser</button>' : ''}
      </div>
      ${state.lastError ? `<p class="note" style="color:var(--critical)">Dernière erreur : ${esc(state.lastError)}</p>` : ''}
      ${state.outbox.length ? `<p class="note">${state.outbox.length} opération(s) en attente d'envoi.</p>` : ''}
    </section>

    <h2 class="section-title">Catégories & budgets mensuels</h2>
    <section class="card" id="budgets">
      ${cats().map((cat, i) => budgetRow(cat, i)).join('')}
      <div class="row" style="margin-top:12px">
        <button class="btn secondary" id="addCat">+ Catégorie</button>
        <button class="btn" id="saveCats">Enregistrer</button>
      </div>
      <p class="note">Total : <b id="budgetTotal">${fmt(cats().reduce((a, c) => a + (c.budget || 0), 0))}</b> / mois. Renommer une catégorie ne modifie pas les anciennes opérations.</p>
    </section>

    <h2 class="section-title">Installer sur l'iPhone</h2>
    <section class="card note">
      Ouvre cette page dans Safari → bouton Partager → <b>Sur l'écran d'accueil</b>. L'appli s'ouvre alors en plein écran, comme une appli native.
    </section>
    ${c.apiUrl ? `<p style="text-align:center"><button class="btn danger" id="disconnect">Se déconnecter et revenir à la démo</button></p>` : ''}
  `;
}

function budgetRow(cat, i) {
  return `<div class="budget-row" data-i="${i}">
    <input class="input emoji-in" value="${esc(cat.emoji)}" aria-label="Emoji" maxlength="4">
    <input class="input" value="${esc(cat.name)}" aria-label="Nom de la catégorie">
    <input class="input" type="number" inputmode="decimal" min="0" step="1" value="${cat.budget || 0}" aria-label="Budget ${esc(cat.name)}">
  </div>`;
}

function readBudgetForm() {
  return $$('#budgets .budget-row').map(row => {
    const [e, n, b] = $$('input', row);
    return { emoji: e.value.trim(), name: n.value.trim(), budget: parseAmount(b.value) };
  }).filter(c => c.name);
}

function bindSettings() {
  $('#saveConn').onclick = async () => {
    const apiUrl = $('#apiUrl').value.trim();
    const token = $('#apiToken').value.trim();
    if (apiUrl && !/^https:\/\/script\.google(usercontent)?\.com\//.test(apiUrl)) { toast("L'URL doit être celle du script Google (…/exec)"); return; }
    const wasDemo = isDemo();
    state.config = { apiUrl, token };
    store.set(KEY.config, state.config);
    if (wasDemo && apiUrl) { state.data = { transactions: [], categories: [] }; state.outbox = []; persist(); }
    await sync();
    if (!state.lastError) toast('Connecté ✓');
    render();
  };
  $('#syncNow') && ($('#syncNow').onclick = () => sync());
  $('#disconnect') && ($('#disconnect').onclick = () => {
    if (!confirm('Revenir au mode démo ? Tes données restent dans le Google Sheet.')) return;
    state.config = { apiUrl: '', token: '' }; store.remove(KEY.config);
    state.data = demoData(); state.outbox = []; persist(); render();
  });
  $('#addCat').onclick = () => {
    const list = readBudgetForm();
    list.push({ emoji: '•', name: '', budget: 0 });
    $('#budgets').querySelectorAll('.budget-row').forEach(r => r.remove());
    $('#budgets').insertAdjacentHTML('afterbegin', list.map(budgetRow).join(''));
    $$('#budgets .budget-row').at(-1).querySelectorAll('input')[1].focus();
  };
  $('#budgets').addEventListener('input', () => {
    $('#budgetTotal').textContent = fmt(readBudgetForm().reduce((a, c) => a + c.budget, 0));
  });
  $('#saveCats').onclick = () => saveCategories(readBudgetForm());
}

// ------------------------------------------------------------------ Formulaire d'ajout / modification

function openEditor(tx) {
  const editing = !!tx;
  const t = tx ? { ...tx } : { type: 'Dépense', category: '', amount: '', note: '', date: todayIso() };
  const dlg = $('#sheet');

  const draw = () => {
    dlg.innerHTML = `
      <form class="sheet-inner" method="dialog">
        <div class="grabber"></div>
        <div class="sheet-head">
          <h2>${editing ? 'Modifier' : 'Nouvelle opération'}</h2>
          <button type="button" class="icon-btn" data-close aria-label="Fermer">✕</button>
        </div>
        <input class="amount-input" id="amount" inputmode="decimal" placeholder="0,00 €" value="${t.amount === '' ? '' : String(t.amount).replace('.', ',')}" aria-label="Montant" autocomplete="off">
        <div class="seg" role="radiogroup" aria-label="Type">
          ${TYPES.map(ty => `<button type="button" role="radio" aria-checked="${t.type === ty}" class="${t.type === ty ? 'active' : ''}" data-settype="${ty}">${ty}</button>`).join('')}
        </div>
        ${t.type === 'Dépense' ? `
          <div class="cat-grid" role="radiogroup" aria-label="Catégorie">
            ${cats().map(c => `<button type="button" role="radio" aria-checked="${t.category === c.name}" class="cat-pick ${t.category === c.name ? 'active' : ''}" data-setcat="${esc(c.name)}"><b>${esc(c.emoji)}</b><span>${esc(c.name)}</span></button>`).join('')}
          </div>` : ''}
        <label class="field"><span>Note</span><input class="input" id="note" value="${esc(t.note)}" placeholder="Ex. courses, resto avec…" autocomplete="off"></label>
        <label class="field"><span>Date</span><input class="input" id="date" type="date" value="${t.date}"></label>
        <button class="btn block" id="saveTx" type="submit">${editing ? 'Enregistrer' : 'Ajouter'}</button>
        ${editing ? '<button class="btn danger block" type="button" id="delTx" style="margin-top:8px">Supprimer</button>' : ''}
      </form>`;
  };

  const capture = () => {
    t.amount = $('#amount', dlg).value;
    t.note = $('#note', dlg).value;
    t.date = $('#date', dlg).value;
  };

  draw();
  dlg.onclick = (e) => {
    if (e.target === dlg) { dlg.close(); return; } // clic sur le fond
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-close')) dlg.close();
    else if (b.dataset.settype) { capture(); t.type = b.dataset.settype; draw(); }
    else if (b.dataset.setcat) { capture(); t.category = b.dataset.setcat; draw(); }
    else if (b.id === 'delTx') {
      if (confirm('Supprimer cette opération ? Elle sera aussi retirée du Google Sheet.')) { deleteTx(t.id); dlg.close(); toast('Supprimée'); }
    }
  };
  dlg.onsubmit = (e) => {
    e.preventDefault();
    capture();
    const amount = parseAmount(t.amount);
    if (!(amount > 0)) { toast('Indique un montant'); $('#amount', dlg).focus(); return; }
    if (t.type === 'Dépense' && !t.category) { toast('Choisis une catégorie'); return; }
    if (!t.date) { toast('Indique une date'); return; }
    saveTx({
      ...(editing ? { id: t.id } : {}),
      date: t.date, type: t.type, amount: Math.round(amount * 100) / 100, note: t.note.trim(),
      category: t.type === 'Dépense' ? t.category : 'Aucune',
    });
    dlg.close();
    toast(editing ? 'Modifiée' : `${fmt(amount)} ajouté${t.type === 'Dépense' ? ' · ' + t.category : ''}`);
  };

  dlg.showModal();
  if (!editing) setTimeout(() => $('#amount', dlg).focus(), 60);
}

// ------------------------------------------------------------------ Interactions globales

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2400);
}

function setSync(text) { $('#syncState').textContent = text; }

function goto(tab) {
  state.tab = tab;
  $('#tooltip').hidden = true;
  render();
  scrollTo(0, 0);
}

$('.tabbar').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (b) goto(b.dataset.tab);
});
$('#prevMonth').onclick = () => { state.month = addMonths(state.month, -1); render(); };
$('#nextMonth').onclick = () => { state.month = addMonths(state.month, 1); render(); };
$('#monthTitle').onclick = () => { const d = new Date(); state.month = { y: d.getFullYear(), m: d.getMonth() }; render(); };
$('#addBtn').onclick = () => openEditor();

$('#view').addEventListener('click', e => {
  const el = e.target.closest('button');
  if (!el) return;
  if (el.dataset.goto) goto(el.dataset.goto);
  else if (el.dataset.tx) openEditor(txs().find(t => t.id === el.dataset.tx));
  else if (el.dataset.cat) { state.filter = { q: '', type: 'Dépense', category: el.dataset.cat, allMonths: false }; goto('historique'); }
  else if (el.id === 'toggleEmpty') { state.showEmptyCats = !state.showEmptyCats; render(); }
  else if ('type' in el.dataset) { state.filter.type = el.dataset.type; render(); }
  else if (el.hasAttribute('data-allmonths')) { state.filter.allMonths = !state.filter.allMonths; render(); }
  else if (el.hasAttribute('data-clearcat')) { state.filter.category = ''; render(); }
});
$('#view').addEventListener('input', e => {
  if (e.target.id !== 'search') return;
  state.filter.q = e.target.value;
  const pos = e.target.selectionStart;
  render();
  const s = $('#search'); s.focus(); s.setSelectionRange(pos, pos);
});

let resizeT;
addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => state.tab === 'stats' && drawMonthlyChart(), 150); });
addEventListener('online', () => sync({ silent: true }));
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync({ silent: true }); });
document.addEventListener('scroll', () => { $('#tooltip').hidden = true; }, { passive: true });

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

if (!state.data || (isDemo() && !state.data.demo)) state.data = isDemo() ? demoData() : { transactions: [], categories: [] };

// Raccourci : ?add ouvre directement le formulaire (pratique depuis l'écran d'accueil)
render();
if (new URLSearchParams(location.search).has('add')) openEditor();
sync({ silent: true });

// ------------------------------------------------------------------ Données de démo

function demoData() {
  const categories = [
    ['Logement', 600, '🏠'], ['Alimentation', 280, '🛒'], ['Resto', 120, '🍔'], ['Essence', 80, '⛽'],
    ['Peages/Parking', 30, '🅿️'], ['Vetements', 60, '👕'], ['Sortie', 50, '🍻'], ['Voyage', 60, '🚆'],
    ['Abonnements', 25, '📺'], ['Cadeau', 30, '🎁'], ['Sante', 20, '💊'], ['Tech', 30, '💻'],
  ].map(([name, budget, emoji]) => ({ name, budget, emoji }));
  const notes = {
    Alimentation: ['Courses', 'Marché', 'Boulangerie'], Resto: ['Pizza', 'Burger', 'Sushi'],
    Essence: ['Plein'], 'Peages/Parking': ['Péage', 'Parking'], Vetements: ['Jean', 'T-shirt'],
    Sortie: ['Bière', 'Cinéma'], Voyage: ['Train'], Cadeau: ['Anniversaire'], Tech: ['Câble'],
    Sante: ['Pharmacie'], Abonnements: ['Streaming'], Logement: ['Loyer'],
  };
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const transactions = [];
  const t = new Date();
  for (let k = 3; k >= 0; k--) {
    const d = new Date(t.getFullYear(), t.getMonth() - k, 1);
    const y = d.getFullYear(), m = d.getMonth();
    const lastDay = k === 0 ? t.getDate() : daysIn(y, m);
    const push = (day, category, type, amount, note) => transactions.push({
      id: `demo-${transactions.length}`, date: `${y}-${pad(m + 1)}-${pad(Math.min(day, lastDay))}`,
      category, type, amount: Math.round(amount * 100) / 100, note,
    });
    push(1, 'Logement', 'Dépense', 600, 'Loyer');
    push(2, 'Abonnements', 'Dépense', 13.99, 'Streaming');
    if (lastDay >= 25 || k > 0) { push(25, 'Aucune', 'Revenu', 2100, 'Salaire'); push(26, 'Aucune', 'Épargne', 250, 'Livret A'); }
    const n = Math.round(lastDay * 0.9);
    for (let i = 0; i < n; i++) {
      const c = categories[1 + Math.floor(rnd() ** 1.6 * (categories.length - 1))].name;
      const base = { Alimentation: 22, Resto: 24, Essence: 60, 'Peages/Parking': 9, Vetements: 35, Sortie: 14, Voyage: 25, Cadeau: 25, Tech: 30, Sante: 15, Abonnements: 6 }[c];
      push(1 + Math.floor(rnd() * lastDay), c, 'Dépense', base * (0.5 + rnd()), notes[c][Math.floor(rnd() * notes[c].length)]);
    }
  }
  return { demo: true, transactions, categories };
}
