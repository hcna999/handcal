'use strict';

const CFG = window.APP_CONFIG || {};
const SCOPES = 'openid email https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = '필기캘린더';
const PAGE_W = 1000;
const PAGE_H = 1414; // A4 비율
const MAX_PAGES = 6;
const COLORS = ['#1f2328', '#2563eb', '#dc2626', '#16a34a', '#ea580c', '#7c3aed', '#facc15'];
const SIZES = { pen: [2, 4, 7], hl: [14, 24, 36], eraser: [12, 28, 56] };
const WD = ['일', '월', '화', '수', '목', '금', '토'];

const $ = (s) => document.querySelector(s);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------- 날짜
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const hm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const localISO = (d) => `${ymd(d)}T${hm(d)}:00`;

// ---------- 저장소
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn(e); } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// 필기는 용량이 커서 IndexedDB에 저장 (사용 불가 시 메모리)
const idb = (() => {
  const mem = new Map();
  let dbp = null;
  function open() {
    if (!dbp) {
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open('handcal', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      }).catch((e) => { console.warn('IndexedDB 사용 불가', e); return null; });
    }
    return dbp;
  }
  async function run(mode, fn, fallback) {
    const db = await open();
    if (!db) return fallback();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode);
      const req = fn(t.objectStore('kv'));
      t.oncomplete = () => res(req.result);
      t.onerror = () => rej(t.error);
    });
  }
  return {
    get: (k) => run('readonly', (s) => s.get(k), () => mem.get(k)),
    set: (k, v) => run('readwrite', (s) => s.put(v, k), () => mem.set(k, v)),
    del: (k) => run('readwrite', (s) => s.delete(k), () => mem.delete(k)),
    keys: () => run('readonly', (s) => s.getAllKeys(), () => [...mem.keys()]),
  };
})();

// ---------- 구글 로그인
// WORKER_URL이 있으면 서버를 통해 로그인을 계속 유지하고, 없으면 1시간짜리 토큰만 사용
const auth = {
  token: null,
  expires: 0,
  refreshing: null,
  init() {
    const saved = store.get('auth', null);
    if (saved && saved.expires > Date.now()) { this.token = saved.token; this.expires = saved.expires; }
  },
  signedIn() { return !!this.token && this.expires > Date.now(); },
  canRefresh() { return !!CFG.WORKER_URL && !!store.get('refresh', null); },
  connected() { return this.signedIn() || this.canRefresh(); },
  wasSignedIn() { return !!CFG.GOOGLE_CLIENT_ID && store.get('wasSignedIn', false); },
  setToken(t) {
    this.token = t.access_token;
    this.expires = Date.now() + (Number(t.expires_in) - 60) * 1000;
    store.set('auth', { token: this.token, expires: this.expires });
    store.set('wasSignedIn', true);
  },
  request(prompt) {
    return new Promise((resolve, reject) => {
      if (!CFG.GOOGLE_CLIENT_ID) return reject(new Error('NO_CLIENT_ID'));
      if (!window.google?.accounts?.oauth2) return reject(new Error('GIS_NOT_LOADED'));
      const error_callback = (e) => reject(new Error(e.type || 'popup_error'));
      if (CFG.WORKER_URL) {
        google.accounts.oauth2.initCodeClient({
          client_id: CFG.GOOGLE_CLIENT_ID,
          scope: SCOPES,
          ux_mode: 'popup',
          callback: async (r) => {
            if (r.error) return reject(new Error(r.error));
            try {
              const t = await worker('/auth/exchange', { method: 'POST', body: JSON.stringify({ code: r.code }) });
              this.setToken(t);
              if (t.refresh_token) store.set('refresh', t.refresh_token);
              resolve();
            } catch (e) { reject(e); }
          },
          error_callback,
        }).requestCode();
        return;
      }
      google.accounts.oauth2.initTokenClient({
        client_id: CFG.GOOGLE_CLIENT_ID,
        scope: SCOPES,
        callback: (r) => {
          if (r.error) return reject(new Error(r.error));
          this.setToken(r);
          resolve();
        },
        error_callback,
      }).requestAccessToken({ prompt });
    });
  },
  // 토큰이 만료됐으면 서버를 통해 조용히 새로 받음
  async ensure() {
    if (this.signedIn()) return true;
    if (!this.canRefresh()) return false;
    if (!this.refreshing) {
      this.refreshing = worker('/auth/refresh', { method: 'POST', body: JSON.stringify({ refresh_token: store.get('refresh') }) })
        .then((t) => { this.setToken(t); return true; })
        .catch((e) => {
          if (e.status === 401) store.del('refresh');
          else if (!navigator.onLine || !e.status) throw e;
          return false;
        })
        .finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  },
  expire() { this.token = null; store.del('auth'); },
  signOut() {
    if (this.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(this.token, () => {});
    this.expire();
    store.del('refresh');
    store.set('wasSignedIn', false);
  },
};

async function worker(path, opts = {}) {
  const res = await fetch(CFG.WORKER_URL.replace(/\/$/, '') + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || 'HTTP ' + res.status);
    err.status = res.status;
    err.code = data.error;
    throw err;
  }
  return data;
}

// 구글 토큰을 붙여 요청. 401이면 한 번 갱신 후 재시도
async function authFetch(url, opts = {}, retry = true) {
  if (!(await auth.ensure())) { updateAuthUI(); throw new Error('AUTH'); }
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + auth.token } });
  if (res.status === 401) {
    auth.expire();
    if (retry && auth.canRefresh()) return authFetch(url, opts, false);
    updateAuthUI();
    throw new Error('AUTH');
  }
  return res;
}

