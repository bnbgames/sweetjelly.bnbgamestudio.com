// Shared formatting, chart and table helpers for the admin dashboard.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const DAY = 86400000;

// ---------------------------------------------------------------- formatting

export const nf = new Intl.NumberFormat();
export const fmt = n => (n == null || Number.isNaN(n) ? '–' : nf.format(Math.round(n)));
export const fmt1 = n => (n == null || Number.isNaN(n) ? '–' : n.toLocaleString(undefined, { maximumFractionDigits: 1 }));
export const pct = (x, digits = 0) => (x == null || !Number.isFinite(x) ? '–' : `${(x * 100).toFixed(digits)}%`);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function relTime(ms) {
  if (!ms) return '–';
  const d = Date.now() - ms;
  if (d < 60000) return 'just now';
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < DAY) return `${Math.floor(d / 3600000)}h ago`;
  if (d < 60 * DAY) return `${Math.floor(d / DAY)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

export const median = arr => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const quantile = (arr, q) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
export const sum = arr => arr.reduce((a, b) => a + b, 0);
// ---------------------------------------------------------------- charts

export const charts = {};
export function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

export function chart(id, config) {
  charts[id]?.destroy();
  const muted = css('--muted');
  const border = css('--border');
  Chart.defaults.color = muted;
  Chart.defaults.borderColor = border;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  config.options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    ...config.options,
    plugins: { legend: { display: false }, ...(config.options?.plugins || {}) },
  };
  charts[id] = new Chart($(`#${id}`), config);
}

export const alpha = (color, a) => `color-mix(in srgb, ${color} ${Math.round(a * 100)}%, transparent)`;
// Chart.js can't parse color-mix(), so charts get rgba() built from the hex tokens.
export function solid(hex, a) {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(v, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// ---------------------------------------------------------------- tables

export function table(el, { columns, rows, sortKey, sortDir = 'desc', pageSize = 0, onRow, empty = 'No data' }) {
  const st = el._t ??= { sortKey, sortDir, page: 0 };
  st.columns = columns; st.rows = rows; st.pageSize = pageSize; st.onRow = onRow;
  if (!columns.some(c => c.key === st.sortKey)) { st.sortKey = sortKey; st.sortDir = sortDir; }

  const draw = () => {
    const col = st.columns.find(c => c.key === st.sortKey);
    const sorted = col ? [...st.rows].sort((a, b) => {
      const va = col.sort ? col.sort(a) : a[col.key];
      const vb = col.sort ? col.sort(b) : b[col.key];
      const r = va == null ? 1 : vb == null ? -1 : va < vb ? -1 : va > vb ? 1 : 0;
      return st.sortDir === 'asc' ? r : -r;
    }) : st.rows;
    const pages = st.pageSize ? Math.max(1, Math.ceil(sorted.length / st.pageSize)) : 1;
    st.page = Math.min(st.page, pages - 1);
    const shown = st.pageSize ? sorted.slice(st.page * st.pageSize, (st.page + 1) * st.pageSize) : sorted;

    el.innerHTML = `<table><thead><tr>${st.columns.map(c =>
      `<th data-k="${c.key}" class="${c.num ? 'num ' : ''}${c.nosort ? '' : 'sortable'} ${c.key === st.sortKey ? `sorted ${st.sortDir}` : ''}">${c.label}</th>`).join('')}</tr></thead>
      <tbody>${shown.length ? shown.map((r, i) => `<tr data-i="${i}" class="${st.onRow ? 'clickable' : ''}">${st.columns.map(c =>
        `<td class="${c.num ? 'num' : ''}">${c.html ? c.html(r) : esc(c.fmt ? c.fmt(r[c.key], r) : r[c.key])}</td>`).join('')}</tr>`).join('')
        : `<tr><td colspan="${st.columns.length}" class="muted">${empty}</td></tr>`}</tbody></table>
      ${st.pageSize && pages > 1 ? `<div class="pager"><button class="btn" data-p="-1" ${st.page === 0 ? 'disabled' : ''}>Prev</button>
        Page ${st.page + 1} of ${pages} · ${fmt(sorted.length)} rows
        <button class="btn" data-p="1" ${st.page >= pages - 1 ? 'disabled' : ''}>Next</button></div>` : ''}`;

    $$('th.sortable', el).forEach(th => th.addEventListener('click', () => {
      if (st.sortKey === th.dataset.k) st.sortDir = st.sortDir === 'asc' ? 'desc' : 'asc';
      else { st.sortKey = th.dataset.k; st.sortDir = 'desc'; }
      st.page = 0; draw();
    }));
    $$('[data-p]', el).forEach(b => b.addEventListener('click', () => { st.page += Number(b.dataset.p); draw(); }));
    if (st.onRow) $$('tbody tr[data-i]', el).forEach(tr => tr.addEventListener('click', () => st.onRow(shown[Number(tr.dataset.i)])));
  };
  draw();
}

export const bar = (x, max = 1) => `<div class="bar"><i style="width:${Math.max(0, Math.min(100, (x / (max || 1)) * 100))}%"></i></div>`;
export const kpi = (label, value, sub = '', id = '') => `<div class="card kpi"><div class="label">${label}</div><div class="value"${id ? ` id="${id}"` : ''}>${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
