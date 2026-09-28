// Monetization view: AdMob (network + mediation reports) and Google Analytics 4
// (in-app purchases, active users, retention), read in the browser with the
// signed-in admin's Google OAuth token. Nothing is stored server-side.
import { $, DAY, fmt, pct, esc, sum, chart, css, solid, table, kpi } from './ui.js';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/admob.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
];

const m = {
  getToken: null,        // (interactive) => Promise<string|null>, provided by app.js
  discovered: false,
  admobAccount: null,
  apps: [],
  selectedApps: new Set(),
  gaProps: [],
  gaProp: null,
  hasProductDim: false,
  loadedKey: '',
  busy: false,
};

const money = (n, cur = 'USD') => (n == null || !Number.isFinite(n) ? '–'
  : n.toLocaleString(undefined, { style: 'currency', currency: cur, maximumFractionDigits: Math.abs(n) < 10 ? 2 : 0 }));
const money2 = (n, cur = 'USD') => (n == null || !Number.isFinite(n) ? '–'
  : n.toLocaleString(undefined, { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: Math.abs(n) < 1 ? 3 : 2 }));

// ---------------------------------------------------------------- Google API plumbing

async function gfetch(url, body) {
  const token = await m.getToken(false);
  if (!token) throw Object.assign(new Error('Not connected'), { status: 401 });
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = Array.isArray(json) ? json[0]?.error : json.error;
    throw Object.assign(new Error(e?.message || `HTTP ${res.status}`), { status: res.status });
  }
  return json;
}

const ymd = d => ({ year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() });
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// "REWARDED_INTERSTITIAL" -> "Rewarded interstitial" when the API sends no display label.
const pretty = v => (v && /^[A-Z_]+$/.test(v) ? v.charAt(0) + v.slice(1).toLowerCase().replace(/_/g, ' ') : v);

function parseAdmobRow(row) {
  const dims = {}, labels = {}, met = {};
  for (const [k, v] of Object.entries(row.dimensionValues || {})) { dims[k] = v.value; labels[k] = v.displayLabel || pretty(v.value); }
  for (const [k, v] of Object.entries(row.metricValues || {})) {
    met[k] = v.microsValue != null ? Number(v.microsValue) / 1e6 : v.integerValue != null ? Number(v.integerValue) : Number(v.doubleValue ?? 0);
  }
  return { dims, labels, met };
}

async function admob(kind, dims, metrics, start, end) {
  const spec = {
    dateRange: { startDate: ymd(start), endDate: ymd(end) },
    dimensions: dims,
    metrics,
    localizationSettings: { currencyCode: 'USD' },
  };
  if (m.selectedApps.size) spec.dimensionFilters = [{ dimension: 'APP', matchesAny: { values: [...m.selectedApps] } }];
  const res = await gfetch(`https://admob.googleapis.com/v1/${m.admobAccount}/${kind}:generate`, { reportSpec: spec });
  return (Array.isArray(res) ? res : []).filter(x => x.row).map(x => parseAdmobRow(x.row));
}

async function ga(body) {
  const res = await gfetch(`https://analyticsdata.googleapis.com/v1beta/${m.gaProp}:runReport`, body);
  return {
    currency: res.metadata?.currencyCode || 'USD',
    rows: (res.rows || []).map(r => ({ d: r.dimensionValues.map(v => v.value), m: r.metricValues.map(v => Number(v.value)) })),
  };
}

async function discover() {
  const [acc, props] = await Promise.allSettled([
    gfetch('https://admob.googleapis.com/v1/accounts'),
    gfetch('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200'),
  ]);
  if (acc.status === 'fulfilled' && acc.value.account?.length) {
    m.admobAccount = acc.value.account[0].name;
    const apps = await gfetch(`https://admob.googleapis.com/v1/${m.admobAccount}/apps?pageSize=100`);
    m.apps = (apps.apps || []).map(a => ({
      id: a.appId,
      name: a.linkedAppInfo?.displayName || a.manualAppInfo?.displayName || a.appId,
      platform: a.platform,
    }));
    const game = m.apps.filter(a => /jelly/i.test(a.name));
    m.selectedApps = new Set((game.length ? game : m.apps).map(a => a.id));
  } else {
    m.admobError = acc.reason?.message || 'No AdMob account visible to this Google account.';
  }
  if (props.status === 'fulfilled') {
    m.gaProps = (props.value.accountSummaries || []).flatMap(a => (a.propertySummaries || []).map(p => ({ id: p.property, name: `${p.displayName} (${a.displayName})` })));
    m.gaProp = (m.gaProps.find(p => /jelly|sweet/i.test(p.name)) || m.gaProps[0])?.id || null;
    if (!m.gaProp) m.gaError = 'No Google Analytics property visible to this Google account.';
  } else {
    m.gaError = props.reason?.message;
  }
  if (m.gaProp) await checkProductDimension();
  m.discovered = true;
}