async function gapi(url, opts = {}) {
  const res = await authFetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  if (res.status === 204) return null;
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

// ---------- 구글 드라이브 (필기 저장)
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const drive = {
  folderId: null,
  async ensureFolder() {
    if (this.folderId) return this.folderId;
    const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const r = await gapi(`${DRIVE}?q=${q}&fields=files(id)&spaces=drive`);
    if (r.files.length) return (this.folderId = r.files[0].id);
    const c = await gapi(`${DRIVE}?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });
    return (this.folderId = c.id);
  },
  async list() {
    const fid = await this.ensureFolder();
    const out = new Map();
    let pageToken = '';
    do {
      const q = encodeURIComponent(`'${fid}' in parents and trashed=false`);
      const r = await gapi(`${DRIVE}?q=${q}&fields=nextPageToken,files(id,name,modifiedTime)&pageSize=1000${pageToken ? '&pageToken=' + pageToken : ''}`);
      for (const f of r.files) out.set(f.name, f);
      pageToken = r.nextPageToken || '';
    } while (pageToken);
    return out;
  },
  read(id) { return gapi(`${DRIVE}/${id}?alt=media`); },
  async create(name, data) {
    const fid = await this.ensureFolder();
    const b = 'hc' + Math.random().toString(36).slice(2);
    const body =
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name, parents: [fid], mimeType: 'application/json' }) +
      `\r\n--${b}\r\nContent-Type: application/json\r\n\r\n` +
      JSON.stringify(data) +
      `\r\n--${b}--`;
    return gapi(`${UPLOAD}?uploadType=multipart&fields=id,name,modifiedTime`, {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body,
    });
  },
  update(id, data) {
    return gapi(`${UPLOAD}/${id}?uploadType=media&fields=id,name,modifiedTime`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
  },
  remove(id) { return gapi(`${DRIVE}/${id}`, { method: 'DELETE' }); },
};

// ---------- 필기 노트 (기기 저장 + 드라이브 동기화)
const blankNote = () => ({ v: 1, height: PAGE_H, strokes: [], updated: 0 });
const normalize = (n) => ({
  v: 1,
  height: Math.max(PAGE_H, Number(n?.height) || PAGE_H),
  strokes: Array.isArray(n?.strokes) ? n.strokes : [],
  updated: n?.updated || 0,
  remoteTime: n?.remoteTime,
});

const notes = {
  localDays: new Set(),
  remote: new Map(), // 날짜 -> 드라이브 파일 {id, modifiedTime}
  pending: new Set(store.get('pending', [])), // 아직 드라이브에 반영 안 된 날짜
  lastSync: 0,
  flushing: false,
  again: false,

  savePending() { store.set('pending', [...this.pending]); },
  has(d) { return this.localDays.has(d) || (this.remote.has(d) && !this.pending.has(d)); },

  async loadLocal() {
    try {
      for (const k of await idb.keys()) {
        const s = String(k);
        if (s.startsWith('note:')) this.localDays.add(s.slice(5));
      }
    } catch (e) { console.warn(e); }
  },

  async syncIndex() {
    const files = await drive.list();
    this.remote.clear();
    for (const [name, f] of files) {
      const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
      if (m) this.remote.set(m[1], f);
    }
    for (const d of [...this.localDays]) {
      if (this.remote.has(d) || this.pending.has(d)) continue;
      const local = await idb.get('note:' + d);
      if (local?.remoteTime) { await idb.del('note:' + d); this.localDays.delete(d); } // 다른 기기에서 지움
      else this.pending.add(d); // 로그인 전에 쓴 필기 → 업로드
    }
    this.savePending();
    this.lastSync = Date.now();
  },

  async refreshIndex(maxAgeMs) {
    if (!auth.connected() || Date.now() - this.lastSync < maxAgeMs) return false;
    await this.syncIndex();
    return true;
  },

  async get(d) {
    const local = await idb.get('note:' + d).catch(() => null);
    const r = this.remote.get(d);
    if (auth.connected() && r && !this.pending.has(d) && (!local || local.remoteTime !== r.modifiedTime)) {
      try {
        const data = await drive.read(r.id);
        const note = normalize(typeof data === 'string' ? JSON.parse(data) : data);
        note.remoteTime = r.modifiedTime;
        await idb.set('note:' + d, note);
        this.localDays.add(d);
        return note;
      } catch (e) {
        if (!local) throw e;
        console.warn(e);
      }
    }
    return local ? normalize(local) : blankNote();
  },

  async put(d, note) {
    note.updated = Date.now();
    if (note.strokes.length) { await idb.set('note:' + d, note); this.localDays.add(d); }
    else { await idb.del('note:' + d); this.localDays.delete(d); }
    this.pending.add(d);
    this.savePending();
    scheduleFlush();
  },

  async flush() {
    if (!auth.connected()) { setStatus(); return; }
    if (!navigator.onLine) { setStatus('offline'); return; }
    if (this.flushing) { this.again = true; return; }
    this.flushing = true;
    if (this.pending.size) setStatus('saving');
    try {
      for (const d of [...this.pending]) {
        const local = await idb.get('note:' + d);
        const r = this.remote.get(d);
        if (local?.strokes?.length) {
          const payload = { v: 1, date: d, height: local.height, strokes: local.strokes, updated: local.updated };
          const f = r ? await drive.update(r.id, payload) : await drive.create(d + '.json', payload);
          this.remote.set(d, f);
          const cur = await idb.get('note:' + d);
          if (cur && cur.updated === local.updated) {
            cur.remoteTime = f.modifiedTime;
            await idb.set('note:' + d, cur);
            this.pending.delete(d);
          }
        } else {
          if (r) {
            await drive.remove(r.id).catch((e) => { if (!/HTTP 404/.test(e.message)) throw e; });
            this.remote.delete(d);
          }
          if (!this.localDays.has(d)) this.pending.delete(d);
        }
        this.savePending();
      }
      setStatus();
    } catch (e) {
      setStatus('error');
      handleErr(e);
    } finally {
      this.flushing = false;
      if (this.again) { this.again = false; this.flush(); }
    }
  },
};

let flushTimer = null;
function scheduleFlush() {
  clearTimeout(flushTimer);
  if (auth.connected()) setStatus('saving');
  flushTimer = setTimeout(() => notes.flush(), 1500);
}

// ---------- 일정
// 메모 일정: 앱에서 직접 적는 일정. 드라이브의 events.json으로 기기 간 동기화
const memos = {
  fileId: null,
  syncing: null,
  all() { return store.get('localEvents', []); },
  save(list) { store.set('localEvents', list); },
  visible(s, e) {
    return this.all()
      .filter((x) => !x.deleted)
      .map((x) => ({ ...x, start: new Date(x.start), end: new Date(x.end), color: '#2563eb', editable: true, source: 'memo' }))
      .filter((x) => x.start < e && x.end > s);
  },
  add(ev) {
    const list = this.all();
    list.push({ id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: ev.title, allDay: ev.allDay, start: ev.start.toISOString(), end: ev.end.toISOString(), updated: Date.now() });
    this.save(list);
    this.sync().catch(handleErr);
  },
  remove(id) {
    this.save(this.all().map((x) => (x.id === id ? { id, deleted: true, updated: Date.now() } : x)));
    this.sync().catch(handleErr);
  },
  sync() {
    if (!auth.connected()) return Promise.resolve();
    if (!this.syncing) this.syncing = this._sync().finally(() => { this.syncing = null; });
    return this.syncing;
  },
  async _sync() {
    if (!this.fileId) {
      const fid = await drive.ensureFolder();
      const q = encodeURIComponent(`'${fid}' in parents and name='events.json' and trashed=false`);
      const r = await gapi(`${DRIVE}?q=${q}&fields=files(id)`);
      this.fileId = r.files[0]?.id || null;
    }
    let remote = [];
    if (this.fileId) {
      const d = await drive.read(this.fileId);
      const data = typeof d === 'string' ? JSON.parse(d) : d;
      remote = Array.isArray(data?.events) ? data.events : [];
    }
    const byId = new Map();
    for (const x of [...remote, ...this.all()]) {
      const cur = byId.get(x.id);
      if (!cur || (x.updated || 0) > (cur.updated || 0)) byId.set(x.id, x);
    }
    const cutoff = Date.now() - 90 * 86400e3;
    const merged = [...byId.values()].filter((x) => !x.deleted || x.updated > cutoff).sort((a, b) => (a.id < b.id ? -1 : 1));
    const before = JSON.stringify(this.all());
    this.save(merged);
    const sortedRemote = [...remote].sort((a, b) => (a.id < b.id ? -1 : 1));
    if (JSON.stringify(sortedRemote) !== JSON.stringify(merged)) {
      const payload = { v: 1, events: merged };
      if (this.fileId) await drive.update(this.fileId, payload);
      else this.fileId = (await drive.create('events.json', payload)).id;
    }
    return before !== JSON.stringify(merged);
  },
};

// 네이버 캘린더 (읽기 전용, 중계 서버 경유)
const naver = {
  enabled() { return !!CFG.WORKER_URL && auth.connected(); },
  warned: false,
  async load(s, e) {
    const res = await authFetch(`${CFG.WORKER_URL.replace(/\/$/, '')}/naver/events?start=${encodeURIComponent(s.toISOString())}&end=${encodeURIComponent(e.toISOString())}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || 'HTTP ' + res.status);
      err.code = data.error;
      throw err;
    }
    return (data.events || []).map((x) => ({
      id: x.id,
      title: x.title,
      allDay: x.allDay,
      start: x.allDay ? parseYmd(x.start) : new Date(x.start),
      end: x.allDay ? parseYmd(x.end) : new Date(x.end),
      color: x.color || '#03c75a',
      calendar: x.calendar,
      editable: false,
      source: 'naver',
    }));
  },
};

