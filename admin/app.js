import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, reauthenticateWithPopup, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import { getDatabase, ref, get } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-database.js';
import {
  getFirestore, collection, query, where, orderBy, startAfter, limit, getDocs, doc, getDoc, getCountFromServer,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
import {
  RARITY, ALBUM, SETS, STICKERS, STICKER_BY_ID, SET_BY_ID, PACKS, STARDUST, COSMETIC_NAMES,
  DEFAULT_UNLOCK_LEVEL, DEFAULT_CLAIM_GRACE_DAYS, COLLECTION_HMAC_KEY,
} from './catalog.js';
import {
  $, $$, DAY, fmt, fmt1, pct, esc, relTime, median, quantile, sum, charts, css, chart, alpha, solid, table, bar, kpi,
} from './ui.js';
import { GOOGLE_SCOPES, initMonetization, renderMonetization, resetMonetization } from './monetization.js';
const INACTIVE_DAYS = 7;
const PAGE = 500;

// ---------------------------------------------------------------- state

const state = {
  players: [],          // parsed saves
  byUid: new Map(),
  levelStats: {},       // levelNum -> { Wins, Fails, FailsAttempt1..4 }
  season: null,         // config/collection doc
  savesError: null,
  signatures: new Map(), // uid -> 'valid' | 'unverified'
};

let app, auth, db, rtdb;

const displayName = p => p.nickname || `Player${p.uid.slice(-4)}`;
const utcDayStamp = (d = new Date()) => d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();

// ---------------------------------------------------------------- config / boot

function parseConfig(text) {
  const t = text.trim();
  const body = t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
  if (!body) throw new Error('No { ... } object found.');
  try { return JSON.parse(body); } catch { /* fall through to JS object literal */ }
  const out = {};
  for (const m of body.matchAll(/([A-Za-z_]\w*)\s*:\s*(['"`])(.*?)\2/g)) out[m[1]] = m[3];
  if (!out.apiKey) throw new Error('Could not read apiKey from the pasted config.');
  return out;
}

function loadConfig() {
  try { return JSON.parse(localStorage.getItem('config')); } catch { return null; }
}

function show(id) {
  for (const s of ['setup', 'signin', 'app']) $(`#${s}`).classList.toggle('hidden', s !== id);
}

function boot() {
  const config = loadConfig();
  if (!config || !config.apiKey) { show('setup'); return; }
  if (!config.databaseURL && config.projectId) {
    config.databaseURL = `https://${config.projectId}-default-rtdb.firebaseio.com`;
  }
  app = initializeApp(config);
  auth = getAuth(app);
  db = getFirestore(app);
  rtdb = getDatabase(app);

  onAuthStateChanged(auth, user => {
    if (!user || user.isAnonymous) { show('signin'); return; }
    $('#who').textContent = user.email;
    show('app');
    loadAll(false);
    if ($('.view.active').dataset.view === 'money') renderMonetization();
  });
}

$('#saveConfig').addEventListener('click', () => {
  try {
    const cfg = parseConfig($('#configInput').value);
    localStorage.setItem('config', JSON.stringify(cfg));
    location.reload();
  } catch (e) {
    $('#setupError').textContent = e.message;
  }
});

$('#resetConfig').addEventListener('click', () => {
  $('#configInput').value = localStorage.getItem('config') || '';
  show('setup');
});

// Google OAuth access token for the AdMob and Analytics APIs. Firebase hands it
// over only at sign-in, so it is kept for its one-hour lifetime in this tab.
function googleProvider() {
  const provider = new GoogleAuthProvider();
  GOOGLE_SCOPES.forEach(s => provider.addScope(s));
  if (auth.currentUser?.email) provider.setCustomParameters({ login_hint: auth.currentUser.email });
  return provider;
}

function cacheGoogleToken(result) {
  const token = GoogleAuthProvider.credentialFromResult(result)?.accessToken;
  if (token) sessionStorage.setItem('googleToken', JSON.stringify({ token, exp: Date.now() + 55 * 60000 }));
}

async function getGoogleToken(interactive) {
  try {
    const cached = JSON.parse(sessionStorage.getItem('googleToken'));
    if (cached && cached.exp > Date.now()) return cached.token;
  } catch { /* no cached token */ }
  if (!interactive || !auth.currentUser) return null;
  cacheGoogleToken(await reauthenticateWithPopup(auth.currentUser, googleProvider()));
  return getGoogleToken(false);
}

$('#googleSignIn').addEventListener('click', async () => {
  $('#signinError').textContent = '';
  try {
    cacheGoogleToken(await signInWithPopup(auth, googleProvider()));
  } catch (e) {
    const hints = {
      'auth/operation-not-allowed': 'Google sign-in is not enabled. Firebase console → Authentication → Sign-in method → enable Google.',
      'auth/unauthorized-domain': `This domain (${location.hostname}) is not authorised. Firebase console → Authentication → Settings → Authorised domains → add it.`,
      'auth/popup-closed-by-user': 'Sign-in window was closed.',
    };
    $('#signinError').textContent = hints[e.code] || e.message;
  }
});

$('#signOut').addEventListener('click', () => {
  sessionStorage.removeItem('googleToken');
  resetMonetization();
  signOut(auth);
});
$('#refresh').addEventListener('click', () => loadAll(false));
$('#fullResync').addEventListener('click', () => {
  if (confirm('Download every save again? This uses one Firestore read per player.')) loadAll(true);
});

// ---------------------------------------------------------------- navigation

const TITLES = { overview: 'Overview', money: 'Monetization', levels: 'Levels', collection: 'Collection', players: 'Players', leaderboards: 'Leaderboards' };

function setView(name) {
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === name));
  $('#viewTitle').textContent = TITLES[name];
  window.scrollTo(0, 0);
  try { localStorage.setItem('adminView', name); } catch { /* ignore */ }
  const signedIn = auth?.currentUser && !auth.currentUser.isAnonymous;
  if (name === 'leaderboards' && signedIn) renderLeaderboards();
  if (name === 'money' && signedIn) renderMonetization();
}
$$('#nav button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));

// ---------------------------------------------------------------- IndexedDB cache of raw saves

const idb = (() => {
  let dbp;
  const open = () => dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('sj-admin', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('saves', { keyPath: 'uid' }); r.result.createObjectStore('meta'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (store, mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    all: () => tx('saves', 'readonly', s => s.getAll()),
    putMany: rows => tx('saves', 'readwrite', s => { rows.forEach(r => s.put(r)); }),
    clear: () => Promise.all([tx('saves', 'readwrite', s => s.clear()), tx('meta', 'readwrite', s => s.clear())]),
    getMeta: k => tx('meta', 'readonly', s => s.get(k)),
    setMeta: (k, v) => tx('meta', 'readwrite', s => s.put(v, k)),
  };
})();

// ---------------------------------------------------------------- loading

function setSync(text, busy = false) {
  $('#syncStatus').innerHTML = busy ? `<span class="loading"><span class="spinner"></span>${esc(text)}</span>` : esc(text);
  $('#refresh').disabled = busy;
  $('#fullResync').disabled = busy;
}

async function syncSaves(full) {
  const projectId = app.options.projectId;
  if (full || (await idb.getMeta('projectId')) !== projectId) await idb.clear();
  await idb.setMeta('projectId', projectId);

  const since = await idb.getMeta('cursor');
  const base = collection(db, 'saves');
  let last = null;
  let reads = 0;
  let maxSaved = since ?? 0;

  let total = null;
  try { total = (await getCountFromServer(base)).data().count; } catch { /* count is optional */ }

  for (;;) {
    const parts = [];
    if (since != null) parts.push(where('savedAtUtc', '>=', since));
    parts.push(orderBy('savedAtUtc'));
    if (last) parts.push(startAfter(last));
    parts.push(limit(PAGE));
    const snap = await getDocs(query(base, ...parts));
    reads += snap.size;
    const rows = snap.docs.map(d => {
      const v = d.data();
      if (v.savedAtUtc > maxSaved) maxSaved = v.savedAtUtc;
      return { uid: d.id, reachedLevel: v.reachedLevel, totalStars: v.totalStars, savedAtUtc: v.savedAtUtc, summary: v.summary, json: v.json };
    });
    await idb.putMany(rows);
    setSync(`Syncing saves… ${fmt(reads)}${since == null && total != null ? ` / ${fmt(total)}` : ''}`, true);
    if (snap.size < PAGE) break;
    last = snap.docs[snap.docs.length - 1];
  }
  await idb.setMeta('cursor', maxSaved);
  return { reads, total };
}

async function loadLevelStats() {
  const path = $('#statsPath').value;
  const snap = await get(ref(rtdb, path ? `${path}/Levels` : 'Levels'));
  const out = {};
  if (snap.exists()) {
    for (const [k, v] of Object.entries(snap.val())) {
      const n = parseInt(k.replace(/^Level/, ''), 10);
      if (n > 0 && v && typeof v === 'object') out[n] = v;
    }
  }
  state.levelStats = out;
}

async function loadSeason() {
  try {
    const s = await getDoc(doc(db, 'config', 'collection'));
    state.season = s.exists() ? s.data() : {};
  } catch { state.season = {}; }
}

async function loadAll(full) {
  $('#globalBanner').classList.add('hidden');
  setSync('Loading…', true);
  state.savesError = null;
  let syncInfo = null;

  const tasks = [
    loadLevelStats().catch(e => { showBanner(`Level stats: ${e.message}`, true); }),
    loadSeason(),
    syncSaves(full).then(r => { syncInfo = r; }).catch(e => { state.savesError = e; }),
  ];
  await Promise.all(tasks);

  if (state.savesError) {
    const denied = /permission|insufficient/i.test(state.savesError.message);
    showBanner(denied
      ? `Can't read player saves with ${auth.currentUser.email}. Publish the updated firebase/firestore.rules (isAdmin) in the Firebase console, or sign in with the admin account. Level stats and leaderboards still work.`
      : `Saves: ${state.savesError.message}`, true);
  }

  const raw = await idb.all().catch(() => []);
  state.players = raw.map(parseSave);
  state.byUid = new Map(state.players.map(p => [p.uid, p]));

  renderAll();
  const readsText = syncInfo ? ` · ${fmt(syncInfo.reads)} save reads this sync` : '';
  setSync(`${fmt(state.players.length)} players · updated ${new Date().toLocaleTimeString()}${readsText}`);
  checkSignatures();
}

function showBanner(msg, bad = false) {
  const b = $('#globalBanner');
  b.textContent = msg;
  b.classList.toggle('bad', bad);
  b.classList.remove('hidden');
}

// ---------------------------------------------------------------- parsing

function parseSave(raw) {
  let p = {};
  try { p = JSON.parse(raw.json || '{}'); } catch { /* corrupt payload */ }
  let col = null;
  if (p.collectionJson) {
    try { col = normalizeCollection(JSON.parse(p.collectionJson)); } catch { /* corrupt collection */ }
  }
  const reached = raw.reachedLevel ?? p.reachedLevel ?? 0;
  return {
    uid: raw.uid,
    reachedLevel: reached,
    beaten: Math.max(0, reached - 1),
    totalStars: raw.totalStars ?? 0,
    savedAt: (raw.savedAtUtc ?? p.savedAtUtc ?? 0) * 1000,
    nickname: p.nickname || '',
    stars: p.starsPerLevel || [],
    scores: p.scoresPerLevel || [],
    openLevel: p.openLevel,
    summary: raw.summary || '',
    col,
    collectionJson: p.collectionJson || '',
  };
}

function normalizeCollection(c) {
  const owned = new Map();
  for (const o of c.owned || []) if (STICKER_BY_ID[o.stickerId]) owned.set(o.stickerId, o.firstAcquiredUtc || 0);
  const completeSets = SETS.filter(s => s.stickers.every(st => owned.has(st.id))).map(s => s.id);
  const coinPacks = {};
  (c.coinPackIds || []).forEach((id, i) => { coinPacks[id] = (c.coinPackCounts || [])[i] || 0; });
  return {
    owned,
    ownedCount: owned.size,
    stardust: c.stardust || 0,
    gems: c.gems || 0,
    unopenedPacks: c.unopenedPacks || [],
    pity: c.packsSinceLastLegendary || 0,
    claimedSets: c.claimedSetRewards || [],
    albumClaimed: !!c.claimedAlbumReward,
    completeSets,
    albumComplete: owned.size === STICKERS.length,
    equipped: c.equipped || {},
    unlockedCosmetics: c.unlockedCosmetics || [],
    coinPacks,
    coinPacksDayStamp: c.coinPacksDayStamp || 0,
    adPackDayStamp: c.adPackDayStamp || 0,
    stardustWiped: c.stardustWipedForSeason || '',
  };
}

// HMAC-SHA256 over the save with checksum blanked, as SaveIntegrity.cs does.
// Saves from older builds were signed with a device-specific key, so a mismatch
// means "not verifiable here", not necessarily tampered.
let hmacKey;
async function verifySignature(json) {
  hmacKey ??= await crypto.subtle.importKey('raw', new TextEncoder().encode(COLLECTION_HMAC_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const o = JSON.parse(json);
  const sig = o.checksum;
  o.checksum = '';
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(JSON.stringify(o))));
  return btoa(String.fromCharCode(...mac)) === sig;
}

async function checkSignatures() {
  for (const p of state.players) {
    if (!p.collectionJson || state.signatures.has(p.uid)) continue;
    try { state.signatures.set(p.uid, (await verifySignature(p.collectionJson)) ? 'valid' : 'unverified'); } catch { state.signatures.set(p.uid, 'unverified'); }
  }
  const unverified = [...state.signatures.values()].filter(v => v === 'unverified').length;
  const el = $('#sigKpi');
  if (el) el.textContent = fmt(unverified);
}

// ---------------------------------------------------------------- season

function seasonInfo() {
  const s = state.season || {};
  const endIso = (s.seasonEndUtc || ALBUM.seasonEndUtc || '').trim();
  const end = endIso ? Date.parse(endIso) : NaN;
  const grace = Number(s.claimGraceDays ?? DEFAULT_CLAIM_GRACE_DAYS);
  const unlockLevel = Number(s.unlockLevel ?? DEFAULT_UNLOCK_LEVEL);
  const next = Date.parse((s.nextSeasonStartUtc || s.seasonStartUtc || '').trim());
  const now = Date.now();
  let phase = 'Active';
  if (Number.isFinite(end) && now >= end) phase = now < end + grace * DAY ? 'Claim window' : 'Waiting for next season';
  return { end, grace, unlockLevel, next, phase };
}

// ---------------------------------------------------------------- derived metrics

function levelMetrics() {
  const players = state.players;
  const now = Date.now();
  const maxLevel = Math.max(0, ...Object.keys(state.levelStats).map(Number), ...players.map(p => p.reachedLevel));
  const stopped = new Array(maxLevel + 2).fill(0);
  const stoppedInactive = new Array(maxLevel + 2).fill(0);
  const beatCount = new Array(maxLevel + 2).fill(0);   // players who beat level N
  const starSum = new Array(maxLevel + 2).fill(0);
  const starN = new Array(maxLevel + 2).fill(0);

  for (const p of players) {
    const r = Math.min(p.reachedLevel, maxLevel + 1);
    if (r >= 1) {
      stopped[r]++;
      if (now - p.savedAt > INACTIVE_DAYS * DAY) stoppedInactive[r]++;
    }
    if (p.beaten >= 1) beatCount[Math.min(p.beaten, maxLevel + 1)]++;
    const n = Math.min(p.stars.length, p.beaten);
    for (let i = 0; i < n; i++) { starSum[i + 1] += p.stars[i]; starN[i + 1]++; }
  }
  // beatCount -> players who beat at least N (suffix sums)
  for (let i = beatCount.length - 2; i >= 1; i--) beatCount[i] += beatCount[i + 1];

  const rows = [];
  for (let n = 1; n <= maxLevel; n++) {
    const s = state.levelStats[n] || {};
    const wins = s.Wins || 0, fails = s.Fails || 0;
    const plays = wins + fails;
    const reached = beatCount[n] + stopped[n]; // beat it, or currently on it
    rows.push({
      level: n, wins, fails, plays,
      winRate: plays ? wins / plays : null,
      f1: s.FailsAttempt1 || 0, f2: s.FailsAttempt2 || 0, f3: s.FailsAttempt3 || 0, f4: s.FailsAttempt4 || 0,
      beat: beatCount[n],
      reached,
      stopped: stopped[n],
      stoppedInactive: stoppedInactive[n],
      quitRate: reached ? stoppedInactive[n] / reached : null,
      avgStars: starN[n] ? starSum[n] / starN[n] : null,
    });
  }
  return rows;
}

function collectionMetrics() {
  const season = seasonInfo();
  const all = state.players;
  const withCol = all.filter(p => p.col);
  const collectors = withCol.filter(p => p.col.ownedCount > 0);
  const eligible = all.filter(p => p.reachedLevel >= season.unlockLevel);

  const stickerOwn = Object.fromEntries(STICKERS.map(s => [s.id, 0]));
  for (const p of collectors) for (const id of p.col.owned.keys()) stickerOwn[id]++;

  const sets = SETS.map(s => {
    const owned = collectors.map(p => s.stickers.filter(st => p.col.owned.has(st.id)).length);
    const complete = collectors.filter(p => p.col.completeSets.includes(s.id)).length;
    const claimed = collectors.filter(p => p.col.claimedSets.includes(s.id)).length;
    const unclaimed = collectors.filter(p => p.col.completeSets.includes(s.id) && !p.col.claimedSets.includes(s.id)).length;
    return { id: s.id, name: s.name, index: s.index, avgOwned: owned.length ? sum(owned) / owned.length : 0, complete, claimed, unclaimed, completeRate: collectors.length ? complete / collectors.length : 0 };
  });

  return { season, all, withCol, collectors, eligible, stickerOwn, sets };
}

// ---------------------------------------------------------------- render: overview

function renderAll() {
  const lv = levelMetrics();
  const cm = collectionMetrics();
  renderOverview(lv, cm);
  renderLevels(lv);
  renderCollection(cm);
  renderPlayers();
  if ($('.view.active').dataset.view === 'leaderboards') renderLeaderboards();
}

function renderOverview(lv, cm) {
  const P = state.players;
  const now = Date.now();
  const active = d => P.filter(p => now - p.savedAt <= d * DAY).length;
  const beaten = P.map(p => p.beaten);
  const top = [...P].sort((a, b) => b.beaten - a.beaten || b.totalStars - a.totalStars)[0];
  const totalWins = sum(Object.values(state.levelStats).map(s => s.Wins || 0));
  const totalFails = sum(Object.values(state.levelStats).map(s => s.Fails || 0));

  $('#overviewKpis').innerHTML = [
    kpi('Players', fmt(P.length), 'cloud saves'),
    kpi('Active 24h', fmt(active(1)), `${fmt(active(7))} in 7d · ${fmt(active(30))} in 30d`),
    kpi('Median level beaten', fmt(median(beaten)), `p90 ${fmt(quantile(beaten, 0.9))}`),
    kpi('Furthest player', top ? fmt(top.beaten) : '–', top ? esc(displayName(top)) : ''),
    kpi('Collectors', fmt(cm.collectors.length), `${pct(cm.collectors.length / (P.length || 1))} of players`),
    kpi('Albums complete', fmt(cm.collectors.filter(p => p.col.albumComplete).length), `${fmt(cm.collectors.filter(p => p.col.albumClaimed).length)} claimed the reward`),
    kpi('Level plays', fmt(totalWins + totalFails), `overall win rate ${pct(totalWins / ((totalWins + totalFails) || 1))}`),
  ].join('');

  // level distribution histogram
  const p95 = quantile(beaten, 0.95) || 10;
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500].find(s => p95 / s <= 25) || 1000;
  const buckets = new Map();
  for (const b of beaten) {
    const k = b > p95 ? Infinity : Math.floor(b / step) * step;
    buckets.set(k, (buckets.get(k) || 0) + 1);
  }
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  chart('chLevelDist', {
    type: 'bar',
    data: {
      labels: keys.map(k => k === Infinity ? `${Math.floor(p95 / step) * step + step}+` : step === 1 ? `${k}` : `${k}–${k + step - 1}`),
      datasets: [{ data: keys.map(k => buckets.get(k)), backgroundColor: solid(css('--accent'), 0.75), borderRadius: 4 }],
    },
    options: { scales: { y: { beginAtZero: true, title: { display: true, text: 'players' } }, x: { title: { display: true, text: 'levels beaten' } } } },
  });

  // activity by last save day
  const days = [...Array(30)].map((_, i) => 29 - i);
  const counts = days.map(d => P.filter(p => {
    const age = Math.floor((now - p.savedAt) / DAY);
    return age === d;
  }).length);
  chart('chActivity', {
    type: 'bar',
    data: {
      labels: days.map(d => new Date(now - d * DAY).toISOString().slice(5, 10)),
      datasets: [{ data: counts, backgroundColor: solid(css('--accent'), 0.55), borderRadius: 3 }],
    },
    options: { scales: { y: { beginAtZero: true } } },
  });

  table($('#topPlayers'), {
    columns: [
      { key: 'name', label: 'Player', html: p => esc(displayName(p)) },
      { key: 'beaten', label: 'Level', num: true, fmt },
      { key: 'totalStars', label: 'Stars', num: true, fmt },
      { key: 'stickers', label: 'Stickers', num: true, sort: p => p.col?.ownedCount ?? -1, html: p => p.col ? `${p.col.ownedCount}/48` : '–' },
      { key: 'savedAt', label: 'Last save', num: true, fmt: v => relTime(v) },
    ],
    rows: [...P].sort((a, b) => b.beaten - a.beaten).slice(0, 10),
    sortKey: 'beaten',
    onRow: openPlayer,
  });

  renderInsights(lv, cm);
}

function renderInsights(lv, cm) {
  const out = [];
  const minPlays = Number($('#minPlays').value) || 30;
  const early = lv.filter(r => r.level <= 100 && r.plays >= minPlays && r.winRate != null);
  if (early.length) {
    const hardest = [...early].sort((a, b) => a.winRate - b.winRate)[0];
    const avg = sum(early.map(r => r.winRate)) / early.length;
    out.push(['warn', `Level ${hardest.level} is the hardest of the first 100: ${pct(hardest.winRate)} win rate vs ${pct(avg)} average (${fmt(hardest.plays)} plays).`]);
  }
  const drop = [...lv].filter(r => r.reached >= 20).sort((a, b) => b.stoppedInactive - a.stoppedInactive)[0];
  if (drop && drop.stoppedInactive > 0) {
    out.push(['bad', `Most players who quit stopped at level ${drop.level}: ${fmt(drop.stoppedInactive)} inactive players (${pct(drop.quitRate)} of everyone who reached it).`]);
  }
  if (cm.all.length) {
    const eligRate = cm.eligible.length / cm.all.length;
    const startRate = cm.eligible.length ? cm.collectors.length / cm.eligible.length : 0;
    out.push([startRate < 0.5 ? 'warn' : 'good', `${pct(eligRate)} of players reach the collection unlock (level ${cm.season.unlockLevel}); ${pct(startRate)} of those own at least one sticker.`]);
  }
  if (cm.collectors.length) {
    const unclaimed = sum(cm.sets.map(s => s.unclaimed));
    if (unclaimed) out.push(['warn', `${fmt(unclaimed)} completed sets have an unclaimed reward. Players may not notice the claim button.`]);
    const hardSet = [...cm.sets].sort((a, b) => a.completeRate - b.completeRate)[0];
    const easySet = [...cm.sets].sort((a, b) => b.completeRate - a.completeRate)[0];
    out.push(['', `Easiest set: ${easySet.name} (${pct(easySet.completeRate, 1)} complete). Hardest: ${hardSet.name} (${pct(hardSet.completeRate, 1)}).`]);
    const canBuy = cm.collectors.filter(p => p.col.stardust >= STARDUST.directBuyCost[0] && !p.col.albumComplete).length;
    if (canBuy) out.push(['', `${fmt(canBuy)} collectors have enough stardust (${STARDUST.directBuyCost[0]}+) to buy a missing Common sticker.`]);
    const queued = sum(cm.collectors.map(p => p.col.unopenedPacks.length));
    if (queued) out.push(['', `${fmt(queued)} packs are sitting unopened across ${fmt(cm.collectors.filter(p => p.col.unopenedPacks.length).length)} players.`]);
  }
  $('#insights').innerHTML = out.length ? out.map(([cls, t]) => `<li class="${cls}">${esc(t)}</li>`).join('') : '<li>No data yet.</li>';
}

// ---------------------------------------------------------------- render: levels

let lastLevelRows = [];
function renderLevels(rows = lastLevelRows) {
  lastLevelRows = rows;
  const from = Math.max(1, Number($('#lvFrom').value) || 1);
  const to = Math.max(from, Number($('#lvTo').value) || from);
  const minPlays = Number($('#minPlays').value) || 1;
  const inRange = rows.filter(r => r.level >= from && r.level <= to);
  const plays = sum(inRange.map(r => r.plays));
  const wins = sum(inRange.map(r => r.wins));
  const ranked = inRange.filter(r => r.plays >= minPlays && r.winRate != null);

  $('#levelKpis').innerHTML = [
    kpi('Plays in range', fmt(plays), `${fmt(wins)} wins · ${fmt(plays - wins)} fails`),
    kpi('Win rate in range', pct(wins / (plays || 1))),
    kpi('Players stopped in range', fmt(sum(inRange.map(r => r.stopped))), `${fmt(sum(inRange.map(r => r.stoppedInactive)))} inactive 7d+`),
    kpi('Levels with data', fmt(inRange.filter(r => r.plays).length), `of ${fmt(inRange.length)} in range`),
  ].join('');

  chart('chLevels', {
    data: {
      labels: inRange.map(r => r.level),
      datasets: [
        { type: 'bar', label: 'Stopped (inactive)', data: inRange.map(r => r.stoppedInactive), backgroundColor: solid(css('--bad'), 0.55), yAxisID: 'y', stack: 's' },
        { type: 'bar', label: 'Stopped (active)', data: inRange.map(r => r.stopped - r.stoppedInactive), backgroundColor: solid(css('--muted'), 0.35), yAxisID: 'y', stack: 's' },
        { type: 'line', label: 'Win rate', data: inRange.map(r => r.winRate == null ? null : r.winRate * 100), borderColor: css('--accent'), backgroundColor: css('--accent'), pointRadius: inRange.length > 120 ? 0 : 2, borderWidth: 2, yAxisID: 'y2', spanGaps: true, tension: 0.2 },
      ],
    },
    options: {
      plugins: { legend: { display: true, position: 'bottom' } },
      scales: {
        x: { stacked: true, ticks: { autoSkip: true, maxTicksLimit: 25 } },
        y: { stacked: true, beginAtZero: true, title: { display: true, text: 'players stopped' } },
        y2: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: 'win rate %' } },
      },
    },
  });

  const levelCols = [
    { key: 'level', label: 'Level', num: true },
    { key: 'winRate', label: 'Win rate', num: true, fmt: v => pct(v) },
    { key: 'plays', label: 'Plays', num: true, fmt },
  ];
  table($('#hardest'), { columns: levelCols, rows: [...ranked].sort((a, b) => a.winRate - b.winRate).slice(0, 10), sortKey: 'winRate', sortDir: 'asc', empty: `No level in range has ${minPlays}+ plays` });
  table($('#dropoff'), {
    columns: [
      { key: 'level', label: 'Level', num: true },
      { key: 'stoppedInactive', label: 'Quit here', num: true, fmt },
      { key: 'quitRate', label: 'of reached', num: true, fmt: v => pct(v, 1) },
      { key: 'winRate', label: 'Win rate', num: true, fmt: v => pct(v) },
    ],
    rows: [...inRange].filter(r => r.stoppedInactive).sort((a, b) => b.stoppedInactive - a.stoppedInactive).slice(0, 10),
    sortKey: 'stoppedInactive',
  });

  const maxPlays = Math.max(1, ...inRange.map(r => r.plays));
  table($('#levelTable'), {
    columns: [
      { key: 'level', label: 'Level', num: true },
      { key: 'plays', label: 'Plays', num: true, html: r => `<div style="display:flex;gap:8px;align-items:center;justify-content:flex-end">${fmt(r.plays)}${bar(r.plays, maxPlays)}</div>` },
      { key: 'wins', label: 'Wins', num: true, fmt },
      { key: 'fails', label: 'Fails', num: true, fmt },
      { key: 'winRate', label: 'Win rate', num: true, html: r => r.winRate == null ? '–' : `<span class="pill ${r.winRate < 0.3 ? 'bad' : r.winRate < 0.5 ? 'warn' : 'good'}">${pct(r.winRate)}</span>` },
      { key: 'f1', label: 'Fail 1', num: true, fmt },
      { key: 'f2', label: 'Fail 2', num: true, fmt },
      { key: 'f3', label: 'Fail 3', num: true, fmt },
      { key: 'f4', label: 'Fail 4+', num: true, fmt },
      { key: 'beat', label: 'Players beat', num: true, fmt },
      { key: 'stopped', label: 'Stopped here', num: true, fmt },
      { key: 'stoppedInactive', label: 'Quit here', num: true, fmt },
      { key: 'avgStars', label: 'Avg stars', num: true, fmt: v => v == null ? '–' : v.toFixed(2) },
    ],
    rows: inRange,
    sortKey: 'level',
    sortDir: 'asc',
    pageSize: 50,
  });
}

$('#lvApply').addEventListener('click', () => { renderLevels(); renderInsights(levelMetrics(), collectionMetrics()); });
$('#statsPath').addEventListener('change', async () => {
  setSync('Loading level stats…', true);
  await loadLevelStats().catch(e => showBanner(`Level stats: ${e.message}`, true));
  renderLevels(levelMetrics());
  setSync(`${fmt(state.players.length)} players`);
});

// ---------------------------------------------------------------- render: collection

function renderCollection(cm) {
  const { season, all, withCol, collectors, eligible, stickerOwn, sets } = cm;
  const C = collectors.length || 1;

  const endTxt = Number.isFinite(season.end) ? new Date(season.end).toUTCString().replace(' GMT', ' UTC') : 'no end date';
  const left = Number.isFinite(season.end) ? season.end - Date.now() : NaN;
  $('#seasonBanner').innerHTML = `<b>${esc(ALBUM.name)}</b> · ${esc(season.phase)} · season ends ${esc(endTxt)}${left > 0 ? ` (${Math.ceil(left / DAY)} days left)` : ''}
    · unlocks at level ${season.unlockLevel} · claim grace ${season.grace} days${Number.isFinite(season.next) && season.next > Date.now() ? ` · next season ${new Date(season.next).toISOString().slice(0, 10)}` : ''}`;

  const owned = collectors.map(p => p.col.ownedCount);
  $('#collectionKpis').innerHTML = [
    kpi('Collectors', fmt(collectors.length), `${pct(collectors.length / (eligible.length || 1))} of ${fmt(eligible.length)} eligible`),
    kpi('Avg stickers', fmt1(owned.length ? sum(owned) / owned.length : 0), `median ${fmt(median(owned))} of 48`),
    kpi('Sets completed', fmt(sum(collectors.map(p => p.col.completeSets.length))), `${fmt(sum(sets.map(s => s.claimed)))} rewards claimed`),
    kpi('Albums complete', fmt(collectors.filter(p => p.col.albumComplete).length), `${fmt(collectors.filter(p => p.col.albumClaimed).length)} claimed`),
    kpi('Stardust held', fmt(sum(collectors.map(p => p.col.stardust))), `median ${fmt(median(collectors.map(p => p.col.stardust)))}`),
    kpi('Gems held', fmt(sum(collectors.map(p => p.col.gems)))),
    kpi('Unverified saves', '…', 'signature does not match the current key', 'sigKpi'),
  ].join('');

  // funnel
  const steps = [
    ['All players', all.length],
    [`Reached level ${season.unlockLevel}`, eligible.length],
    ['Has collection save', withCol.length],
    ['1+ sticker', collectors.length],
    ['12+ stickers', collectors.filter(p => p.col.ownedCount >= 12).length],
    ['1+ set complete', collectors.filter(p => p.col.completeSets.length >= 1).length],
    ['4+ sets complete', collectors.filter(p => p.col.completeSets.length >= 4).length],
    ['Album complete', collectors.filter(p => p.col.albumComplete).length],
  ];
  chart('chFunnel', {
    type: 'bar',
    data: { labels: steps.map(s => s[0]), datasets: [{ data: steps.map(s => s[1]), backgroundColor: solid(css('--accent'), 0.7), borderRadius: 4 }] },
    options: {
      indexAxis: 'y',
      interaction: { mode: 'nearest', intersect: true },
      plugins: { tooltip: { callbacks: { label: c => `${fmt(c.raw)} · ${pct(c.raw / (all.length || 1), 1)}` } } },
      scales: { x: { beginAtZero: true } },
    },
  });

  // owned distribution
  const dist = new Array(STICKERS.length + 1).fill(0);
  withCol.forEach(p => dist[p.col.ownedCount]++);
  chart('chOwnedDist', {
    type: 'bar',
    data: { labels: dist.map((_, i) => i), datasets: [{ data: dist, backgroundColor: solid(css('--accent'), 0.6), borderRadius: 2 }] },
    options: { scales: { y: { beginAtZero: true, title: { display: true, text: 'players' } }, x: { title: { display: true, text: 'stickers owned' } } } },
  });

  // heatmap
  const rarColor = r => css(`--r${r}`);
  $('#heatmap').innerHTML = `<div class="heatmap">${SETS.map(s => {
    const setStat = sets[s.index];
    return `<div class="set-name">${esc(s.name)}</div>${s.stickers.map(st => {
      const share = stickerOwn[st.id] / C;
      return `<div class="cell" title="${esc(st.name)} · ${RARITY[st.rarity]} · owned by ${fmt(stickerOwn[st.id])} collectors"
        style="background:${alpha('var(--accent)', 0.08 + share * 0.6)}">
        <span class="n">${esc(st.name)}</span>
        <span><b>${pct(share)}</b> <span class="rar" style="color:${rarColor(st.rarity)}">${RARITY[st.rarity][0]}</span></span></div>`;
    }).join('')}<div class="set-pct">${pct(setStat.completeRate, 1)} done</div>`;
  }).join('')}</div>`;

  table($('#setTable'), {
    columns: [
      { key: 'name', label: 'Set' },
      { key: 'avgOwned', label: 'Avg owned', num: true, fmt: v => `${v.toFixed(1)}/6` },
      { key: 'completeRate', label: 'Complete', num: true, html: r => `${pct(r.completeRate, 1)} <span class="muted small">(${fmt(r.complete)})</span>` },
      { key: 'claimed', label: 'Claimed', num: true, fmt },
      { key: 'unclaimed', label: 'Unclaimed', num: true, html: r => r.unclaimed ? `<span class="pill warn">${fmt(r.unclaimed)}</span>` : '0' },
    ],
    rows: sets,
    sortKey: 'index',
    sortDir: 'asc',
  });

  const w = PACKS.standard.weights;
  const wSum = sum(w);
  table($('#rarityTable'), {
    columns: [
      { key: 'name', label: 'Rarity', html: r => `<span class="r${r.r}">&#9679;</span> ${r.name}` },
      { key: 'count', label: 'Stickers', num: true },
      { key: 'avgOwn', label: 'Avg owned by', num: true, fmt: v => pct(v, 1) },
      { key: 'odds', label: 'Pack odds', num: true, fmt: v => pct(v, 0) },
      { key: 'dup', label: 'Dup → stardust', num: true },
      { key: 'cost', label: 'Buy cost', num: true, fmt },
    ],
    rows: RARITY.map((name, r) => {
      const ids = STICKERS.filter(s => s.rarity === r).map(s => s.id);
      return { r, name, count: ids.length, avgOwn: ids.length ? sum(ids.map(id => stickerOwn[id])) / ids.length / C : 0, odds: w[r] / wSum, dup: STARDUST.duplicateYield[r], cost: STARDUST.directBuyCost[r] };
    }),
    sortKey: 'r',
    sortDir: 'asc',
  });

  // acquisitions per day, stacked by rarity
  const now = Date.now();
  const dayKeys = [...Array(30)].map((_, i) => 29 - i);
  const acq = RARITY.map(() => new Array(30).fill(0));
  for (const p of collectors) {
    for (const [id, t] of p.col.owned) {
      const age = Math.floor((now - t * 1000) / DAY);
      if (t && age >= 0 && age < 30) acq[STICKER_BY_ID[id].rarity][29 - age]++;
    }
  }
  chart('chAcq', {
    type: 'bar',
    data: {
      labels: dayKeys.map(d => new Date(now - d * DAY).toISOString().slice(5, 10)),
      datasets: RARITY.map((name, r) => ({ label: name, data: acq[r], backgroundColor: solid(rarColor(r), 0.8), stack: 'a' })),
    },
    options: { plugins: { legend: { display: true, position: 'bottom' } }, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } } },
  });

  // stardust buckets aligned to direct-buy prices
  const cost = STARDUST.directBuyCost;
  const bands = [[0, 0, '0'], [1, cost[0] - 1, `1–${cost[0] - 1}`], [cost[0], cost[1] - 1, `${cost[0]}–${cost[1] - 1}`], [cost[1], cost[2] - 1, `${cost[1]}–${cost[2] - 1}`], [cost[2], cost[3] - 1, `${cost[2]}–${cost[3] - 1}`], [cost[3], Infinity, `${cost[3]}+`]];
  const sd = collectors.map(p => p.col.stardust);
  chart('chStardust', {
    type: 'bar',
    data: { labels: bands.map(b => b[2]), datasets: [{ data: bands.map(([lo, hi]) => sd.filter(v => v >= lo && v <= hi).length), backgroundColor: solid(css('--r2'), 0.6), borderRadius: 4 }] },
    options: { scales: { y: { beginAtZero: true, title: { display: true, text: 'collectors' } }, x: { title: { display: true, text: 'stardust' } } } },
  });
  const wiped = collectors.filter(p => p.col.stardustWiped).length;
  $('#stardustNote').textContent = `Bands match the direct-buy prices (Common ${cost[0]}, Rare ${cost[1]}, Epic ${cost[2]}, Legendary ${cost[3]}).`
    + (wiped ? ` ${fmt(wiped)} players already had their stardust wiped by the season end.` : '');

  // unopened packs
  const packCounts = {};
  const packHolders = {};
  for (const p of collectors) {
    const seen = new Set();
    for (const id of p.col.unopenedPacks) { packCounts[id] = (packCounts[id] || 0) + 1; seen.add(id); }
    seen.forEach(id => { packHolders[id] = (packHolders[id] || 0) + 1; });
  }
  const nearPity = collectors.filter(p => p.col.pity >= PACKS.standard.pity - 5).length;
  table($('#packTable'), {
    columns: [
      { key: 'name', label: 'Pack' },
      { key: 'queued', label: 'Queued', num: true, fmt },
      { key: 'holders', label: 'Players', num: true, fmt },
    ],
    rows: Object.keys({ ...PACKS, ...packCounts }).map(id => ({ id, name: PACKS[id]?.name || id, queued: packCounts[id] || 0, holders: packHolders[id] || 0 })),
    sortKey: 'queued',
    empty: 'No queued packs',
  });
  $('#pityNote').textContent = `${fmt(nearPity)} players are within 5 packs of the Legendary pity (${PACKS.standard.pity}).`;

  // shop today
  const today = utcDayStamp();
  const shop = {};
  let buyersToday = 0, everBought = 0, adToday = 0, adEver = 0;
  for (const p of collectors) {
    if (p.col.coinPacksDayStamp) everBought++;
    if (p.col.coinPacksDayStamp === today) {
      buyersToday++;
      for (const [id, n] of Object.entries(p.col.coinPacks)) shop[id] = (shop[id] || 0) + n;
    }
    if (p.col.adPackDayStamp) adEver++;
    if (p.col.adPackDayStamp === today) adToday++;
  }
  table($('#shopTable'), {
    columns: [{ key: 'label', label: 'Item' }, { key: 'value', label: 'Count', num: true, fmt }],
    rows: [
      ...Object.entries(shop).map(([id, n]) => ({ label: `${PACKS[id]?.name || id} bought with coins`, value: n })),
      { label: 'Players who bought a coin pack', value: buyersToday },
      { label: 'Free ad packs claimed', value: adToday },
      { label: 'Players who ever bought a coin pack', value: everBought },
      { label: 'Players who ever claimed an ad pack', value: adEver },
    ],
    sortKey: 'none',
  });

  // cosmetics
  const cos = {};
  for (const p of collectors) {
    for (const [slot, id] of Object.entries(p.col.equipped)) {
      if (!id) continue;
      const k = `${slot}|${id}`;
      cos[k] = (cos[k] || 0) + 1;
    }
  }
  table($('#cosmeticTable'), {
    columns: [{ key: 'name', label: 'Cosmetic' }, { key: 'slot', label: 'Slot' }, { key: 'n', label: 'Equipped', num: true, fmt }],
    rows: Object.entries(cos).map(([k, n]) => {
      const [slot, id] = k.split('|');
      return { name: COSMETIC_NAMES[id] || id, slot: slot.replace(/Id$/, ''), n };
    }),
    sortKey: 'n',
    empty: 'Nothing equipped yet',
  });
}

// ---------------------------------------------------------------- render: players

function renderPlayers() {
  const q = $('#playerSearch').value.trim().toLowerCase();
  const days = Number($('#playerActive').value);
  const collectorsOnly = $('#playerCollectorsOnly').checked;
  const now = Date.now();
  const rows = state.players.filter(p =>
    (!q || displayName(p).toLowerCase().includes(q) || p.uid.toLowerCase().includes(q))
    && (!days || now - p.savedAt <= days * DAY)
    && (!collectorsOnly || (p.col && p.col.ownedCount > 0)));
  $('#playerCount').textContent = `${fmt(rows.length)} players`;

  table($('#playerTable'), {
    columns: [
      { key: 'name', label: 'Player', sort: p => displayName(p).toLowerCase(), html: p => `${esc(displayName(p))}${p.nickname ? '' : ' <span class="muted small">(auto)</span>'}` },
      { key: 'uid', label: 'UID', html: p => `<code>${esc(p.uid.slice(0, 10))}…</code>` },
      { key: 'beaten', label: 'Level', num: true, fmt },
      { key: 'totalStars', label: 'Stars', num: true, fmt },
      { key: 'stickers', label: 'Stickers', num: true, sort: p => p.col?.ownedCount ?? -1, html: p => p.col ? `${p.col.ownedCount}/48` : '–' },
      { key: 'sets', label: 'Sets', num: true, sort: p => p.col?.completeSets.length ?? -1, html: p => p.col ? `${p.col.completeSets.length}/8` : '–' },
      { key: 'stardust', label: 'Stardust', num: true, sort: p => p.col?.stardust ?? -1, html: p => p.col ? fmt(p.col.stardust) : '–' },
      { key: 'gems', label: 'Gems', num: true, sort: p => p.col?.gems ?? -1, html: p => p.col ? fmt(p.col.gems) : '–' },
      { key: 'savedAt', label: 'Last save', num: true, fmt: v => relTime(v) },
    ],
    rows,
    sortKey: 'beaten',
    pageSize: 50,
    onRow: openPlayer,
  });
}
['#playerSearch', '#playerActive', '#playerCollectorsOnly'].forEach(s => $(s).addEventListener('input', renderPlayers));

async function openPlayer(p) {
  const el = $('#drawer');
  const c = p.col;
  const sig = state.signatures.get(p.uid) || (p.collectionJson ? '…' : '–');
  const stars = p.stars.slice(0, p.beaten);
  const starCounts = [0, 1, 2, 3].map(n => stars.filter(s => s === n).length);
  el.innerHTML = `<div class="drawer-bg"></div><aside class="drawer">
    <div style="display:flex;align-items:center;gap:10px"><h2>${esc(displayName(p))}</h2><button class="btn close">Close</button></div>
    <div class="muted small"><code>${esc(p.uid)}</code></div>
    <div class="card kv">
      <div><span>Levels beaten</span>${fmt(p.beaten)}</div>
      <div><span>Total stars</span>${fmt(p.totalStars)} <span class="muted small">(${stars.length ? (sum(stars) / stars.length).toFixed(2) : '–'} avg)</span></div>
      <div><span>Last cloud save</span>${p.savedAt ? new Date(p.savedAt).toLocaleString() : '–'}</div>
      <div><span>3★ / 2★ / 1★ levels</span>${starCounts[3]} / ${starCounts[2]} / ${starCounts[1]}</div>
      <div><span>Best level score</span>${fmt(Math.max(0, ...p.scores))}</div>
      <div><span>Last level opened</span>${fmt(p.openLevel)}</div>
    </div>
    <div class="card"><div class="card-head"><h3>Stars per level</h3><span class="hint">last 100 beaten</span></div><div class="chart short"><canvas id="chPlayerStars"></canvas></div></div>
    ${c ? `<div class="card">
      <div class="card-head"><h3>Collection</h3><span class="hint">${c.ownedCount}/48 stickers · signature ${esc(sig)}</span></div>
      <div class="kv" style="margin-bottom:12px">
        <div><span>Stardust</span>${fmt(c.stardust)}</div>
        <div><span>Gems</span>${fmt(c.gems)}</div>
        <div><span>Queued packs</span>${c.unopenedPacks.length ? esc(c.unopenedPacks.join(', ')) : 'none'}</div>
        <div><span>Legendary pity</span>${c.pity}/${PACKS.standard.pity}</div>
        <div><span>Sets claimed</span>${c.claimedSets.length ? esc(c.claimedSets.map(id => SET_BY_ID[id]?.name || id).join(', ')) : 'none'}</div>
        <div><span>Album reward</span>${c.albumClaimed ? 'claimed' : c.albumComplete ? '<span class="pill warn">complete, unclaimed</span>' : 'not complete'}</div>
        <div><span>Equipped</span>${esc(Object.values(c.equipped).filter(Boolean).map(id => COSMETIC_NAMES[id] || id).join(', ') || 'nothing')}</div>
      </div>
      <div class="mini-album">${SETS.map(s => `<div class="set-name small"><b>${esc(s.name)}</b></div>${s.stickers.map(st =>
        `<div class="cell ${c.owned.has(st.id) ? 'own' : ''}" title="${esc(st.name)} · ${RARITY[st.rarity]}${c.owned.get(st.id) ? ` · got ${new Date(c.owned.get(st.id) * 1000).toISOString().slice(0, 10)}` : ''}">
          <span class="n">${esc(st.name)}</span><span class="rar r${st.rarity}">${RARITY[st.rarity]}</span></div>`).join('')}`).join('')}</div>
    </div>` : '<div class="card muted">No collection save.</div>'}
    <details class="card"><summary class="small">Raw save summary</summary><pre class="small" style="white-space:pre-wrap">${esc(p.summary || '(empty)')}</pre></details>
  </aside>`;
  el.classList.remove('hidden');
  const close = () => { charts.chPlayerStars?.destroy(); delete charts.chPlayerStars; el.classList.add('hidden'); el.innerHTML = ''; };
  $('.drawer-bg', el).addEventListener('click', close);
  $('.close', el).addEventListener('click', close);
  document.addEventListener('keydown', function onKey(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } });

  const startLvl = Math.max(0, stars.length - 100);
  chart('chPlayerStars', {
    type: 'bar',
    data: { labels: stars.slice(startLvl).map((_, i) => startLvl + i + 1), datasets: [{ data: stars.slice(startLvl), backgroundColor: solid(css('--r3'), 0.8) }] },
    options: { scales: { y: { min: 0, max: 3, ticks: { stepSize: 1 } }, x: { ticks: { maxTicksLimit: 10 } } } },
  });

  if (p.collectionJson && !state.signatures.has(p.uid)) {
    await checkSignatures();
  }
}