async function checkProductDimension() {
  try {
    const meta = await gfetch(`https://analyticsdata.googleapis.com/v1beta/${m.gaProp}/metadata`);
    m.hasProductDim = (meta.dimensions || []).some(d => d.apiName === 'customEvent:product_id');
  } catch { m.hasProductDim = false; }
}

// ---------------------------------------------------------------- data

async function fetchAll(days) {
  const end = new Date(Date.now() - DAY);           // through yesterday: today is still filling in
  const start = new Date(end.getTime() - (days - 1) * DAY);
  const out = { start, end, days, errors: {} };
  const safe = async (key, fn) => { try { out[key] = await fn(); } catch (e) { out.errors[key] = e.message; } };

  const net = ['ESTIMATED_EARNINGS', 'IMPRESSIONS', 'AD_REQUESTS', 'MATCHED_REQUESTS', 'CLICKS'];
  const tasks = [];
  if (m.admobAccount) {
    tasks.push(
      safe('adDaily', () => admob('networkReport', ['DATE', 'FORMAT', 'PLATFORM'], net, start, end)),
      safe('adCountry', () => admob('networkReport', ['COUNTRY'], ['ESTIMATED_EARNINGS', 'IMPRESSIONS'], start, end)),
      safe('adUnits', () => admob('networkReport', ['AD_UNIT', 'FORMAT', 'PLATFORM'], net, start, end)),
      safe('mediation', () => admob('mediationReport', ['AD_SOURCE', 'FORMAT'], ['ESTIMATED_EARNINGS', 'IMPRESSIONS', 'AD_REQUESTS', 'MATCHED_REQUESTS'], start, end)),
    );
  }
  if (m.gaProp) {
    const dateRanges = [{ startDate: iso(start), endDate: iso(end) }];
    const purchaseFilter = { filter: { fieldName: 'eventName', stringFilter: { value: 'in_app_purchase' } } };
    tasks.push(
      safe('gaDaily', () => ga({ dateRanges, dimensions: [{ name: 'date' }, { name: 'platform' }], metrics: [{ name: 'activeUsers' }, { name: 'newUsers' }, { name: 'purchaseRevenue' }] })),
      safe('gaPlatform', () => ga({ dateRanges, dimensions: [{ name: 'platform' }], metrics: [{ name: 'activeUsers' }, { name: 'newUsers' }, { name: 'purchaseRevenue' }, { name: 'totalPurchasers' }, { name: 'firstTimePurchasers' }] })),
      safe('gaCountry', () => ga({ dateRanges, dimensions: [{ name: 'countryId' }, { name: 'country' }], metrics: [{ name: 'activeUsers' }, { name: 'purchaseRevenue' }, { name: 'totalPurchasers' }], limit: 100, orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }] })),
      safe('gaProducts', () => ga({
        dateRanges,
        dimensions: [{ name: m.hasProductDim ? 'customEvent:product_id' : 'platform' }],
        metrics: [{ name: 'eventCount' }, { name: 'purchaseRevenue' }],
        dimensionFilter: purchaseFilter,
        limit: 50,
      })),
      safe('gaCohorts', () => ga(cohortRequest())),
    );
  }
  await Promise.all(tasks);
  return out;
}

function cohortRequest() {
  // Six complete weeks of first-open cohorts, each followed for up to 6 weeks.
  const today = new Date();
  const cohorts = [];
  for (let w = 6; w >= 1; w--) {
    const s = new Date(today.getTime() - (w * 7 + 1) * DAY);
    const e = new Date(s.getTime() + 6 * DAY);
    cohorts.push({ name: iso(s), dimension: 'firstSessionDate', dateRange: { startDate: iso(s), endDate: iso(e) } });
  }
  return {
    dimensions: [{ name: 'cohort' }, { name: 'cohortNthWeek' }],
    metrics: [{ name: 'cohortActiveUsers' }, { name: 'cohortTotalUsers' }],
    cohortSpec: { cohorts, cohortsRange: { granularity: 'WEEKLY', startOffset: 0, endOffset: 5 } },
  };
}