const events = {
  cache: new Map(),
  key: (s, e) => ymd(s) + '_' + ymd(e),
  cached(s, e) { return this.cache.get(this.key(s, e)) || null; },
  clear() { this.cache.clear(); },
  reset() { this.cache.clear(); },

  async load(s, e) {
    let list = memos.visible(s, e);
    if (naver.enabled()) {
      try {
        list = list.concat(await naver.load(s, e));
        naver.warned = false;
      } catch (err) {
        if (err.message === 'AUTH') throw err;
        if (!naver.warned) { naver.warned = true; toast('네이버 캘린더를 불러오지 못했어요: ' + err.message.slice(0, 100), 5000); }
        console.warn(err);
        list.sort(sortEvents);
        return list; // 실패 결과는 캐시하지 않음
      }
    }
    list.sort(sortEvents);
    this.cache.set(this.key(s, e), list);
    return list;
  },

  on(list, day) {
    const s = day, e = addDays(day, 1);
    return list.filter((ev) => ev.start < e && (ev.end > s || (+ev.start === +ev.end && ev.start >= s)));
  },

  add(ev) { memos.add(ev); this.clear(); },
  remove(ev) { memos.remove(ev.id); this.clear(); },
};

function sortEvents(a, b) {
  return (b.allDay - a.allDay) || (a.start - b.start) || a.title.localeCompare(b.title);
}