// ---------------------------------------------------------------- render: leaderboards

const BOARDS = [
  { key: 'level_reached', title: 'Level reached' },
  { key: 'total_stars', title: 'Total stars' },
  { key: 'best_score', title: 'Best single-level score' },
];
let boardsLoadedAt = 0;

async function renderLeaderboards() {
  if (Date.now() - boardsLoadedAt < 60000) return;
  boardsLoadedAt = Date.now();
  const wrap = $('#boards');
  wrap.innerHTML = BOARDS.map(b => `<div class="card" id="board-${b.key}"><div class="card-head"><h3>${b.title}</h3><span class="hint"></span></div><div class="loading"><span class="spinner"></span>Loading…</div></div>`).join('');
  await Promise.all(BOARDS.map(async b => {
    const card = $(`#board-${b.key}`);
    try {
      const col = collection(db, 'leaderboards', b.key, 'scores');
      const [snap, count] = await Promise.all([
        getDocs(query(col, orderBy('score', 'desc'), limit(50))),
        getCountFromServer(col).then(r => r.data().count).catch(() => null),
      ]);
      $('.hint', card).textContent = count != null ? `${fmt(count)} entries` : '';
      const holder = document.createElement('div');
      holder.className = 'table-wrap';
      card.querySelector('.loading').replaceWith(holder);
      table(holder, {
        columns: [
          { key: 'rank', label: '#', num: true },
          { key: 'name', label: 'Name' },
          { key: 'score', label: 'Score', num: true, fmt },
          { key: 'ts', label: 'Updated', num: true, fmt: v => relTime(v) },
        ],
        rows: snap.docs.map((d, i) => ({ rank: i + 1, uid: d.id, ...d.data() })),
        sortKey: 'rank',
        sortDir: 'asc',
        onRow: r => { const p = state.byUid.get(r.uid); if (p) openPlayer(p); },
      });
    } catch (e) {
      card.querySelector('.loading').outerHTML = `<div class="error">${esc(e.message)}</div>`;
    }
  }));
}

// ---------------------------------------------------------------- go

try {
  const v = localStorage.getItem('adminView');
  if (v && TITLES[v]) setView(v);
} catch { /* ignore */ }
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.players.length && renderAll());
initMonetization({ getToken: getGoogleToken });
boot();