// ---------------------------------------------------------------- UI

export function initMonetization({ getToken }) {
  m.getToken = getToken;
  $('#moneyConnect').addEventListener('click', async () => {
    try {
      await m.getToken(true);
      m.loadedKey = '';
      await renderMonetization();
    } catch (e) {
      showConnect(e.message);
    }
  });
  $('#moneyDays').addEventListener('change', () => renderMonetization());
  $('#moneyFee').addEventListener('change', () => renderMonetization(true));
  $('#moneyProp').addEventListener('change', async e => { m.gaProp = e.target.value; await checkProductDimension(); m.loadedKey = ''; renderMonetization(); });
  $('#moneyReload').addEventListener('click', () => { m.loadedKey = ''; renderMonetization(); });
}

export function resetMonetization() {
  Object.assign(m, { discovered: false, admobAccount: null, apps: [], selectedApps: new Set(), gaProps: [], gaProp: null, loadedKey: '', admobError: null, gaError: null });
}

function showConnect(error = '') {
  $('#moneyConnectCard').classList.remove('hidden');
  $('#moneyBody').classList.add('hidden');
  $('#moneyConnectError').textContent = error;
}

let lastData = null;

export async function renderMonetization(rerenderOnly = false) {
  if (m.busy) return;
  const token = await m.getToken(false);
  if (!token) { showConnect(); return; }
  $('#moneyConnectCard').classList.add('hidden');
  $('#moneyBody').classList.remove('hidden');

  if (rerenderOnly && lastData) { draw(lastData); return; }

  m.busy = true;
  const status = $('#moneyStatus');
  status.innerHTML = '<span class="loading"><span class="spinner"></span>Loading AdMob and Analytics…</span>';
  try {
    if (!m.discovered) {
      await discover();
      renderPickers();
    }
    const days = Number($('#moneyDays').value) || 28;
    const key = `${days}|${m.gaProp}|${[...m.selectedApps].sort().join(',')}`;
    if (key !== m.loadedKey || !lastData) {
      lastData = await fetchAll(days);
      m.loadedKey = key;
    }
    draw(lastData);
    status.textContent = `${iso(lastData.start)} → ${iso(lastData.end)} · loaded ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    if (e.status === 401) { showConnect('Google session expired. Connect again.'); } else { status.innerHTML = `<span class="error">${esc(e.message)}</span>`; }
  } finally {
    m.busy = false;
  }
}

function renderPickers() {
  const sel = $('#moneyProp');
  sel.innerHTML = m.gaProps.map(p => `<option value="${esc(p.id)}" ${p.id === m.gaProp ? 'selected' : ''}>${esc(p.name)}</option>`).join('') || '<option>No GA4 property</option>';
  const apps = $('#moneyApps');
  apps.innerHTML = m.apps.map(a => `<label><input type="checkbox" value="${esc(a.id)}" ${m.selectedApps.has(a.id) ? 'checked' : ''}> ${esc(a.name)} <span class="muted">(${esc(PLATFORM_NAME(a.platform))})</span></label>`).join('')
    || `<span class="muted small">${esc(m.admobError || 'No AdMob apps')}</span>`;
  apps.querySelectorAll('input').forEach(i => i.addEventListener('change', () => {
    i.checked ? m.selectedApps.add(i.value) : m.selectedApps.delete(i.value);
    renderMonetization();
  }));
  const errs = [m.admobError && `AdMob: ${m.admobError}`, m.gaError && `Analytics: ${m.gaError}`].filter(Boolean);
  $('#moneyBanner').classList.toggle('hidden', !errs.length);
  $('#moneyBanner').textContent = errs.join(' · ');
}

const PLATFORM_NAME = p => (/ios/i.test(p) ? 'iOS' : /android/i.test(p) ? 'Android' : p);
const gaDate = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

function draw(D) {
  const fee = Math.min(0.5, Math.max(0, (Number($('#moneyFee').value) || 0) / 100));
  const cur = D.gaDaily?.currency || 'USD';
  const note = (id, key) => { $(id).innerHTML = D.errors[key] ? `<div class="error">${esc(D.errors[key])}</div>` : ''; };

  // ---- daily series
  const dates = [];
  for (let t = D.start.getTime(); t <= D.end.getTime() + 1000; t += DAY) dates.push(iso(new Date(t)));
  const adByDate = Object.fromEntries(dates.map(d => [d, 0]));
  for (const r of D.adDaily || []) { const d = gaDate(r.dims.DATE); if (d in adByDate) adByDate[d] += r.met.ESTIMATED_EARNINGS; }
  const dauByDate = Object.fromEntries(dates.map(d => [d, 0]));
  const iapByDate = Object.fromEntries(dates.map(d => [d, 0]));
  for (const r of D.gaDaily?.rows || []) {
    const d = gaDate(r.d[0]);
    if (d in dauByDate) { dauByDate[d] += r.m[0]; iapByDate[d] += r.m[2]; }
  }

  const adTotal = sum(Object.values(adByDate));
  const iapGross = sum(Object.values(iapByDate));
  const iapNet = iapGross * (1 - fee);
  const dauDays = dates.filter(d => dauByDate[d] > 0);
  const avgDau = dauDays.length ? sum(dauDays.map(d => dauByDate[d])) / dauDays.length : 0;
  const dauSum = sum(Object.values(dauByDate));
  const plat = D.gaPlatform?.rows || [];
  const periodUsers = sum(plat.map(r => r.m[0]));
  const payers = sum(plat.map(r => r.m[3]));
  const firstPayers = sum(plat.map(r => r.m[4]));
  const adImps = sum((D.adDaily || []).map(r => r.met.IMPRESSIONS));

  $('#moneyKpis').innerHTML = [
    kpi('Revenue', money(adTotal + iapNet, cur), `ads + IAP after ${pct(fee)} store fee`),
    kpi('Ad revenue', money(adTotal), `${pct(adTotal / ((adTotal + iapNet) || 1))} of revenue · eCPM ${money2(adImps ? adTotal / adImps * 1000 : null)}`),
    kpi('IAP revenue (gross)', money(iapGross, cur), `${money(iapNet, cur)} net est.`),
    kpi('ARPDAU', money2(dauSum ? (adTotal + iapNet) / dauSum : null, cur), `avg DAU ${fmt(avgDau)}`),
    kpi('Active users', fmt(periodUsers), `${fmt(sum(plat.map(r => r.m[1])))} new`),
    kpi('Payers', fmt(payers), `${pct(payers / (periodUsers || 1), 2)} conversion · ${fmt(firstPayers)} first-time`),
    kpi('ARPPU', money2(payers ? iapGross / payers : null, cur), 'gross IAP per payer'),
  ].join('');

  chart('chRevenue', {
    data: {
      labels: dates.map(d => d.slice(5)),
      datasets: [
        { type: 'bar', label: 'Ads', data: dates.map(d => adByDate[d]), backgroundColor: solid(css('--accent'), 0.7), stack: 'r', yAxisID: 'y' },
        { type: 'bar', label: 'IAP (net est.)', data: dates.map(d => iapByDate[d] * (1 - fee)), backgroundColor: solid(css('--r1'), 0.7), stack: 'r', yAxisID: 'y' },
        { type: 'line', label: 'ARPDAU', data: dates.map(d => dauByDate[d] ? (adByDate[d] + iapByDate[d] * (1 - fee)) / dauByDate[d] : null), borderColor: css('--r3'), backgroundColor: css('--r3'), pointRadius: 2, borderWidth: 2, yAxisID: 'y2', tension: 0.2, spanGaps: true },
      ],
    },
    options: {
      plugins: { legend: { display: true, position: 'bottom' }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.dataset.yAxisID === 'y2' ? money2(c.raw, cur) : money(c.raw, cur)}` } } },
      scales: {
        x: { stacked: true },
        y: { stacked: true, beginAtZero: true, title: { display: true, text: 'revenue' } },
        y2: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: 'ARPDAU' } },
      },
    },
  });

  // ---- ad formats
  const byFormat = {};
  for (const r of D.adDaily || []) {
    const k = r.labels.FORMAT;
    const f = byFormat[k] ??= { format: k, earnings: 0, imps: 0, req: 0, matched: 0, clicks: 0 };
    f.earnings += r.met.ESTIMATED_EARNINGS; f.imps += r.met.IMPRESSIONS; f.req += r.met.AD_REQUESTS; f.matched += r.met.MATCHED_REQUESTS; f.clicks += r.met.CLICKS;
  }
  const formats = Object.values(byFormat).map(f => ({
    ...f, ecpm: f.imps ? f.earnings / f.imps * 1000 : null, perDau: dauSum ? f.imps / dauSum : null,
    fill: f.req ? f.matched / f.req : null, show: f.matched ? f.imps / f.matched : null,
  }));
  note('#formatErr', 'adDaily');
  table($('#formatTable'), {
    columns: [
      { key: 'format', label: 'Format' },
      { key: 'earnings', label: 'Earnings', num: true, fmt: v => money(v) },
      { key: 'imps', label: 'Impressions', num: true, fmt },
      { key: 'ecpm', label: 'eCPM', num: true, fmt: v => money2(v) },
      { key: 'perDau', label: 'Imps / DAU', num: true, fmt: v => v == null ? '–' : v.toFixed(2) },
      { key: 'fill', label: 'Match rate', num: true, fmt: v => pct(v) },
      { key: 'show', label: 'Show rate', num: true, html: r => r.show == null ? '–' : `<span class="pill ${r.show < 0.6 ? 'bad' : r.show < 0.8 ? 'warn' : 'good'}">${pct(r.show)}</span>` },
    ],
    rows: formats,
    sortKey: 'earnings',
  });

  // ---- platforms
  const platRows = {};
  const P = k => platRows[k] ??= { platform: k, adEarn: 0, imps: 0, users: 0, dauSum: 0, iap: 0, payers: 0 };
  for (const r of D.adDaily || []) { const p = P(PLATFORM_NAME(r.labels.PLATFORM)); p.adEarn += r.met.ESTIMATED_EARNINGS; p.imps += r.met.IMPRESSIONS; }
  for (const r of plat) { const p = P(PLATFORM_NAME(r.d[0])); p.users += r.m[0]; p.iap += r.m[2]; p.payers += r.m[3]; }
  for (const r of D.gaDaily?.rows || []) P(PLATFORM_NAME(r.d[1])).dauSum += r.m[0];
  table($('#platformTable'), {
    columns: [
      { key: 'platform', label: 'Platform' },
      { key: 'users', label: 'Users', num: true, fmt },
      { key: 'adEarn', label: 'Ads', num: true, fmt: v => money(v) },
      { key: 'iap', label: 'IAP gross', num: true, fmt: v => money(v, cur) },
      { key: 'payers', label: 'Payers', num: true, html: r => `${fmt(r.payers)} <span class="muted small">${pct(r.payers / (r.users || 1), 2)}</span>` },
      { key: 'arpdau', label: 'ARPDAU', num: true, sort: r => r.dauSum ? (r.adEarn + r.iap * (1 - fee)) / r.dauSum : -1, html: r => money2(r.dauSum ? (r.adEarn + r.iap * (1 - fee)) / r.dauSum : null, cur) },
      { key: 'ecpm', label: 'eCPM', num: true, sort: r => r.imps ? r.adEarn / r.imps : -1, html: r => money2(r.imps ? r.adEarn / r.imps * 1000 : null) },
    ],
    rows: Object.values(platRows).filter(r => r.platform && r.platform !== '(not set)'),
    sortKey: 'users',
  });

  // ---- mediation
  const med = (D.mediation || []).map(r => ({
    source: r.labels.AD_SOURCE, format: r.labels.FORMAT,
    earnings: r.met.ESTIMATED_EARNINGS, imps: r.met.IMPRESSIONS, req: r.met.AD_REQUESTS, matched: r.met.MATCHED_REQUESTS,
  })).map(r => ({ ...r, ecpm: r.imps ? r.earnings / r.imps * 1000 : null, fill: r.req ? r.matched / r.req : null }));
  const medTotal = sum(med.map(r => r.earnings)) || 1;
  note('#mediationErr', 'mediation');
  table($('#mediationTable'), {
    columns: [
      { key: 'source', label: 'Ad source' },
      { key: 'format', label: 'Format' },
      { key: 'earnings', label: 'Earnings', num: true, fmt: v => money(v) },
      { key: 'share', label: 'Share', num: true, sort: r => r.earnings, html: r => pct(r.earnings / medTotal, 1) },
      { key: 'ecpm', label: 'eCPM', num: true, fmt: v => money2(v) },
      { key: 'imps', label: 'Impressions', num: true, fmt },
      { key: 'req', label: 'Requests', num: true, fmt },
      { key: 'fill', label: 'Fill', num: true, html: r => r.fill == null ? '–' : `<span class="pill ${r.fill < 0.2 ? 'bad' : r.fill < 0.5 ? 'warn' : 'good'}">${pct(r.fill, 1)}</span>` },
    ],
    rows: med,
    sortKey: 'earnings',
    pageSize: 20,
  });
  const bySource = {};
  for (const r of med) bySource[r.source] = (bySource[r.source] || 0) + r.earnings;
  const srcEntries = Object.entries(bySource).sort((a, b) => b[1] - a[1]);
  const palette = ['--accent', '--r1', '--r2', '--r3', '--good', '--warn', '--bad', '--r0'].map(v => solid(css(v), 0.8));
  chart('chMediation', {
    type: 'doughnut',
    data: { labels: srcEntries.map(e => e[0]), datasets: [{ data: srcEntries.map(e => e[1]), backgroundColor: srcEntries.map((_, i) => palette[i % palette.length]), borderColor: css('--surface') }] },
    options: { interaction: { mode: 'nearest', intersect: true }, plugins: { legend: { display: true, position: 'right' }, tooltip: { callbacks: { label: c => `${c.label}: ${money(c.raw)} (${pct(c.raw / medTotal, 1)})` } } } },
  });

  // ---- ad units
  const unitRows = (D.adUnits || []).map(r => ({
    unit: r.labels.AD_UNIT, format: r.labels.FORMAT, platform: PLATFORM_NAME(r.labels.PLATFORM),
    earnings: r.met.ESTIMATED_EARNINGS, impressions: r.met.IMPRESSIONS,
    ecpm: r.met.IMPRESSIONS ? r.met.ESTIMATED_EARNINGS / r.met.IMPRESSIONS * 1000 : null,
    fill: r.met.AD_REQUESTS ? r.met.MATCHED_REQUESTS / r.met.AD_REQUESTS : null,
    show: r.met.MATCHED_REQUESTS ? r.met.IMPRESSIONS / r.met.MATCHED_REQUESTS : null,
  }));
  table($('#unitTable'), {
    columns: [
      { key: 'unit', label: 'Ad unit' },
      { key: 'format', label: 'Format' },
      { key: 'platform', label: 'Platform' },
      { key: 'earnings', label: 'Earnings', num: true, fmt: v => money(v) },
      { key: 'ecpm', label: 'eCPM', num: true, fmt: v => money2(v) },
      { key: 'fill', label: 'Match rate', num: true, fmt: v => pct(v) },
      { key: 'show', label: 'Show rate', num: true, fmt: v => pct(v) },
    ],
    rows: unitRows,
    sortKey: 'earnings',
    empty: D.errors.adUnits || 'No ad unit data',
  });

  // ---- products
  const prodRows = (D.gaProducts?.rows || []).map(r => ({ product: r.d[0], count: r.m[0], revenue: r.m[1] }));
  const prodTotal = sum(prodRows.map(r => r.revenue)) || 1;
  table($('#productTable'), {
    columns: [
      { key: 'product', label: m.hasProductDim ? 'Product' : 'Platform' },
      { key: 'count', label: 'Purchases', num: true, fmt },
      { key: 'revenue', label: 'Gross', num: true, fmt: v => money(v, cur) },
      { key: 'share', label: 'Share', num: true, sort: r => r.revenue, html: r => pct(r.revenue / prodTotal, 1) },
      { key: 'avg', label: 'Avg price', num: true, sort: r => r.count ? r.revenue / r.count : 0, html: r => money2(r.count ? r.revenue / r.count : null, cur) },
    ],
    rows: prodRows,
    sortKey: 'revenue',
    empty: D.errors.gaProducts || 'No in_app_purchase events in this period',
  });
  $('#productNote').textContent = m.hasProductDim ? ''
    : 'Per-product breakdown needs a GA4 custom dimension: Analytics → Admin → Custom definitions → Create custom dimension, scope Event, parameter "product_id". Until then purchases are grouped by platform.';

  // ---- countries
  const countries = {};
  // Joined on ISO code: AdMob reports COUNTRY as "US", GA4 countryId likewise.
  const C = code => countries[code] ??= { code, country: code, users: 0, adEarn: 0, imps: 0, iap: 0, payers: 0 };
  for (const r of D.adCountry || []) { const c = C(r.dims.COUNTRY); c.adEarn += r.met.ESTIMATED_EARNINGS; c.imps += r.met.IMPRESSIONS; }
  for (const r of D.gaCountry?.rows || []) { const c = C(r.d[0]); c.country = r.d[1]; c.users += r.m[0]; c.iap += r.m[1]; c.payers += r.m[2]; }
  const countryRows = Object.values(countries).filter(c => c.code && c.code !== '(not set)')
    .map(c => ({ ...c, total: c.adEarn + c.iap * (1 - fee), arpu: c.users ? (c.adEarn + c.iap * (1 - fee)) / c.users : null, ecpm: c.imps ? c.adEarn / c.imps * 1000 : null }));
  table($('#countryTable'), {
    columns: [
      { key: 'country', label: 'Country' },
      { key: 'users', label: 'Users', num: true, fmt },
      { key: 'total', label: 'Revenue', num: true, fmt: v => money(v, cur) },
      { key: 'adEarn', label: 'Ads', num: true, fmt: v => money(v) },
      { key: 'ecpm', label: 'eCPM', num: true, fmt: v => money2(v) },
      { key: 'iap', label: 'IAP gross', num: true, fmt: v => money(v, cur) },
      { key: 'arpu', label: 'Rev / user', num: true, fmt: v => money2(v, cur) },
    ],
    rows: countryRows,
    sortKey: 'total',
    pageSize: 15,
  });

  // ---- retention
  const coh = {};
  for (const r of D.gaCohorts?.rows || []) {
    const [name, nth] = r.d;
    const c = coh[name] ??= { cohort: name, size: 0, weeks: [] };
    c.size = Math.max(c.size, r.m[1]);
    c.weeks[Number(nth)] = r.m[0];
  }
  const cohRows = Object.values(coh).sort((a, b) => a.cohort.localeCompare(b.cohort));
  table($('#retentionTable'), {
    columns: [
      { key: 'cohort', label: 'Week of first open' },
      { key: 'size', label: 'Users', num: true, fmt },
      ...[1, 2, 3, 4, 5].map(w => ({
        key: `w${w}`, label: `Week ${w}`, num: true, nosort: true,
        html: r => r.weeks[w] == null ? '' : `<span style="padding:2px 6px;border-radius:4px;background:${solid(css('--good'), Math.min(0.85, 0.1 + (r.weeks[w] / (r.size || 1)) * 2))}">${pct(r.weeks[w] / (r.size || 1), 1)}</span>`,
      })),
    ],
    rows: cohRows,
    sortKey: 'cohort',
    sortDir: 'asc',
    empty: D.errors.gaCohorts || 'No cohort data',
  });

  // Everything computed above, for the dashboard's export.
  m.snapshot = {
    period: { start: iso(D.start), end: iso(D.end), days: D.days },
    currency: cur,
    storeFee: fee,
    apps: m.apps.filter(a => m.selectedApps.has(a.id)).map(a => `${a.name} (${PLATFORM_NAME(a.platform)})`),
    kpis: {
      revenueNet: adTotal + iapNet, adRevenue: adTotal, iapGross, iapNetEstimate: iapNet,
      arpdau: dauSum ? (adTotal + iapNet) / dauSum : null, avgDau,
      activeUsers: periodUsers, newUsers: sum(plat.map(r => r.m[1])), payers, firstTimePayers: firstPayers,
      payerConversion: periodUsers ? payers / periodUsers : null, arppu: payers ? iapGross / payers : null,
      adImpressions: adImps, ecpm: adImps ? adTotal / adImps * 1000 : null,
    },
    daily: dates.map(d => ({ date: d, adRevenue: adByDate[d], iapGross: iapByDate[d], dau: dauByDate[d] })),
    formats,
    platforms: Object.values(platRows),
    mediation: med,
    adUnits: unitRows,
    products: prodRows,
    countries: countryRows,
    retention: cohRows.map(c => ({ cohort: c.cohort, users: c.size, ...Object.fromEntries([1, 2, 3, 4, 5].map(w => [`week${w}`, c.weeks[w] == null ? null : c.weeks[w] / (c.size || 1)])) })),
    errors: D.errors,
  };

  renderMoneyInsights({ D, fee, cur, adTotal, iapGross, iapNet, formats, platRows, med, medTotal, countryRows, cohRows, payers, periodUsers, adByDate, iapByDate, dates });
}