// ---------- 화면 상태
const state = {
  view: 'month',
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  date: null,
};
let monthToken = 0;
let dayToken = 0;

// ---------- 월간 달력
function inkIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ink');
  svg.setAttribute('aria-label', '필기 있음');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M4 20h4L19 9l-4-4L4 16v4zm13.5-16.5 3 3');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '2');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

function monthRange() {
  const first = state.month;
  const start = addDays(first, -first.getDay());
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const weeks = Math.ceil((first.getDay() + days) / 7);
  return { start, end: addDays(start, weeks * 7), weeks };
}

async function renderMonth() {
  const y = state.month.getFullYear(), m = state.month.getMonth();
  $('#month-title').textContent = `${y}년 ${m + 1}월`;
  const { start, end, weeks } = monthRange();
  const grid = $('#grid');
  grid.style.setProperty('--rows', weeks);
  const cellH = (grid.clientHeight || 600) / weeks;
  const maxChips = Math.max(1, Math.floor((cellH - 34) / 17));
  const evs = events.cached(start, end);
  const today = ymd(new Date());
  const frag = document.createDocumentFragment();

  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(start, i), ds = ymd(d), wd = d.getDay();
    const cell = el('div', 'cell');
    if (d.getMonth() !== m) cell.classList.add('other');
    if (ds === today) cell.classList.add('today');
    cell.dataset.date = ds;
    const head = el('div', 'cell-head');
    head.append(el('span', 'num' + (wd === 0 ? ' sun' : wd === 6 ? ' sat' : ''), String(d.getDate())));
    if (notes.has(ds)) head.append(inkIcon());
    cell.append(head);
    if (evs) {
      const list = events.on(evs, d);
      const shown = list.length > maxChips ? maxChips - 1 : list.length;
      for (const ev of list.slice(0, shown)) {
        const chip = el('div', 'chip', ev.title);
        chip.style.setProperty('--c', ev.color);
        cell.append(chip);
      }
      if (list.length > shown) cell.append(el('div', 'more', `+${list.length - shown}개`));
    }
    frag.append(cell);
  }
  grid.replaceChildren(frag);

  if (!evs) {
    const token = ++monthToken;
    try {
      await events.load(start, end);
      if (token === monthToken && state.view === 'month') renderMonth();
    } catch (e) { handleErr(e); }
  }
}

function shiftMonth(n) {
  state.month = new Date(state.month.getFullYear(), state.month.getMonth() + n, 1);
  renderMonth();
}

// ---------- 하루 화면 (필기)
const pad = {
  canvas: null, ctx: null, overlay: null, octx: null,
  scale: 1, dpr: 1,
  note: blankNote(), loading: false,
  undo: [], redo: [],
  tool: 'pen',
  colors: store.get('colors', { pen: COLORS[0], hl: '#facc15' }),
  sizeIdx: store.get('sizeIdx', 1),
  fingerDraw: store.get('fingerDraw', true),
  penSeen: store.get('penSeen', false),
  active: null,
  scroll: null,
  rafPending: false,
  hover: null,
};

function layoutPad() {
  const wrap = $('#page-scroll');
  if (!wrap.clientWidth) return;
  const cssW = Math.max(280, Math.min(wrap.clientWidth - 24, 1100));
  pad.scale = cssW / PAGE_W;
  const cssH = Math.round(pad.note.height * pad.scale);
  pad.dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt(12e6 / (cssW * cssH)));
  for (const c of [pad.canvas, pad.overlay]) {
    c.style.width = cssW + 'px';
    c.style.height = cssH + 'px';
    c.width = Math.round(cssW * pad.dpr);
    c.height = Math.round(cssH * pad.dpr);
  }
  redraw();
  $('#add-page').disabled = pad.note.height >= PAGE_H * MAX_PAGES;
}

function setTransform(ctx) {
  const k = pad.scale * pad.dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(k, 0, 0, k, 0, 0);
}

function drawPaper(ctx) {
  ctx.save();
  ctx.strokeStyle = '#eef0f3';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let y = 70; y < pad.note.height; y += 50) { ctx.moveTo(40, y); ctx.lineTo(PAGE_W - 40, y); }
  ctx.stroke();
  ctx.strokeStyle = '#cfd4db';
  ctx.setLineDash([10, 10]);
  ctx.beginPath();
  for (let y = PAGE_H; y < pad.note.height; y += PAGE_H) { ctx.moveTo(0, y); ctx.lineTo(PAGE_W, y); }
  ctx.stroke();
  ctx.restore();
}

function drawStroke(ctx, s) {
  const p = s.points;
  if (!p.length) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = ctx.fillStyle = s.color;
  if (s.tool === 'hl') {
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = s.size;
    ctx.beginPath();
    ctx.moveTo(p[0][0], p[0][1]);
    if (p.length === 1) ctx.lineTo(p[0][0] + 0.1, p[0][1]);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
    ctx.stroke();
  } else {
    const w = (pr) => s.size * (0.4 + 0.9 * pr);
    if (p.length === 1) {
      ctx.beginPath();
      ctx.arc(p[0][0], p[0][1], w(p[0][2]) / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      let prev = p[0];
      for (let i = 1; i < p.length - 1; i++) {
        const mid = [(p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2];
        ctx.lineWidth = w(p[i][2]);
        ctx.beginPath();
        ctx.moveTo(prev[0], prev[1]);
        ctx.quadraticCurveTo(p[i][0], p[i][1], mid[0], mid[1]);
        ctx.stroke();
        prev = mid;
      }
      const last = p[p.length - 1];
      ctx.lineWidth = w(last[2]);
      ctx.beginPath();
      ctx.moveTo(prev[0], prev[1]);
      ctx.lineTo(last[0], last[1]);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function redraw() {
  setTransform(pad.ctx);
  drawPaper(pad.ctx);
  for (const s of pad.note.strokes) drawStroke(pad.ctx, s);
  renderOverlay();
}

function renderOverlay() {
  pad.rafPending = false;
  setTransform(pad.octx);
  if (pad.active?.stroke) drawStroke(pad.octx, pad.active.stroke);
  const h = pad.hover;
  if (h && (pad.tool === 'eraser' || pad.active?.erase)) {
    pad.octx.beginPath();
    pad.octx.arc(h[0], h[1], SIZES.eraser[pad.sizeIdx] / 2, 0, Math.PI * 2);
    pad.octx.strokeStyle = '#6b7280';
    pad.octx.lineWidth = 1.5 / pad.scale;
    pad.octx.stroke();
  }
}

function requestOverlay() {
  if (pad.rafPending) return;
  pad.rafPending = true;
  requestAnimationFrame(renderOverlay);
}

function toPage(e) {
  const r = pad.canvas.getBoundingClientRect();
  return [(e.clientX - r.left) / pad.scale, (e.clientY - r.top) / pad.scale];
}

function makePoint(e) {
  const [x, y] = toPage(e);
  const pr = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(pr * 100) / 100];
}

function distToSeg(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  let t = len ? ((px - a[0]) * dx + (py - a[1]) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

function eraseAt(x, y) {
  const r = SIZES.eraser[pad.sizeIdx] / 2;
  const kept = pad.note.strokes.filter((s) => {
    const reach = r + s.size / 2;
    const p = s.points;
    if (p.length === 1) return Math.hypot(x - p[0][0], y - p[0][1]) > reach;
    for (let i = 1; i < p.length; i++) if (distToSeg(x, y, p[i - 1], p[i]) <= reach) return false;
    return true;
  });
  if (kept.length !== pad.note.strokes.length) {
    pad.note.strokes = kept;
    pad.active.changed = true;
    redraw();
  }
}

function snapshot() { return { strokes: pad.note.strokes.slice(), height: pad.note.height }; }
function pushUndo(snap = snapshot()) {
  pad.undo.push(snap);
  if (pad.undo.length > 200) pad.undo.shift();
  pad.redo = [];
  updateUndoUI();
}
function restore(from, to) {
  const snap = from.pop();
  if (!snap) return;
  to.push(snapshot());
  const resize = snap.height !== pad.note.height;
  pad.note.strokes = snap.strokes;
  pad.note.height = snap.height;
  resize ? layoutPad() : redraw();
  updateUndoUI();
  saveSoon();
}
function updateUndoUI() {
  $('#undo').disabled = !pad.undo.length;
  $('#redo').disabled = !pad.redo.length;
}

function onPointerDown(e) {
  if (e.pointerType === 'pen' && !pad.penSeen) {
    pad.penSeen = true;
    store.set('penSeen', true);
    if (pad.fingerDraw) { setFingerDraw(false); toast('펜이 감지돼서 손가락은 화면 이동용으로 바꿨어요'); }
  }
  if (e.pointerType === 'touch' && !pad.fingerDraw) {
    if (!pad.scroll) {
      pad.scroll = { id: e.pointerId, x: e.clientX, y: e.clientY };
      pad.canvas.setPointerCapture(e.pointerId);
    }
    return;
  }
  const eraserButton = e.button === 5 || (e.buttons & 32);
  if (pad.active || pad.loading || (e.button > 0 && !eraserButton)) return;
  e.preventDefault();
  pad.canvas.setPointerCapture(e.pointerId);
  const pt = makePoint(e);
  pad.hover = pt;
  if (pad.tool === 'eraser' || eraserButton) {
    pad.active = { id: e.pointerId, erase: true, before: snapshot(), changed: false };
    eraseAt(pt[0], pt[1]);
    requestOverlay();
  } else {
    const tool = pad.tool;
    pad.active = { id: e.pointerId, stroke: { tool, color: pad.colors[tool], size: SIZES[tool][pad.sizeIdx], points: [pt] } };
    requestOverlay();
  }
}

function onPointerMove(e) {
  if (pad.scroll && e.pointerId === pad.scroll.id) {
    const sc = $('#page-scroll');
    sc.scrollTop -= e.clientY - pad.scroll.y;
    sc.scrollLeft -= e.clientX - pad.scroll.x;
    pad.scroll.x = e.clientX;
    pad.scroll.y = e.clientY;
    return;
  }
  if (!pad.active || e.pointerId !== pad.active.id) {
    if (pad.tool === 'eraser' && e.pointerType !== 'touch') { pad.hover = makePoint(e); requestOverlay(); }
    return;
  }
  const list = e.getCoalescedEvents?.() || [];
  for (const ev of list.length ? list : [e]) {
    const pt = makePoint(ev);
    if (pad.active.erase) eraseAt(pt[0], pt[1]);
    else {
      const pts = pad.active.stroke.points, last = pts[pts.length - 1];
      if (Math.abs(pt[0] - last[0]) + Math.abs(pt[1] - last[1]) >= 0.8) pts.push(pt);
      else last[2] = pt[2];
    }
    pad.hover = pt;
  }
  requestOverlay();
}

function onPointerUp(e) {
  if (pad.scroll && e.pointerId === pad.scroll.id) { pad.scroll = null; return; }
  if (!pad.active || e.pointerId !== pad.active.id) return;
  const a = pad.active;
  pad.active = null;
  if (a.erase) {
    if (a.changed) { pushUndo(a.before); saveSoon(); }
  } else {
    pushUndo();
    pad.note.strokes.push(a.stroke);
    drawStroke(pad.ctx, a.stroke);
    saveSoon();
  }
  if (e.pointerType === 'touch') pad.hover = null;
  requestOverlay();
}

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}
async function saveNow() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!state.date) return;
  try { await notes.put(state.date, { ...pad.note, strokes: pad.note.strokes.slice() }); }
  catch (e) { handleErr(e); }
  if (!auth.connected()) setStatus();
}

function setFingerDraw(v) {
  pad.fingerDraw = v;
  store.set('fingerDraw', v);
  $('#finger-mode').textContent = v ? '손가락: 필기' : '손가락: 화면 이동';
}

function buildToolbar() {
  const colors = $('#colors');
  for (const c of COLORS) {
    const b = el('button', 'swatch');
    b.style.background = c;
    b.dataset.color = c;
    b.setAttribute('aria-label', '색상 ' + c);
    colors.append(b);
  }
  const sizes = $('#sizes');
  [4, 8, 13].forEach((px, i) => {
    const b = el('button', 'size');
    b.dataset.size = i;
    b.setAttribute('aria-label', ['가늘게', '보통', '굵게'][i]);
    const dot = el('span');
    dot.style.width = dot.style.height = px + 'px';
    b.append(dot);
    sizes.append(b);
  });
  syncToolbar();
}

function syncToolbar() {
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === pad.tool));
  const color = pad.colors[pad.tool];
  document.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('active', b.dataset.color === color));
  $('#colors').classList.toggle('disabled', pad.tool === 'eraser');
  document.querySelectorAll('.size').forEach((b) => b.classList.toggle('active', Number(b.dataset.size) === pad.sizeIdx));
  if (pad.tool !== 'eraser') pad.hover = null;
  if (pad.ctx) requestOverlay();
}