function renderMoneyInsights(x) {
  const out = [];
  const total = x.adTotal + x.iapNet;
  if (total) out.push(['', `Ads bring ${pct(x.adTotal / total)} of revenue and in-app purchases ${pct(x.iapNet / total)} (after an estimated ${pct(x.fee)} store fee).`]);

  if (x.dates.length >= 14) {
    const rev = d => x.adByDate[d] + x.iapByDate[d] * (1 - x.fee);
    const last = sum(x.dates.slice(-7).map(rev)), prev = sum(x.dates.slice(-14, -7).map(rev));
    if (prev) out.push([last >= prev ? 'good' : 'bad', `Revenue in the last 7 days is ${last >= prev ? 'up' : 'down'} ${pct(Math.abs(last - prev) / prev)} on the week before.`]);
  }

  const rew = x.formats.find(f => /reward/i.test(f.format) && !/interstitial/i.test(f.format));
  const inter = x.formats.find(f => /^interstitial$/i.test(f.format));
  if (rew && inter && rew.ecpm && inter.ecpm) {
    out.push(['', `Rewarded eCPM is ${money2(rew.ecpm)} vs ${money2(inter.ecpm)} for interstitials. Players watch ${rew.perDau?.toFixed(2)} rewarded and see ${inter.perDau?.toFixed(2)} interstitials per day.`]);
    if (rew.ecpm > inter.ecpm * 1.5 && rew.perDau < 1) out.push(['warn', 'Rewarded ads pay much more but are watched less than once per player per day. More rewarded placements (extra moves, daily bonus, pack re-rolls) are the cheapest revenue lever.']);
  }
  for (const f of x.formats) {
    if (f.show != null && f.show < 0.7 && f.matched > 100) out.push(['warn', `${f.format}: only ${pct(f.show)} of filled ads are actually shown. Ads load but players leave before the placement, so those fills are wasted (and can lower network bids).`]);
    if (f.fill != null && f.fill < 0.7 && f.req > 1000) out.push(['warn', `${f.format}: match rate is ${pct(f.fill)}. Check the mediation group has enough bidders/waterfall lines for the main countries.`]);
  }

  const reqTotal = sum(x.med.map(r => r.req)) || 1;
  for (const r of x.med) {
    if (r.req / reqTotal > 0.05 && r.fill != null && r.fill < 0.1) out.push(['warn', `${r.source}, ${r.format}: fills only ${pct(r.fill, 1)} of ${fmt(r.req)} requests. Check its setup or floor price, or remove it from the waterfall.`]);
  }
  const top = [...x.med].sort((a, b) => b.earnings - a.earnings)[0];
  if (top) out.push(['', `${top.source}, ${top.format}, is the top earner with ${pct(top.earnings / x.medTotal)} of mediated revenue.`]);

  if (x.periodUsers) {
    const conv = x.payers / x.periodUsers;
    out.push([conv < 0.01 ? 'warn' : 'good', `${pct(conv, 2)} of active users made a purchase. Casual puzzle games often land around 1–3%. A first-purchase starter offer usually moves this most.`]);
  }
  const ios = x.platRows.iOS;
  if (ios && ios.users > 200 && ios.iap === 0) out.push(['bad', 'iOS shows active users but no in-app purchase revenue in Analytics. Unity IAP 5 uses StoreKit 2, which Firebase may not log automatically. Log the transaction from the game (FirebaseAnalytics.LogTransaction) to track iOS IAP.']);

  const bigCountries = x.countryRows.filter(c => c.imps > 5000 && c.ecpm);
  if (bigCountries.length > 2) {
    const best = [...bigCountries].sort((a, b) => b.ecpm - a.ecpm)[0];
    const worst = [...bigCountries].sort((a, b) => a.ecpm - b.ecpm)[0];
    out.push(['', `Highest eCPM: ${best.country} (${money2(best.ecpm)}). Lowest: ${worst.country} (${money2(worst.ecpm)}). Consider this when choosing user-acquisition countries.`]);
  }
  const c = x.cohRows.filter(r => r.size >= 50 && r.weeks[1] != null);
  if (c.length) {
    const w1 = sum(c.map(r => r.weeks[1])) / sum(c.map(r => r.size));
    out.push([w1 < 0.15 ? 'bad' : w1 < 0.25 ? 'warn' : 'good', `Week-1 retention averages ${pct(w1, 1)}. Revenue per user grows with every extra week a player stays, so early-level difficulty (see Levels) directly drives ad revenue.`]);
  }
  $('#moneyInsights').innerHTML = out.length ? out.map(([cls, t]) => `<li class="${cls}">${esc(t)}</li>`).join('') : '<li>No data for this period.</li>';
}

/** Aggregates from the last Monetization load (null if never connected). */
export function getMonetizationSnapshot() {
  if (!m.snapshot) return null;
  return { ...m.snapshot, insights: [...document.querySelectorAll('#moneyInsights li')].map(li => li.textContent) };
}

/** Raw AdMob / GA4 rows from the last load. */
export function getMonetizationRaw() {
  return lastData;
}