function dayTitle(d) {
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${sameYear ? '' : d.getFullYear() + '년 '}${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})`;
}

async function openDay(ds, { push = true } = {}) {
  await saveNow();
  const fromMonth = state.view !== 'day';
  state.view = 'day';
  state.date = ds;
  if (push) history[fromMonth ? 'pushState' : 'replaceState']({ day: ds }, '', '#' + ds);
  $('#month-view').classList.add('hidden');
  $('#month-nav').classList.add('hidden');
  $('#day-view').classList.remove('hidden');
  $('#day-nav').classList.remove('hidden');
  const d = parseYmd(ds);
  $('#day-title').textContent = dayTitle(d);
  $('#ev-title').value = '';

  pad.note = blankNote();
  pad.undo = [];
  pad.redo = [];
  pad.active = null;
  pad.loading = true;
  updateUndoUI();
  $('#page-scroll').scrollTop = 0;
  layoutPad();
  renderDayEvents();

  const token = ++dayToken;
  const timer = setTimeout(() => token === dayToken && $('#loading').classList.remove('hidden'), 250);
  try {
    await notes.refreshIndex(60000).catch((e) => { if (e.message === 'AUTH') throw e; console.warn(e); });
    const note = await notes.get(ds);
    if (token !== dayToken) return;
    pad.note = note;
    layoutPad();
  } catch (e) {
    handleErr(e);
  } finally {
    clearTimeout(timer);
    if (token === dayToken) { pad.loading = false; $('#loading').classList.add('hidden'); }
  }
}

async function closeDay() {
  await saveNow();
  dayToken++;
  const d = parseYmd(state.date);
  state.view = 'month';
  state.month = new Date(d.getFullYear(), d.getMonth(), 1);
  state.date = null;
  $('#day-view').classList.add('hidden');
  $('#day-nav').classList.add('hidden');
  $('#month-view').classList.remove('hidden');
  $('#month-nav').classList.remove('hidden');
  renderMonth();
  refreshInBackground();
}

function shiftDay(n) {
  openDay(ymd(addDays(parseYmd(state.date), n)));
}

async function renderDayEvents() {
  const ds = state.date;
  const day = parseYmd(ds);
  const list = $('#event-list');
  const draw = (all) => {
    if (state.date !== ds) return;
    const evs = events.on(all, day);
    $('#events-summary').textContent = evs.length ? `일정 ${evs.length}개` : '일정';
    if (!evs.length) { list.replaceChildren(el('li', 'muted', '일정이 없어요')); return; }
    list.replaceChildren(...evs.map((ev) => {
      const li = el('li');
      const dot = el('span', 'dot');
      dot.style.setProperty('--c', ev.color);
      let time = '종일';
      if (!ev.allDay) {
        const sameDay = ymd(ev.start) === ds && ymd(ev.end) === ds;
        time = sameDay ? `${hm(ev.start)}–${hm(ev.end)}` : ymd(ev.start) === ds ? `${hm(ev.start)}~` : '~' + (ymd(ev.end) === ds ? hm(ev.end) : '');
      }
      li.append(dot, el('span', 'ev-time', time), el('span', 'ev-title', ev.title));
      li.title = ev.calendar ? `${ev.title} · 네이버 ${ev.calendar}` : ev.title;
      if (ev.editable) {
        const del = el('button', 'ev-del', '✕');
        del.setAttribute('aria-label', '일정 삭제');
        del.onclick = async () => {
          if (!confirm(`'${ev.title}' 일정을 삭제할까요?`)) return;
          try { await events.remove(ev); renderDayEvents(); } catch (e) { handleErr(e); }
        };
        li.append(del);
      }
      return li;
    }));
  };
  const s = day, e = addDays(day, 1);
  const cached = events.cached(s, e);
  if (cached) return draw(cached);
  list.replaceChildren(el('li', 'muted', '불러오는 중…'));
  try { draw(await events.load(s, e)); }
  catch (err) {
    handleErr(err);
    if (state.date === ds) list.replaceChildren(el('li', 'muted', '일정을 불러오지 못했어요'));
  }
}

async function onAddEvent(ev) {
  ev.preventDefault();
  const title = $('#ev-title').value.trim();
  if (!title || !state.date) return;
  const allDay = $('#ev-allday').checked;
  const day = parseYmd(state.date);
  let start = day, end = addDays(day, 1);
  if (!allDay) {
    start = new Date(`${state.date}T${$('#ev-start').value || '09:00'}`);
    end = new Date(`${state.date}T${$('#ev-end').value || '10:00'}`);
    if (end <= start) end = new Date(+start + 3600e3);
  }
  const btn = ev.submitter || $('#event-form button[type=submit]');
  btn.disabled = true;
  try {
    await events.add({ title, allDay, start, end });
    $('#ev-title').value = '';
    renderDayEvents();
  } catch (e) { handleErr(e); }
  finally { btn.disabled = false; }
}

// ---------- 동기화 상태 / 알림
function setStatus(kind) {
  const s = $('#sync-status');
  if (!kind) {
    if (!auth.connected()) kind = auth.wasSignedIn() ? 'expired' : 'local';
    else kind = notes.pending.size ? 'saving' : 'synced';
  }
  s.textContent = {
    local: '이 기기에만 저장',
    expired: '연결 만료 · 기기에 저장 중',
    saving: '저장 중…',
    synced: '드라이브에 저장됨',
    offline: '오프라인 · 나중에 동기화',
    error: '동기화 실패',
  }[kind] || '';
}

let toastTimer = null;
function toast(msg, ms = 3000) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

function handleErr(e) {
  const msg = e?.message || String(e);
  if (msg === 'AUTH') {
    updateAuthUI();
    toast('구글 연결이 만료됐어요. 화면을 아무 곳이나 누르면 다시 연결돼요.', 4000);
  } else if (msg === 'NO_CLIENT_ID') {
    toast('config.js에 구글 클라이언트 ID를 넣어야 동기화돼요. (README 참고)', 5000);
  } else if (msg === 'GIS_NOT_LOADED') {
    toast('구글 로그인 모듈을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.', 4000);
  } else if (e?.code === 'not_owner') {
    toast('허용되지 않은 구글 계정이에요. 앱 주인 계정으로 로그인해 주세요.', 5000);
  } else if (/popup_closed|access_denied/.test(msg)) {
    toast('로그인이 취소됐어요');
  } else if (/popup_failed/.test(msg)) {
    toast('팝업이 차단됐어요. 팝업을 허용해 주세요.', 4000);
  } else {
    console.error(e);
    toast(navigator.onLine ? '오류: ' + msg.slice(0, 120) : '오프라인이에요. 연결되면 다시 동기화해요.', 4000);
  }
}

// ---------- 로그인 UI
function updateAuthUI() {
  const b = $('#auth-btn');
  if (!CFG.GOOGLE_CLIENT_ID) { b.textContent = '구글 연결 설정'; b.className = 'pill'; }
  else if (auth.connected()) { b.textContent = '로그아웃'; b.className = 'pill'; }
  else if (auth.wasSignedIn()) { b.textContent = '다시 연결'; b.className = 'pill primary'; }
  else { b.textContent = '구글 로그인'; b.className = 'pill primary'; }
  setStatus();
}

let expiryTimer = null;
function watchExpiry() {
  clearTimeout(expiryTimer);
  if (auth.signedIn() && !auth.canRefresh()) expiryTimer = setTimeout(() => { auth.expire(); updateAuthUI(); }, auth.expires - Date.now());
}

async function connect(prompt) {
  await auth.request(prompt);
  watchExpiry();
  await afterSignIn();
}

async function onAuthClick() {
  if (!CFG.GOOGLE_CLIENT_ID) return handleErr(new Error('NO_CLIENT_ID'));
  if (auth.connected()) {
    if (!confirm('로그아웃할까요? 이 기기에 저장된 필기는 그대로 남아요.')) return;
    auth.signOut();
    events.reset();
    updateAuthUI();
    rerender();
    return;
  }
  try { await connect(auth.wasSignedIn() ? '' : 'consent'); } catch (e) { handleErr(e); }
}

async function afterSignIn() {
  updateAuthUI();
  try {
    await notes.syncIndex();
    await memos.sync();
    events.reset();
    rerender();
    await notes.flush();
  } catch (e) { handleErr(e); }
}

function rerender() {
  if (state.view === 'month') renderMonth();
  else renderDayEvents();
}

let lastRefresh = 0;
async function refreshInBackground() {
  if (!auth.connected() || Date.now() - lastRefresh < 20000) return;
  lastRefresh = Date.now();
  try {
    await notes.refreshIndex(20000);
    await memos.sync();
    events.clear();
    rerender();
    if (notes.pending.size) notes.flush();
  } catch (e) { handleErr(e); }
}

// ---------- 시작
function bind() {
  $('#prev-month').onclick = () => shiftMonth(-1);
  $('#next-month').onclick = () => shiftMonth(1);
  $('#today-btn').onclick = () => {
    const t = new Date();
    state.month = new Date(t.getFullYear(), t.getMonth(), 1);
    renderMonth();
  };
  $('#back-btn').onclick = () => history.state?.day ? history.back() : closeDay();
  $('#prev-day').onclick = () => shiftDay(-1);
  $('#next-day').onclick = () => shiftDay(1);
  $('#auth-btn').onclick = onAuthClick;

  // 1시간 로그인 만료 후 다음 탭에서 자동으로 다시 연결 (팝업이 잠깐 떴다 닫힘)
  let reconnecting = false;
  document.addEventListener('click', (e) => {
    if (reconnecting || auth.connected() || !auth.wasSignedIn()) return;
    if (e.target.closest('#auth-btn, canvas')) return;
    reconnecting = true;
    connect('').catch(handleErr).finally(() => { reconnecting = false; });
  }, true);

  // 달력: 날짜 탭 → 하루 화면, 좌우 스와이프 → 달 이동
  const grid = $('#grid');
  let swipe = null, swiped = false;
  grid.addEventListener('pointerdown', (e) => { swipe = { x: e.clientX, y: e.clientY }; swiped = false; });
  grid.addEventListener('pointerup', (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) { swiped = true; shiftMonth(dx < 0 ? 1 : -1); }
  });
  grid.addEventListener('click', (e) => {
    if (swiped) { swiped = false; return; }
    const cell = e.target.closest('.cell');
    if (cell) openDay(cell.dataset.date);
  });

  // 필기
  pad.canvas = $('#canvas');
  pad.overlay = $('#overlay');
  pad.ctx = pad.canvas.getContext('2d');
  pad.octx = pad.overlay.getContext('2d');
  pad.canvas.addEventListener('pointerdown', onPointerDown);
  pad.canvas.addEventListener('pointermove', onPointerMove);
  pad.canvas.addEventListener('pointerup', onPointerUp);
  pad.canvas.addEventListener('pointercancel', onPointerUp);
  pad.canvas.addEventListener('pointerleave', () => { if (!pad.active) { pad.hover = null; requestOverlay(); } });
  pad.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // iOS: 길게 누르기/돋보기 방지
  pad.canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });

  buildToolbar();
  document.querySelectorAll('.tool').forEach((b) => { b.onclick = () => { pad.tool = b.dataset.tool; syncToolbar(); }; });
  $('#colors').onclick = (e) => {
    const b = e.target.closest('.swatch');
    if (!b || pad.tool === 'eraser') return;
    pad.colors[pad.tool] = b.dataset.color;
    store.set('colors', pad.colors);
    syncToolbar();
  };
  $('#sizes').onclick = (e) => {
    const b = e.target.closest('.size');
    if (!b) return;
    pad.sizeIdx = Number(b.dataset.size);
    store.set('sizeIdx', pad.sizeIdx);
    syncToolbar();
  };
  $('#undo').onclick = () => restore(pad.undo, pad.redo);
  $('#redo').onclick = () => restore(pad.redo, pad.undo);
  setFingerDraw(pad.fingerDraw);
  $('#finger-mode').onclick = () => setFingerDraw(!pad.fingerDraw);
  $('#clear').onclick = () => {
    if (!pad.note.strokes.length || !confirm('이 날의 필기를 모두 지울까요? (실행 취소 가능)')) return;
    pushUndo();
    pad.note.strokes = [];
    redraw();
    saveSoon();
  };
  $('#add-page').onclick = () => {
    if (pad.note.height >= PAGE_H * MAX_PAGES) return;
    pushUndo();
    pad.note.height += PAGE_H;
    layoutPad();
    saveSoon();
  };

  // 일정 입력
  $('#ev-allday').onchange = (e) => $('#ev-times').classList.toggle('hidden', e.target.checked);
  $('#event-form').addEventListener('submit', onAddEvent);
  if (window.matchMedia('(max-width: 899px)').matches && window.innerHeight < 700) $('#events-panel').open = false;

  // 키보드 (윈도우)
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input')) return;
    if (state.view === 'day') {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? restore(pad.redo, pad.undo) : restore(pad.undo, pad.redo); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); restore(pad.redo, pad.undo); }
      else if (e.key === 'Escape') $('#back-btn').click();
      else if (e.key === 'ArrowLeft') shiftDay(-1);
      else if (e.key === 'ArrowRight') shiftDay(1);
    } else if (e.key === 'ArrowLeft') shiftMonth(-1);
    else if (e.key === 'ArrowRight') shiftMonth(1);
  });

  // 안드로이드 뒤로가기 → 달력
  window.addEventListener('popstate', (e) => {
    if (e.state?.day) openDay(e.state.day, { push: false });
    else if (state.view === 'day') closeDay();
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => (state.view === 'day' ? layoutPad() : renderMonth()), 150);
  });
  window.addEventListener('online', () => { notes.flush(); refreshInBackground(); });
  window.addEventListener('offline', () => setStatus('offline'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
    else refreshInBackground();
  });
  window.addEventListener('pagehide', () => { saveNow(); });
}

async function init() {
  auth.init();
  bind();
  await notes.loadLocal();
  updateAuthUI();
  history.replaceState(null, '', location.pathname + location.search);
  renderMonth();
  if (auth.connected()) { watchExpiry(); afterSignIn(); }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  }
}

init();
