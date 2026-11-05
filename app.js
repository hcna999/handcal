'use strict';

const CFG = window.APP_CONFIG || {};
const SCOPES = 'openid email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/tasks';
const FOLDER_NAME = '필기캘린더';
const PAGE_W = 1000;
const PAGE_H = 1414; // A4 비율
const MAX_PAGES = 6;
const COLORS = ['#1f2328', '#2563eb', '#dc2626', '#16a34a', '#ea580c', '#7c3aed', '#facc15'];
const SIZES = { pen: [2, 4, 7], hl: [14, 24, 36], eraser: [12, 28, 56] };
const WD = ['일', '월', '화', '수', '목', '금', '토'];

const $ = (s) => document.querySelector(s);

// 아이콘 (index.html의 <symbol>)
function icon(name, cls = 'ic') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

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
  // 사진·녹음 같은 파일 올리기
  async createBinary(name, blob) {
    const fid = await this.ensureFolder();
    const b = 'hc' + Math.random().toString(36).slice(2);
    const body = new Blob([
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [fid] })}\r\n--${b}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
      blob,
      `\r\n--${b}--`,
    ]);
    return gapi(`${UPLOAD}?uploadType=multipart&fields=id`, {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body,
    });
  },
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
  inkFolderId: null,
  async ensureInkFolder() {
    if (this.inkFolderId) return this.inkFolderId;
    const fid = await this.ensureFolder();
    const q = encodeURIComponent(`'${fid}' in parents and name='ink' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const r = await gapi(`${DRIVE}?q=${q}&fields=files(id)&spaces=drive`);
    if (r.files.length) return (this.inkFolderId = r.files[0].id);
    const c = await gapi(`${DRIVE}?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ink', parents: [fid], mimeType: 'application/vnd.google-apps.folder' }),
    });
    return (this.inkFolderId = c.id);
  },
  async uploadInkPng(name, b64, existingId) {
    const u8 = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const blob = new Blob([u8], { type: 'image/png' });
    if (existingId) {
      return gapi(`${UPLOAD}/${existingId}?uploadType=media&fields=id`, {
        method: 'PATCH', headers: { 'Content-Type': 'image/png' }, body: blob,
      }).catch(() => this.uploadInkPng(name, b64, null));
    }
    const fid = await this.ensureInkFolder();
    const b = 'hc' + Math.random().toString(36).slice(2);
    const body = new Blob([
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [fid] })}\r\n--${b}\r\nContent-Type: image/png\r\n\r\n`,
      blob,
      `\r\n--${b}--`,
    ]);
    return gapi(`${UPLOAD}?uploadType=multipart&fields=id`, {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body,
    });
  },
};

// ---------- 필기 노트 (기기 저장 + 드라이브 동기화)
// 하루 필기 = 탭(pages) 최대 MAX_TABS개. 각 탭은 자기 획·종이 길이·글자 변환 결과를 가짐
const MAX_TABS = 5;
const newPageId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
// kind: 'ink'(손글씨) 또는 'text'(키보드 메모)
// kind: 없음(손글씨) / 'text'(키보드) / 'photo'(사진) / 'voice'(음성). 사진·음성은 media 목록 + 설명·받아쓴 글(text)
const blankPage = (kind = 'ink') => {
  const p = { id: newPageId(), height: PAGE_H, strokes: [] };
  if (kind === 'text') Object.assign(p, { kind, text: '' });
  if (kind === 'photo' || kind === 'voice') Object.assign(p, { kind, text: '', media: [] });
  return p;
};
// 새 날짜는 키보드 메모로 시작 (버튼으로 손글씨 전환)
const blankNote = () => ({ v: 2, pages: [blankPage('text')], updated: 0 });
const normPage = (p, id) => ({
  id: p?.id || id,
  height: Math.max(PAGE_H, Number(p?.height) || PAGE_H),
  strokes: Array.isArray(p?.strokes) ? p.strokes : [],
  ...(p?.title ? { title: String(p.title) } : {}),
  ...(p?.ocr ? { ocr: p.ocr } : {}),
  ...(p?.paper ? { paper: p.paper } : {}),
  ...(p?.t ? { t: p.t } : {}),
  ...(p?.conflict ? { conflict: true } : {}),
  ...(p?.kind === 'text' ? { kind: 'text', text: String(p.text || '') } : {}),
  ...(p?.kind === 'photo' || p?.kind === 'voice' ? { kind: p.kind, text: String(p.text || ''), media: Array.isArray(p.media) ? p.media : [] } : {}),
});
// 예전 형식(탭 없이 strokes 하나)도 첫 번째 탭으로 읽음
const normalize = (n) => ({
  v: 2,
  pages: Array.isArray(n?.pages) && n.pages.length ? n.pages.map((p, i) => normPage(p, 'p' + i)) : [normPage(n, 'p0')],
  updated: n?.updated || 0,
  remoteTime: n?.remoteTime,
  ...(n?.gone ? { gone: n.gone } : {}),
});
const docEmpty = (doc) => doc.pages.every((p) => !p.strokes.length && !(p.text || '').trim() && !p.media?.length);
const cloneDoc = (doc) => ({ ...doc, pages: doc.pages.map((p) => ({ ...p, strokes: p.strokes.slice(), ...(p.media ? { media: p.media.map((m) => ({ ...m })) } : {}) })) });

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
    const prev = await idb.get('note:' + d).catch(() => null);
    stampPages(prev && normalize(prev), note);
    if (prev?.remoteTime && !note.remoteTime) note.remoteTime = prev.remoteTime;
    noteIndex.update(d, note);
    if (!docEmpty(note)) { await idb.set('note:' + d, note); this.localDays.add(d); }
    else { await idb.del('note:' + d); this.localDays.delete(d); }
    this.pending.add(d);
    this.savePending();
    scheduleFlush();
    gtasks.schedule(d);
  },

  // 드라이브의 최신 수정 시각이 마지막으로 맞춘 시각과 다르면 받아서 탭 단위로 합침 (raw를 고침)
  async mergeRemote(d, raw, r) {
    const meta = await gapi(`${DRIVE}/${r.id}?fields=modifiedTime`).catch(() => null);
    if (!meta || meta.modifiedTime === raw.remoteTime) return;
    const data = await drive.read(r.id);
    const remote = normalize(typeof data === 'string' ? JSON.parse(data) : data);
    const base = raw.remoteTime ? Date.parse(raw.remoteTime) : 0;
    const { doc, conflicts } = mergeDocs(normalize(raw), remote, base);
    raw.pages = doc.pages;
    if (doc.gone) raw.gone = doc.gone; else delete raw.gone;
    raw.updated = Date.now();
    await idb.set('note:' + d, raw);
    noteIndex.update(d, normalize(raw));
    if (state.view === 'day' && state.date === d) {
      const curId = pad.note.id;
      pad.doc = normalize(raw);
      pad.pageIdx = Math.max(0, pad.doc.pages.findIndex((p) => p.id === curId));
      $('#text-page').dataset.pageId = '';
      $('#media-page').dataset.pageId = '';
      renderTabs();
      renderOcr();
      layoutPad();
    }
    listState.cache.delete(d);
    toast(conflicts ? '다른 기기에서도 고쳐서, 겹친 탭은 사본으로 남겼어요' : '다른 기기의 수정과 합쳤어요', 4000);
  },

  async flush() {
    if (!auth.connected()) { setStatus(); return; }
    if (!navigator.onLine) { setStatus('offline'); return; }
    if (this.flushing) { this.again = true; return; }
    this.flushing = true;
    if (this.pending.size) setStatus('saving');
    try {
      for (const d of [...this.pending]) {
        const raw = await idb.get('note:' + d);
        const local = raw && normalize(raw);
        const r = this.remote.get(d);
        if (local && !docEmpty(local)) {
          await uploadMedia(d, raw);
          if (r) await this.mergeRemote(d, raw, r);
          const payload = { v: 2, date: d, pages: normalize(raw).pages, updated: raw.updated, ...(raw.gone ? { gone: raw.gone } : {}) };
          const f = r ? await drive.update(r.id, payload) : await drive.create(d + '.json', payload);
          this.remote.set(d, f);
          const cur = await idb.get('note:' + d);
          if (cur) {
            cur.remoteTime = f.modifiedTime;
            await idb.set('note:' + d, cur);
            if (cur.updated === raw.updated) this.pending.delete(d);
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

// 문서 안 사진·녹음 중 아직 드라이브에 없는 것을 올리고 driveId를 기록 (열려 있는 화면의 문서에도 반영)
async function uploadMedia(d, raw) {
  let changed = false;
  for (const p of raw.pages || []) {
    for (const m of p.media || []) {
      if (m.driveId) continue;
      const blob = await idb.get('blob:' + m.id).catch(() => null);
      if (!blob) continue;
      const ext = m.type === 'image' ? 'jpg' : (m.mime || '').includes('mp4') ? 'm4a' : 'webm';
      const f = await drive.createBinary(`media-${d}-${m.id}.${ext}`, blob);
      m.driveId = f.id;
      changed = true;
      if (state.date === d) pad.doc.pages.find((x) => x.id === p.id)?.media?.forEach((x) => { if (x.id === m.id) x.driveId = f.id; });
    }
  }
  if (changed) await idb.set('note:' + d, raw);
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
  update(id, ev) {
    this.save(this.all().map((x) => (x.id === id ? { ...x, title: ev.title, allDay: ev.allDay, start: ev.start.toISOString(), end: ev.end.toISOString(), updated: Date.now() } : x)));
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
  // 로그인이 잠깐 만료됐어도 전에 받아 둔 일정은 보여줌
  known() { return !!CFG.WORKER_URL && (auth.connected() || auth.wasSignedIn()); },
  warned: false,
  async load(s, e) {
    const res = await authFetch(`${CFG.WORKER_URL.replace(/\/$/, '')}/naver/events?start=${encodeURIComponent(s.toISOString())}&end=${encodeURIComponent(e.toISOString())}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || 'HTTP ' + res.status);
      err.code = data.error;
      throw err;
    }
    if (Array.isArray(data.calendars) && data.calendars.length) {
      store.set('naverCals', data.calendars);
      renderCalFilter();
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

// 일정 보관: 네이버 일정은 달(YYYY-MM)마다 받아온 시각을 기억하고 기기(localStorage 'naverEvents')에 저장한다.
// 이미 받은 달은 바로 그리고(오래됐으면 뒤에서 다시 받음), 받을 때는 앞뒤 달까지 한 번에 받아 둔다.
// 메모 일정은 늘 기기 목록(memos)에서 바로 계산한다.
const EV_FRESH = 5 * 60e3; // 5분 지나면 뒤에서 새로 받음
const monthKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const monthStart = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
function monthsIn(s, e) {
  const out = [];
  for (let m = monthStart(s); m < e; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) out.push(m);
  return out;
}
const overlaps = (ev, s, e) => ev.start < e && (ev.end > s || (+ev.start === +ev.end && ev.start >= s));

const events = {
  months: null, // {YYYY-MM: 받은 시각}
  list: null, // 네이버 일정 (Date로 바꾼 것)
  version: 0, // 네이버 일정이 바뀔 때마다 1씩 (다시 그릴지 판단)
  inflight: new Map(),

  restore() {
    if (this.list) return;
    const saved = store.get('naverEvents', null);
    this.months = saved?.months || {};
    this.list = (saved?.list || []).map((x) => ({ ...x, start: new Date(x.start), end: new Date(x.end) }));
  },
  persist() {
    // 오늘 기준 앞뒤 18개월만 남김
    const now = new Date();
    const lo = monthKey(new Date(now.getFullYear(), now.getMonth() - 18, 1)), hi = monthKey(new Date(now.getFullYear(), now.getMonth() + 18, 1));
    for (const k of Object.keys(this.months)) if (k < lo || k > hi) delete this.months[k];
    const keep = this.list.filter((ev) => monthKey(ev.end) >= lo && monthKey(ev.start) <= hi);
    store.set('naverEvents', { months: this.months, list: keep });
  },
  // 이 기간을 다 받아 둔 적이 있으면 (오래됐어도) 바로 돌려줌, 아니면 null
  cached(s, e) {
    let list = memos.visible(s, e);
    if (naver.known()) {
      this.restore();
      const have = monthsIn(s, e).every((m) => this.months[monthKey(m)]);
      if (!have && naver.enabled()) return null; // 받으러 가야 함
      list = list.concat(this.list.filter((ev) => overlaps(ev, s, e)));
    }
    return list.sort(sortEvents);
  },
  fresh(s, e) {
    if (!naver.enabled()) return true; // 받을 수 없으면 있는 것으로 끝
    this.restore();
    return monthsIn(s, e).every((m) => Date.now() - (this.months[monthKey(m)] || 0) < EV_FRESH);
  },
  // 앱으로 돌아왔을 때 등: 보여주던 건 그대로 두고 다음에 뒤에서 새로 받게 함
  clear() { if (this.months) for (const k of Object.keys(this.months)) this.months[k] = 1; },
  reset() { this.months = {}; this.list = []; this.version++; store.del('naverEvents'); },

  async load(s, e) {
    if (!naver.enabled()) return this.cached(s, e);
    this.restore();
    const need = monthsIn(s, e).filter((m) => Date.now() - (this.months[monthKey(m)] || 0) >= EV_FRESH);
    if (need.length) {
      // 모자란 달 + 앞뒤 한 달씩 한 번에 (최대 12개월)
      let from = need[0], to = new Date(need[need.length - 1].getFullYear(), need[need.length - 1].getMonth() + 1, 1);
      const wider = [new Date(from.getFullYear(), from.getMonth() - 1, 1), new Date(to.getFullYear(), to.getMonth() + 1, 1)];
      if (monthsIn(wider[0], wider[1]).length <= 12) [from, to] = wider;
      try {
        // 이미 받으러 간 요청이 이 기간을 덮으면 그걸 기다림
        const last = need[need.length - 1];
        const needEnd = new Date(last.getFullYear(), last.getMonth() + 1, 1);
        const cover = [...this.inflight.values()].find((x) => x.from <= need[0] && x.to >= needEnd);
        await (cover ? cover.promise : this.fetchRange(from, to));
        naver.warned = false;
      } catch (err) {
        if (err.message === 'AUTH') throw err;
        if (!naver.warned) { naver.warned = true; toast('네이버 캘린더를 불러오지 못했어요: ' + err.message.slice(0, 100), 5000); }
        console.warn(err);
        // 실패한 달은 30초 동안 다시 요청하지 않음 (받아 둔 게 있으면 그걸로 보여줌)
        const retry = Date.now() - EV_FRESH + 30e3;
        for (const m of need) this.months[monthKey(m)] = Math.max(this.months[monthKey(m)] || 0, retry);
        return this.cached(s, e);
      }
    }
    return this.cached(s, e);
  },
  // 같은 기간을 동시에 두 번 요청하지 않음
  fetchRange(from, to) {
    const key = monthKey(from) + '~' + monthKey(to);
    if (!this.inflight.has(key)) {
      this.inflight.set(key, { from, to, promise: (async () => {
        const got = await naver.load(from, to);
        const old = this.list.filter((ev) => overlaps(ev, from, to));
        const sig = (l) => l.map((ev) => `${ev.id}|${+ev.start}|${+ev.end}|${ev.title}|${ev.color}|${ev.calendar}`).sort().join('\n');
        if (sig(old) !== sig(got)) this.version++;
        const seen = new Set();
        this.list = this.list.filter((ev) => !overlaps(ev, from, to)).concat(got).filter((ev) => {
          const k = ev.id + '|' + +ev.start;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        const now = Date.now();
        for (const m of monthsIn(from, to)) this.months[monthKey(m)] = now;
        this.persist();
      })().finally(() => this.inflight.delete(key)) });
    }
    return this.inflight.get(key).promise;
  },
  // 앞뒤 화면에 걸칠 일정을 미리 받아 둠 (넘길 때 바로 보이게, 실패해도 조용히)
  prefetch(s, e) {
    if (!naver.enabled() || this.fresh(s, e)) return;
    setTimeout(() => this.load(s, e).catch(() => {}), 300);
  },

  on(list, day) {
    const s = day, e = addDays(day, 1);
    const hidden = hiddenCals();
    return list.filter((ev) => !hidden.has(calKey(ev)) && overlaps(ev, s, e));
  },

  add(ev) { memos.add(ev); },
  update(id, ev) { memos.update(id, ev); },
  remove(ev) { memos.remove(ev.id); },
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

// 막대 배경색이 밝으면 검은 글자, 어두우면 흰 글자
function textOn(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex || '');
  if (!m) return '#fff';
  const [r, g, b] = m.slice(1).map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#1f2328' : '#ffffff';
}

function monthRange() {
  const first = state.month;
  const start = addDays(first, -first.getDay());
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const weeks = Math.ceil((first.getDay() + days) / 7);
  return { start, end: addDays(start, weeks * 7), weeks };
}

// 보기 전환: 월간 / 주간 / 메모 모아보기
const sundayOf = (d) => addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -d.getDay());
state.calView = store.get('calView', 'month');
state.weekStart = sundayOf(new Date());

function renderMonth() {
  document.querySelectorAll('#view-seg button, #bottom-tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === state.calView);
    b.setAttribute('aria-selected', String(b.dataset.view === state.calView));
  });
  const v = state.calView;
  $('#grid').classList.toggle('hidden', v !== 'month');
  $('.weekdays').classList.toggle('hidden', v === 'list' || v === 'todo');
  $('#todo-view').classList.toggle('hidden', v !== 'todo');
  $('#month-view').classList.toggle('week-mode', v === 'week');
  $('#week-grid').classList.toggle('hidden', v !== 'week');
  $('#list-view').classList.toggle('hidden', v !== 'list');
  for (const id of ['#prev-month', '#next-month', '#today-btn']) $(id).classList.toggle('hidden', v === 'list' || v === 'todo');
  renderDueBar();
  miniState.month = v === 'week' && state.weekStart ? new Date(addDays(state.weekStart, 3).getFullYear(), addDays(state.weekStart, 3).getMonth(), 1) : state.month;
  renderMiniCal();
  if (v === 'todo') return renderTodos();
  if (v === 'week') return renderWeek();
  if (v === 'list') return renderList();
  return renderMonthView();
}

function setCalView(v) {
  if (v === state.calView) return;
  const today = new Date();
  if (v === 'week') {
    // 지금 보던 달이 이번 달이면 이번 주, 아니면 그 달의 첫 주
    const sameMonth = state.month.getFullYear() === today.getFullYear() && state.month.getMonth() === today.getMonth();
    state.weekStart = sundayOf(sameMonth ? today : state.month);
  } else if (v === 'month' && state.calView === 'week') {
    const mid = addDays(state.weekStart, 3);
    state.month = new Date(mid.getFullYear(), mid.getMonth(), 1);
  }
  state.calView = v;
  store.set('calView', v);
  renderMonth();
}

// 한 날짜의 탭들을 미리보기 글로: 타자 메모는 그대로, 손글씨는 변환된 글자(없으면 표시만)
function docPreview(doc) {
  return doc.pages.map((p) => {
    if (p.kind === 'text') return { kind: 'text', text: (p.text || '').trim() };
    if (p.kind === 'photo') return p.media.length || (p.text || '').trim() ? { kind: 'text', text: `📷 사진 ${p.media.length}장${p.text ? ' · ' + p.text.trim() : ''}` } : null;
    if (p.kind === 'voice') return p.media.length || (p.text || '').trim() ? { kind: 'text', text: (p.text || '').trim() || `🎤 녹음 ${p.media.length}개` } : null;
    if (!p.strokes.length) return null;
    return p.ocr?.text ? { kind: 'ink', text: p.ocr.text.trim(), page: p } : { kind: 'ink', text: '', page: p };
  }).filter((x) => x && (x.text || x.kind === 'ink'));
}

// 주간 시간표: 그 주 전체에서 시간 범위를 맞춰 칸끼리 줄이 맞게
function weekTimeline(day, timed, weekEvs) {
  const hoursOf = (e) => [e.start.getHours() + e.start.getMinutes() / 60, e.end.getHours() + e.end.getMinutes() / 60 || 24];
  let h0 = 8, h1 = 21;
  for (const e of weekEvs || []) {
    if (e.allDay) continue;
    const [a, b] = hoursOf(e);
    h0 = Math.min(h0, Math.floor(a));
    h1 = Math.max(h1, Math.ceil(b > a ? b : a + 1));
  }
  const box = el('div', 'wtime');
  box.style.setProperty('--hours', h1 - h0);
  for (let h = h0; h < h1; h++) {
    const line = el('div', 'wtime-hour', `${h}`);
    line.style.top = `calc(${h - h0} * var(--hour-h))`;
    box.append(line);
  }
  // 겹치는 일정은 옆으로 나란히
  const items = timed.map((e) => {
    const sameDay = ymd(e.start) === ymd(day);
    const [a0, b0] = hoursOf(e);
    const a = sameDay ? a0 : h0, b = ymd(e.end) === ymd(day) ? Math.max(b0, a + 0.5) : h1;
    return { e, a: Math.max(h0, a), b: Math.min(h1, Math.max(b, a + 0.5)) };
  }).sort((x, y) => x.a - y.a);
  const lanes = [];
  for (const it of items) {
    let l = lanes.findIndex((end) => end <= it.a);
    if (l < 0) { l = lanes.length; lanes.push(0); }
    lanes[l] = it.b;
    it.lane = l;
  }
  for (const it of items) {
    const b = el('div', 'wtime-ev', `${hm(it.e.start)} ${it.e.title}`);
    b.title = `${hm(it.e.start)}–${hm(it.e.end)} ${it.e.title}`;
    b.style.top = `calc(${it.a - h0} * var(--hour-h))`;
    b.style.height = `calc(${it.b - it.a} * var(--hour-h) - 2px)`;
    b.style.left = `calc(1.2rem + (100% - 1.2rem) * ${it.lane / lanes.length})`;
    b.style.width = `calc((100% - 1.2rem) / ${lanes.length} - 2px)`;
    b.style.setProperty('--c', it.e.color);
    b.style.setProperty('--chip-text', textOn(it.e.color));
    box.append(b);
  }
  if (ymd(day) === ymd(new Date())) {
    const now = new Date();
    const nh = now.getHours() + now.getMinutes() / 60;
    if (nh >= h0 && nh <= h1) {
      const nowLine = el('div', 'wtime-now');
      nowLine.style.top = `calc(${nh - h0} * var(--hour-h))`;
      nowLine.title = `지금 ${hm(now)}`;
      box.append(nowLine);
    }
  }
  return box;
}

let weekToken = 0;
async function renderWeek() {
  const start = state.weekStart, end = addDays(start, 7), last = addDays(start, 6);
  const sameYear = start.getFullYear() === new Date().getFullYear();
  // 휴대폰처럼 좁으면 '10.25 – 31'처럼 짧게
  $('#month-title').textContent = window.matchMedia('(max-width: 599px)').matches
    ? `${start.getMonth() + 1}.${start.getDate()} – ` + (last.getMonth() === start.getMonth() ? `${last.getDate()}` : `${last.getMonth() + 1}.${last.getDate()}`)
    : (sameYear ? '' : start.getFullYear() + '년 ') + `${start.getMonth() + 1}월 ${start.getDate()}일 – ` +
      (last.getMonth() === start.getMonth() ? `${last.getDate()}일` : `${last.getMonth() + 1}월 ${last.getDate()}일`);
  const evs = events.cached(start, end);
  const today = ymd(new Date());
  const token = ++weekToken;
  const grid = $('#week-grid');
  let maxAllday = 0;
  const cells = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i), ds = ymd(d), wd = d.getDay();
    const cell = el('div', 'wcell' + (ds === today ? ' today' : ''));
    cell.dataset.date = ds;
    const head = el('div', 'whead');
    const hol = holidayOn(d);
    const red = wd === 0 || hol;
    head.append(el('span', 'wday' + (red ? ' sun' : wd === 6 ? ' sat' : ''), WD[wd]), el('span', 'num' + (red ? ' sun' : wd === 6 ? ' sat' : ''), String(d.getDate())));
    const lun = lunarLabel(d);
    if (lun) head.append(el('span', 'lunar', lun));
    if (notes.has(ds)) head.append(inkIcon());
    cell.append(head);
    if (hol) cell.append(el('div', 'hol', hol));
    if (evs) {
      // 넓은 화면: 종일 일정은 위에, 시간 있는 일정은 시간표(8시~21시, 벗어나면 늘림)에
      const wide = window.matchMedia('(min-width: 900px)').matches;
      const dayEvs = events.on(evs, d);
      // 종일 칸은 그 주에서 가장 많은 날에 맞춰 높이를 같게 (시간표 줄이 칸끼리 맞도록)
      const allday = el('div', 'wallday');
      for (const ev of dayEvs) {
        if (wide && !ev.allDay) continue;
        const chip = el('div', 'chip', (ev.allDay ? '' : hm(ev.start) + ' ') + ev.title);
        chip.style.setProperty('--c', ev.color);
        chip.style.setProperty('--chip-text', textOn(ev.color));
        allday.append(chip);
      }
      cell.append(allday);
      if (wide) {
        maxAllday = Math.max(maxAllday, allday.children.length + (hol ? 1 : 0));
        cell.append(weekTimeline(d, dayEvs.filter((e) => !e.allDay), evs));
      }
    }
    const memo = el('div', 'wmemo');
    cell.append(memo);
    cells.push({ ds, memo });
  }
  grid.replaceChildren(...cells.map((c) => c.memo.parentElement));
  grid.style.setProperty('--allday-n', maxAllday);
  if (!evs || !events.fresh(start, end)) {
    const ver = events.version;
    try {
      await events.load(start, end);
      if (token === weekToken && state.view === 'month' && state.calView === 'week' && (!evs || events.version !== ver)) renderWeek();
    } catch (e) { handleErr(e); }
    events.prefetch(addDays(start, -28), addDays(end, 28));
    return;
  }
  events.prefetch(addDays(start, -28), addDays(end, 28));
  // 메모 미리보기는 노트를 읽어서 채움 ('메모 일정' 표시가 꺼져 있으면 숨김)
  if (!hiddenCals().has(MEMO_CAL)) {
    for (const { ds, memo } of cells) {
      if (!notes.has(ds)) continue;
      try {
        const doc = await notes.get(ds);
        if (token !== weekToken) return;
        for (const it of docPreview(doc)) {
          memo.append(el('div', 'wmemo-item' + (it.kind === 'text' ? ' typed' : ''), it.text || '✎ 손글씨 (글자 변환 대기)'));
        }
      } catch (e) { console.warn(e); }
    }
  }
}

// ---------- 메모 모아보기: 메모가 있는 날짜를 최신순으로
const LIST_PAGE = 20;
const listState = { shown: LIST_PAGE, cache: new Map(), token: 0 };
function allNoteDates() {
  const set = new Set(notes.localDays);
  for (const d of notes.remote.keys()) set.add(d);
  return [...set].filter((d) => notes.has(d)).sort().reverse();
}

async function renderList() {
  $('#month-title').textContent = '메모 모아보기';
  const token = ++listState.token;
  const q = $('#list-search').value.trim().toLowerCase();
  const dates = allNoteDates();
  const box = $('#list-items');
  if (!dates.length) { box.replaceChildren(el('p', 'muted-text', '아직 메모가 없어요. 날짜를 눌러 필기하거나 타자로 적어 보세요.')); $('#list-more').classList.add('hidden'); return; }
  // 검색할 때는 전부 읽어서 거름
  const targets = q ? dates : dates.slice(0, listState.shown);
  const items = [];
  for (const ds of targets) {
    // 색인에 글만 있으면 문서를 읽지 않음 (손글씨 그림이 필요할 때만 읽음)
    const ix = noteIndex.get(ds);
    let prev;
    if (ix && !listState.cache.has(ds) && !ix.p.some((x) => x.ink)) prev = ix.p;
    else {
      let doc = listState.cache.get(ds);
      if (!doc) {
        try { doc = await notes.get(ds); listState.cache.set(ds, doc); } catch (e) { console.warn(e); continue; }
        if (token !== listState.token) return;
      }
      prev = docPreview(doc);
    }
    if (!prev.length) continue;
    if (q && !prev.some((p) => p.text.toLowerCase().includes(q))) continue;
    items.push(listItem(ds, prev));
  }
  if (token !== listState.token) return;
  box.replaceChildren(...(items.length ? items : [el('p', 'muted-text', '검색 결과가 없어요.')]));
  $('#list-more').classList.toggle('hidden', !!q || dates.length <= listState.shown);
}

function listItem(ds, prev) {
  const d = parseYmd(ds);
  const item = el('article', 'list-item');
  item.dataset.date = ds;
  const head = el('div', 'list-head');
  head.append(el('span', 'list-date', `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`), el('span', 'list-wd' + (d.getDay() === 0 ? ' sun' : d.getDay() === 6 ? ' sat' : ''), WD[d.getDay()] + '요일'));
  item.append(head);
  for (const it of prev) {
    if (it.text) item.append(el('div', 'list-text' + (it.kind === 'text' ? ' typed' : ''), it.text));
    else {
      // 아직 글자로 바뀌지 않은 손글씨는 작은 그림으로
      const img = el('img', 'list-ink');
      img.alt = '손글씨';
      const wasDark = darkInk;
      img.src = 'data:image/png;base64,' + noteImage(it.page);
      darkInk = wasDark;
      item.append(img);
    }
  }
  return item;
}

// ---------- 할 일 모아보기: 모든 날짜의 할 일을 체크하면 원래 메모에도 반영
// ---------- 할 일 기한 읽기: '금요일까지', '내일', '11/7', '7일까지', '3일 뒤' 등 (기준은 메모 날짜)
const WD_CHARS = '일월화수목금토';
function parseDue(text, base) {
  const t = text;
  let m;
  const at = (d) => ymd(d);
  if (/(^|[^가-힣])오늘/.test(t)) return at(base);
  if (/내일/.test(t)) return at(addDays(base, 1));
  if (/모레/.test(t)) return at(addDays(base, 2));
  if (/글피/.test(t)) return at(addDays(base, 3));
  if ((m = /(\d+)\s*일\s*(뒤|후)/.exec(t))) return at(addDays(base, +m[1]));
  if ((m = /(\d{1,2})\s*[/.]\s*(\d{1,2})(?!\d)/.exec(t)) || (m = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/.exec(t))) {
    let d = new Date(base.getFullYear(), +m[1] - 1, +m[2]);
    if (d.getMonth() !== +m[1] - 1) return null;
    if (d < addDays(base, -60)) d = new Date(base.getFullYear() + 1, +m[1] - 1, +m[2]); // 연말에 쓴 '1/5'는 내년
    return at(d);
  }
  if ((m = /(이번|다음|담|다다음)?\s*주?\s*([일월화수목금토])요일/.exec(t))) {
    const wd = WD_CHARS.indexOf(m[2]);
    const week = { 다음: 1, 담: 1, 다다음: 2 }[m[1]] || 0;
    if (m[1]) return at(addDays(sundayOf(base), week * 7 + wd));
    return at(addDays(base, (wd - base.getDay() + 7) % 7));
  }
  if (/월말/.test(t)) return at(new Date(base.getFullYear(), base.getMonth() + 1, 0));
  if ((m = /(?:^|[^\d/.])(\d{1,2})\s*일\s*(까지|에|날|전)/.exec(t))) {
    let d = new Date(base.getFullYear(), base.getMonth(), +m[1]);
    if (d < base) d = new Date(base.getFullYear(), base.getMonth() + 1, +m[1]);
    return at(d);
  }
  return null;
}

function dueLabel(due) {
  if (!due) return '';
  const today = ymd(new Date());
  const diff = Math.round((parseYmd(due) - parseYmd(today)) / 86400e3);
  if (diff < 0) return `${-diff}일 지남`;
  if (diff === 0) return '오늘';
  if (diff === 1) return '내일';
  const d = parseYmd(due);
  return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
}

// ---------- 할 일 모아보기 (기한순 / 메모 날짜순)
const todoState = { token: 0, showDone: store.get('todoShowDone', false), sort: store.get('todoSort', 'due') };
// 달력 위 마감 알림 줄: 색인만 읽어 빠르게 "오늘 마감 N · 지난 것 N"을 세고, 누르면 할 일(기한순)로
function renderDueBar() {
  const bar = $('#due-bar');
  if (!bar) return;
  const today = ymd(new Date());
  let dueToday = 0, overdue = 0;
  if (store.get('dueBarHidden', '') !== today && (state.calView === 'month' || state.calView === 'week')) {
    for (const ds of allNoteDates()) {
      for (const t of noteIndex.get(ds)?.todos || []) {
        if (t.done) continue;
        const due = parseDue(t.text, parseYmd(ds));
        if (!due) continue;
        if (due === today) dueToday++;
        else if (due < today) overdue++;
      }
    }
  }
  bar.classList.toggle('hidden', !(dueToday || overdue));
  if (!(dueToday || overdue)) return;
  const parts = [];
  if (dueToday) parts.push(`오늘 마감 ${dueToday}개`);
  if (overdue) parts.push(`기한 지난 것 ${overdue}개`);
  $('#due-open').textContent = `☐ ${parts.join(' · ')} — 할 일 보기 ›`;
  bar.classList.toggle('over', overdue > 0);
}

async function renderTodos() {
  $('#month-title').textContent = '할 일 모아보기';
  $('#todo-show-done').checked = todoState.showDone;
  document.querySelectorAll('#todo-sort button').forEach((b) => b.classList.toggle('active', b.dataset.sort === todoState.sort));
  const token = ++todoState.token;
  const box = $('#todo-items');
  if (!box.children.length) box.replaceChildren(el('p', 'muted-text', '불러오는 중…'));
  const all = [];
  for (const ds of allNoteDates()) {
    const ix = noteIndex.get(ds);
    let list;
    if (ix && !listState.cache.has(ds)) list = ix.todos.map((t) => ({ ...t, due: parseDue(t.text, parseYmd(ds)) }));
    else {
      let doc = listState.cache.get(ds);
      if (!doc) {
        try { doc = await notes.get(ds); listState.cache.set(ds, doc); } catch (e) { console.warn(e); continue; }
        if (token !== todoState.token) return;
      }
      list = todosOf(doc, ds);
    }
    for (const t of list) all.push({ ...t, ds });
  }
  if (token !== todoState.token) return;
  const left = all.filter((t) => !t.done).length;
  const doneCount = all.filter((t) => t.done).length;
  $('#todo-count').textContent = `남은 할 일 ${left}개`;
  const clearBtn = $('#todo-clear-done');
  if (clearBtn) {
    clearBtn.classList.toggle('hidden', !(todoState.showDone && doneCount > 0));
    clearBtn.textContent = `완료 ${doneCount}개 정리`;
  }
  const shown = all.filter((t) => todoState.showDone || !t.done);
  if (!shown.length) {
    box.replaceChildren(el('p', 'muted-text', left || todoState.showDone ? '할 일이 없어요.' : "남은 할 일이 없어요. 메모에서 [] + 스페이스로 할 일을 적거나, 손글씨로 쓰면 AI가 찾아줘요. '금요일까지'처럼 쓰면 기한도 잡아요."));
    return;
  }
  const row = (t) => {
    const r = el('label', 'todo-row' + (t.done ? ' done' : ''));
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = t.done;
    cb.onchange = () => toggleTodo(t.ds, t, cb.checked, r);
    r.append(cb, el('span', 'todo-text', t.text));
    if (t.due) r.append(el('span', 'todo-due' + (t.due < ymd(new Date()) && !t.done ? ' over' : ''), dueLabel(t.due)));
    if (t.kind === 'ocr') r.append(icon('pen', 'ic todo-src'));
    const go = el('button', 'todo-go', `${parseYmd(t.ds).getMonth() + 1}/${parseYmd(t.ds).getDate()}`);
    go.title = '메모 열기';
    go.onclick = (e) => { e.preventDefault(); openDay(t.ds); };
    r.append(go);
    return r;
  };
  const section = (title, items, ds) => {
    const sec = el('section', 'todo-group');
    const head = el('button', 'todo-date', title);
    if (ds) { head.title = '이 날짜 열기'; head.onclick = () => openDay(ds); }
    sec.append(head, ...items.map(row));
    return sec;
  };
  if (todoState.sort === 'due') {
    // 기한별 묶음: 지남 · 오늘 · 내일 · 이번 주 · 나중 · 기한 없음 (기한 없으면 메모 날짜 최신순)
    const today = ymd(new Date()), tomorrow = ymd(addDays(new Date(), 1)), weekEnd = ymd(addDays(sundayOf(new Date()), 6));
    const buckets = [['지남', []], ['오늘', []], ['내일', []], ['이번 주', []], ['나중', []], ['기한 없음', []]];
    for (const t of shown) {
      const d = t.due;
      const i = !d ? 5 : d < today ? 0 : d === today ? 1 : d === tomorrow ? 2 : d <= weekEnd ? 3 : 4;
      buckets[i][1].push(t);
    }
    for (const [, items] of buckets) items.sort((a, b) => (a.due || '').localeCompare(b.due || '') || b.ds.localeCompare(a.ds));
    box.replaceChildren(...buckets.filter(([, it]) => it.length).map(([title, it]) => section(`${title} · ${it.length}`, it)));
  } else {
    const byDate = new Map();
    for (const t of shown) { if (!byDate.has(t.ds)) byDate.set(t.ds, []); byDate.get(t.ds).push(t); }
    box.replaceChildren(...[...byDate].map(([ds, it]) => {
      const d = parseYmd(ds);
      return section(`${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})`, it, ds);
    }));
  }
}

// ---------- 음력·공휴일 (브라우저 내장 한국 음력 '단기' 달력 사용)
const lunarFmt = (() => {
  try { return new Intl.DateTimeFormat('ko-KR-u-ca-dangi', { month: 'numeric', day: 'numeric' }); } catch { return null; }
})();
const lunarCache = new Map();
function lunarOf(d) {
  const k = ymd(d);
  if (lunarCache.has(k)) return lunarCache.get(k);
  let v = null;
  if (lunarFmt) {
    const parts = lunarFmt.formatToParts(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12));
    const mon = parts.find((p) => p.type === 'month')?.value || '';
    const day = parts.find((p) => p.type === 'day')?.value;
    v = { leap: /윤|bis/.test(mon), m: parseInt(mon.replace(/\D/g, ''), 10), d: parseInt(day, 10) };
  }
  lunarCache.set(k, v);
  return v;
}

const holidayCache = new Map();
function holidaysOf(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const h = new Map();
  const set = (d, name) => h.set(ymd(d), h.has(ymd(d)) ? h.get(ymd(d)) + '·' + name : name);
  const solar = [[1, 1, '신정'], [3, 1, '삼일절'], [5, 5, '어린이날'], [6, 6, '현충일'], [8, 15, '광복절'], [10, 3, '개천절'], [10, 9, '한글날'], [12, 25, '성탄절']];
  for (const [mm, dd, name] of solar) set(new Date(y, mm - 1, dd), name);
  // 음력 공휴일: 설날(전날·당일·다음날), 부처님오신날, 추석(전날·당일·다음날)
  const lunarDays = [];
  if (lunarFmt) {
    for (let d = new Date(y, 0, 1); d.getFullYear() === y; d = addDays(d, 1)) {
      const l = lunarOf(d);
      if (!l || l.leap) continue;
      if (l.m === 1 && l.d === 1) lunarDays.push(['설날', d]);
      if (l.m === 4 && l.d === 8) set(d, '부처님오신날');
      if (l.m === 8 && l.d === 15) lunarDays.push(['추석', d]);
    }
  }
  const blocks = [];
  for (const [name, d] of lunarDays) {
    const days = [addDays(d, -1), d, addDays(d, 1)];
    days.forEach((x, i) => set(x, i === 1 ? name : `${name} 연휴`));
    blocks.push(days);
  }
  // 대체공휴일: 설·추석 연휴가 일요일(또는 다른 공휴일)과 겹치면, 어린이날·국경일·부처님오신날·성탄절은 토·일과 겹치면 다음 평일
  const isOff = (d) => d.getDay() === 0 || d.getDay() === 6 || h.has(ymd(d));
  const nextFree = (d) => { let x = addDays(d, 1); while (isOff(x)) x = addDays(x, 1); return x; };
  for (const days of blocks) {
    const overlap = days.filter((x) => x.getDay() === 0 || solar.some(([mm, dd]) => x.getMonth() === mm - 1 && x.getDate() === dd)).length;
    let last = days[2];
    for (let i = 0; i < overlap; i++) { last = nextFree(last); set(last, '대체공휴일'); }
  }
  const weekendRule = [[3, 1], [5, 5], [8, 15], [10, 3], [10, 9], [12, 25]].map(([mm, dd]) => new Date(y, mm - 1, dd));
  for (const [k, name] of [...h]) if (name.includes('부처님오신날')) weekendRule.push(parseYmd(k));
  for (const d of weekendRule) {
    const wknd = d.getDay() === 0 || d.getDay() === 6;
    const clash = (h.get(ymd(d)) || '').includes('·');
    if (wknd || clash) set(nextFree(d), '대체공휴일');
  }
  holidayCache.set(y, h);
  return h;
}
const holidayOn = (d) => (hiddenCals().has(HOLIDAY_CAL) ? null : holidaysOf(d.getFullYear()).get(ymd(d)) || null);

function lunarLabel(d) {
  const mode = store.get('lunar', 'key');
  if (mode === 'off') return '';
  const l = lunarOf(d);
  if (!l) return '';
  if (mode === 'key' && l.d !== 1 && l.d !== 15) return '';
  return `${l.leap ? '윤' : ''}${l.m}.${l.d}`;
}

// ---------- 전체 검색: 메모·변환된 손글씨·할 일·일정
const searchState = { token: 0, events: null };
function openSearch() {
  $('#search-ov').classList.remove('hidden');
  $('#search-input').value = '';
  $('#search-results').replaceChildren(el('p', 'muted-text', '메모·손글씨·할 일·일정 제목에서 찾아요.'));
  setTimeout(() => $('#search-input').focus(), 30);
  // 일정은 앞뒤 6개월치를 한 번 불러둠
  if (!searchState.events) {
    const s = addDays(new Date(), -183), e = addDays(new Date(), 183);
    events.load(s, e).then((list) => { searchState.events = list; }).catch(() => { searchState.events = []; });
  }
}

function markText(text, q) {
  const span = el('span');
  const lower = text.toLowerCase();
  let i = 0, j;
  while ((j = lower.indexOf(q, i)) >= 0) {
    span.append(document.createTextNode(text.slice(i, j)), el('mark', null, text.slice(j, j + q.length)));
    i = j + q.length;
  }
  span.append(document.createTextNode(text.slice(i)));
  return span;
}

async function runSearch() {
  const q = $('#search-input').value.trim().toLowerCase();
  const box = $('#search-results');
  const token = ++searchState.token;
  if (!q) { box.replaceChildren(el('p', 'muted-text', '메모·손글씨·할 일·일정 제목에서 찾아요.')); return; }
  const hits = [];
  const dates = allNoteDates();
  box.replaceChildren(el('p', 'muted-text', `찾는 중… (0/${dates.length})`));
  let n = 0;
  for (const ds of dates) {
    let doc = listState.cache.get(ds) || noteIndex.doc(ds);
    if (!doc) {
      try { doc = await notes.get(ds); listState.cache.set(ds, doc); } catch { continue; }
      if (token !== searchState.token) return;
    }
    if (++n % 20 === 0) box.firstChild && (box.firstChild.textContent = `찾는 중… (${n}/${dates.length})`);
    for (const p of doc.pages) {
      const txt = p.kind === 'text' || p.kind === 'voice' ? p.text || '' : p.kind === 'photo' ? '' : p.ocr?.text || '';
      for (const line of txt.split('\n')) {
        if (!line.toLowerCase().includes(q)) continue;
        const isTodo = TODO_RE.test(line);
        hits.push({ ds, type: isTodo ? '할 일' : p.kind === 'text' ? '메모' : p.kind === 'voice' ? '음성' : '손글씨', text: line.replace(TODO_RE, '$3').trim() });
      }
    }
  }
  for (const ev of [...(searchState.events || []), ...memos.visible(new Date(2000, 0, 1), new Date(2100, 0, 1))].filter((x) => !hiddenCals().has(calKey(x)))) {
    if (ev.title.toLowerCase().includes(q)) hits.push({ ds: ymd(ev.start), type: '일정', text: (ev.allDay ? '' : hm(ev.start) + ' ') + ev.title });
  }
  if (token !== searchState.token) return;
  const seen = new Set();
  const uniq = hits.filter((h) => { const k = h.ds + h.type + h.text; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => b.ds.localeCompare(a.ds)).slice(0, 150);
  if (!uniq.length) { box.replaceChildren(el('p', 'muted-text', '찾는 내용이 없어요.')); return; }
  box.replaceChildren(el('p', 'muted-text', `${uniq.length}개 찾음`), ...uniq.map((h) => {
    const d = parseYmd(h.ds);
    const b = el('button', 'search-hit');
    b.append(el('span', 'search-date', `${d.getFullYear() === new Date().getFullYear() ? '' : d.getFullYear() + '. '}${d.getMonth() + 1}/${d.getDate()} (${WD[d.getDay()]})`), el('span', 'search-type', h.type), markText(h.text, q));
    b.onclick = () => { $('#search-ov').classList.add('hidden'); openDay(h.ds); };
    return b;
  }));
}

// ---------- 내보내기: 마크다운 파일 / PDF(인쇄) / 공유
function openExport() {
  const today = new Date();
  const from = el('input'); from.type = 'date';
  const to = el('input'); to.type = 'date';
  const setRange = (a, b) => { from.value = ymd(a); to.value = ymd(b); };
  const base = state.view === 'day' && state.date ? parseYmd(state.date) : today;
  setRange(base, base);
  const quick = el('div', 'settings-btns');
  for (const [label, fn] of [
    ['이 날짜', () => setRange(base, base)],
    ['이번 주', () => setRange(sundayOf(base), addDays(sundayOf(base), 6))],
    ['이번 달', () => setRange(new Date(base.getFullYear(), base.getMonth(), 1), new Date(base.getFullYear(), base.getMonth() + 1, 0))],
  ]) { const b = el('button', 'pill', label); b.onclick = fn; quick.append(b); }
  const range = el('div', 'export-range');
  range.append(from, el('span', null, '~'), to);
  const acts = el('div', 'settings-btns');
  const mk = (label, cls, fn) => { const b = el('button', 'pill ' + cls, label); b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e) { handleErr(e); } finally { b.disabled = false; } }; acts.append(b); };
  mk('마크다운 저장', 'primary', () => exportRange(from.value, to.value, 'md'));
  mk('PDF로 인쇄·저장', '', () => exportRange(from.value, to.value, 'pdf'));
  if (navigator.share) mk('공유', '', () => exportRange(from.value, to.value, 'share'));
  openModal('내보내기', [el('p', 'muted-text', '메모·변환된 손글씨·할 일·일정을 한 파일로 모아요. 손글씨와 사진은 그림으로 들어가요.'), quick, range, acts]);
}

async function collectExport(fromDs, toDs) {
  if (!fromDs || !toDs || fromDs > toDs) throw new Error('기간을 확인해 주세요');
  const days = [];
  const evs = await events.load(parseYmd(fromDs), addDays(parseYmd(toDs), 1)).catch(() => []);
  for (let d = parseYmd(fromDs); ymd(d) <= toDs; d = addDays(d, 1)) {
    const ds = ymd(d);
    const dayEvs = events.on(evs, d);
    const doc = notes.has(ds) ? await notes.get(ds) : null;
    if (!dayEvs.length && !doc) continue;
    const blocks = [];
    for (const p of doc?.pages || []) {
      if (p.kind === 'text' && (p.text || '').trim()) blocks.push({ type: 'text', text: p.text.trim() });
      else if (p.kind === 'voice') { if ((p.text || '').trim()) blocks.push({ type: 'text', label: '음성 메모', text: p.text.trim() }); }
      else if (p.kind === 'photo') { for (const m of p.media || []) { const url = await mediaDataUrl(m).catch(() => null); if (url) blocks.push({ type: 'img', url, label: '사진' }); } }
      else if (p.strokes.length) {
        const wasDark = darkInk;
        blocks.push({ type: 'img', url: 'data:image/png;base64,' + noteImage(p), label: '손글씨' });
        darkInk = wasDark;
        if (p.ocr?.text) blocks.push({ type: 'text', label: '손글씨를 글자로', text: p.ocr.text.trim() });
      }
    }
    days.push({ ds, d, evs: dayEvs, blocks });
  }
  return days;
}

function exportMarkdown(days) {
  const out = [];
  for (const { d, evs, blocks } of days) {
    out.push(`## ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} (${WD[d.getDay()]})`, '');
    if (evs.length) { out.push('**일정**'); for (const e of evs) out.push(`- ${e.allDay ? '종일' : hm(e.start)} ${e.title}`); out.push(''); }
    for (const b of blocks) {
      if (b.label) out.push(`**${b.label}**`);
      if (b.type === 'img') out.push(`![${b.label}](${b.url})`);
      else out.push(b.text.replace(/^☐ /gm, '- [ ] ').replace(/^☑ /gm, '- [x] '));
      out.push('');
    }
  }
  return out.join('\n');
}

function exportHtml(days, title) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const body = days.map(({ d, evs, blocks }) => `<section><h2>${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})</h2>` +
    (evs.length ? `<ul class="ev">${evs.map((e) => `<li>${e.allDay ? '종일' : hm(e.start)} ${esc(e.title)}</li>`).join('')}</ul>` : '') +
    blocks.map((b) => (b.label ? `<h3>${esc(b.label)}</h3>` : '') + (b.type === 'img' ? `<img src="${b.url}">` : `<pre>${esc(b.text)}</pre>`)).join('') + '</section>').join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font-family:-apple-system,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;color:#1f2328;margin:24px}
h1{font-size:20px}h2{font-size:16px;border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:24px}h3{font-size:13px;color:#555;margin:10px 0 4px}
pre{white-space:pre-wrap;font:inherit;margin:0}img{max-width:100%;max-height:420px;border:1px solid #eee;border-radius:6px}
.ev{margin:4px 0 8px;padding-left:18px;color:#444}section{break-inside:avoid-page}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;
}

async function exportRange(fromDs, toDs, how) {
  const days = await collectExport(fromDs, toDs);
  if (!days.length) return toast('그 기간에는 메모·일정이 없어요');
  const title = fromDs === toDs ? `필기캘린더 ${fromDs}` : `필기캘린더 ${fromDs} ~ ${toDs}`;
  if (how === 'pdf') {
    // 숨긴 틀에 그려서 인쇄 창 → 'PDF로 저장' 선택
    const f = el('iframe');
    f.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
    document.body.append(f);
    f.contentDocument.open();
    f.contentDocument.write(exportHtml(days, title));
    f.contentDocument.close();
    await new Promise((r) => setTimeout(r, 400));
    f.contentWindow.focus();
    f.contentWindow.print();
    setTimeout(() => f.remove(), 60000);
    return;
  }
  const md = `# ${title}\n\n` + exportMarkdown(days);
  const file = new File([md], `${title.replace(/[\s~]+/g, '_')}.md`, { type: 'text/markdown' });
  if (how === 'share' && navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title });
    return;
  }
  const a = el('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('파일로 저장했어요');
}

async function toggleTodo(ds, t, done, row) {
  const doc = listState.cache.get(ds) || (await notes.get(ds));
  if (!setTodoDone(doc, t, done)) return toast('메모가 바뀌어서 다시 불러올게요');
  t.done = done;
  row.classList.toggle('done', done);
  try {
    await notes.put(ds, cloneDoc(doc));
    refreshDigest(ds, doc);
  } catch (e) { handleErr(e); }
  // 완료한 항목은 잠깐 보여준 뒤 목록에서 정리
  setTimeout(() => { if (state.calView === 'todo' && state.view === 'month') renderTodos(); }, done && !todoState.showDone ? 700 : 0);
}

// 완료한 할 일을 메모에서 한 번에 정리 (타자·음성 메모는 완료 줄 제거, 손글씨 OCR은 완료 항목 제거)
async function clearDoneTodos() {
  const dates = allNoteDates();
  let total = 0;
  for (const ds of dates) {
    const doc = listState.cache.get(ds) || noteIndex.doc(ds) || (await notes.get(ds).catch(() => null));
    if (doc) total += (noteIndex.get(ds)?.todos || todosOf(doc, ds)).filter((t) => t.done).length;
  }
  if (!total) return toast('정리할 완료된 할 일이 없어요');
  if (!confirm(`완료한 할 일 ${total}개를 메모에서 지울까요?`)) return;
  let removed = 0;
  for (const ds of dates) {
    const doc = listState.cache.get(ds) || (await notes.get(ds).catch(() => null));
    if (!doc) continue;
    let changed = false;
    for (const p of doc.pages) {
      if (p.kind === 'text' || p.kind === 'voice') {
        const lines = (p.text || '').split('\n');
        const kept = lines.filter((line) => {
          const m = TODO_RE.exec(line);
          if (m && m[3].trim() && /[xX☑✅]/.test(m[2])) { removed++; changed = true; return false; }
          return true;
        });
        if (kept.length !== lines.length) p.text = kept.join('\n');
      } else if (p.ocr?.todos?.length) {
        const nextTodos = [], nextDone = [];
        p.ocr.todos.forEach((t, i) => {
          if (p.ocr.done?.[i]) { removed++; changed = true; }
          else { nextTodos.push(t); nextDone.push(false); }
        });
        p.ocr.todos = nextTodos;
        p.ocr.done = nextDone;
      }
    }
    if (changed) {
      await notes.put(ds, cloneDoc(doc));
      listState.cache.set(ds, doc);
      refreshDigest(ds, doc);
    }
  }
  toast(`완료한 할 일 ${removed}개를 정리했어요`);
  renderTodos();
}

// 타자 메모 아래: 이 메모의 할 일을 바로 체크
function renderTextTodos() {
  const box = $('#text-todos');
  const page = pad.note;
  const todos = page.kind === 'text' ? todosOf({ pages: [page] }) : [];
  box.classList.toggle('hidden', !todos.length);
  if (!todos.length) { box.replaceChildren(); return; }
  const left = todos.filter((t) => !t.done).length;
  const open = store.get('textTodosOpen', false);
  const head = el('button', 'text-todos-head', `할 일 ${todos.length} · 남음 ${left} ${open ? '▾' : '▸'}`);
  head.setAttribute('aria-expanded', String(open));
  head.onclick = () => { store.set('textTodosOpen', !open); renderTextTodos(); };
  if (!open) { box.replaceChildren(head); return; }
  box.replaceChildren(head, ...todos.map((t) => {
    const row = el('label', 'todo-row' + (t.done ? ' done' : ''));
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = t.done;
    cb.onchange = () => {
      if (!setTodoDone(pad.doc, t, cb.checked)) return renderTextTodos();
      const ta = $('#text-page');
      ta.value = page.text;
      saveSoon();
      renderTextTodos();
    };
    row.append(cb, el('span', 'todo-text', t.text));
    return row;
  }));
}

// 할 일 화면에서 바로 추가 → 오늘 날짜의 타자 메모 끝에 '☐ 내용'
// 그 날짜의 타자 메모 탭 끝에 '☐ 내용'을 붙임 (탭이 없으면 만듦). 붙인 탭을 돌려줌, 탭이 가득이면 null
function appendTodoLine(doc, text) {
  let page = doc.pages.find((p) => p.kind === 'text');
  if (!page) {
    const empty = doc.pages.find((p) => !p.strokes.length && p.kind !== 'text');
    if (empty) Object.assign(empty, { kind: 'text', text: '' });
    else if (doc.pages.length < MAX_TABS) doc.pages.push(blankPage('text'));
    else return null;
    page = doc.pages.find((p) => p.kind === 'text');
  }
  page.text = (page.text && !page.text.endsWith('\n') ? page.text + '\n' : page.text || '') + '☐ ' + text;
  return page;
}

async function quickAddTodo(text) {
  text = text.trim();
  if (!text) return;
  const ds = ymd(new Date());
  const doc = await notes.get(ds);
  if (!appendTodoLine(doc, text)) return toast(`오늘 탭이 ${MAX_TABS}개로 가득 찼어요`);
  await notes.put(ds, cloneDoc(doc));
  listState.cache.set(ds, doc);
  refreshDigest(ds, doc);
  renderTodos();
}

// 타자 메모에서 할 일 줄 넣기 / 할 일 줄에서 엔터 치면 다음 줄도 ☐
function insertTodo() {
  const ta = $('#text-page');
  // 입력칸에 커서가 없으면 맨 끝에 추가
  if (document.activeElement !== ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  const pos = ta.selectionStart, v = ta.value;
  const lineStart = v.lastIndexOf('\n', pos - 1) + 1;
  const line = v.slice(lineStart, v.indexOf('\n', pos) < 0 ? v.length : v.indexOf('\n', pos));
  if (TODO_RE.test(line)) { ta.focus(); return; }
  if (line.trim()) {
    ta.setRangeText('\n☐ ', pos, pos, 'end');
  } else {
    ta.setRangeText('☐ ', lineStart, lineStart, 'end');
  }
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}

async function renderMonthView() {
  const y = state.month.getFullYear(), m = state.month.getMonth();
  // 휴대폰처럼 좁으면 '11월'처럼 짧게 (올해가 아니면 연도 붙임)
  $('#month-title').textContent = window.matchMedia('(max-width: 599px)').matches
    ? `${y === new Date().getFullYear() ? '' : y + '.'}${m + 1}월`
    : `${y}년 ${m + 1}월`;
  const { start, end, weeks } = monthRange();
  const grid = $('#grid');
  grid.style.setProperty('--rows', weeks);
  const cellH = (grid.clientHeight || 600) / weeks;
  const anyDigest = Array.from({ length: weeks * 7 }, (_, i) => digests.get(ymd(addDays(start, i)))).some(Boolean);
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const chipH = rem * 1.16 + 2;
  const maxChips = Math.max(1, Math.floor((cellH - rem * 2.2 - (anyDigest ? chipH : 0)) / chipH));
  const evs = events.cached(start, end);
  const today = ymd(new Date());
  const frag = document.createDocumentFragment();

  // 주마다 일정을 줄(lane)에 배치: 여러 날에 걸친 일정은 같은 줄에 길게 이어서 그림
  const weekLayouts = [];
  if (evs) {
    for (let w = 0; w < weeks; w++) {
      const spans = new Map(); // ev -> { first, last }
      for (let i = 0; i < 7; i++) {
        for (const ev of events.on(evs, addDays(start, w * 7 + i))) {
          const sp = spans.get(ev);
          if (sp) sp.last = i; else spans.set(ev, { ev, first: i, last: i });
        }
      }
      const items = [...spans.values()].sort((a, b) =>
        (a.first - b.first) || ((b.last - b.first) - (a.last - a.first)) || sortEvents(a.ev, b.ev));
      const lanes = []; // lanes[l][day] = item
      for (const it of items) {
        let l = 0;
        while (lanes[l] && lanes[l].slice(it.first, it.last + 1).some(Boolean)) l++;
        if (!lanes[l]) lanes[l] = new Array(7).fill(null);
        for (let i = it.first; i <= it.last; i++) lanes[l][i] = it;
        it.lane = l;
      }
      const overflow = lanes.length > maxChips;
      weekLayouts.push({ lanes, visible: overflow ? Math.max(1, maxChips - 1) : lanes.length, overflow });
    }
  }

  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(start, i), ds = ymd(d), wd = d.getDay();
    const cell = el('div', 'cell');
    if (d.getMonth() !== m) cell.classList.add('other');
    if (ds === today) cell.classList.add('today');
    cell.dataset.date = ds;
    const head = el('div', 'cell-head');
    const hol = holidayOn(d);
    head.append(el('span', 'num' + (wd === 0 || hol ? ' sun' : wd === 6 ? ' sat' : ''), String(d.getDate())));
    const lun = lunarLabel(d);
    if (lun) head.append(el('span', 'lunar', lun));
    if (notes.has(ds)) head.append(inkIcon());
    cell.append(head);
    // 공휴일 이름 (네이버 일정에 같은 이름이 있으면 생략)
    if (hol && !(evs && events.on(evs, d).some((e) => hol.split('·').some((h) => e.title.includes(h.replace(' 연휴', '')))))) {
      cell.append(el('div', 'hol', hol));
    }
    if (evs) {
      const { lanes, visible } = weekLayouts[Math.floor(i / 7)];
      const col = i % 7;
      let lastUsed = -1;
      for (let l = 0; l < visible; l++) if (lanes[l][col]) lastUsed = l;
      for (let l = 0; l <= lastUsed; l++) {
        const it = lanes[l][col];
        if (!it || it.first !== col) { cell.append(el('div', 'chip spacer', ' ')); continue; }
        const n = it.last - it.first + 1;
        const chip = el('div', 'chip', it.ev.title);
        chip.style.setProperty('--c', it.ev.color);
        chip.style.setProperty('--chip-text', textOn(it.ev.color));
        // 지난주/다음주로 이어지는 일정은 그쪽 끝을 칸 끝까지 붙이고 모서리를 각지게
        const contL = it.first === 0 && ymd(it.ev.start) < ds;
        const contR = it.last === 6 && events.on([it.ev], addDays(start, Math.floor(i / 7) * 7 + 7)).length > 0;
        if (contL) chip.classList.add('cont-left');
        if (contR) chip.classList.add('cont-right');
        if (n > 1 || contL || contR) {
          chip.classList.add('span');
          chip.style.width = `calc(${n * 100}% + ${(n - 1) * 9 + (contL ? 4 : 0) + (contR ? 4 : 0)}px)`;
        }
        cell.append(chip);
      }
      let hidden = 0;
      for (let l = visible; l < lanes.length; l++) if (lanes[l][col]) hidden++;
      if (hidden) cell.append(el('div', 'more', `+${hidden}개`));
    }
    const dg = !hiddenCals().has(MEMO_CAL) ? digests.get(ds) : null;
    if (dg?.text) {
      const line = el('div', 'digest', dg.text);
      if (dg.todos) line.prepend(el('span', 'digest-todo', `☐${dg.todos} `));
      line.title = dg.text;
      cell.append(line);
    }
    frag.append(cell);
  }
  grid.replaceChildren(frag);

  if (!evs || !events.fresh(start, end)) {
    const token = ++monthToken;
    const ver = events.version;
    try {
      await events.load(start, end);
      if (token === monthToken && state.view === 'month' && state.calView === 'month' && (!evs || events.version !== ver)) renderMonth();
    } catch (e) { handleErr(e); }
  }
  events.prefetch(addDays(start, -35), addDays(end, 42));
}

function shiftMonth(n) {
  if (state.calView === 'week') state.weekStart = addDays(state.weekStart, 7 * n);
  else state.month = new Date(state.month.getFullYear(), state.month.getMonth() + n, 1);
  renderMonth();
}

// 달 넘김 모션: 지금 달이 옆으로 빠지고 새 달이 반대쪽에서 들어옴 (손가락으로 끌던 위치에서 이어짐)
let monthAnimating = false;
function animateMonth(dir) {
  if (state.calView === 'list') return;
  const grid = $(state.calView === 'week' ? '#week-grid' : '#grid');
  if (monthAnimating) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    grid.style.transform = '';
    shiftMonth(dir);
    return;
  }
  monthAnimating = true;
  const w = grid.clientWidth;
  grid.style.transition = 'transform .18s ease-in, opacity .18s ease-in';
  grid.style.transform = `translateX(${dir > 0 ? -w : w}px)`;
  grid.style.opacity = '0.2';
  setTimeout(() => {
    shiftMonth(dir);
    grid.style.transition = 'none';
    grid.style.transform = `translateX(${dir > 0 ? w * 0.6 : -w * 0.6}px)`;
    void grid.offsetWidth;
    grid.style.transition = 'transform .24s ease-out, opacity .24s ease-out';
    grid.style.transform = '';
    grid.style.opacity = '';
    setTimeout(() => { grid.style.transition = ''; monthAnimating = false; }, 250);
  }, 180);
}

// ---------- 하루 화면 (필기)
function isIPad() {
  return /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

const pad = {
  canvas: null, ctx: null, overlay: null, octx: null,
  scale: 1, dpr: 1,
  doc: blankNote(), pageIdx: 0, loading: false,
  get note() { return this.doc.pages[this.pageIdx] || this.doc.pages[0]; },
  undo: [], redo: [],
  tool: 'pen',
  colors: store.get('colors', { pen: COLORS[0], hl: '#facc15' }),
  sizeIdx: store.get('sizeIdx', 1),
  // 손가락은 기본으로 화면 이동, 필기는 펜으로만
  fingerDraw: store.get('fingerDraw2', false),
  recentTouch: [],
  penSeen: store.get('penSeen', false),
  active: null,
  scroll: null,
  rafPending: false,
  lastEdit: 0,
  hover: null,
};

function layoutPad() {
  const kind = pad.note.kind;
  const isMedia = kind === 'photo' || kind === 'voice';
  const isText = kind === 'text';
  const ta = $('#text-page');
  $('#media-page').classList.toggle('hidden', !isMedia);
  if (isMedia) {
    $('#day-view').classList.add('text-mode');
    $('.page-wrap').classList.add('hidden');
    $('#add-page').classList.add('hidden');
    ta.classList.add('hidden');
    $('#text-todos').classList.add('hidden');
    ta.dataset.pageId = '';
    if ($('#media-page').dataset.pageId !== pad.note.id || !$('#media-page').children.length) {
      $('#media-page').dataset.pageId = pad.note.id;
      renderMediaPage();
    }
    return;
  }
  $('#media-page').dataset.pageId = '';
  $('#day-view').classList.toggle('text-mode', isText);
  $('.page-wrap').classList.toggle('hidden', isText);
  $('#add-page').classList.toggle('hidden', isText);
  ta.classList.toggle('hidden', !isText);
  if (isText) {
    if (ta.dataset.pageId !== pad.note.id) { ta.value = pad.note.text || ''; ta.dataset.pageId = pad.note.id; }
    renderTextTodos();
    return;
  }
  $('#text-todos').classList.add('hidden');
  ta.dataset.pageId = '';
  const wrap = $('#page-scroll');
  if (!wrap.clientWidth) return;
  const cssW = Math.round(Math.max(280, Math.min(wrap.clientWidth - 24, 1100)) * (pad.zoom || 1));
  pad.scale = cssW / PAGE_W;
  $('#paper-select').value = pad.note.paper || 'lined';
  const cssH = Math.round(pad.note.height * pad.scale);
  pad.dpr = Math.min(Math.max(window.devicePixelRatio || 1, 2), Math.sqrt(16e6 / (cssW * cssH)));
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

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// 다크 모드에서는 검은 잉크를 밝게 보여줌 (저장되는 색은 그대로). AI 변환 이미지는 항상 밝은 바탕
let darkInk = false;
const DARK_INK = { '#1f2328': '#e8eaed' };
const inkColor = (c) => (darkInk && DARK_INK[c]) || c;

function drawPaper(ctx) {
  ctx.save();
  drawPaperKind(ctx);
  ctx.strokeStyle = cssVar('--page-break');
  ctx.setLineDash([10, 10]);
  ctx.beginPath();
  for (let y = PAGE_H; y < pad.note.height; y += PAGE_H) { ctx.moveTo(0, y); ctx.lineTo(PAGE_W, y); }
  ctx.stroke();
  ctx.restore();
}

// 획을 부드럽게: 손떨림 보정 → 필압(펜) 또는 속도(손가락·마우스)로 굵기 → 외곽선을 채워서 그림
// 촘촘한 점(손떨림)만 다듬고, 크게 움직인 곳은 모양을 그대로 둠
function smoothPoints(p, k = 0.45, scale = 4) {
  if (p.length < 3) return p.map((q) => q.slice());
  const out = [p[0].slice()];
  for (let i = 1; i < p.length; i++) {
    const a = out[i - 1], b = p[i];
    const d = Math.hypot(b[0] - p[i - 1][0], b[1] - p[i - 1][1]);
    const kk = k * Math.max(0, 1 - d / scale);
    out.push([a[0] + (b[0] - a[0]) * (1 - kk), a[1] + (b[1] - a[1]) * (1 - kk), b[2]]);
  }
  out[out.length - 1] = p[p.length - 1].slice(); // 끝점은 손을 뗀 자리 그대로
  return out;
}

function drawStroke(ctx, s, live = false) {
  const p = s.points;
  if (!p.length) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = ctx.fillStyle = inkColor(s.color);
  if (s.tool === 'hl') {
    const q = smoothPoints(uniquePoints(p), 0.5);
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = s.size;
    ctx.beginPath();
    ctx.moveTo(q[0][0], q[0][1]);
    if (q.length === 1) ctx.lineTo(q[0][0] + 0.1, q[0][1]);
    for (let i = 1; i < q.length - 1; i++) {
      ctx.quadraticCurveTo(q[i][0], q[i][1], (q[i][0] + q[i + 1][0]) / 2, (q[i][1] + q[i + 1][1]) / 2);
    }
    if (q.length > 1) ctx.lineTo(q[q.length - 1][0], q[q.length - 1][1]);
    ctx.stroke();
  } else {
    ctx.fill(penPath(s, live));
  }
  ctx.restore();
}

// 펜 획을 매끄러운 외곽선(Path2D)으로 변환. 완성된 획은 캐시
let pathCache = new WeakMap(); // 압력 설정을 바꾸면 새로 만듦
function penPath(s, live) {
  if (!live && pathCache.has(s)) return pathCache.get(s);
  const pts = inkPoints(s);
  const outline = window.PerfectFreehand.getStroke(live ? pts.concat(pad.active?.predicted || []) : pts, {
    size: s.size * 1.2,
    thinning: 0.5,
    smoothing: 0.6,
    streamline: 0.45,
    simulatePressure: false,
    last: !live,
  });
  const path = new Path2D();
  if (outline.length) {
    path.moveTo(outline[0][0], outline[0][1]);
    for (let i = 1; i < outline.length; i++) {
      const [x0, y0] = outline[i], [x1, y1] = outline[(i + 1) % outline.length];
      path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    }
    path.closePath();
  }
  if (!live) pathCache.set(s, path);
  return path;
}

// 압력값 보정: 애플 펜슬은 가볍게 쓰면 0.05~0.2 정도라 너무 가늘어지므로 범위를 넓힘
// 예전 버전에 중복 저장된 좌표(같은 구간이 반복됨) 제거
function uniquePoints(points) {
  const seen = new Set();
  return points.filter((q) => {
    const k = q[0] + ',' + q[1];
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function inkPoints(s) {
  const p = uniquePoints(s.points);
  const isPen = s.pen ?? !p.every((q) => q[2] === 0.5);
  if (!isPen) return p.map((q) => [q[0], q[1], 0.5]);
  const pr = p.map((q) => q[2]);
  // 예전 버전은 압력 0을 0.5로 잘못 저장했음 → 그런 값은 주변 압력으로 채움
  if (s.pen === undefined) {
    const real = pr.filter((v) => v !== 0.5).sort((x, y) => x - y);
    if (real.length && real[real.length >> 1] < 0.35) {
      let lastReal = real[real.length >> 1];
      for (let i = 0; i < pr.length; i++) {
        if (pr[i] === 0.5) pr[i] = lastReal;
        else lastReal = pr[i];
      }
    }
  }
  const [base, mult] = pressureCurve();
  return p.map((q, i) => [q[0], q[1], Math.min(1, base + pr[i] * mult)]);
}

function redraw(skip) {
  darkInk = cssVar('--is-dark') === '1';
  setTransform(pad.ctx);
  drawPaper(pad.ctx);
  for (const s of pad.note.strokes) if (!skip?.has(s)) drawStroke(pad.ctx, s);
  renderOverlay();
}

function renderOverlay() {
  pad.rafPending = false;
  setTransform(pad.octx);
  if (pad.active?.stroke) drawStroke(pad.octx, pad.active.stroke, true);
  if (lasso.path || lasso.sel.size) lassoOverlay(pad.octx);
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
  let pr = 0.5;
  if (e.pointerType === 'pen') {
    // 펜이 닿는 순간/떼는 순간에는 압력이 0으로 오므로 직전 값을 사용
    const last = pad.active?.stroke?.points.at(-1);
    pr = e.pressure > 0 ? e.pressure : last ? last[2] : 0.15;
  }
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

// ---------- 확대·축소: 두 손가락 벌리기, Ctrl+휠, 도구 줄 [−][100%][+]
function setZoom(z, focus) {
  z = Math.max(0.5, Math.min(3, Math.round(z * 100) / 100));
  if (z === pad.zoom) return;
  const sc = $('#page-scroll');
  const r = sc.getBoundingClientRect();
  const fx = focus ? focus.x - r.left : sc.clientWidth / 2, fy = focus ? focus.y - r.top : sc.clientHeight / 2;
  // 손가락 사이(또는 화면 가운데)에 있던 자리가 그대로 보이게
  const rx = (sc.scrollLeft + fx) / Math.max(1, sc.scrollWidth), ry = (sc.scrollTop + fy) / Math.max(1, sc.scrollHeight);
  pad.zoom = z;
  layoutPad();
  sc.scrollLeft = rx * sc.scrollWidth - fx;
  sc.scrollTop = ry * sc.scrollHeight - fy;
  $('#zoom-label').textContent = Math.round(z * 100) + '%';
}

const pinch = { pts: new Map(), start: null, raf: 0 };
function pinchDown(e) {
  pinch.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch.pts.size === 2) {
    const [a, b] = [...pinch.pts.values()];
    pinch.start = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: pad.zoom };
    // 두 번째 손가락이 닿으면 그리던·밀던 것은 취소하고 확대로
    if (pad.active?.pointerType === 'touch') { pad.active = null; requestOverlay(); }
    pad.scroll = null;
    return true;
  }
  return false;
}
function pinchMove(e) {
  if (!pinch.pts.has(e.pointerId)) return false;
  pinch.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!pinch.start || pinch.pts.size < 2) return false;
  const [a, b] = [...pinch.pts.values()];
  const z = pinch.start.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.start.d);
  cancelAnimationFrame(pinch.raf);
  pinch.raf = requestAnimationFrame(() => setZoom(z, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }));
  return true;
}
function pinchUp(e) {
  const was = pinch.start;
  pinch.pts.delete(e.pointerId);
  if (pinch.pts.size < 2) pinch.start = null;
  return !!was;
}

// ---------- 종이 배경 (탭마다): 줄 / 모눈 / 점 / 무지
function drawPaperKind(ctx) {
  const kind = pad.note.paper || 'lined';
  const h = pad.note.height;
  ctx.strokeStyle = ctx.fillStyle = cssVar('--paper-line');
  ctx.lineWidth = 1;
  if (kind === 'lined') {
    ctx.beginPath();
    for (let y = 70; y < h; y += 50) { ctx.moveTo(40, y); ctx.lineTo(PAGE_W - 40, y); }
    ctx.stroke();
  } else if (kind === 'grid') {
    ctx.beginPath();
    for (let y = 40; y < h; y += 40) { ctx.moveTo(0, y); ctx.lineTo(PAGE_W, y); }
    for (let x = 40; x < PAGE_W; x += 40) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    ctx.stroke();
  } else if (kind === 'dot') {
    for (let y = 40; y < h; y += 40) for (let x = 40; x < PAGE_W; x += 40) { ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill(); }
  }
}

// ---------- 펜 압력 감도 (설정): 가볍게 쓰는 사람은 굵게 보정
const PRESSURE = { light: [0.32, 2.2], normal: [0.25, 1.6], heavy: [0.15, 1.1] };
function pressureCurve() { return PRESSURE[store.get('pressure', 'normal')] || PRESSURE.normal; }

// ---------- 올가미: 둘러싸서 옮기기·색 바꾸기·지우기
const lasso = {
  sel: new Set(),
  path: null,
  drag: null,
  active: null,
  bbox() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of this.sel) for (const p of s.points) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    const m = 12;
    return { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
  },
  clear() {
    this.sel.clear();
    this.path = null;
    this.drag = null;
    $('#sel-bar').classList.add('hidden');
    if (pad.ctx) { redraw(); requestOverlay(); }
  },
  showBar() {
    $('#sel-bar').classList.toggle('hidden', !this.sel.size);
    $('#sel-count').textContent = `${this.sel.size}개 선택`;
  },
};
function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function lassoDown(e) {
  const [x, y] = toPage(e);
  lasso.active = { id: e.pointerId };
  if (lasso.sel.size) {
    const b = lasso.bbox();
    if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) {
      // 선택한 것 옮기기 시작: 원래 자리에서는 잠시 지우고 덮개 화면에 따라 그림
      lasso.drag = { x, y, dx: 0, dy: 0 };
      redraw(lasso.sel);
      requestOverlay();
      return;
    }
  }
  lasso.sel.clear();
  lasso.showBar();
  redraw();
  lasso.path = [[x, y]];
  requestOverlay();
}
function lassoMove(e) {
  const [x, y] = toPage(e);
  if (lasso.drag) { lasso.drag.dx = x - lasso.drag.x; lasso.drag.dy = y - lasso.drag.y; }
  else if (lasso.path) lasso.path.push([x, y]);
  requestOverlay();
}
function lassoUp() {
  lasso.active = null;
  if (lasso.drag) {
    const { dx, dy } = lasso.drag;
    lasso.drag = null;
    if (Math.hypot(dx, dy) > 1) {
      pushUndo();
      const moved = new Set();
      pad.note.strokes = pad.note.strokes.map((s) => {
        if (!lasso.sel.has(s)) return s;
        const t = { ...s, points: s.points.map((p) => [Math.round((p[0] + dx) * 10) / 10, Math.round((p[1] + dy) * 10) / 10, p[2]]) };
        moved.add(t);
        return t;
      });
      lasso.sel = moved;
      saveSoon();
    }
    redraw();
    requestOverlay();
    return;
  }
  const poly = lasso.path || [];
  lasso.path = null;
  if (poly.length > 4) {
    for (const s of pad.note.strokes) {
      const inside = s.points.filter((p) => inPolygon(p[0], p[1], poly)).length;
      if (inside / s.points.length >= 0.5) lasso.sel.add(s);
    }
  }
  lasso.showBar();
  requestOverlay();
}
function lassoOverlay(ctx) {
  ctx.save();
  ctx.lineWidth = 1.5 / pad.scale;
  ctx.setLineDash([6 / pad.scale, 4 / pad.scale]);
  ctx.strokeStyle = cssVar('--accent');
  if (lasso.path) {
    ctx.beginPath();
    lasso.path.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
  }
  if (lasso.sel.size) {
    const dx = lasso.drag?.dx || 0, dy = lasso.drag?.dy || 0;
    if (lasso.drag) {
      ctx.save();
      ctx.translate(dx, dy);
      ctx.setLineDash([]);
      for (const s of lasso.sel) drawStroke(ctx, s);
      ctx.restore();
    }
    const b = lasso.bbox();
    ctx.strokeRect(b.x0 + dx, b.y0 + dy, b.x1 - b.x0, b.y1 - b.y0);
  }
  ctx.restore();
}
function recolorSelection(color) {
  if (!lasso.sel.size) return;
  pushUndo();
  const next = new Set();
  pad.note.strokes = pad.note.strokes.map((s) => {
    if (!lasso.sel.has(s)) return s;
    const t = { ...s, color };
    next.add(t);
    return t;
  });
  lasso.sel = next;
  redraw();
  requestOverlay();
  saveSoon();
}
function deleteSelection() {
  if (!lasso.sel.size) return;
  pushUndo();
  pad.note.strokes = pad.note.strokes.filter((s) => !lasso.sel.has(s));
  lasso.clear();
  saveSoon();
}

function capture(id) {
  try { pad.canvas.setPointerCapture(id); } catch { /* 이미 떨어진 포인터 */ }
}

function onPointerDown(e) {
  if (e.pointerType === 'touch' && pinchDown(e)) return;
  if (e.pointerType === 'pen') {
    // 손바닥이 먼저 닿아 그려지던 획은 취소
    if (pad.active?.pointerType === 'touch') { pad.active = null; requestOverlay(); }
    if (!pad.penSeen) {
      pad.penSeen = true;
      store.set('penSeen', true);
      dropRecentTouchStrokes();
      if (pad.fingerDraw) { setFingerDraw(false); toast('펜이 감지돼서 손가락은 화면 이동용으로 바꿨어요'); }
    }
  }
  if (e.pointerType === 'touch' && !pad.fingerDraw) {
    if (!pad.scroll) {
      pad.scroll = { id: e.pointerId, x: e.clientX, y: e.clientY };
      capture(e.pointerId);
    }
    return;
  }
  const eraserButton = e.button === 5 || (e.buttons & 32);
  if (pad.active || pad.loading || (e.button > 0 && !eraserButton)) return;
  // 넓게 닿는 터치는 손바닥으로 간주
  if (e.pointerType === 'touch' && Math.max(e.width || 0, e.height || 0) > 40) return;
  e.preventDefault();
  capture(e.pointerId);
  if (pad.tool === 'lasso' && !eraserButton) { lassoDown(e); return; }
  const pt = makePoint(e);
  pad.hover = pt;
  if (pad.tool === 'eraser' || eraserButton) {
    pad.active = { id: e.pointerId, erase: true, before: snapshot(), changed: false };
    eraseAt(pt[0], pt[1]);
    requestOverlay();
  } else {
    const tool = pad.tool;
    const stroke = { tool, color: pad.colors[tool], size: SIZES[tool][pad.sizeIdx], points: [pt] };
    if (e.pointerType === 'pen') stroke.pen = true;
    pad.active = { id: e.pointerId, pointerType: e.pointerType, stroke, predicted: [] };
    requestOverlay();
  }
}

function onPointerMove(e) {
  if (e.pointerType === 'touch' && pinchMove(e)) return;
  if (lasso.active && e.pointerId === lasso.active.id) { lassoMove(e); return; }
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
  // 아이패드 사파리는 이미 받은 이동 이벤트를 다시 보내는 경우가 있어 시간순으로 새것만 사용
  const list = e.getCoalescedEvents?.() || [];
  for (const ev of list.length ? list : [e]) {
    if (ev.timeStamp <= (pad.active.lastTime ?? -1)) continue;
    pad.active.lastTime = ev.timeStamp;
    const pt = makePoint(ev);
    if (pad.active.erase) eraseAt(pt[0], pt[1]);
    else {
      const pts = pad.active.stroke.points, last = pts[pts.length - 1];
      if (Math.abs(pt[0] - last[0]) + Math.abs(pt[1] - last[1]) >= 0.5) pts.push(pt);
      else last[2] = pt[2];
    }
    pad.hover = pt;
  }
  if (pad.active.stroke) {
    const pred = e.getPredictedEvents?.() || [];
    pad.active.predicted = pred.slice(0, 2).map(makePoint);
  }
  requestOverlay();
}

function onPointerUp(e) {
  if (e.pointerType === 'touch' && pinchUp(e)) { pad.scroll = null; return; }
  if (lasso.active && e.pointerId === lasso.active.id) { lassoUp(e); return; }
  if (pad.scroll && e.pointerId === pad.scroll.id) { pad.scroll = null; return; }
  if (!pad.active || e.pointerId !== pad.active.id) return;
  const a = pad.active;
  pad.active = null;
  if (a.erase) {
    if (a.changed) { pushUndo(a.before); saveSoon(); }
  } else {
    pushUndo();
    if (a.pointerType === 'touch') pad.recentTouch.push({ stroke: a.stroke, at: Date.now() });
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
  const date = state.date;
  try { await notes.put(date, cloneDoc(pad.doc)); }
  catch (e) { handleErr(e); }
  if (docEmpty(pad.doc)) { autoOcr.drop(date); digests.remove(date); }
  else if (docNeedsOcr(pad.doc)) { pad.lastEdit = Date.now(); autoOcr.touch(date); }
  if (!docEmpty(pad.doc)) refreshDigest(date, pad.doc);
  if (!auth.connected()) setStatus();
  if (state.view === 'day' && state.date === date) renderOcr();
}

// 펜을 처음 쓰기 직전 몇 초 사이에 손으로 그려진 획(손바닥 오작동)을 지움
function dropRecentTouchStrokes() {
  const recent = new Set(pad.recentTouch.filter((r) => Date.now() - r.at < 5000).map((r) => r.stroke));
  pad.recentTouch = [];
  if (!recent.size) return;
  pushUndo();
  pad.note.strokes = pad.note.strokes.filter((s) => !recent.has(s));
  redraw();
  saveSoon();
}

function setFingerDraw(v) {
  pad.fingerDraw = v;
  store.set('fingerDraw2', v);
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
  $('#colors').classList.toggle('disabled', pad.tool === 'eraser' || pad.tool === 'lasso');
  $('#sizes').classList.toggle('disabled', pad.tool === 'lasso');
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
  if (state.date && state.date !== ds) autoOcr.hurry(state.date);
  const fromMonth = state.view !== 'day';
  state.view = 'day';
  state.date = ds;
  if (push) history[fromMonth ? 'pushState' : 'replaceState']({ day: ds }, '', '#' + ds);
  document.body.classList.add('in-day');
  $('#day-menu-btn').classList.remove('hidden');
  hideMenu();
  $('#month-view').classList.add('hidden');
  $('#month-nav').classList.add('hidden');
  $('#day-view').classList.remove('hidden');
  $('#day-nav').classList.remove('hidden');
  if (isNarrow()) setPanel(false);
  const d = parseYmd(ds);
  $('#day-title').textContent = dayTitle(d);
  $('#ev-title').value = '';
  $('#ev-end-date').value = ds;
  $('#ev-end-date').min = ds;
  cancelEditEvent();

  pad.doc = blankNote();
  pad.pageIdx = 0;
  renderTabs();
  renderOcr();
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
    pad.doc = note;
    pad.pageIdx = Math.max(0, note.pages.findIndex((p) => p.strokes.length || (p.text || '').trim()));
    renderTabs();
    renderOcr();
    renderDayTodos();
    todoInk.clear();
    layoutPad();
    if (pad.note.kind === 'text') focusText();
  } catch (e) {
    handleErr(e);
  } finally {
    clearTimeout(timer);
    if (token === dayToken) { pad.loading = false; $('#loading').classList.add('hidden'); }
  }
}

async function closeDay() {
  await saveNow();
  document.body.classList.remove('in-day');
  $('#day-menu-btn').classList.add('hidden');
  autoOcr.hurry(state.date);
  dayToken++;
  const d = parseYmd(state.date);
  state.view = 'month';
  state.month = new Date(d.getFullYear(), d.getMonth(), 1);
  if (state.calView === 'week') state.weekStart = sundayOf(d);
  listState.cache.delete(state.date);
  state.date = null;
  $('#day-view').classList.add('hidden');
  $('#day-nav').classList.add('hidden');
  $('#month-view').classList.remove('hidden');
  $('#month-nav').classList.remove('hidden');
  renderMonth();
  refreshInBackground();
}

// ---------- 필기 탭
function tabLabel(page, i) {
  if (page.title) return page.title.slice(0, 12);
  if (page.kind === 'photo') return (firstLine(page.text) || `사진 ${page.media.length || ''}`).slice(0, 10).trim();
  if (page.kind === 'voice') return (firstLine(page.text) || `음성 ${i + 1}`).slice(0, 10);
  if (page.kind === 'text') {
    const first = firstLine(page.text);
    return first ? first.slice(0, 10) : `메모 ${i + 1}`;
  }
  const first = (page.ocr?.text || '').split('\n').map((l) => l.replace(/^[-•\d.\s]+/, '').trim()).find(Boolean);
  return first ? first.slice(0, 10) : `필기 ${i + 1}`;
}

function renderTabs() {
  const bar = $('#page-tabs');
  const pages = pad.doc.pages;
  const items = pages.map((p, i) => {
    const b = el('button', 'page-tab' + (i === pad.pageIdx ? ' active' : ''));
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(i === pad.pageIdx));
    b.append(icon(p.kind === 'text' ? 'keyboard' : p.kind === 'photo' ? 'photo' : p.kind === 'voice' ? 'mic' : 'pen'), el('span', 'page-tab-label', tabLabel(p, i)));
    if (p.ocr && !needsOcr(p)) b.append(el('span', 'page-tab-done', '✓'));
    b.title = (p.kind === 'text' ? firstLine(p.text) || '키보드 메모' : p.kind ? tabLabel(p, i) : p.ocr?.summary || `필기 ${i + 1}`) + ' · 길게 누르면 이름 바꾸기·순서 이동';
    b.onclick = () => { if (!b._long) switchPage(i); b._long = false; };
    onLongPress(b, (e) => { b._long = true; showTabMenu(e, i); });
    if (i === pad.pageIdx && pages.length > 1) {
      const x = el('span', 'page-tab-x', '✕');
      x.setAttribute('role', 'button');
      x.setAttribute('aria-label', '이 탭 삭제');
      x.onclick = (e) => { e.stopPropagation(); deletePage(i); };
      b.append(x);
    }
    return b;
  });
  if (pages.length < MAX_TABS) {
    const add = el('button', 'page-tab add');
    add.append(icon('plus'));
    add.title = `새 메모 탭 (최대 ${MAX_TABS}개) · 길게 누르면 종류 선택`;
    add.setAttribute('aria-label', '새 메모 탭');
    add.onclick = () => { if (!add._long) addPage('text'); add._long = false; };
    onLongPress(add, (e) => { add._long = true; showNewTabMenu(e); });
    items.push(add);
  }
  const toInk = pad.note.kind === 'text';
  if (toInk) {
    const todoBtn = el('button', 'page-tab todo-insert');
    todoBtn.append(icon('check'), el('span', null, '할 일'));
    todoBtn.title = '할 일 줄 넣기';
    todoBtn.addEventListener('pointerdown', (e) => e.preventDefault()); // 입력칸 포커스 유지
    todoBtn.onclick = insertTodo;
    items.push(todoBtn);
    const tplBtn = el('button', 'page-tab', '서식');
    tplBtn.title = '메모 서식 넣기 (회의록 등)';
    tplBtn.addEventListener('pointerdown', (e) => e.preventDefault());
    tplBtn.onclick = (e) => showTemplateMenu(e);
    items.push(tplBtn);
  }
  const kindBtn = el('button', 'page-tab kind-toggle');
  kindBtn.append(icon(toInk ? 'pen' : 'keyboard'), el('span', null, toInk ? '필기로' : '타자로'));
  kindBtn.title = toInk ? '손글씨로 쓰기' : '키보드로 쓰기';
  kindBtn.onclick = toggleKind;
  items.push(kindBtn);
  bar.replaceChildren(...items);
}

// 탭 길게 누르기 메뉴: 이름 바꾸기, 왼쪽·오른쪽 이동, 삭제
function showTabMenu(e, i) {
  const pages = pad.doc.pages;
  const page = pages[i];
  if (!page) return;
  const move = (dir) => {
    const j = i + dir;
    if (j < 0 || j >= pages.length) return;
    [pages[i], pages[j]] = [pages[j], pages[i]];
    if (pad.pageIdx === i) pad.pageIdx = j;
    else if (pad.pageIdx === j) pad.pageIdx = i;
    renderTabs();
    saveSoon();
  };
  const items = [
    {
      label: '탭 이름 바꾸기',
      keepOpen: true,
      fn: () => showMenu(e, [{
        input: {
          placeholder: tabLabel(page, i) + ' (비우면 자동 이름)',
          onSubmit: (v) => {
            if (v === '-' || v === '자동') delete page.title;
            else page.title = v.slice(0, 12);
            renderTabs();
            saveSoon();
          },
        },
      }]),
    },
  ];
  if (page.title) {
    items.push({ label: '자동 이름으로 되돌리기', fn: () => { delete page.title; renderTabs(); saveSoon(); } });
  }
  if (i > 0) items.push({ label: '← 왼쪽으로 옮기기', fn: () => move(-1) });
  if (i < pages.length - 1) items.push({ label: '→ 오른쪽으로 옮기기', fn: () => move(1) });
  if (pages.length > 1) items.push({ label: '이 탭 삭제', fn: () => deletePage(i) });
  showMenu(e, items);
}

function switchPage(i) {
  if (i === pad.pageIdx || pad.active) return;
  lasso.sel.clear();
  $('#sel-bar').classList.add('hidden');
  pad.pageIdx = i;
  pad.undo = [];
  pad.redo = [];
  updateUndoUI();
  $('#page-scroll').scrollTop = 0;
  renderTabs();
  renderOcr();
  layoutPad();
}

function addPage(kind = 'text') {
  if (pad.loading) return;
  if (pad.doc.pages.length >= MAX_TABS) return toast(`탭은 최대 ${MAX_TABS}개예요`);
  pad.doc.pages.push(blankPage(kind));
  switchPage(pad.doc.pages.length - 1);
  if (kind === 'text') focusText();
}

// 지금 탭을 타자 ↔ 손글씨로 바꿈. 이미 내용이 있으면 바꾸지 않고 그 종류의 새 탭을 엶
function toggleKind() {
  if (pad.loading || pad.active) return;
  const cur = pad.note, toInk = cur.kind === 'text';
  if (cur.kind === 'photo' || cur.kind === 'voice') return addPage('text'); // 사진·녹음은 그대로 두고 새 타자 탭
  const empty = toInk ? !(cur.text || '').trim() : !cur.strokes.length;
  if (!empty) return addPage(toInk ? 'ink' : 'text');
  if (toInk) { delete cur.kind; delete cur.text; }
  else { Object.assign(cur, { kind: 'text', text: '' }); delete cur.ocr; }
  pad.undo = [];
  pad.redo = [];
  updateUndoUI();
  renderTabs();
  renderOcr();
  layoutPad();
  if (!toInk) focusText();
}

// 마우스·키보드 기기에서만 바로 입력 칸에 커서 (휴대폰은 키보드가 갑자기 올라오지 않게)
function focusText(force) {
  if (force || !window.matchMedia('(pointer: coarse)').matches) $('#text-page').focus();
}

// 키보드 메모 탭으로 이동 (없으면 만들거나, 지금 탭이 빈 필기면 타자 탭으로 바꿈)
function openTextTab() {
  if (pad.loading) return false;
  let i = pad.doc.pages.findIndex((p) => p.kind === 'text');
  if (i < 0) {
    const cur = pad.note;
    if (!cur.strokes.length && cur.kind !== 'text') {
      Object.assign(cur, { kind: 'text', text: '' });
      delete cur.ocr;
      i = pad.pageIdx;
      renderTabs();
      renderOcr();
      layoutPad();
    } else if (pad.doc.pages.length < MAX_TABS) {
      pad.doc.pages.push(blankPage('text'));
      i = pad.doc.pages.length - 1;
    } else {
      toast(`탭이 ${MAX_TABS}개로 가득 찼어요`);
      return false;
    }
  }
  switchPage(i);
  $('#text-page').focus();
  return true;
}

function deletePage(i) {
  const page = pad.doc.pages[i];
  const hasContent = page.strokes.length || (page.text || '').trim() || page.media?.length;
  if (hasContent && !confirm(`'${tabLabel(page, i)}' 탭을 삭제할까요? (휴지통에 30일 보관)`)) return;
  pad.doc.pages.splice(i, 1);
  const date = state.date;
  if (hasContent) {
    trash.add(date, page);
    toast('탭을 지웠어요', 5000, { label: '되돌리기', fn: () => restorePage(date, page, i) });
  }
  pad.pageIdx = Math.min(i, pad.doc.pages.length - 1);
  pad.undo = [];
  pad.redo = [];
  updateUndoUI();
  renderTabs();
  renderOcr();
  layoutPad();
  saveSoon();
  refreshDigest(state.date, pad.doc);
}

// 지운 탭 되살리기 (되돌리기 토스트·휴지통에서)
async function restorePage(date, page, at) {
  const open = state.view === 'day' && state.date === date;
  const doc = open ? pad.doc : await notes.get(date);
  if (doc.pages.some((p) => p.id === page.id)) return;
  if (doc.pages.length >= MAX_TABS) {
    const empty = doc.pages.findIndex((p) => !p.strokes.length && !(p.text || '').trim() && !p.media?.length);
    if (empty < 0) return toast(`그날 탭이 ${MAX_TABS}개로 가득 차서 되살릴 수 없어요`);
    doc.pages.splice(empty, 1);
  }
  doc.pages.splice(Math.min(at ?? doc.pages.length, doc.pages.length), 0, page);
  trash.remove(page.id);
  if (open) {
    pad.pageIdx = doc.pages.indexOf(page);
    renderTabs();
    renderOcr();
    layoutPad();
    saveSoon();
  } else {
    await notes.put(date, cloneDoc(doc));
    listState.cache.set(date, doc);
  }
  refreshDigest(date, doc);
  toast('되살렸어요');
}

function shiftDay(n) {
  const pw = $('.page-wrap');
  pw.classList.remove('in-left', 'in-right');
  openDay(ymd(addDays(parseYmd(state.date), n))).then(() => {
    void pw.offsetWidth;
    pw.classList.add(n > 0 ? 'in-left' : 'in-right');
  });
}

// 일정·요약 패널: 넓은 화면은 왼쪽 패널(기본 보임), 좁은 화면은 아래 시트(기본 숨김)
const isNarrow = () => window.matchMedia('(max-width: 899px)').matches;
function setPanel(visible) {
  const body = $('.day-body');
  const toggled = isNarrow() ? visible : !visible;
  if (body.classList.contains('panel-toggled') === toggled) return;
  body.classList.toggle('panel-toggled', toggled);
  if (!isNarrow()) { store.set('panelHidden2', !visible); layoutPad(); }
  syncPanelButton();
}
function panelVisible() {
  const toggled = $('.day-body').classList.contains('panel-toggled');
  return isNarrow() ? toggled : !toggled;
}
function syncPanelButton() {
  const b = $('#panel-toggle'), v = panelVisible();
  b.classList.toggle('on', v);
  b.setAttribute('aria-expanded', String(v));
}

let editingEventId = null;

function startEditEvent(ev) {
  editingEventId = ev.id;
  $('#ev-title').value = ev.title;
  $('#ev-allday').checked = !!ev.allDay;
  $('#ev-times').classList.toggle('hidden', !!ev.allDay);
  $('.ev-end-label')?.classList.toggle('hidden', !ev.allDay);
  if (ev.allDay) {
    const endDay = addDays(ev.end, -1);
    $('#ev-end-date').value = ymd(endDay >= ev.start ? endDay : ev.start);
    $('#ev-end-date').min = ymd(ev.start);
  } else {
    $('#ev-start').value = hm(ev.start);
    $('#ev-end').value = hm(ev.end);
  }
  $('#ev-submit').textContent = '저장';
  $('#ev-cancel').classList.remove('hidden');
  renderDayEvents();
  $('#ev-title').focus();
}

function cancelEditEvent() {
  editingEventId = null;
  if ($('#ev-submit')) $('#ev-submit').textContent = '추가';
  if ($('#ev-cancel')) $('#ev-cancel').classList.add('hidden');
  if (state.date && $('#ev-end-date')) {
    $('#ev-end-date').value = state.date;
    $('#ev-end-date').min = state.date;
  }
}

// 하루 화면 왼쪽 패널: 이 날짜의 할 일 목록 + 키보드 할 일 추가 + 손글씨(OCR) 할 일 추가
function updatePanelToggleLabel() {
  const btn = $('#panel-toggle');
  if (!btn) return;
  const todos = state.date && pad.doc ? todosOf(pad.doc, state.date) : [];
  const left = todos.filter((t) => !t.done).length;
  if (left > 0) btn.textContent = `할 일 ${left}`;
  else if (todos.length > 0) btn.textContent = `할 일 ✓`;
  else btn.textContent = '할 일';
}

function renderDayTodos() {
  const box = $('#day-todo-list');
  const sum = $('#day-todos-summary');
  if (!box || !sum || !state.date) return;
  const ds = state.date;
  const todos = todosOf(pad.doc, ds);
  const left = todos.filter((t) => !t.done).length;
  sum.textContent = todos.length ? `할 일 ${todos.length}개 (남음 ${left})` : '할 일';
  updatePanelToggleLabel();
  if (!todos.length) {
    box.replaceChildren(el('p', 'muted-text', '아직 할 일이 없어요. 아래에 치거나 펜으로 써서 바로 추가해 보세요.'));
    return;
  }
  box.replaceChildren(...todos.map((t) => {
    const row = el('label', 'todo-row' + (t.done ? ' done' : ''));
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = t.done;
    cb.onchange = () => {
      if (!setTodoDone(pad.doc, t, cb.checked)) return renderDayTodos();
      if (pad.note.kind === 'text') $('#text-page').value = pad.note.text || '';
      renderTextTodos();
      renderDayTodos();
      saveSoon();
      refreshDigest(ds, pad.doc);
    };
    row.append(cb, el('span', 'todo-text', t.text));
    if (t.due) row.append(el('span', 'todo-due' + (t.due < ymd(new Date()) && !t.done ? ' over' : ''), dueLabel(t.due)));
    if (t.kind === 'ocr') row.append(icon('pen', 'ic todo-src'));
    return row;
  }));
}

async function addDayTodosFromLines(lines) {
  if (!state.date) return;
  const clean = lines.map((l) => l.replace(TODO_RE, '$3').replace(/^[-*•\d.)\s]+/, '').trim()).filter(Boolean);
  if (!clean.length) return;
  // 지금 열린 탭이 손글씨 탭이고 이미 OCR이 있으면 그 탭의 할 일(ocr.todos)에 바로 넣거나, 타자 메모 탭에 '☐ 내용' 줄로 추가
  if (!pad.note.kind && pad.note.strokes?.length && pad.note.ocr) {
    pad.note.ocr.todos = pad.note.ocr.todos || [];
    pad.note.ocr.done = pad.note.ocr.done || [];
    for (const text of clean) {
      pad.note.ocr.todos.push(text);
      pad.note.ocr.done.push(false);
    }
    if (pad.note.ocr.text && !pad.note.ocr.text.includes(clean[0])) {
      pad.note.ocr.text = (pad.note.ocr.text.trim() + '\n' + clean.map((c) => '☐ ' + c).join('\n')).trim();
    }
    renderOcr();
  } else {
    for (const text of clean) {
      if (!appendTodoLine(pad.doc, text)) {
        toast(`탭이 ${MAX_TABS}개로 가득 찼어요`);
        break;
      }
    }
    if (pad.note.kind === 'text') {
      $('#text-page').value = pad.note.text || '';
      renderTextTodos();
    }
  }
  renderTabs();
  renderDayTodos();
  saveSoon();
  refreshDigest(state.date, pad.doc);
  toast(clean.length > 1 ? `할 일 ${clean.length}개를 추가했어요` : `'${clean[0]}' 할 일을 추가했어요`);
}

// 왼쪽 패널의 미니 손글씨 할 일 패드
const todoInk = {
  strokes: [],
  active: null,
  timer: null,
  init() {
    const c = $('#day-todo-canvas');
    if (!c) return;
    const ctx = c.getContext('2d');
    const pt = (e) => {
      const r = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(300, Math.round(r.width * dpr));
      const h = Math.max(200, Math.round(r.height * dpr));
      if (Math.abs(c.width - w) > 4 || Math.abs(c.height - h) > 4) {
        c.width = w;
        c.height = h;
      }
      return [(e.clientX - r.left) * (c.width / (r.width || 1)), (e.clientY - r.top) * (c.height / (r.height || 1)), e.pressure || 0.5];
    };
    const redrawMini = () => {
      ctx.clearRect(0, 0, c.width, c.height);
      const wasDark = darkInk;
      darkInk = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
      for (const s of this.strokes) drawStroke(ctx, s);
      if (this.active) drawStroke(ctx, this.active);
      darkInk = wasDark;
    };
    this.redraw = redrawMini;
    c.addEventListener('pointerdown', (e) => {
      if (e.button && e.button !== 0) return;
      e.preventDefault();
      clearTimeout(this.timer);
      try { c.setPointerCapture(e.pointerId); } catch {}
      this.active = { id: e.pointerId, tool: 'pen', color: COLORS[0], size: SIZES[1], points: [pt(e)] };
      redrawMini();
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.active || e.pointerId !== this.active.id) return;
      e.preventDefault();
      this.active.points.push(pt(e));
      redrawMini();
    });
    const end = (e) => {
      if (!this.active || e.pointerId !== this.active.id) return;
      this.strokes.push(this.active);
      this.active = null;
      redrawMini();
      // 필기를 멈추고 2.2초 동안 더 안 쓰면 자동으로 OCR 인식해 할 일로 추가
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { if (this.strokes.length) this.recognize(); }, 2200);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    if ($('#day-todo-ink-clear')) $('#day-todo-ink-clear').onclick = () => this.clear();
    if ($('#day-todo-ink-add')) $('#day-todo-ink-add').onclick = () => this.recognize();
  },
  clear() {
    clearTimeout(this.timer);
    this.strokes = [];
    this.active = null;
    this.redraw?.();
  },
  async recognize() {
    clearTimeout(this.timer);
    if (!this.strokes.length) return toast('먼저 아래 칸에 손글씨로 할 일을 적어 주세요');
    if (!CFG.WORKER_URL) return toast('중계 서버가 연결되어야 손글씨 인식을 쓸 수 있어요');
    if (!auth.connected()) return toast('먼저 구글 로그인을 해주세요');
    const btn = $('#day-todo-ink-add');
    if (btn) { btn.disabled = true; btn.textContent = '인식 중…'; }
    try {
      const fakeNote = { strokes: this.strokes.slice() };
      const img = noteImage(fakeNote);
      if (!img) return;
      const data = await ocrRequest(img, state.date);
      const lines = (data.todos && data.todos.length)
        ? data.todos
        : (data.text || '').split('\n').map((s) => s.trim()).filter(Boolean);
      if (!lines.length) return toast('글자를 인식하지 못했어요. 조금 더 크게 써 보세요.');
      await addDayTodosFromLines(lines);
      this.clear();
    } catch (e) {
      handleErr(e);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '인식해 추가'; }
    }
  },
};

async function renderDayEvents() {
  const ds = state.date;
  const day = parseYmd(ds);
  const list = $('#event-list');
  renderDayTodos();
  const draw = (all) => {
    if (state.date !== ds) return;
    const evs = events.on(all, day);
    $('#events-summary').textContent = evs.length ? `일정 ${evs.length}개` : '일정';
    updatePanelToggleLabel(evs.length);
    if (!evs.length) { list.replaceChildren(el('li', 'muted', '일정이 없어요')); return; }
    list.replaceChildren(...evs.map((ev) => {
      const li = el('li');
      const dot = el('span', 'dot');
      dot.style.setProperty('--c', ev.color);
      let time = '종일';
      if (!ev.allDay) {
        const sameDay = ymd(ev.start) === ds && ymd(ev.end) === ds;
        time = sameDay ? `${hm(ev.start)}–${hm(ev.end)}` : ymd(ev.start) === ds ? `${hm(ev.start)}~` : '~' + (ymd(ev.end) === ds ? hm(ev.end) : '');
      } else {
        const endIncl = addDays(ev.end, -1);
        if (ymd(ev.start) !== ymd(endIncl)) time = `${ev.start.getMonth() + 1}/${ev.start.getDate()}~${endIncl.getMonth() + 1}/${endIncl.getDate()}`;
      }
      li.append(dot, el('span', 'ev-time', time), el('span', 'ev-title', ev.title));
      li.title = ev.calendar ? `${ev.title} · 네이버 ${ev.calendar}` : ev.editable ? `${ev.title} (눌러서 수정)` : ev.title;
      if (ev.editable) {
        li.classList.add('editable');
        if (editingEventId === ev.id) li.classList.add('editing');
        li.onclick = (e) => {
          if (e.target.closest('.ev-del')) return;
          startEditEvent(ev);
        };
        const del = el('button', 'ev-del', '✕');
        del.setAttribute('aria-label', '일정 삭제');
        del.onclick = async (e) => {
          e.stopPropagation();
          if (!confirm(`'${ev.title}' 일정을 삭제할까요?`)) return;
          if (editingEventId === ev.id) cancelEditEvent();
          try { await events.remove(ev); renderDayEvents(); } catch (e2) { handleErr(e2); }
        };
        li.append(del);
      }
      return li;
    }));
  };
  const s = day, e = addDays(day, 1);
  const cached = events.cached(s, e);
  if (cached) {
    draw(cached);
    if (events.fresh(s, e)) return;
  } else list.replaceChildren(el('li', 'muted', '불러오는 중…'));
  try {
    const ver = events.version;
    const got = await events.load(s, e);
    if (!cached || events.version !== ver) draw(got);
  }
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
  const existing = editingEventId ? memos.all().find((x) => x.id === editingEventId) : null;
  const startDs = existing ? ymd(new Date(existing.start)) : state.date;
  const day = parseYmd(startDs);
  let start = day, end = addDays(day, 1);
  if (allDay) {
    const endDs = $('#ev-end-date')?.value || startDs;
    const endDay = parseYmd(endDs >= startDs ? endDs : startDs);
    end = addDays(endDay, 1);
  } else {
    start = new Date(`${startDs}T${$('#ev-start').value || '09:00'}`);
    end = new Date(`${startDs}T${$('#ev-end').value || '10:00'}`);
    if (end <= start) end = new Date(+start + 3600e3);
  }
  const btn = ev.submitter || $('#event-form button[type=submit]');
  btn.disabled = true;
  try {
    if (editingEventId) {
      await events.update(editingEventId, { title, allDay, start, end });
      cancelEditEvent();
    } else {
      await events.add({ title, allDay, start, end });
    }
    $('#ev-title').value = '';
    renderDayEvents();
  } catch (e) { handleErr(e); }
  finally { btn.disabled = false; }
}

// ---------- 필기 → 글자 (중계 서버의 Gemini 사용)
// 필기 상태를 짧은 문자열로: 바뀌었으면 다시 변환해야 함
const inkSig = (note) => note.strokes.length + ':' + note.strokes.reduce((a, s) => a + s.points.length, 0);
const needsOcr = (note) => !!note?.strokes?.length && (!note.ocr || (note.ocr.sig && note.ocr.sig !== inkSig(note)));
const docNeedsOcr = (doc) => doc.pages.some(needsOcr);
// 달력 칸 요약: 탭마다 한 줄씩 이어 붙이고 할 일 개수는 합침
const firstLine = (t) => (t || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
// 할 일: 타자 메모에서 ☐/[ ]로 시작하는 줄(☑/[x]는 완료) + 손글씨 AI가 뽑은 할 일
const TODO_RE = /^(\s*(?:[-*•]\s*)?)(\[[ xX]\]|☐|☑|□|✅)\s*(.*)$/;
// ds(메모 날짜)를 주면 글에서 기한도 읽음
function todosOf(doc, ds) {
  const out = [];
  const base = ds ? parseYmd(ds) : null;
  for (const p of doc.pages) {
    if (p.kind === 'text' || p.kind === 'voice') {
      (p.text || '').split('\n').forEach((line, li) => {
        const m = TODO_RE.exec(line);
        if (m && m[3].trim()) out.push({ pageId: p.id, kind: 'text', line: li, text: m[3].trim(), done: /[xX☑✅]/.test(m[2]), due: base && parseDue(m[3], base) });
      });
    } else if (p.ocr?.todos?.length && p.strokes.length) {
      p.ocr.todos.forEach((t, i) => out.push({ pageId: p.id, kind: 'ocr', idx: i, text: t, done: !!p.ocr.done?.[i], due: base && parseDue(t, base) }));
    }
  }
  return out;
}
function setTodoDone(doc, t, done) {
  const p = doc.pages.find((x) => x.id === t.pageId);
  if (!p) return false;
  if (t.kind === 'text') {
    const lines = (p.text || '').split('\n');
    const m = TODO_RE.exec(lines[t.line] || '');
    if (!m) return false;
    const box = m[2].startsWith('[') ? (done ? '[x]' : '[ ]') : done ? '☑' : '☐';
    lines[t.line] = `${m[1]}${box} ${m[3]}`;
    p.text = lines.join('\n');
  } else {
    if (!p.ocr) return false;
    p.ocr.done = p.ocr.done || [];
    p.ocr.done[t.idx] = done;
  }
  return true;
}

function digestOf(doc) {
  const parts = [];
  for (const p of doc.pages) {
    if (p.kind === 'photo' || p.kind === 'voice') {
      const line = firstLine(p.text) || (p.media.length ? (p.kind === 'photo' ? `사진 ${p.media.length}장` : `녹음 ${p.media.length}개`) : '');
      if (line) parts.push(line.slice(0, 80));
    } else if (p.kind === 'text') {
      const line = firstLine(p.text).replace(TODO_RE, '$3').trim();
      if (line) parts.push(line.slice(0, 80));
    } else if (p.ocr && p.strokes.length) parts.push(digestLine(p.ocr));
  }
  const text = parts.filter(Boolean).join(' · ').slice(0, 120);
  const todos = todosOf(doc).filter((t) => !t.done).length; // 남은 할 일만
  return text || todos ? { text: text || `할 일 ${todos}개`, todos } : null;
}
function refreshDigest(date, doc) {
  const d = digestOf(doc), cur = digests.get(date);
  if (!d) { digests.remove(date); return; }
  if (!cur || cur.text !== d.text || cur.todos !== d.todos) digests.set(date, d);
}
const digestLine = (o) => (o.summary || (o.text || '').split('\n').find((l) => l.trim()) || '').trim().slice(0, 80);

function noteImage(note) {
  const strokes = note.strokes;
  if (!strokes.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    for (const p of s.points) {
      x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
    }
  }
  const m = 30;
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(PAGE_W, x1 + m); y1 += m;
  const w = x1 - x0, h = y1 - y0;
  // 글자 인식에는 이 정도 해상도면 충분하고, 작을수록 AI 응답이 빠름
  let k = Math.min(1.25, 1100 / w);
  if (h * k > 5000) k = 5000 / h;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
  const wasDark = darkInk;
  darkInk = false;
  for (const s of strokes) drawStroke(ctx, s);
  darkInk = wasDark;
  return c.toDataURL('image/png').split(',')[1];
}

async function ocrRequest(image, date) {
  // 서버가 끊지 못하는 경우를 대비해 화면 쪽에서도 시간 제한
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await authFetch(`${CFG.WORKER_URL.replace(/\/$/, '')}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, date, glossary: glossary.words() }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || 'HTTP ' + res.status);
      err.code = data.error;
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error('변환이 1분 안에 끝나지 않았어요');
      err.code = 'gemini_timeout';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 변환 결과를 노트에 저장하고 달력용 요약을 갱신. 그사이 필기가 바뀌었으면 false
async function applyOcr(date, pageId, data, sig, image) {
  const ocr = {
    text: data.text,
    summary: data.summary,
    todos: data.todos,
    decisions: data.decisions,
    at: Date.now(),
    sig,
    quality: data.quality || 'draft',
    model: data.model || '',
  };
  const keepDone = (page) => {
    const prev = page.ocr;
    if (prev?.done) ocr.done = (ocr.todos || []).map((t) => !!prev.done[(prev.todos || []).indexOf(t)]);
    if (prev?.imageId) ocr.imageId = prev.imageId;
  };
  let doc, prevImageId = null;
  if (state.date === date) {
    doc = pad.doc;
    const page = doc.pages.find((p) => p.id === pageId);
    if (!page || inkSig(page) !== sig) return false;
    prevImageId = page.ocr?.imageId || null;
    keepDone(page);
    page.ocr = ocr;
    saveSoon();
    renderOcr();
    renderTabs();
  } else {
    doc = await notes.get(date);
    const page = doc.pages.find((p) => p.id === pageId);
    if (!page || inkSig(page) !== sig) return false;
    prevImageId = page.ocr?.imageId || null;
    keepDone(page);
    page.ocr = ocr;
    await notes.put(date, doc);
  }
  // 주기적 유료 모델 다듬기용으로 손글씨 그림을 드라이브 ink/ 폴더에 함께 저장
  if (image && auth.connected()) {
    drive.uploadInkPng(`${date}_${pageId}.png`, image, prevImageId).then(async (id) => {
      if (!id) return;
      ocr.imageId = id;
      if (state.date === date) saveSoon();
      else await notes.put(date, doc).catch(() => {});
    }).catch((e) => console.warn('ink PNG 업로드 실패', e));
  }
  refreshDigest(date, doc);
  if (state.view === 'month') renderMonth();
  return true;
}

// 달력 칸에 보여줄 한 줄 요약. 드라이브의 digests.json으로 기기 간 동기화
const digests = {
  fileId: null,
  syncing: null,
  all() { return store.get('digests', {}); },
  get(date) { const d = this.all()[date]; return d && !d.deleted ? d : null; },
  set(date, d) {
    const all = this.all();
    all[date] = { ...d, at: Date.now() };
    store.set('digests', all);
    this.sync().catch(handleErr);
  },
  remove(date) {
    if (!this.get(date)) return;
    const all = this.all();
    all[date] = { deleted: true, at: Date.now() };
    store.set('digests', all);
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
      const q = encodeURIComponent(`'${fid}' in parents and name='digests.json' and trashed=false`);
      this.fileId = (await gapi(`${DRIVE}?q=${q}&fields=files(id)`)).files[0]?.id || null;
    }
    let remote = {};
    if (this.fileId) {
      const d = await drive.read(this.fileId);
      remote = (typeof d === 'string' ? JSON.parse(d) : d)?.days || {};
    }
    const merged = { ...remote };
    for (const [k, v] of Object.entries(this.all())) if (!merged[k] || (v.at || 0) > (merged[k].at || 0)) merged[k] = v;
    store.set('digests', merged);
    if (JSON.stringify(merged) !== JSON.stringify(remote)) {
      const payload = { v: 1, days: merged };
      if (this.fileId) await drive.update(this.fileId, payload);
      else this.fileId = (await drive.create('digests.json', payload)).id;
    }
  },
};

// 백그라운드 자동 변환: 필기를 멈추고 잠시 뒤 대기열에 넣고, Gemini가 붐비면 간격을 늘려 다시 시도
const autoOcr = {
  queue: new Set(store.get('ocrQueue', [])),
  timers: new Map(),
  retryAt: 0,
  fails: 0,
  running: false,
  kickTimer: null,
  IDLE_MS: 90000,
  BACKOFF_MIN: [2, 5, 15, 30],
  enabled() { return !!CFG.WORKER_URL && auth.connected(); },
  // 로그인이 잠깐 만료됐어도 전에 받아 둔 일정은 보여줌
  known() { return !!CFG.WORKER_URL && (auth.connected() || auth.wasSignedIn()); },
  save() { store.set('ocrQueue', [...this.queue]); },
  // 필기가 바뀌면 호출: 일정 시간 더 손대지 않으면 대기열로
  touch(date, delay = this.IDLE_MS) {
    clearTimeout(this.timers.get(date));
    this.timers.set(date, setTimeout(() => {
      this.timers.delete(date);
      this.queue.add(date);
      this.save();
      this.kick();
    }, delay));
  },
  // 다른 날짜로 넘어가면 기다리던 날은 곧바로 처리
  hurry(date) { if (this.timers.has(date)) this.touch(date, 5000); },
  drop(date) {
    clearTimeout(this.timers.get(date));
    this.timers.delete(date);
    if (this.queue.delete(date)) this.save();
  },
  // 최근 30일 안에 쓴 필기 중 변환이 안 된 것을 대기열에 추가
  async scan() {
    const since = Date.now() - 30 * 86400e3;
    for (const d of notes.localDays) {
      if (this.queue.has(d) || this.timers.has(d)) continue;
      const raw = await idb.get('note:' + d).catch(() => null);
      if (raw && (raw.updated || 0) > since && docNeedsOcr(normalize(raw))) this.queue.add(d);
    }
    this.save();
    this.kick();
  },
  kick(delay = 0) {
    clearTimeout(this.kickTimer);
    this.kickTimer = setTimeout(() => this.run(), Math.max(delay, this.retryAt - Date.now(), 0));
  },
  async run() {
    if (this.running || !this.queue.size || !this.enabled() || !navigator.onLine) return;
    if (Date.now() < this.retryAt) return this.kick();
    this.running = true;
    let later = 0;
    try {
      for (const d of [...this.queue]) {
        if (this.timers.has(d)) continue; // 아직 쓰는 중
        if (state.date === d && Date.now() - pad.lastEdit < this.IDLE_MS) { later = this.IDLE_MS; continue; }
        const doc = state.date === d ? pad.doc : await notes.get(d);
        const page = doc.pages.find(needsOcr);
        if (!page) { this.queue.delete(d); this.save(); continue; }
        const sig = inkSig(page);
        try {
          const img = noteImage(page);
          const data = await ocrRequest(img, d);
          await applyOcr(d, page.id, data, sig, img);
          later = 1000; // 같은 날 다른 탭이 남았으면 곧 이어서
          this.fails = 0;
          break;
        } catch (e) {
          if (e.message === 'AUTH') break;
          const busy = ['gemini_busy', 'gemini_timeout'].includes(e.code) || !e.status || e.status >= 500;
          const mins = e.code === 'gemini_quota' ? 60 : busy ? this.BACKOFF_MIN[Math.min(this.fails, this.BACKOFF_MIN.length - 1)] : 30;
          this.fails++;
          this.retryAt = Date.now() + mins * 60000;
          console.warn('자동 변환 보류', d, e.message, `${mins}분 뒤 재시도`);
          break;
        }
      }
    } finally {
      this.running = false;
      if (state.view === 'day') renderOcr();
      if (this.queue.size) this.kick(later || 30000);
    }
  },
};

function renderOcr() {
  const o = pad.note.ocr;
  // 손글씨 탭에 필기가 있을 때만 위에 한 줄 카드로 (펼치면 원문 편집)
  // 손글씨 탭이면 처음부터 보여줌 (쓰는 도중에 카드가 생겨 필기장이 밀려 내려가지 않게)
  const show = !pad.note.kind;
  $('#ocr-panel').classList.toggle('hidden', !show);
  const openCard = store.get('ocrOpen', false);
  $('#ocr-body').classList.toggle('hidden', !openCard);
  $('#ocr-head').setAttribute('aria-expanded', String(openCard));
  $('#ocr-more').textContent = openCard ? '접기' : '자세히';
  const refined = o?.quality === 'refined' && !needsOcr(pad.note);
  const lineEl = $('#ocr-line');
  lineEl.textContent = o
    ? (needsOcr(pad.note) ? '(고친 필기는 잠시 뒤 다시 변환) ' : '') + (firstLine(o.text) || '(글자 없음)')
    : !pad.note.strokes.length ? '손글씨를 쓰면 잠시 뒤 자동으로 글자로 바뀌어요'
    : !CFG.WORKER_URL ? '글자 변환은 중계 서버를 연결하면 쓸 수 있어요'
    : '손글씨 → 글자 변환 대기 중…';
  if (refined) lineEl.prepend(el('span', 'ocr-badge', '✦ AI 다듬음'));
  $('#ocr-btn').textContent = o ? '다시 변환' : '지금 변환';
  $('#ocr-refine-btn')?.classList.toggle('hidden', !o || !CFG.WORKER_URL);
  if ($('#ocr-refine-btn')) $('#ocr-refine-btn').textContent = refined ? '다시 다듬기' : 'AI 다듬기';
  $('#ocr-draft-btn')?.classList.toggle('hidden', !o?.draft);
  $('#ocr-revert-btn')?.classList.toggle('hidden', !o?.draft);
  $('#ocr-copy').classList.toggle('hidden', !o);
  $('#ocr-result').classList.toggle('hidden', !o);
  const chEl = $('#ocr-changes');
  if (chEl) {
    const ch = o?.changes?.length ? `다듬은 내용: ${o.changes.join(' · ')}` : '';
    chEl.textContent = ch;
    chEl.classList.toggle('hidden', !ch);
  }
  $('#ocr-hint').classList.toggle('hidden', !!o && !needsOcr(pad.note));
  let hint = '필기를 멈추고 잠시 뒤 자동으로 글자로 바꿔요. 요약은 달력에 보여요.';
  if (!CFG.WORKER_URL) hint = '중계 서버(WORKER_URL)를 연결하면 쓸 수 있어요.';
  else if (state.date && autoOcr.queue.has(state.date) && autoOcr.retryAt > Date.now()) {
    hint = `AI 서버가 붐벼서 ${new Date(autoOcr.retryAt).toTimeString().slice(0, 5)}쯤 다시 변환해요.`;
  } else if (o && needsOcr(pad.note)) hint = '필기가 바뀌어서 잠시 뒤 다시 변환해요.';
  $('#ocr-hint').textContent = hint;
  if (!o) return;
  // 오른쪽 칸에는 원문만. 요약·할 일은 달력 칸 한 줄로만 보여줌
  if (document.activeElement !== $('#ocr-text')) $('#ocr-text').value = o.text || '';
}

async function runOcr() {
  if (!CFG.WORKER_URL) return toast('중계 서버를 먼저 연결해야 해요');
  if (!auth.connected()) return toast('먼저 구글 로그인을 해주세요');
  const image = noteImage(pad.note);
  if (!image) return toast('변환할 필기가 없어요');
  const date = state.date, pageId = pad.note.id, sig = inkSig(pad.note), btn = $('#ocr-btn');
  btn.disabled = true;
  const started = Date.now();
  btn.textContent = '변환 중…';
  const tick = setInterval(() => { btn.textContent = `변환 중… ${Math.round((Date.now() - started) / 1000)}초`; }, 1000);
  try {
    const data = await ocrRequest(image, date);
    if (await applyOcr(date, pageId, data, sig, image) && !docNeedsOcr(pad.doc)) autoOcr.drop(date);
  } catch (e) {
    handleErr(e);
  } finally {
    clearInterval(tick);
    btn.disabled = false;
    if (state.date === date) {
      renderOcr();
      renderDayTodos();
    }
  }
}

// 지금 열린 손글씨 탭의 초벌 변환을 유료 모델로 정밀하게 다듬기
async function runRefinePage() {
  if (!CFG.WORKER_URL) return toast('중계 서버를 먼저 연결해야 해요');
  if (!auth.connected()) return toast('먼저 구글 로그인을 해주세요');
  const page = pad.note;
  if (!page.ocr) return toast('먼저 손글씨를 변환해 주세요');
  const image = noteImage(page);
  if (!image) return toast('변환할 필기가 없어요');
  const date = state.date, pageId = page.id, sig = inkSig(page), btn = $('#ocr-refine-btn');
  btn.disabled = true;
  btn.textContent = '다듬는 중…';
  try {
    const res = await authFetch(`${CFG.WORKER_URL.replace(/\/$/, '')}/refine/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image,
        date,
        draft: { text: page.ocr.text, summary: page.ocr.summary, todos: page.ocr.todos, decisions: page.ocr.decisions },
        glossary: glossary.words(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || 'HTTP ' + res.status), { code: data.error });
    if (state.date !== date || pad.note.id !== pageId || inkSig(pad.note) !== sig) return;
    const prev = page.ocr;
    const draftSnap = prev.draft || { text: prev.text, summary: prev.summary, todos: prev.todos, decisions: prev.decisions };
    // 할 일 완료 체크 보존 (todoMap 매핑 우선)
    const oldDone = prev.done || [];
    const oldTodos = prev.todos || [];
    const mapByNew = new Map((data.todoMap || []).map((m) => [m.to, m.from]));
    const newDone = (data.todos || []).map((t) => {
      const fromText = mapByNew.get(t) || t;
      const idx = oldTodos.indexOf(fromText);
      return idx >= 0 ? !!oldDone[idx] : false;
    });
    // Google Tasks 연결표 키 갱신
    for (const m of data.todoMap || []) {
      if (!m.from || !m.to || m.from === m.to) continue;
      const oldKey = gtasks.key(date, { pageId, text: m.from });
      const newKey = gtasks.key(date, { pageId, text: m.to });
      const entry = gtasks.entry(oldKey);
      if (entry) {
        gtasks.setEntry(newKey, { ...entry, renameTitle: m.to });
        gtasks.map[oldKey] = { ...entry, movedTo: newKey, deleted: true, t: Date.now() };
      }
    }
    // 새로 발견된 고유명사는 개인 용어집에 자동 추가
    for (const w of data.newGlossary || []) glossary.add(w, 'auto');
    page.ocr = {
      ...prev,
      text: data.text,
      summary: data.summary,
      todos: data.todos,
      decisions: data.decisions,
      done: newDone,
      quality: 'refined',
      refinedAt: Date.now(),
      model: data.model || '',
      draft: draftSnap,
      changes: data.changes || [],
    };
    delete page.ocr.userEdited;
    saveSoon();
    refreshDigest(date, pad.doc);
    renderOcr();
    renderTabs();
    toast(data.changes?.length ? `AI가 다듬었어요 (${data.changes.length}곳 교정)` : 'AI가 확인했어요 (고칠 곳 없음)');
  } catch (e) {
    handleErr(e);
  } finally {
    btn.disabled = false;
    if (state.date === date) {
      renderOcr();
      renderDayTodos();
    }
  }
}

function showOcrDraftDiff() {
  const o = pad.note.ocr;
  if (!o?.draft) return;
  const box = el('div', 'ocr-diff');
  const col1 = el('div', 'ocr-diff-col');
  col1.append(el('h4', null, '초벌 변환 (원래 글자)'), el('pre', null, o.draft.text || '(없음)'));
  const col2 = el('div', 'ocr-diff-col');
  col2.append(el('h4', null, '✦ AI 다듬은 결과'), el('pre', null, o.text || '(없음)'));
  box.append(col1, col2);
  const nodes = [box];
  if (o.changes?.length) nodes.unshift(el('p', 'muted-text', '바뀐 곳: ' + o.changes.join(' · ')));
  openModal('초벌 변환 ↔ AI 다듬기 비교', nodes);
}

function revertOcrToDraft() {
  const o = pad.note.ocr;
  if (!o?.draft) return;
  const d = o.draft;
  pad.note.ocr = {
    ...o,
    text: d.text,
    summary: d.summary,
    todos: d.todos,
    decisions: d.decisions,
    quality: 'draft',
    userEdited: true,
  };
  delete pad.note.ocr.draft;
  delete pad.note.ocr.changes;
  saveSoon();
  refreshDigest(state.date, pad.doc);
  renderOcr();
  renderTabs();
  toast('초벌 변환 결과로 되돌렸어요');
}

// Antigravity 스케줄 자동화(Argon 모델)에서 브라우저(Chrome DevTools MCP)로 직접 다듬을 때 쓰는 도우미
window.argonRefine = {
  // 다른 브라우저·기기에서 복사한 연결 코드(base64 JSON) 또는 리프레시 토큰 문자열로 구글 드라이브 즉시 연결
  async connectWithCode(raw) {
    if (!raw) return false;
    try {
      let parsed = null;
      try {
        parsed = JSON.parse(decodeURIComponent(escape(atob(raw))));
      } catch {
        parsed = { r: raw };
      }
      if (parsed?.r) store.set('refresh', parsed.r);
      if (parsed?.a?.token) {
        auth.token = parsed.a.token;
        auth.expires = parsed.a.expires || (Date.now() + 3000 * 1000);
        store.set('auth', { token: auth.token, expires: auth.expires });
        store.set('wasSignedIn', true);
      }
      const ok = await auth.ensure();
      if (!ok) throw new Error('토큰 갱신에 실패했어요');
      watchExpiry();
      await afterSignIn();
      toast('연결 코드로 구글 드라이브에 연결됐어요!');
      return true;
    } catch (e) {
      handleErr(e);
      return false;
    }
  },
  // limit: 한 번에 돌려줄 최대 탭 수 (그림 base64가 커서 자동화 도구 응답이 잘리지 않게). 남은 건 remaining으로 알려주고 다음 실행 때 처리
  async collectTargets(daysBack = 14, limit = 10) {
    if (auth.connected()) {
      await Promise.all([notes.syncIndex(), digests.sync(), glossary.sync()]).catch((e) => console.warn(e));
    }
    const minDate = ymd(addDays(new Date(), -daysBack));
    const dates = allNoteDates().filter((d) => d >= minDate);
    const items = [];
    for (const date of dates) {
      const doc = state.date === date && state.view === 'day' ? pad.doc : await notes.get(date);
      const dayObj = parseYmd(date);
      const cachedEvs = events.cached(dayObj, addDays(dayObj, 1)) || [];
      const dayEvents = events.on(cachedEvs, dayObj).map((e) => e.title);
      const otherText = doc.pages
        .filter((p) => p.kind === 'text' && p.text?.trim())
        .map((p) => p.text.trim().slice(0, 200));
      for (const page of doc.pages) {
        if (page.kind || !page.strokes?.length) continue;
        const o = page.ocr;
        if (o?.userEdited) continue;
        const stale = needsOcr(page);
        if (!stale && o?.quality === 'refined') continue;
        const image = noteImage(page);
        if (!image) continue;
        items.push({
          date,
          pageId: page.id,
          sig: inkSig(page),
          image,
          draft: o ? { text: o.text || '', summary: o.summary || '', todos: o.todos || [], decisions: o.decisions || [] } : null,
          context: { events: dayEvents, otherNotes: otherText },
        });
      }
    }
    const picked = items.slice(0, Math.max(1, limit));
    return {
      connected: auth.connected(),
      syncStatus: $('#sync-status')?.textContent || '',
      glossary: glossary.words(),
      count: picked.length,
      remaining: items.length - picked.length,
      items: picked,
    };
  },
  async applyResult({ date, pageId, sig, text = '', summary = '', todos = [], decisions = [], todoMap = [], newGlossary = [], changes = [], model = 'gemini-4-argon' }) {
    const isCurrent = state.date === date && state.view === 'day';
    const doc = isCurrent ? pad.doc : await notes.get(date);
    const page = doc.pages.find((p) => p.id === pageId);
    if (!page || inkSig(page) !== sig) return { ok: false, reason: 'sig_mismatch' };
    const prev = page.ocr || {};
    const draftSnap = prev.draft || (prev.text ? { text: prev.text, summary: prev.summary || '', todos: prev.todos || [], decisions: prev.decisions || [] } : null);
    const oldDone = prev.done || [];
    const oldTodos = prev.todos || [];
    const mapByNew = new Map((todoMap || []).map((m) => [m.to, m.from]));
    const newDone = (todos || []).map((t) => {
      const fromText = mapByNew.get(t) || t;
      const idx = oldTodos.indexOf(fromText);
      return idx >= 0 ? !!oldDone[idx] : false;
    });
    for (const m of todoMap || []) {
      if (!m.from || !m.to || m.from === m.to) continue;
      const oldKey = gtasks.key(date, { pageId, text: m.from });
      const newKey = gtasks.key(date, { pageId, text: m.to });
      const entry = gtasks.entry(oldKey);
      if (entry) {
        gtasks.setEntry(newKey, { ...entry, renameTitle: m.to });
        gtasks.map[oldKey] = { ...entry, movedTo: newKey, deleted: true, t: Date.now() };
      }
    }
    for (const w of newGlossary || []) glossary.add(w, 'auto');
    page.ocr = {
      ...prev,
      sig,
      at: Date.now(),
      text,
      summary,
      todos,
      decisions,
      done: newDone,
      quality: 'refined',
      refinedAt: Date.now(),
      model,
      ...(draftSnap ? { draft: draftSnap } : {}),
      changes: changes || [],
    };
    delete page.ocr.userEdited;
    if (isCurrent) {
      await notes.put(date, cloneDoc(pad.doc));
      renderOcr();
      renderTabs();
    } else {
      await notes.put(date, doc);
    }
    refreshDigest(date, doc);
    if (state.view === 'month') renderMonth();
    if (auth.connected()) {
      await Promise.all([notes.flush(), digests.sync(), glossary.sync(), gtasks.run(false)]).catch((e) => console.warn(e));
    }
    return { ok: true, date, pageId, changesCount: (changes || []).length };
  },
};

// ---------- 동기화 상태 / 알림
function setStatus(kind) {
  const s = $('#sync-status');
  if (!kind) {
    if (!navigator.onLine) kind = 'offline';
    else if (!auth.connected()) kind = auth.wasSignedIn() ? 'expired' : 'local';
    else kind = notes.pending.size ? 'saving' : 'synced';
  }
  $('#sync-dot').dataset.state = kind;
  $('#offline-bar').classList.toggle('hidden', kind !== 'offline');
  const lastSyncStr = notes.lastSync ? ` · ${hm(new Date(notes.lastSync))}` : '';
  s.textContent = {
    local: '이 기기에만 저장',
    expired: '연결 만료 · 기기에 저장 중',
    saving: '저장 중…',
    synced: `드라이브에 저장됨${lastSyncStr}`,
    offline: '오프라인 · 나중에 동기화',
    error: '동기화 실패',
  }[kind] || '';
}

function renderLinkStatus() {
  const box = $('#link-status');
  if (!box) return;
  const naverCals = store.get('naverCals', []);
  const naverTxt = !CFG.WORKER_URL ? '네이버 캘린더: 중계 서버 미설정'
    : !auth.connected() ? '네이버 캘린더: 로그인 후 연결'
    : naverCals.length ? `네이버 캘린더 ${naverCals.length}개 연결됨` : '네이버 캘린더 연결됨';
  const aiTxt = !CFG.WORKER_URL ? 'AI 변환: 미설정' : 'AI 손글씨 변환: 사용 가능';
  box.textContent = `${naverTxt} · ${aiTxt}`;
}

async function renderStorageInfo() {
  const box = $('#storage-info');
  if (!box) return;
  const count = notes.localDays.size;
  let usageTxt = '';
  if (navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      if (est.usage) usageTxt = ` · 기기 저장소 ${(est.usage / (1024 * 1024)).toFixed(1)}MB 사용 중`;
    } catch { /* 무시 */ }
  }
  box.textContent = `저장된 메모 ${count}일치${usageTxt}`;
}

let toastTimer = null;
function toast(msg, ms = 3000, action) {
  const t = $('#toast');
  $('#toast-msg').textContent = msg;
  const a = $('#toast-action');
  a.classList.toggle('hidden', !action);
  if (action) {
    a.textContent = action.label;
    a.onclick = () => { t.classList.add('hidden'); action.fn(); };
  }
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
    await digests.sync();
    trash.sync().catch(console.warn);
    templates.sync().catch(console.warn);
    glossary.sync().catch(console.warn);
    noteIndex.fill().then(() => noteIndex.sync()).catch(console.warn);
    prefs.sync().then(() => { renderCalFilter(); rerender(); }).catch(console.warn);
    events.clear();
    rerender();
    await notes.flush();
    autoOcr.scan();
    gtasks.run(true);
  } catch (e) { handleErr(e); }
}

// 중계 서버의 주기적 다듬기용으로 리프레시 토큰을 암호화 등록
async function registerRefineToken() {
  const rt = store.get('refresh', null);
  if (!rt || !CFG.WORKER_URL || !auth.connected()) return;
  await authFetch(`${CFG.WORKER_URL.replace(/\/$/, '')}/refine/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: rt }),
  });
}

// 자동화 브라우저(Chrome DevTools)처럼 구글 OAuth 팝업 로그인이 막히는 환경을 위해,
// 이미 로그인된 기기·브라우저에서 연결 코드를 복사해 붙여넣거나 window.argonRefine.connectWithCode(code)로 연결
function openTokenTransfer() {
  const curRefresh = store.get('refresh', null);
  const curAuth = store.get('auth', null);
  const box = el('div');
  box.style.display = 'flex';
  box.style.flexDirection = 'column';
  box.style.gap = '10px';
  const desc = el('p', 'muted-text', '다른 브라우저(또는 안티그래비티 자동화 창)에서 구글 팝업 로그인이 막힐 때, 이미 로그인된 브라우저에서 연결 코드를 복사해 붙여넣으면 바로 같은 구글 드라이브에 연결됩니다.');
  box.append(desc);
  box.append(el('p', 'warn-text', '⚠ 이 코드는 구글 드라이브 메모와 할 일을 열 수 있는 열쇠예요. 내 기기끼리만 쓰고 메신저·메일로 다른 사람에게 보내지 마세요. 새어 나갔다면 ⚙ → 로그아웃 후 다시 로그인하면 이전 코드는 못 써요.'));
  if (curRefresh || curAuth?.token) {
    const payload = btoa(unescape(encodeURIComponent(JSON.stringify({ r: curRefresh, a: curAuth }))));
    const copyBtn = el('button', 'pill primary', '현재 로그인 연결 코드 복사하기');
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(payload);
        toast('연결 코드를 복사했어요! 연결할 창에 붙여넣으세요.');
      } catch {
        prompt('아래 연결 코드를 복사하세요:', payload);
      }
    };
    box.append(copyBtn);
  }
  const input = el('input');
  input.type = 'text';
  input.placeholder = '복사한 연결 코드를 여기에 붙여넣기';
  input.style.padding = '8px 10px';
  input.style.border = '1px solid var(--line)';
  input.style.borderRadius = '8px';
  const applyBtn = el('button', 'pill', '연결 코드로 로그인 적용');
  applyBtn.onclick = async () => {
    const ok = await window.argonRefine.connectWithCode(input.value.trim());
    if (ok) closeModal();
  };
  box.append(input, applyBtn);
  openModal('구글 로그인 연결 코드 (기기·브라우저 간 이전)', [box]);
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
    await digests.sync();
    events.clear();
    rerender();
    if (notes.pending.size) notes.flush();
    autoOcr.kick();
    gtasks.run(true);
  } catch (e) { handleErr(e); }
}

// ---------- 구글 Tasks 연동 (양방향)
// 할 일마다 Tasks의 '필기캘린더' 목록에 작업을 하나씩 만듦.
// 어느 할 일이 어느 작업인지(키 → 작업 id, 마지막으로 맞춘 완료 여부)는 드라이브의 gtasks.json에 저장해 기기끼리 공유
const TASKS = 'https://tasks.googleapis.com/tasks/v1';
const TASKLIST_TITLE = '필기캘린더';
const MARKER_RE = /\s*\[(hc:(\d{4}-\d{2}-\d{2}):[0-9a-z]+)\]\s*/; // 예전 버전이 메모에 넣던 꼬리표
const strHash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const gtasks = {
  listId: store.get('gtasksListId', null),
  map: store.get('gtasksMap', {}), // 키 → { id, done, t }
  mapFileId: null,
  dirty: new Set(),
  timer: null,
  running: null,
  applying: false,
  problem: null,
  lastSync: 0,
  on() { return store.get('gtasksOn', true) && !!CFG.GOOGLE_CLIENT_ID && auth.connected(); },
  key(ds, t) { return `hc:${ds}:${strHash(t.pageId + '|' + t.text)}`; },
  schedule(ds) {
    if (this.applying || !this.on()) return;
    this.dirty.add(ds);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(false), 3000);
  },
  setEntry(k, v) {
    if (v) this.map[k] = { ...v, t: Date.now() };
    else this.map[k] = { deleted: true, t: Date.now() };
    this.mapChanged = true;
  },
  entry(k) { const e = this.map[k]; return e && !e.deleted ? e : null; },
  async api(path, opts = {}) {
    try {
      return await gapi(TASKS + path, opts.body ? { ...opts, headers: { 'Content-Type': 'application/json' } } : opts);
    } catch (e) {
      if (/HTTP 403/.test(e.message)) {
        this.problem = /has not been used|is disabled|SERVICE_DISABLED/i.test(e.message) ? 'api' : 'scope';
        renderTasksStatus();
        e.silent = true;
      }
      throw e;
    }
  },
  // 드라이브의 연결표와 합치기 (항목마다 더 최근 것)
  async syncMap(upload) {
    if (!this.mapFileId) {
      const fid = await drive.ensureFolder();
      const q = encodeURIComponent(`'${fid}' in parents and name='gtasks.json' and trashed=false`);
      this.mapFileId = (await gapi(`${DRIVE}?q=${q}&fields=files(id)`)).files[0]?.id || null;
    }
    let remote = {};
    if (this.mapFileId) {
      const d = await drive.read(this.mapFileId);
      remote = (typeof d === 'string' ? JSON.parse(d) : d)?.map || {};
    }
    const merged = { ...remote };
    for (const [k, v] of Object.entries(this.map)) if (!merged[k] || (v.t || 0) > (merged[k].t || 0)) merged[k] = v;
    // 오래된 삭제 표시는 정리
    const cutoff = Date.now() - 60 * 86400e3;
    for (const [k, v] of Object.entries(merged)) if (v.deleted && v.t < cutoff) delete merged[k];
    this.map = merged;
    store.set('gtasksMap', this.map);
    if (upload && JSON.stringify(merged) !== JSON.stringify(remote)) {
      const payload = { v: 1, map: merged };
      if (this.mapFileId) await drive.update(this.mapFileId, payload);
      else this.mapFileId = (await drive.create('gtasks.json', payload)).id;
    }
  },
  async ensureList() {
    if (this.listId) return this.listId;
    const r = await this.api('/users/@me/lists?maxResults=100');
    const found = (r.items || []).find((l) => l.title === TASKLIST_TITLE);
    this.listId = found ? found.id : (await this.api('/users/@me/lists', { method: 'POST', body: JSON.stringify({ title: TASKLIST_TITLE }) })).id;
    store.set('gtasksListId', this.listId);
    return this.listId;
  },
  async allTasks(listId) {
    const out = [];
    let token = '';
    do {
      const r = await this.api(`/lists/${listId}/tasks?showCompleted=true&showHidden=true&maxResults=100${token ? '&pageToken=' + token : ''}`);
      out.push(...(r.items || []).map((t) => ({ ...t, _list: listId })));
      token = r.nextPageToken || '';
    } while (token);
    return out;
  },
  // 음성 비서 등으로 Tasks에 직접 만든 할 일 → 마감일(없으면 오늘) 메모에 '☐ 할 일'로 추가
  async importTask(task) {
    const title = (task.title || '').trim().split('\n')[0].slice(0, 200);
    const ds = task.due ? task.due.slice(0, 10) : ymd(new Date());
    const open = state.view === 'day' && state.date === ds;
    const doc = open ? pad.doc : await notes.get(ds);
    const page = appendTodoLine(doc, title);
    if (!page) return null;
    this.setEntry(this.key(ds, { pageId: page.id, text: title }), { id: task.id, done: false, list: task._list });
    this.applying = true;
    try {
      if (open) { saveSoon(); $('#text-page').dataset.pageId = ''; layoutPad(); renderTabs(); }
      else await notes.put(ds, cloneDoc(doc));
    } finally { this.applying = false; }
    listState.cache.set(ds, doc);
    refreshDigest(ds, doc);
    return ds;
  },
  run(full) {
    if (!this.running) {
      this.running = this._run(full)
        .catch((e) => { if (e.message === 'AUTH' || !e.silent) handleErr(e); else console.warn('Tasks 연동', e.message); })
        .finally(() => { this.running = null; if (this.dirty.size) this.schedule([...this.dirty][0]); });
    }
    return this.running;
  },
  async _run(full) {
    if (!this.on()) return;
    const dates = new Set(this.dirty);
    this.dirty.clear();
    this.mapChanged = false;
    await this.syncMap(false);
    let tasks;
    try { await this.ensureList(); tasks = await this.allTasks(this.listId); }
    catch (e) {
      if (!/HTTP 404/.test(e.message)) throw e;
      this.listId = null;
      store.del('gtasksListId');
      await this.ensureList();
      tasks = [];
      // 목록을 새로 만들었으면 예전 연결표는 무의미
      for (const k of Object.keys(this.map)) this.setEntry(k, null);
    }
    // 기본 목록('내 할 일 목록')도 함께 읽음 (음성 비서가 주로 여기에 넣음)
    try { tasks = tasks.concat((await this.allTasks('@default')).filter((t) => !tasks.some((x) => x.id === t.id))); }
    catch (e) { if (e.silent || e.message === 'AUTH') throw e; console.warn('기본 목록', e.message); }
    this.problem = null;
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const dateOf = (k) => k.slice(3, 13);
    let changedAny = false;
    // 예전 꼬리표가 붙은 작업은 연결표로 옮기고 메모에서 꼬리표 지우기
    for (const t of tasks) {
      const m = MARKER_RE.exec(t.notes || '');
      if (!m) continue;
      if (!this.entry(m[1])) this.setEntry(m[1], { id: t.id, done: t.status === 'completed' });
      t.notes = (t.notes || '').replace(MARKER_RE, '').trim();
      await this.api(`/lists/${t._list}/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify({ notes: t.notes }) });
    }
    // Tasks에 직접 만든 새 할 일 가져오기 (가져오기를 켠 뒤 생긴 것, 앱이 만든 것은 제외)
    let since = store.get('gtasksImportSince', 0);
    if (!since) { since = Date.now(); store.set('gtasksImportSince', since); }
    const mapped = new Set(Object.values(this.map).filter((e) => e.id).map((e) => e.id));
    for (const t of tasks) {
      if (mapped.has(t.id) || t.status === 'completed' || t.parent || !(t.title || '').trim()) continue;
      if ((t.notes || '').startsWith('필기캘린더') || Date.parse(t.updated) < since) continue;
      const ds = await this.importTask(t);
      if (ds) { dates.add(ds); mapped.add(t.id); changedAny = true; }
    }
    // Tasks 앱에서 체크가 바뀐 날짜 찾기
    for (const [k, e] of Object.entries(this.map)) {
      if (e.deleted) continue;
      const task = byId.get(e.id);
      if (full || (task && (task.status === 'completed') !== e.done)) dates.add(dateOf(k));
    }
    if (full) {
      const since = ymd(addDays(new Date(), -60));
      for (const d of allNoteDates()) if (d >= since) dates.add(d);
    }
    const usedIds = new Set(Object.values(this.map).filter((e) => !e.deleted).map((e) => e.id));
    for (const ds of dates) {
      // 이 기기가 모르는 날짜는 메모 목록을 막 새로 받은 경우에만 처리 (실수로 Tasks를 지우지 않게)
      if (!notes.has(ds) && Date.now() - notes.lastSync > 5 * 60000) continue;
      const open = state.view === 'day' && state.date === ds;
      const doc = open ? pad.doc : await notes.get(ds);
      const seen = new Set();
      let docChanged = false;
      for (const t of todosOf(doc, ds)) {
        const k = this.key(ds, t);
        if (seen.has(k)) continue;
        seen.add(k);
        let e = this.entry(k);
        let task = e && byId.get(e.id);
        if (e && !task) continue; // Tasks 앱에서 지운 작업은 다시 만들지 않음
        if (!task) {
          // 연결표가 늦게 온 경우: 같은 날짜·같은 제목의 작업이 있으면 그걸 씀 (중복 방지)
          task = tasks.find((x) => !usedIds.has(x.id) && x.title === t.text && (x.due || '').startsWith(ds));
          if (task) { usedIds.add(task.id); e = { id: task.id, done: undefined }; }
        }
        if (!task) {
          const d = parseYmd(ds);
          const created = await this.api(`/lists/${this.listId}/tasks`, { method: 'POST', body: JSON.stringify({
            title: t.text,
            notes: `필기캘린더 ${d.getMonth() + 1}월 ${d.getDate()}일 메모`,
            due: `${t.due || ds}T00:00:00.000Z`,
            status: t.done ? 'completed' : 'needsAction',
          }) });
          usedIds.add(created.id);
          this.setEntry(k, { id: created.id, done: t.done });
          continue;
        }
        // AI 다듬기로 할 일 글자가 바뀌었으면 Tasks 제목도 PATCH
        if (e?.renameTitle && task.title !== e.renameTitle) {
          await this.api(`/lists/${task._list || this.listId}/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ title: e.renameTitle }) });
          task.title = e.renameTitle;
          delete e.renameTitle;
        }
        // 기한을 고쳐 썼으면 Tasks 마감일도 맞춤 (가져온 작업은 원래 마감일 유지)
        const wantDue = t.due || ds;
        if (task._list === this.listId && (task.due || '').slice(0, 10) !== wantDue) {
          await this.api(`/lists/${task._list}/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ due: `${wantDue}T00:00:00.000Z` }) });
        }
        const gDone = task.status === 'completed';
        const last = e.done;
        let next = last;
        if (last === undefined) {
          // 처음 맞추는 할 일: 한쪽이라도 완료면 완료로
          if (gDone && !t.done) { setTodoDone(doc, t, true); docChanged = true; }
          else if (t.done && !gDone) await this.setStatus(task, true);
          next = gDone || t.done;
        } else if (gDone !== last && t.done === last) {
          setTodoDone(doc, t, gDone); // Tasks 앱에서 바뀜 → 메모에 반영
          docChanged = true;
          next = gDone;
        } else if (t.done !== gDone) {
          await this.setStatus(task, t.done); // 앱에서 바뀜 → Tasks에 반영
          next = t.done;
        }
        if (next !== e.done || e.id !== this.map[k]?.id || e.renameTitle !== undefined) this.setEntry(k, { id: task.id, done: next, list: task._list });
      }
      // 메모에서 지운 할 일은 Tasks에서도 삭제 (단, AI 다듬기로 제목만 옮겨간 항목은 삭제하지 않음)
      for (const [k, e] of Object.entries(this.map)) {
        if (e.deleted || e.movedTo || dateOf(k) !== ds || seen.has(k)) continue;
        if (byId.has(e.id)) await this.api(`/lists/${byId.get(e.id)._list}/tasks/${e.id}`, { method: 'DELETE' }).catch((err) => { if (!/HTTP 404/.test(err.message)) throw err; });
        this.setEntry(k, null);
      }
      if (docChanged) {
        changedAny = true;
        this.applying = true;
        try {
          if (open) { saveSoon(); $('#text-page').dataset.pageId = ''; layoutPad(); renderTextTodos(); }
          else await notes.put(ds, doc);
        } finally { this.applying = false; }
        listState.cache.set(ds, doc);
        refreshDigest(ds, doc);
      }
    }
    if (this.mapChanged) await this.syncMap(true);
    else store.set('gtasksMap', this.map);
    this.lastSync = Date.now();
    renderTasksStatus();
    if (changedAny && state.view === 'month') renderMonth();
  },
  setStatus(task, done) {
    return this.api(`/lists/${task._list || this.listId}/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify(done ? { status: 'completed' } : { status: 'needsAction', completed: null }) });
  },
};

function renderTasksStatus() {
  const el2 = $('#gtasks-status');
  if (!el2) return;
  const on = store.get('gtasksOn', true);
  document.querySelectorAll('#gtasks-seg button').forEach((b) => b.classList.toggle('active', (b.dataset.on === '1') === on));
  $('#gtasks-reauth').classList.toggle('hidden', !(on && gtasks.problem === 'scope'));
  el2.textContent = !on ? '꺼져 있어요'
    : !auth.connected() ? '구글 로그인 후 연동돼요'
    : gtasks.problem === 'api' ? '구글 클라우드에서 Tasks API를 켜야 해요'
    : gtasks.problem === 'scope' ? 'Tasks 권한이 필요해요. 아래 버튼으로 다시 연결해 주세요'
    : gtasks.lastSync ? `Tasks '${TASKLIST_TITLE}' 목록과 연동됨 · ${hm(new Date(gtasks.lastSync))}`
    : '연동 준비 중…';
}

// ---------- 사진·음성 메모 (탭 종류 'photo', 'voice')
// 파일은 기기 IndexedDB('blob:id')에 먼저 두고, 동기화할 때 드라이브 '필기캘린더' 폴더에 올려 driveId를 기록
const mediaUrls = new Map(); // media id → 화면용 주소
async function mediaBlob(m) {
  let blob = await idb.get('blob:' + m.id).catch(() => null);
  if (!blob && m.driveId && auth.connected()) {
    const res = await authFetch(`${DRIVE}/${m.driveId}?alt=media`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    blob = await res.blob();
    await idb.set('blob:' + m.id, blob);
  }
  return blob;
}
async function mediaUrl(m) {
  if (mediaUrls.has(m.id)) return mediaUrls.get(m.id);
  const blob = await mediaBlob(m);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  mediaUrls.set(m.id, url);
  return url;
}
async function mediaDataUrl(m) {
  const blob = await mediaBlob(m);
  if (!blob) return null;
  return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
}

// 사진은 긴 쪽 1600px JPEG로 줄여 저장 (용량 절약)
async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  return { blob, w: c.width, h: c.height };
}

async function addPhotos(page, files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try {
      const { blob, w, h } = await shrinkImage(f);
      const m = { id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), type: 'image', mime: 'image/jpeg', w, h };
      await idb.set('blob:' + m.id, blob);
      page.media.push(m);
    } catch (e) { console.warn(e); toast('사진을 읽지 못했어요'); }
  }
}

// 녹음 → 16kHz 모노 WAV로 바꿔서 중계 서버 Gemini로 받아쓰기 (최대 6분)
async function toWav16k(blob, maxSec = 360) {
  const buf = await blob.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const audio = await ctx.decodeAudioData(buf);
  ctx.close?.();
  const sec = Math.min(audio.duration, maxSec);
  const off = new OfflineAudioContext(1, Math.ceil(sec * 16000), 16000);
  const src = off.createBufferSource();
  src.buffer = audio;
  src.connect(off.destination);
  src.start(0);
  const pcm = (await off.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); out.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, 16000, true); out.setUint32(28, 32000, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  w(36, 'data'); out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return { wav: new Blob([out], { type: 'audio/wav' }), cut: audio.duration > maxSec };
}
const blobToB64 = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(b); });

async function transcribeInto(date, pageId, m) {
  if (!CFG.WORKER_URL || !auth.connected()) return toast('음성을 글자로 바꾸려면 구글 로그인과 중계 서버가 필요해요');
  const status = $('#voice-status');
  if (status) status.textContent = '글자로 바꾸는 중…';
  try {
    const { wav, cut } = await toWav16k(await mediaBlob(m));
    const res = await authFetch(`${CFG.WORKER_URL.replace(/\/$/, '')}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: await blobToB64(wav), mime: 'audio/wav', date }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || 'HTTP ' + res.status), { code: data.error });
    // 받아쓴 글 + 찾은 할 일(☐)을 이 탭 글에 덧붙임
    const add = [data.text.trim(), ...(data.todos || []).map((t) => '☐ ' + t)].filter(Boolean).join('\n');
    const open = state.view === 'day' && state.date === date;
    const doc = open ? pad.doc : await notes.get(date);
    const page = doc.pages.find((p) => p.id === pageId);
    if (!page) return;
    page.text = (page.text ? page.text.replace(/\n*$/, '\n\n') : '') + add;
    m.transcribed = true;
    const pm = page.media.find((x) => x.id === m.id);
    if (pm) pm.transcribed = true;
    if (open) { saveSoon(); if (pad.note.id === pageId) renderMediaPage(); renderTabs(); }
    else await notes.put(date, cloneDoc(doc));
    refreshDigest(date, doc);
    if (cut) toast('6분이 넘는 녹음은 앞 6분만 글자로 바꿨어요', 5000);
  } catch (e) {
    handleErr(e);
  } finally {
    const st = $('#voice-status');
    if (st) st.textContent = '';
  }
}

const recorder = { rec: null, chunks: [], started: 0, timer: null };
async function toggleRecord() {
  const page = pad.note;
  if (recorder.rec) { recorder.rec.stop(); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { return toast('마이크를 쓸 수 없어요. 브라우저 설정에서 마이크를 허용해 주세요', 5000); }
  const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  recorder.rec = rec;
  recorder.chunks = [];
  recorder.started = Date.now();
  rec.ondataavailable = (e) => { if (e.data.size) recorder.chunks.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(recorder.timer);
    const blob = new Blob(recorder.chunks, { type: rec.mimeType || 'audio/webm' });
    const dur = Math.round((Date.now() - recorder.started) / 1000);
    recorder.rec = null;
    const m = { id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), type: 'audio', mime: blob.type, dur };
    await idb.set('blob:' + m.id, blob);
    page.media.push(m);
    saveSoon();
    renderMediaPage();
    renderTabs();
    transcribeInto(state.date, page.id, m);
  };
  rec.start(1000);
  recorder.timer = setInterval(() => {
    const s = Math.round((Date.now() - recorder.started) / 1000);
    const b = $('#rec-btn');
    if (b) b.textContent = `■ 멈추기 ${Math.floor(s / 60)}:${pad2(s % 60)}`;
  }, 500);
  renderMediaPage();
}

function renderMediaPage() {
  const box = $('#media-page');
  const page = pad.note;
  const date = state.date;
  const items = [];
  if (page.kind === 'photo') {
    const bar = el('div', 'media-bar');
    const pick = el('label', 'pill primary media-pick');
    const input = el('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = async () => { await addPhotos(page, [...input.files]); saveSoon(); renderMediaPage(); renderTabs(); };
    pick.append(icon('photo'), el('span', null, '사진 찍기·고르기'), input);
    bar.append(pick);
    items.push(bar);
    const grid = el('div', 'photo-grid');
    for (const m of page.media) {
      const fig = el('figure', 'photo');
      const img = el('img');
      img.alt = '사진';
      if (m.w && m.h) img.style.aspectRatio = `${m.w} / ${m.h}`;
      mediaUrl(m).then((u) => { if (u) img.src = u; }).catch(() => { img.alt = '사진을 불러오지 못했어요'; });
      img.onclick = () => mediaUrl(m).then((u) => u && openModal('사진', [Object.assign(el('img', 'photo-full'), { src: u })]));
      const del = el('button', 'photo-del', '✕');
      del.setAttribute('aria-label', '사진 지우기');
      del.onclick = () => {
        if (!confirm('이 사진을 지울까요?')) return;
        page.media = page.media.filter((x) => x !== m);
        saveSoon();
        renderMediaPage();
      };
      fig.append(img, del);
      grid.append(fig);
    }
    if (page.media.length) items.push(grid);
    else items.push(el('p', 'muted-text', '사진을 찍거나 앨범에서 골라 넣으세요. 다른 앱에서 "공유 → 필기캘린더"로도 넣을 수 있어요(안드로이드).'));
  } else {
    const bar = el('div', 'media-bar');
    const rec = el('button', 'pill ' + (recorder.rec ? 'danger' : 'primary'), recorder.rec ? '■ 멈추기' : '● 녹음 시작');
    rec.id = 'rec-btn';
    rec.onclick = toggleRecord;
    bar.append(rec, Object.assign(el('span', 'muted-text'), { id: 'voice-status' }));
    items.push(bar);
    for (const m of page.media) {
      const row = el('div', 'voice-row');
      const audio = el('audio');
      audio.controls = true;
      audio.preload = 'none';
      mediaUrl(m).then((u) => { if (u) audio.src = u; }).catch(() => {});
      row.append(audio, el('span', 'muted-text', m.dur ? `${Math.floor(m.dur / 60)}:${pad2(m.dur % 60)}` : ''));
      if (!m.transcribed) {
        const again = el('button', 'pill', '글자로 바꾸기');
        again.onclick = () => transcribeInto(date, page.id, m);
        row.append(again);
      }
      items.push(row);
    }
    if (!page.media.length) items.push(el('p', 'muted-text', '녹음하면 AI가 받아 적고, 말한 할 일은 ☐로 넣어요. (구글 로그인·중계 서버 필요)'));
  }
  // 사진 설명·받아쓴 글 (검색·요약·할 일에 쓰임)
  const ta = el('textarea', 'media-text');
  ta.placeholder = page.kind === 'photo' ? '사진 설명 (검색에 쓰여요)' : '받아쓴 글 (직접 고칠 수 있어요)';
  ta.value = page.text || '';
  ta.rows = page.kind === 'photo' ? 3 : 10;
  ta.oninput = () => { page.text = ta.value; saveSoon(); };
  items.push(ta);
  box.replaceChildren(...items);
}

// 안드로이드 '공유 → 필기캘린더'로 받은 글·링크·사진을 오늘 메모에 넣음 (sw.js가 share-inbox 캐시에 보관)
async function takeShared(flag) {
  if (!flag || !('caches' in window)) return false;
  const cache = await caches.open('share-inbox');
  const metaRes = await cache.match('./share-meta');
  if (!metaRes) return false;
  const meta = await metaRes.json();
  const ds = ymd(new Date());
  const doc = await notes.get(ds);
  const text = [meta.title, meta.text, meta.url].filter(Boolean).join('\n').trim();
  if (text) {
    let page = doc.pages.find((p) => p.kind === 'text');
    if (!page) { page = blankPage('text'); if (doc.pages.length < MAX_TABS) doc.pages.push(page); }
    page.text = (page.text ? page.text.replace(/\n*$/, '\n\n') : '') + text;
  }
  const files = [];
  for (const f of meta.files || []) {
    const r = await cache.match(f.key);
    if (r) files.push(new File([await r.blob()], f.name || 'photo', { type: f.type }));
    await cache.delete(f.key);
  }
  if (files.length) {
    let page = doc.pages.find((p) => p.kind === 'photo');
    if (!page && doc.pages.length < MAX_TABS) { page = blankPage('photo'); doc.pages.push(page); }
    if (page) await addPhotos(page, files);
  }
  await cache.delete('./share-meta');
  await notes.put(ds, cloneDoc(doc));
  refreshDigest(ds, doc);
  toast('공유받은 내용을 오늘 메모에 넣었어요');
  await openDay(ds, { push: true });
  return true;
}

// ---------- 드라이브에 JSON 하나를 두고 항목별로 더 최근 것을 합치는 저장소 (휴지통·서식·색인)
function syncedStore(fileName, storeKey, keepDays = 60) {
  return {
    fileId: null,
    syncing: null,
    timer: null,
    all() { return store.get(storeKey, {}); },
    live() { return Object.entries(this.all()).filter(([, v]) => !v.deleted); },
    get(k) { const v = this.all()[k]; return v && !v.deleted ? v : null; },
    put(k, v) {
      const a = this.all();
      a[k] = { ...v, t: Date.now() };
      store.set(storeKey, a);
      this.later();
    },
    del(k) {
      const a = this.all();
      if (!a[k] || a[k].deleted) return;
      a[k] = { deleted: true, t: Date.now() };
      store.set(storeKey, a);
      this.later();
    },
    later() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.sync().catch(handleErr), 2000);
    },
    sync() {
      if (!auth.connected()) return Promise.resolve();
      if (!this.syncing) this.syncing = this._sync().finally(() => { this.syncing = null; });
      return this.syncing;
    },
    async _sync() {
      if (!this.fileId) {
        const fid = await drive.ensureFolder();
        const q = encodeURIComponent(`'${fid}' in parents and name='${fileName}' and trashed=false`);
        this.fileId = (await gapi(`${DRIVE}?q=${q}&fields=files(id)`)).files[0]?.id || null;
      }
      let remote = {};
      if (this.fileId) {
        const d = await drive.read(this.fileId);
        remote = (typeof d === 'string' ? JSON.parse(d) : d)?.items || {};
      }
      const merged = { ...remote };
      for (const [k, v] of Object.entries(this.all())) if (!merged[k] || (v.t || 0) > (merged[k].t || 0)) merged[k] = v;
      const cutoff = Date.now() - keepDays * 86400e3;
      for (const [k, v] of Object.entries(merged)) if ((v.t || 0) < cutoff && (v.deleted || keepDays < 365)) delete merged[k];
      store.set(storeKey, merged);
      if (JSON.stringify(merged) !== JSON.stringify(remote)) {
        const payload = { v: 1, items: merged };
        if (this.fileId) await drive.update(this.fileId, payload);
        else this.fileId = (await drive.create(fileName, payload)).id;
      }
    },
  };
}

// ---------- 두 기기에서 같은 날을 고쳤을 때 탭 단위로 합치기
// 각 탭은 마지막으로 바뀐 시각 t, 문서는 지운 탭 기록 gone{id: 시각}을 가짐 (notes.put이 자동으로 기록)
function stampPages(prev, next) {
  const now = Date.now();
  const old = new Map((prev?.pages || []).map((p) => [p.id, p]));
  const sig = (p) => JSON.stringify({ ...p, t: undefined });
  for (const p of next.pages) {
    const o = old.get(p.id);
    if (!o || sig(o) !== sig(p)) p.t = now;
    else if (o.t) p.t = o.t;
  }
  const gone = { ...(prev?.gone || {}), ...(next.gone || {}) };
  for (const id of old.keys()) if (!next.pages.some((p) => p.id === id)) gone[id] = now;
  const cutoff = now - 60 * 86400e3;
  for (const [id, t] of Object.entries(gone)) if (t < cutoff || next.pages.some((p) => p.id === id && (p.t || 0) > t)) delete gone[id];
  if (Object.keys(gone).length) next.gone = gone;
  else delete next.gone;
}

function mergeDocs(local, remote, base) {
  const pages = [];
  const rById = new Map(remote.pages.map((p) => [p.id, p]));
  const gone = { ...(remote.gone || {}) };
  for (const [id, t] of Object.entries(local.gone || {})) gone[id] = Math.max(gone[id] || 0, t);
  let conflicts = 0;
  for (const lp of local.pages) {
    const rp = rById.get(lp.id);
    if (!rp) { if (!(remote.gone?.[lp.id] > (lp.t || 0))) pages.push(lp); continue; }
    rById.delete(lp.id);
    const lt = lp.t || 0, rt = rp.t || 0;
    const same = JSON.stringify({ ...lp, t: 0 }) === JSON.stringify({ ...rp, t: 0 });
    if (same) { pages.push(lt >= rt ? lp : rp); continue; }
    // 둘 다 지난 동기화 뒤에 고쳤으면: 최신 것을 쓰고 다른 쪽은 '충돌 사본' 탭으로 살림
    // 단, 손글씨 획이나 사진·녹음 파일은 똑같고 OCR 원문/요약만 고친 경우에는 탭을 복제하지 않고 최신 수정본으로 덮어씀
    pages.push(lt >= rt ? lp : rp);
    const sameContentExceptOcr = !lp.kind && !rp.kind && inkSig(lp) === inkSig(rp);
    if (lt > base && rt > base && !sameContentExceptOcr) {
      const older = lt >= rt ? rp : lp;
      const baseId = older.id.replace(/-c[0-9a-z]+$/i, '');
      const cid = baseId + '-c' + Date.now().toString(36);
      // 이미 같은 내용의 충돌 사본이 있으면 또 만들지 않음
      const olderSig = JSON.stringify({ ...older, id: '', t: 0, conflict: undefined });
      const dup = pages.some((p) => p.conflict && JSON.stringify({ ...p, id: '', t: 0, conflict: undefined }) === olderSig);
      if (!dup && pages.length < MAX_TABS) {
        pages.push({ ...older, id: cid, t: Date.now(), conflict: true, ...(older.kind === 'text' || older.kind === 'voice' ? { text: '(다른 기기에서 고친 내용)\n' + (older.text || '') } : {}) });
        conflicts++;
      }
    }
  }
  for (const rp of rById.values()) if (!(local.gone?.[rp.id] > (rp.t || 0))) pages.push(rp);
  const doc = { v: 2, pages: pages.length ? pages : [blankPage('text')], updated: Date.now() };
  for (const id of Object.keys(gone)) if (pages.some((p) => p.id === id && (p.t || 0) > gone[id])) delete gone[id];
  if (Object.keys(gone).length) doc.gone = gone;
  return { doc, conflicts };
}

// ---------- 날짜별 색인: 드라이브 index.json (미리보기 글·할 일). 처음 여는 기기도 목록·검색·할 일이 빠름
const noteIndex = Object.assign(syncedStore('index.json', 'noteIndex', 3650), {
  entry(doc, ds) {
    return {
      p: docPreview(doc).map((x) => ({ kind: x.kind, text: x.text, ink: !!x.page && !x.text })),
      todos: todosOf(doc, ds).map(({ pageId, kind, line, idx, text, done }) => ({ pageId, kind, line, idx, text, done })),
      u: doc.updated || Date.now(),
    };
  },
  update(ds, doc) {
    if (!doc || docEmpty(doc)) this.del(ds);
    else this.put(ds, this.entry(doc, ds));
    // 할 일이 바뀌었을 수 있으니 달력 위 마감 알림 줄도 다시 셈 (모아서 한 번)
    clearTimeout(this.dueTimer);
    this.dueTimer = setTimeout(() => { if (state.view === 'month') renderDueBar(); }, 200);
  },
  // 검색에 쓸 가벼운 문서 모양
  doc(ds) {
    const e = this.get(ds);
    return e ? { pages: e.p.map((x) => ({ id: 'ix', kind: 'text', text: x.text, strokes: [] })) } : null;
  },
  // 이 기기에 있는데 색인에 없는 날짜를 채움
  async fill() {
    for (const ds of notes.localDays) {
      if (this.get(ds)) continue;
      const raw = await idb.get('note:' + ds).catch(() => null);
      if (raw) this.put(ds, this.entry(normalize(raw), ds));
    }
  },
});

// ---------- 앱 잠금: PIN(필수) + 지문·얼굴(가능한 기기). 기기마다 따로, 화면만 잠금(데이터 암호화는 아님)
const appLock = {
  conf() { return store.get('lock', null); },
  hiddenAt: 0,
  async hash(pin, salt) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pin));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  },
  async check(pin) { const c = this.conf(); return !!c && (await this.hash(pin, c.salt)) === c.hash; },
  show() {
    const c = this.conf();
    if (!c) return;
    let entered = '';
    const dots = () => $('#lock-dots').replaceChildren(...Array.from({ length: Math.max(4, entered.length) }, (_, i) => el('span', 'lock-dot' + (i < entered.length ? ' on' : ''))));
    const press = async (k) => {
      if (k === '⌫') entered = entered.slice(0, -1);
      else if (entered.length < 8) entered += k;
      dots();
      if (entered.length >= c.len && (await this.check(entered))) this.unlock();
      else if (entered.length >= c.len) { $('#lock-msg').textContent = '번호가 달라요'; entered = ''; setTimeout(dots, 300); }
    };
    $('#lock-pad').replaceChildren(...['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k) => {
      const b = el('button', 'lock-key', k);
      if (!k) b.disabled = true;
      b.onclick = () => press(k);
      return b;
    }));
    $('#lock-msg').textContent = '';
    dots();
    $('#lock-bio').classList.toggle('hidden', !c.credId);
    $('#lock-bio').onclick = () => this.bio();
    $('#lock').classList.remove('hidden');
    this.onKey = (e) => { if (/^\d$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') press('⌫'); e.stopPropagation(); };
    document.addEventListener('keydown', this.onKey, true);
    if (c.credId) this.bio();
  },
  unlock() {
    $('#lock').classList.add('hidden');
    document.removeEventListener('keydown', this.onKey, true);
  },
  async bio() {
    const c = this.conf();
    try {
      const id = Uint8Array.from(atob(c.credId), (ch) => ch.charCodeAt(0));
      await navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), allowCredentials: [{ id, type: 'public-key' }], userVerification: 'required', timeout: 60000 } });
      this.unlock();
    } catch { $('#lock-msg').textContent = '번호로 열어 주세요'; }
  },
  async registerBio() {
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: '필기캘린더' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'owner', displayName: '필기캘린더 사용자' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
      timeout: 60000,
    } });
    return btoa(String.fromCharCode(...new Uint8Array(cred.rawId)));
  },
};

function openLockSettings() {
  const c = appLock.conf();
  const nodes = [el('p', 'muted-text', '이 기기에서 앱을 열 때 번호(또는 지문·얼굴)를 물어요. 화면만 잠그며, 기기마다 따로 설정해요.')];
  if (!c) {
    const pin = Object.assign(el('input'), { type: 'password', inputMode: 'numeric', placeholder: '번호 4~8자리', maxLength: 8 });
    const pin2 = Object.assign(el('input'), { type: 'password', inputMode: 'numeric', placeholder: '한 번 더', maxLength: 8 });
    const bioWrap = el('label', 'todo-toggle');
    const bio = Object.assign(el('input'), { type: 'checkbox' });
    bioWrap.append(bio, document.createTextNode(' 지문·얼굴로도 열기'));
    const ok = el('button', 'pill primary', '잠금 켜기');
    ok.onclick = async () => {
      if (!/^\d{4,8}$/.test(pin.value)) return toast('숫자 4~8자리로 정해 주세요');
      if (pin.value !== pin2.value) return toast('두 번 입력한 번호가 달라요');
      const salt = Math.random().toString(36).slice(2);
      const conf = { salt, hash: await appLock.hash(pin.value, salt), len: pin.value.length, after: 5 };
      if (bio.checked) {
        try { conf.credId = await appLock.registerBio(); } catch { toast('지문·얼굴 등록은 건너뛰었어요 (번호로만 잠금)'); }
      }
      store.set('lock', conf);
      closeModal();
      toast('앱 잠금을 켰어요');
    };
    const form = el('div', 'lock-form');
    form.append(pin, pin2);
    if (window.PublicKeyCredential) form.append(bioWrap);
    form.append(ok);
    nodes.push(form);
  } else {
    const after = el('div', 'seg');
    for (const [v, label] of [[0, '바로'], [5, '5분 뒤'], [30, '30분 뒤']]) {
      const b = el('button', c.after === v ? 'active' : '', label);
      b.onclick = () => { store.set('lock', { ...appLock.conf(), after: v }); openLockSettings(); };
      after.append(b);
    }
    const pin = Object.assign(el('input'), { type: 'password', inputMode: 'numeric', placeholder: '지금 번호', maxLength: 8 });
    const off = el('button', 'pill danger', '잠금 끄기');
    off.onclick = async () => {
      if (!(await appLock.check(pin.value))) return toast('번호가 달라요');
      store.del('lock');
      closeModal();
      toast('앱 잠금을 껐어요');
    };
    nodes.push(el('span', 'settings-label', '다른 앱을 쓰다 돌아오면 잠그기'), after, el('span', 'settings-label', '끄려면 번호 입력'), pin, off);
  }
  openModal('앱 잠금', nodes);
}

// ---------- 캘린더별 켜고 끄기 (드라이브 prefs.json으로 기기끼리 같게)
const MEMO_CAL = '메모 일정', HOLIDAY_CAL = '공휴일';
const prefs = syncedStore('prefs.json', 'prefs', 36500);
const calKey = (ev) => (ev.source === 'memo' ? MEMO_CAL : ev.calendar || '네이버 캘린더');
let hiddenMemo = { raw: undefined, set: new Set() };
function hiddenCals() {
  const raw = localStorage.getItem('prefs');
  if (raw !== hiddenMemo.raw) hiddenMemo = { raw, set: new Set(prefs.get('hiddenCals')?.list || []) };
  return hiddenMemo.set;
}
function setCalVisible(name, visible) {
  const h = new Set(hiddenCals());
  if (visible) h.delete(name); else h.add(name);
  prefs.put('hiddenCals', { list: [...h] });
  renderCalFilter();
  if (state.view === 'month') renderMonth();
  else renderDayEvents();
}
function renderCalFilter() {
  const box = $('#cal-filter');
  if (!box) return;
  const hidden = hiddenCals();
  const row = (c) => {
    const r = el('label', 'cal-row');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !hidden.has(c.name);
    cb.style.setProperty('--c', c.color || '#03c75a');
    cb.onchange = () => setCalVisible(c.name, cb.checked);
    r.title = c.name;
    r.append(cb, el('span', 'cal-name', c.name));
    return r;
  };
  const naverCals = store.get('naverCals', []);
  const groups = [
    ['네이버 캘린더', naverCals.length ? naverCals : null],
    ['이 앱', [{ name: MEMO_CAL, color: '#2563eb' }, { name: HOLIDAY_CAL, color: '#dc2626' }]],
  ];
  box.replaceChildren(...groups.flatMap(([title, cals]) => [
    el('h3', 'cal-group-title', title),
    ...(cals ? cals.map(row) : [el('div', 'cal-empty', naver.enabled() ? '불러오는 중…' : '로그인하면 나타나요')]),
  ]));
}

// 왼쪽 캘린더 목록 창 (넓은 화면은 옆에 붙고, 좁은 화면은 서랍처럼 덮음)
const miniState = { month: null };
const isWideSide = () => window.matchMedia('(min-width: 900px)').matches;
function setSide(open) {
  document.body.classList.toggle('side-on', open);
  $('#side-btn').setAttribute('aria-expanded', String(open));
  if (isWideSide()) store.set('sideOpen', open);
  if (open) { renderCalFilter(); renderMiniCal(); }
}
function renderMiniCal() {
  const box = $('#mini-grid');
  if (!box || !document.body.classList.contains('side-on')) return;
  const m = miniState.month || state.month;
  miniState.month = m;
  $('#mini-title').textContent = `${m.getFullYear()}.${String(m.getMonth() + 1).padStart(2, '0')}`;
  const today = ymd(new Date());
  const start = sundayOf(m);
  const cells = ['일', '월', '화', '수', '목', '금', '토'].map((d, i) => el('span', 'mini-dow' + (i === 0 ? ' sun' : i === 6 ? ' sat' : ''), d));
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const ds = ymd(d);
    const b = el('button', 'mini-day', String(d.getDate()));
    if (d.getMonth() !== m.getMonth()) b.classList.add('other');
    if (d.getDay() === 0 || holidayOn(d)) b.classList.add('sun');
    else if (d.getDay() === 6) b.classList.add('sat');
    if (ds === today) b.classList.add('today');
    b.setAttribute('aria-label', `${d.getMonth() + 1}월 ${d.getDate()}일 열기`);
    b.onclick = () => { if (!isWideSide()) setSide(false); openDay(ds); };
    cells.push(b);
    if (i === 34 && addDays(start, 35).getMonth() !== m.getMonth()) break;
  }
  box.replaceChildren(...cells);
}
function shiftMini(n) {
  const m = miniState.month || state.month;
  miniState.month = new Date(m.getFullYear(), m.getMonth() + n, 1);
  renderMiniCal();
}

// 휴지통: 지운 탭을 30일 보관 (드라이브 trash.json으로 기기끼리 공유)
const trash = Object.assign(syncedStore('trash.json', 'trash', 30), {
  add(date, page) { this.put(page.id, { date, page, at: Date.now() }); },
  remove(id) { this.del(id); },
  list() { return this.live().map(([id, v]) => ({ id, ...v })).sort((a, b) => b.at - a.at); },
});

// 메모 서식 (드라이브 templates.json으로 공유, 오래돼도 지우지 않음)
const templates = Object.assign(syncedStore('templates.json', 'templates', 3650), {
  list() {
    const items = this.live().map(([id, v]) => ({ id, ...v })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (items.length || store.get('templatesInit', false)) return items;
    // 처음엔 기본 서식 두 개
    store.set('templatesInit', true);
    this.put('tpl-meeting', { name: '회의록', text: '회의록 · {날짜}\n참석자: \n안건\n- \n결정\n- \n할 일\n☐ ', order: 0 });
    this.put('tpl-daily', { name: '하루 정리', text: '{날짜} 정리\n오늘 한 일\n- \n내일 할 일\n☐ \n메모\n', order: 1 });
    return this.list();
  },
});

// 개인 용어집: 자주 쓰는 사람 이름·약어·프로젝트명 (드라이브 glossary.json으로 동기화, AI 변환 시 힌트로 전달)
const glossary = Object.assign(syncedStore('glossary.json', 'glossary', 36500), {
  words() { return this.live().map(([w]) => w); },
  add(word, src = 'user') {
    const w = String(word || '').trim().slice(0, 40);
    if (!w) return;
    this.put(w, { src });
  },
});

// ---------- 떠 있는 메뉴·길게 누르기·위에 뜬 창 닫기
function showMenu(e, items) {
  const m = $('#pop-menu');
  m.replaceChildren(...items.map((it) => {
    if (it.input) {
      const f = el('form', 'pop-input');
      const inp = el('input');
      inp.placeholder = it.input.placeholder;
      inp.enterKeyHint = 'done';
      f.append(inp);
      f.onsubmit = (ev) => { ev.preventDefault(); const v = inp.value.trim(); hideMenu(); if (v) it.input.onSubmit(v); };
      setTimeout(() => inp.focus(), 30);
      return f;
    }
    const b = el('button', 'pop-item');
    b.setAttribute('role', 'menuitem');
    if (it.icon) b.append(icon(it.icon));
    b.append(el('span', null, it.label));
    b.onclick = () => {
      if (it.keepOpen) return it.fn(b);
      hideMenu();
      it.fn();
    };
    return b;
  }));
  m.classList.remove('hidden');
  const x = e?.clientX ?? window.innerWidth / 2, y = e?.clientY ?? window.innerHeight / 2;
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
}
function hideMenu() { $('#pop-menu').classList.add('hidden'); }

function onLongPress(target, fn, ms = 500) {
  let timer = null, sx = 0, sy = 0;
  const cancel = () => { clearTimeout(timer); timer = null; };
  target.addEventListener('pointerdown', (e) => {
    sx = e.clientX; sy = e.clientY;
    cancel();
    timer = setTimeout(() => { timer = null; navigator.vibrate?.(15); fn(e); }, ms);
  });
  target.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel(); });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) target.addEventListener(t, cancel);
  target.addEventListener('contextmenu', (e) => e.preventDefault());
}

// Esc나 뒤로가기: 가장 위에 열린 것부터 하나 닫음. 닫은 게 있으면 true
function closeTopLayer() {
  if (!$('#pop-menu').classList.contains('hidden')) { hideMenu(); return true; }
  for (const id of ['#modal', '#search-ov', '#onboard']) {
    if (!$(id).classList.contains('hidden')) { $(id).classList.add('hidden'); return true; }
  }
  if (state.view === 'month' && !isWideSide() && document.body.classList.contains('side-on')) { setSide(false); return true; }
  if (!$('#settings').classList.contains('hidden')) { $('#settings').classList.add('hidden'); $('#settings-btn').setAttribute('aria-expanded', 'false'); return true; }
  if (state.view === 'day' && isNarrow() && panelVisible()) { setPanel(false); return true; }
  if (state.view === 'day' && typeof lasso !== 'undefined' && lasso.sel.size) { lasso.clear(); return true; }
  return false;
}

// ---------- 빠른 동작: 날짜 길게 누르기, ＋ 버튼, 새 탭 종류
async function addTodoTo(ds, text) {
  const open = state.view === 'day' && state.date === ds;
  const doc = open ? pad.doc : await notes.get(ds);
  const page = appendTodoLine(doc, text);
  if (!page) return toast(`그날 탭이 ${MAX_TABS}개로 가득 찼어요`);
  if (open) { $('#text-page').dataset.pageId = ''; layoutPad(); renderTabs(); saveSoon(); }
  else { await notes.put(ds, cloneDoc(doc)); listState.cache.set(ds, doc); }
  refreshDigest(ds, doc);
  if (state.view === 'month') renderMonth();
  toast(`${parseYmd(ds).getMonth() + 1}월 ${parseYmd(ds).getDate()}일에 할 일을 넣었어요`);
}

// 손글씨 탭 열기: 지금 탭이 빈 메모면 손글씨로 바꾸고, 아니면 새 손글씨 탭
function openInkTab() {
  const cur = pad.note;
  if (cur.kind === 'text' && !(cur.text || '').trim()) toggleKind();
  else if (cur.kind) addPage('ink');
}

const READY = { media: true };
function dayActions(ds) {
  return [
    { label: '할 일 추가', icon: 'check', keepOpen: true, fn: () => showMenu(null, [{ input: { placeholder: "할 일 (예: 금요일까지 보고서)", onSubmit: (v) => addTodoTo(ds, v) } }]) },
    { label: '키보드 메모', icon: 'keyboard', fn: () => openDay(ds).then(() => focusText(true)) },
    { label: '손글씨', icon: 'pen', fn: () => openDay(ds).then(openInkTab) },
    ...(READY.media ? [
      { label: '사진 메모', icon: 'photo', fn: () => openDay(ds).then(() => addPage('photo')) },
      { label: '음성 메모', icon: 'mic', fn: () => openDay(ds).then(() => addPage('voice')) },
    ] : []),
    { label: '할 일 패널 열기', icon: 'check', fn: () => openDay(ds).then(() => { setPanel(true); $('#day-todo-input').focus(); }) },
  ];
}

function showNewTabMenu(e) {
  showMenu(e, [
    { label: '키보드 메모 탭', icon: 'keyboard', fn: () => addPage('text') },
    { label: '손글씨 탭', icon: 'pen', fn: () => addPage('ink') },
    ...(READY.media ? [
      { label: '사진 탭', icon: 'photo', fn: () => addPage('photo') },
      { label: '음성 탭', icon: 'mic', fn: () => addPage('voice') },
    ] : []),
  ]);
}

// 서식 넣기: {날짜}는 그날 날짜로
function showTemplateMenu(e) {
  const items = templates.list();
  showMenu(e, [
    ...items.map((t) => ({ label: t.name, fn: () => insertTemplate(t.text) })),
    { label: '서식 고치기…', icon: 'gear', fn: openTemplateEditor },
  ]);
}
function insertTemplate(text) {
  const d = parseYmd(state.date);
  const body = text.replaceAll('{날짜}', `${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})`);
  const ta = $('#text-page');
  if (document.activeElement !== ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  const pos = ta.selectionStart;
  const before = ta.value.slice(0, pos);
  ta.setRangeText((before && !before.endsWith('\n') ? '\n' : '') + body, pos, ta.selectionEnd, 'end');
  ta.dispatchEvent(new Event('input'));
}

// ---------- 범용 창
function openModal(title, nodes) {
  $('#modal-title').textContent = title;
  $('#modal-body').replaceChildren(...nodes);
  $('#modal').classList.remove('hidden');
  $('#settings').classList.add('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }

function openTemplateEditor() {
  const rows = el('div', 'tpl-list');
  const draw = () => {
    rows.replaceChildren(...templates.list().map((t) => {
      const box = el('div', 'tpl-item');
      const name = el('input');
      name.value = t.name;
      name.placeholder = '서식 이름';
      const text = el('textarea');
      text.value = t.text;
      text.rows = 6;
      const save = () => templates.put(t.id, { name: name.value.trim() || '서식', text: text.value, order: t.order });
      name.onchange = save;
      text.onchange = save;
      const del = el('button', 'pill danger', '삭제');
      del.onclick = () => { if (confirm(`'${t.name}' 서식을 지울까요?`)) { templates.del(t.id); draw(); } };
      box.append(name, text, del);
      return box;
    }));
  };
  draw();
  const add = el('button', 'pill primary', '+ 서식 추가');
  add.onclick = () => { templates.put('tpl-' + Date.now().toString(36), { name: '새 서식', text: '{날짜}\n', order: templates.list().length }); draw(); };
  openModal('메모 서식', [el('p', 'muted-text', '{날짜}는 넣을 때 그날 날짜로 바뀌어요.'), rows, add]);
}

function openTrash() {
  const items = trash.list();
  const now = Date.now();
  openModal('휴지통 (30일 보관)', items.length ? items.map((it) => {
    const d = parseYmd(it.date);
    const row = el('div', 'trash-row');
    const left = Math.max(0, 30 - Math.floor((now - it.at) / 86400e3));
    const what = it.page.kind === 'text' ? firstLine(it.page.text) || '키보드 메모'
      : it.page.kind === 'photo' ? '사진 메모' : it.page.kind === 'voice' ? '음성 메모'
      : it.page.ocr?.text ? firstLine(it.page.ocr.text) : '손글씨';
    row.append(el('span', 'trash-what', `${d.getMonth() + 1}월 ${d.getDate()}일 · ${what}`), el('span', 'muted-text', `${left}일 남음`));
    const b = el('button', 'pill', '되살리기');
    b.onclick = async () => { await restorePage(it.date, it.page); openTrash(); };
    row.append(b);
    return row;
  }) : [el('p', 'muted-text', '휴지통이 비어 있어요.')]);
}

function openGlossary() {
  const chips = el('div', 'glossary-chips');
  const draw = () => {
    const words = glossary.live();
    if (!words.length) {
      chips.replaceChildren(el('span', 'muted-text', '등록된 단어가 없어요. 자주 쓰는 사람 이름·약어를 넣어 보세요.'));
      return;
    }
    chips.replaceChildren(...words.map(([w]) => {
      const chip = el('span', 'glossary-chip');
      const del = el('button', null, '✕');
      del.setAttribute('aria-label', `${w} 삭제`);
      del.onclick = () => { glossary.del(w); draw(); };
      chip.append(el('span', null, w), del);
      return chip;
    }));
  };
  draw();
  const row = el('form', 'jump-date-row');
  const inp = el('input');
  inp.placeholder = '예: 홍길동, TF회의, 마일스톤';
  const add = el('button', 'pill primary', '추가');
  add.type = 'submit';
  row.append(inp, add);
  row.onsubmit = (e) => {
    e.preventDefault();
    for (const part of inp.value.split(/[,，\n]/)) glossary.add(part, 'user');
    inp.value = '';
    draw();
  };
  openModal('개인 용어집', [
    el('p', 'muted-text', '자주 쓰는 사람 이름·약어·프로젝트명을 등록하면 손글씨 AI 변환과 주기적 다듬기가 훨씬 정확해져요.'),
    row,
    chips,
  ]);
}

async function openRefineLog() {
  const nodes = [el('p', 'muted-text', '손글씨 초벌 변환을 유료 모델로 정밀하게 다듬은 내역이에요.')];
  const runRow = el('div', 'jump-date-row');
  const dryBtn = el('button', 'pill', '대상 확인 (Dry-run)');
  const runBtn = el('button', 'pill primary', '지금 일괄 다듬기');
  const statusEl = el('p', 'muted-text', '');
  const runBatch = async (dry) => {
    if (!CFG.WORKER_URL || !auth.connected()) return toast('구글 로그인과 중계 서버가 필요해요');
    dryBtn.disabled = runBtn.disabled = true;
    statusEl.textContent = dry ? '다듬을 대상을 찾는 중…' : '다듬는 중…';
    try {
      const res = await authFetch(`${CFG.WORKER_URL.replace(/\/$/, '')}/refine/run${dry ? '?dry=1' : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || 'HTTP ' + res.status);
      if (dry) statusEl.textContent = `다듬기 대상 ${data.count || 0}건` + (data.targets?.length ? `: ${data.targets.map((t) => t.date).join(', ')}` : '');
      else {
        statusEl.textContent = `완료: ${data.refined || 0}건 다듬음 (건너뜀 ${data.skipped || 0}건)`;
        await notes.syncIndex();
        await digests.sync();
        if (state.view === 'month') renderMonth();
      }
    } catch (e) { statusEl.textContent = '오류: ' + (e.message || e); }
    finally { dryBtn.disabled = runBtn.disabled = false; }
  };
  dryBtn.onclick = () => runBatch(true);
  runBtn.onclick = () => runBatch(false);
  runRow.append(dryBtn, runBtn);
  nodes.push(runRow, statusEl);
  if (auth.connected()) {
    try {
      const fid = await drive.ensureFolder();
      const q = encodeURIComponent(`'${fid}' in parents and name='refine-log.json' and trashed=false`);
      const fileId = (await gapi(`${DRIVE}?q=${q}&fields=files(id)`)).files?.[0]?.id;
      if (fileId) {
        const log = await drive.read(fileId);
        const obj = typeof log === 'string' ? JSON.parse(log) : log;
        const ym = new Date().toISOString().slice(0, 7);
        const spent = obj?.monthly?.[ym]?.usd || 0;
        nodes.push(el('p', 'muted-text', `이번 달(${ym}) 추정 비용: $${spent.toFixed(4)}`));
        const runs = (obj?.runs || []).slice(0, 15);
        for (const r of runs) {
          const row = el('div', 'refine-log-row');
          row.append(
            el('div', null, `${r.at?.slice(0, 16).replace('T', ' ') || ''} · ${r.refined || 0}건 다듬음 ($${(r.costUsd || 0).toFixed(4)})`),
            ...(r.items || []).map((it) => el('div', 'muted-text', `· ${it.date}: ${(it.changes || []).join(', ') || '교정 없음'}`)),
          );
          nodes.push(row);
        }
      } else {
        nodes.push(el('p', 'muted-text', '아직 다듬기 실행 기록이 없어요.'));
      }
    } catch { /* 무시 */ }
  }
  openModal('AI 손글씨 다듬기 내역', nodes);
}

// 달력 제목·하루 제목을 눌러 연·월·날짜 바로 이동
function openDateJump() {
  const curDate = state.view === 'day' && state.date ? parseYmd(state.date)
    : state.calView === 'week' && state.weekStart ? state.weekStart : state.month;
  let year = curDate.getFullYear();
  const curMonth = curDate.getMonth();
  const head = el('div', 'jump-head');
  const prevY = el('button', 'icon-btn', '‹');
  const nextY = el('button', 'icon-btn', '›');
  const yLabel = el('strong', null, `${year}년`);
  prevY.onclick = () => { year--; yLabel.textContent = `${year}년`; drawMonths(); };
  nextY.onclick = () => { year++; yLabel.textContent = `${year}년`; drawMonths(); };
  head.append(prevY, yLabel, nextY);

  const mGrid = el('div', 'jump-months');
  const drawMonths = () => {
    mGrid.replaceChildren(...Array.from({ length: 12 }, (_, m) => {
      const b = el('button', year === curDate.getFullYear() && m === curMonth ? 'active' : '', `${m + 1}월`);
      b.onclick = () => {
        closeModal();
        if (state.view === 'day') closeDay();
        state.month = new Date(year, m, 1);
        if (state.calView === 'week') state.weekStart = sundayOf(state.month);
        renderMonth();
      };
      return b;
    }));
  };
  drawMonths();

  const dateRow = el('form', 'jump-date-row');
  const dateInput = el('input');
  dateInput.type = 'date';
  dateInput.value = state.view === 'day' && state.date ? state.date : ymd(new Date());
  const goBtn = el('button', 'pill primary', '날짜 열기');
  goBtn.type = 'submit';
  dateRow.append(dateInput, goBtn);
  dateRow.onsubmit = (e) => {
    e.preventDefault();
    if (!dateInput.value) return;
    closeModal();
    openDay(dateInput.value);
  };
  openModal('날짜 바로 이동', [head, mGrid, el('span', 'settings-label', '특정 날짜 메모 바로 열기'), dateRow]);
}

// ---------- 처음 쓰는 사람 안내
const ONBOARD = [
  ['날짜를 누르면 그날 메모', '달력에서 날짜를 누르면 그날 메모가 열려요. 오른쪽 아래 ＋는 오늘 메모, 날짜를 길게 누르면 할 일·일정을 바로 넣어요.'],
  ['타자 ↔ 손글씨', '기본은 키보드 메모예요. 오른쪽 위 [필기로]를 누르면 펜으로 써요. 손글씨는 잠시 뒤 자동으로 글자로 바뀌고 달력에 요약이 보여요.'],
  ['할 일', "줄 앞에 [] + 스페이스를 치면 ☐ 할 일이 돼요. '금요일까지 보고서'처럼 쓰면 기한을 알아서 잡고, 구글 Tasks와도 연동돼요."],
  ['모아 보고 찾기', '월·주·메모·할 일로 모아 보고, 돋보기로 메모·손글씨·일정을 한 번에 찾아요. 설정(톱니바퀴)에 서식·내보내기·휴지통이 있어요.'],
];
function showOnboarding() {
  let i = 0;
  const draw = () => {
    const [t, d] = ONBOARD[i];
    $('#onboard-step').replaceChildren(el('h2', null, t), el('p', null, d));
    $('#onboard-dots').replaceChildren(...ONBOARD.map((_, k) => el('span', 'dot-step' + (k === i ? ' on' : ''))));
    $('#onboard-next').textContent = i === ONBOARD.length - 1 ? '시작하기' : '다음';
  };
  const done = () => { store.set('onboarded', true); $('#onboard').classList.add('hidden'); };
  $('#onboard-next').onclick = () => { if (++i >= ONBOARD.length) done(); else draw(); };
  $('#onboard-skip').onclick = done;
  draw();
  $('#onboard').classList.remove('hidden');
}

// ---------- 설정: 글자 크기 · 화면 모드
const UI_SCALES = [0.85, 0.92, 1, 1.1, 1.2, 1.35, 1.5];

// 화면 면적이 클수록 글자를 키우고, 터치 기기는 조금 크게(손가락), 마우스 기기는 조금 작게
// 기준: 갤럭시 폴드8 펼친 화면 ≈ 16px(일정 글자 약 12.8px), 접은 화면 ≈ 14px, 아이패드 ≈ 16.4px, 노트북 ≈ 14.6px
function autoFontPx() {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const f = 9.5 + 0.0065 * Math.sqrt(window.innerWidth * window.innerHeight) + (coarse ? 0.5 : -1);
  return Math.max(13, Math.min(18, f));
}
function applyAutoFont() {
  if (document.activeElement?.matches?.('input, textarea')) return;
  document.documentElement.style.setProperty('--fs-base', autoFontPx().toFixed(2) + 'px');
}
const settings = {
  scale: store.get('uiScale', 1),
  theme: store.get('theme', 'auto'),
  apply() {
    const root = document.documentElement;
    root.style.setProperty('--ui-scale', this.scale);
    applyAutoFont();
    if (this.theme === 'auto') delete root.dataset.theme;
    else root.dataset.theme = this.theme;
    $('#screen-info').textContent = `이 화면 ${window.innerWidth}×${window.innerHeight} · 기본 글자 ${autoFontPx().toFixed(1)}px`;
    $('#font-size-label').textContent = this.scale === 1 ? '자동' : `자동 ${this.scale > 1 ? '+' : '−'}${Math.round(Math.abs(this.scale - 1) * 100)}%`;
    $('#font-down').disabled = this.scale <= UI_SCALES[0];
    $('#font-up').disabled = this.scale >= UI_SCALES[UI_SCALES.length - 1];
    document.querySelectorAll('#theme-seg button').forEach((b) => b.classList.toggle('active', b.dataset.theme === this.theme));
    document.querySelectorAll('#lunar-seg button').forEach((b) => b.classList.toggle('active', b.dataset.lunar === store.get('lunar', 'key')));
    document.querySelectorAll('#pressure-seg button').forEach((b) => b.classList.toggle('active', b.dataset.pressure === store.get('pressure', 'normal')));
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', cssVar('--card') || '#ffffff');
    relayout();
  },
  step(dir) {
    let i = UI_SCALES.findIndex((v) => v >= this.scale - 0.001);
    if (i < 0) i = UI_SCALES.indexOf(1);
    this.scale = UI_SCALES[Math.max(0, Math.min(UI_SCALES.length - 1, i + dir))];
    store.set('uiScale', this.scale);
    this.apply();
  },
  setTheme(t) {
    this.theme = t;
    store.set('theme', t);
    this.apply();
  },
};

function relayout() {
  if (state.view === 'day') layoutPad();
  else renderMonth();
}

// ---------- 시작
function bind() {
  $('#prev-month').onclick = () => animateMonth(-1);
  $('#next-month').onclick = () => animateMonth(1);
  $('#today-btn').onclick = () => {
    const t = new Date();
    if (state.calView === 'week') {
      const diffW = Math.round((sundayOf(t) - state.weekStart) / (7 * 86400e3));
      if (diffW === 0) return;
      state.weekStart = addDays(sundayOf(t), -7 * Math.sign(diffW));
      return animateMonth(Math.sign(diffW));
    }
    const diff = (t.getFullYear() - state.month.getFullYear()) * 12 + t.getMonth() - state.month.getMonth();
    if (diff === 0) return;
    if (Math.abs(diff) === 1) return animateMonth(diff);
    state.month = new Date(t.getFullYear(), t.getMonth() - Math.sign(diff), 1);
    animateMonth(Math.sign(diff));
  };
  $('#back-btn').onclick = () => history.state?.day ? history.back() : closeDay();
  $('#prev-day').onclick = () => shiftDay(-1);
  $('#next-day').onclick = () => shiftDay(1);
  $('#auth-btn').onclick = onAuthClick;

  // 설정 메뉴
  const panel = $('#settings'), sbtn = $('#settings-btn');
  const toggleSettings = (open) => {
    panel.classList.toggle('hidden', !open);
    sbtn.setAttribute('aria-expanded', String(open));
    if (open) { renderTasksStatus(); renderLinkStatus(); renderStorageInfo(); }
  };
  sbtn.onclick = (e) => { e.stopPropagation(); toggleSettings(panel.classList.contains('hidden')); };
  panel.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => toggleSettings(false));
  $('#font-down').onclick = () => settings.step(-1);
  $('#font-up').onclick = () => settings.step(1);
  document.querySelectorAll('#theme-seg button').forEach((b) => { b.onclick = () => settings.setTheme(b.dataset.theme); });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => settings.theme === 'auto' && settings.apply());

  // 1시간 로그인 만료 후 다음 탭에서 자동으로 다시 연결 (팝업이 잠깐 떴다 닫힘)
  let reconnecting = false;
  document.addEventListener('click', (e) => {
    if (reconnecting || auth.connected() || !auth.wasSignedIn()) return;
    if (e.target.closest('#auth-btn, canvas')) return;
    reconnecting = true;
    connect('').catch(handleErr).finally(() => { reconnecting = false; });
  }, true);

  // 달력: 날짜 탭 → 하루 화면, 좌우 스와이프 → 달 이동
  $('#view-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setCalView(b.dataset.view); });
  $('#bottom-tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setCalView(b.dataset.view); });
  // ＋: 누르면 오늘 메모, 길게 누르면 종류 선택
  const fab = $('#fab');
  let fabLong = false;
  fab.onclick = () => {
    if (fabLong) { fabLong = false; return; }
    openDay(ymd(new Date())).then(() => { if (pad.note.kind === 'text') focusText(true); });
  };
  onLongPress(fab, (e) => { fabLong = true; showMenu(e, dayActions(ymd(new Date()))); });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#pop-menu')) hideMenu(); }, true);
  $('#modal-close').onclick = closeModal;
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  $('#month-title').onclick = openDateJump;
  $('#day-title').onclick = openDateJump;
  $('#open-lock').onclick = openLockSettings;
  $('#open-trash').onclick = () => trash.sync().catch(() => {}).finally(openTrash);
  $('#open-templates').onclick = openTemplateEditor;
  if ($('#open-glossary')) $('#open-glossary').onclick = () => glossary.sync().catch(() => {}).finally(openGlossary);
  if ($('#open-refine-log')) $('#open-refine-log').onclick = openRefineLog;
  if ($('#token-transfer-btn')) $('#token-transfer-btn').onclick = openTokenTransfer;
  $('#open-onboard').onclick = () => { $('#settings').classList.add('hidden'); showOnboarding(); };
  $('#sync-now').onclick = () => { lastRefresh = 0; notes.lastSync = 0; refreshInBackground(); notes.flush(); };
  $('#ocr-head').onclick = () => { store.set('ocrOpen', !store.get('ocrOpen', false)); renderOcr(); };
  $('#list-search').addEventListener('input', () => { clearTimeout(listState.searchTimer); listState.searchTimer = setTimeout(renderList, 250); });
  $('#list-more').onclick = () => { listState.shown += LIST_PAGE; renderList(); };
  $('#list-items').addEventListener('click', (e) => { const it = e.target.closest('.list-item'); if (it) openDay(it.dataset.date); });
  for (const grid of [$('#grid'), $('#week-grid')]) attachSwipe(grid);
}

function attachSwipe(grid) {
  let drag = null, swiped = false, pressTimer = null;
  grid.addEventListener('contextmenu', (e) => { if (e.target.closest('.cell, .wcell')) e.preventDefault(); });
  grid.addEventListener('pointerdown', (e) => {
    if (monthAnimating) return;
    const cell = e.target.closest('.cell, .wcell');
    clearTimeout(pressTimer);
    if (cell) {
      pressTimer = setTimeout(() => {
        if (drag?.active) return;
        drag = null;
        swiped = true; // 손을 뗄 때 날짜가 열리지 않게
        navigator.vibrate?.(15);
        showMenu(e, dayActions(cell.dataset.date));
      }, 500);
    }
    drag = { x: e.clientX, y: e.clientY, id: e.pointerId, t: Date.now(), active: false };
    swiped = false;
  });
  grid.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 10) clearTimeout(pressTimer);
    if (!drag.active) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        drag.active = true;
        try { grid.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
        grid.style.transition = 'none';
      } else {
        if (Math.abs(dy) > 12) drag = null;
        return;
      }
    }
    grid.style.transform = `translateX(${dx}px)`;
    grid.style.opacity = String(1 - Math.min(0.5, Math.abs(dx) / grid.clientWidth));
  });
  const endDrag = (e) => {
    clearTimeout(pressTimer);
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.active) return;
    swiped = true;
    const dx = e.clientX - d.x;
    const speed = Math.abs(dx) / Math.max(1, Date.now() - d.t);
    if (Math.abs(dx) > grid.clientWidth * 0.18 || (Math.abs(dx) > 40 && speed > 0.5)) animateMonth(dx < 0 ? 1 : -1);
    else {
      grid.style.transition = 'transform .2s ease-out, opacity .2s ease-out';
      grid.style.transform = '';
      grid.style.opacity = '';
    }
  };
  grid.addEventListener('pointerup', endDrag);
  grid.addEventListener('pointercancel', endDrag);
  grid.addEventListener('click', (e) => {
    if (swiped) { swiped = false; return; }
    const cell = e.target.closest('.cell, .wcell');
    if (cell) openDay(cell.dataset.date);
  });
}

function bindPad() {
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
  document.querySelectorAll('.tool').forEach((b) => { b.onclick = () => { pad.tool = b.dataset.tool; if (pad.tool !== 'lasso') lasso.clear(); syncToolbar(); }; });
  // 확대·축소
  pad.zoom = 1;
  $('#zoom-in').onclick = () => setZoom(pad.zoom + 0.25);
  $('#zoom-out').onclick = () => setZoom(pad.zoom - 0.25);
  $('#zoom-label').onclick = () => setZoom(1);
  $('#page-scroll').addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey) || pad.note.kind) return;
    e.preventDefault();
    setZoom(pad.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { x: e.clientX, y: e.clientY });
  }, { passive: false });
  // 종이 배경
  $('#paper-select').onchange = (e) => { pad.note.paper = e.target.value === 'lined' ? undefined : e.target.value; if (!pad.note.paper) delete pad.note.paper; redraw(); saveSoon(); };
  // 올가미 선택 막대
  $('#sel-colors').replaceChildren(...COLORS.map((c) => {
    const b = el('button', 'swatch');
    b.style.background = c;
    b.setAttribute('aria-label', '선택한 글씨 색 ' + c);
    b.onclick = () => recolorSelection(c);
    return b;
  }));
  $('#sel-delete').onclick = deleteSelection;
  $('#sel-done').onclick = () => lasso.clear();
  // 펜 압력 감도
  $('#pressure-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    store.set('pressure', b.dataset.pressure);
    pathCache = new WeakMap();
    settings.apply();
    if (state.view === 'day' && !pad.note.kind) redraw();
  });
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
    if (!pad.note.strokes.length || !confirm('이 탭의 필기를 모두 지울까요? (실행 취소 가능)')) return;
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

  // 키보드 메모
  const ta = $('#text-page');
  ta.addEventListener('input', () => {
    // 줄 맨 앞에 '[]'+스페이스 → ☐
    const pos = ta.selectionStart, v = ta.value;
    const lineStart = v.lastIndexOf('\n', pos - 1) + 1;
    const m = /^(\s*(?:[-*•]\s*)?)\[\] $/.exec(v.slice(lineStart, pos));
    if (m) ta.setRangeText(m[1] + '☐ ', lineStart, pos, 'end');
    clearTimeout(ta._todoTimer);
    ta._todoTimer = setTimeout(() => { renderTextTodos(); renderDayTodos(); }, 300);
    if (pad.note.kind !== 'text' || ta.dataset.pageId !== pad.note.id) return;
    pad.note.text = ta.value;
    const label = document.querySelector('.page-tab.active .page-tab-label');
    if (label) label.textContent = tabLabel(pad.note, pad.pageIdx);
    saveSoon();
  });
  ta.addEventListener('blur', () => saveNow());
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.shiftKey) return;
    const pos = ta.selectionStart, v = ta.value;
    const lineStart = v.lastIndexOf('\n', pos - 1) + 1;
    const m = TODO_RE.exec(v.slice(lineStart, pos));
    if (!m) return;
    e.preventDefault();
    if (!m[3].trim()) ta.setRangeText('', lineStart, pos, 'end'); // 빈 할 일 줄에서 엔터 → 할 일 끝내기
    else ta.setRangeText(`\n${m[1]}${m[2].startsWith('[') ? '[ ]' : '☐'} `, pos, pos, 'end');
    ta.dispatchEvent(new Event('input'));
  });
  $('#todo-sort').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    todoState.sort = b.dataset.sort;
    store.set('todoSort', todoState.sort);
    renderTodos();
  });
  $('#search-btn').onclick = openSearch;
  $('#search-close').onclick = () => $('#search-ov').classList.add('hidden');
  $('#search-ov').addEventListener('click', (e) => { if (e.target.id === 'search-ov') $('#search-ov').classList.add('hidden'); });
  $('#search-input').addEventListener('input', () => { clearTimeout(searchState.timer); searchState.timer = setTimeout(runSearch, 250); });
  $('#open-export').onclick = openExport;
  $('#day-menu-btn').onclick = openExport;
  $('#lunar-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    store.set('lunar', b.dataset.lunar);
    settings.apply();
  });
  $('#todo-add').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const v = e.target.value;
    e.target.value = '';
    quickAddTodo(v).catch(handleErr);
  });
  // 구글 Tasks 연동 설정
  $('#gtasks-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    store.set('gtasksOn', b.dataset.on === '1');
    renderTasksStatus();
    if (b.dataset.on === '1') gtasks.run(true);
  });
  $('#gtasks-reauth').onclick = () => connect('').then(() => gtasks.run(true)).catch(handleErr);
  $('#settings-btn').addEventListener('click', renderTasksStatus);
  $('#due-open').onclick = () => { todoState.sort = 'due'; store.set('todoSort', 'due'); setCalView('todo'); };
  $('#due-close').onclick = () => { store.set('dueBarHidden', ymd(new Date())); renderDueBar(); };
  $('#side-btn').onclick = () => setSide(!document.body.classList.contains('side-on'));
  $('#side-backdrop').onclick = () => setSide(false);
  $('#mini-prev').onclick = () => shiftMini(-1);
  $('#mini-next').onclick = () => shiftMini(1);
  $('#mini-title').onclick = () => {
    const m = miniState.month;
    if (state.calView !== 'month') setCalView('month');
    state.month = new Date(m.getFullYear(), m.getMonth(), 1);
    if (!isWideSide()) setSide(false);
    renderMonth();
  };
  setSide(isWideSide() && store.get('sideOpen', true));
  // 화면 폭이 바뀌면(폴드 접고 펴기·창 크기) 넓으면 기억한 대로, 좁으면 닫음
  window.matchMedia('(min-width: 900px)').addEventListener('change', (e) => setSide(e.matches && store.get('sideOpen', true)));
  $('#todo-show-done').addEventListener('change', (e) => {
    todoState.showDone = e.target.checked;
    store.set('todoShowDone', todoState.showDone);
    renderTodos();
  });
  if ($('#todo-clear-done')) $('#todo-clear-done').onclick = clearDoneTodos;

  // 필기 → 글자
  $('#ocr-btn').onclick = runOcr;
  if ($('#ocr-refine-btn')) $('#ocr-refine-btn').onclick = runRefinePage;
  if ($('#ocr-draft-btn')) $('#ocr-draft-btn').onclick = showOcrDraftDiff;
  if ($('#ocr-revert-btn')) $('#ocr-revert-btn').onclick = revertOcrToDraft;
  $('#ocr-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(pad.note.ocr?.text || ''); toast('복사했어요'); }
    catch { toast('복사하지 못했어요'); }
  };
  $('#ocr-text').addEventListener('input', (e) => {
    if (!pad.note.ocr) return;
    pad.note.ocr.text = e.target.value;
    pad.note.ocr.userEdited = true;
    saveSoon();
  });

  // 일정·요약 패널
  $('#panel-toggle').onclick = () => setPanel(!panelVisible());
  $('#panel-close').onclick = () => setPanel(false);
  if (store.get('panelHidden2', true)) $('.day-body').classList.add('panel-toggled');
  if (isNarrow()) $('.day-body').classList.remove('panel-toggled');
  syncPanelButton();
  // 시트가 열린 채로 필기장을 누르면 시트를 닫음
  $('#page-scroll').addEventListener('pointerdown', () => { if (isNarrow() && panelVisible()) setPanel(false); }, true);

  // 하루 화면 왼쪽 패널: 할 일 입력 + 손글씨 할 일 패드 + 일정 입력
  if ($('#day-todo-form')) {
    $('#day-todo-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const inp = $('#day-todo-input');
      const v = inp.value.trim();
      if (!v) return;
      inp.value = '';
      await addDayTodosFromLines([v]);
    });
  }
  todoInk.init();
  $('#ev-allday').onchange = (e) => {
    $('#ev-times').classList.toggle('hidden', e.target.checked);
    $('.ev-end-label')?.classList.toggle('hidden', !e.target.checked);
  };
  if ($('#ev-cancel')) $('#ev-cancel').onclick = () => { cancelEditEvent(); $('#ev-title').value = ''; renderDayEvents(); };
  $('#event-form').addEventListener('submit', onAddEvent);

  // 키보드 (윈도우)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && closeTopLayer()) { e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); return; }
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === '/' && state.view === 'month') { e.preventDefault(); openSearch(); return; }
    if (state.view === 'day') {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? restore(pad.redo, pad.undo) : restore(pad.undo, pad.redo); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); restore(pad.redo, pad.undo); }
      else if (e.key === 'Escape') $('#back-btn').click();
      else if (e.key === 'ArrowLeft') shiftDay(-1);
      else if (e.key === 'ArrowRight') shiftDay(1);
      else if (!mod && !e.altKey && (e.key.length === 1 || e.key === 'Enter' || e.key === 'Process') && !e.target.closest('button')) {
        const ch = e.key.length === 1 ? e.key : e.key === 'Enter' ? '\n' : '';
        if (openTextTab() && ch) {
          e.preventDefault();
          const ta = $('#text-page');
          ta.value += ch;
          ta.dispatchEvent(new Event('input'));
        }
      }
    } else if (e.key === 'ArrowLeft') animateMonth(-1);
    else if (e.key === 'ArrowRight') animateMonth(1);
  });

  // 안드로이드 뒤로가기 → 달력
  window.addEventListener('popstate', (e) => {
    if (e.state?.day) openDay(e.state.day, { push: false });
    else if (state.view === 'day') closeDay();
  });

  let resizeTimer = null, lastNarrow = isNarrow();
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      // 폴드를 접고 펼쳐 좁은/넓은 화면이 바뀌면 패널 상태를 그 화면 기본값으로
      if (isNarrow() !== lastNarrow) {
        lastNarrow = isNarrow();
        $('.day-body').classList.toggle('panel-toggled', !lastNarrow && store.get('panelHidden2', true));
        syncPanelButton();
      }
      settings.apply();
    }, 150);
  });
  window.addEventListener('online', async () => {
    setStatus();
    const had = notes.pending.size;
    await notes.flush();
    refreshInBackground();
    autoOcr.kick();
    if (had && auth.connected()) toast('다시 연결됐어요 · 밀린 메모를 올렸어요');
  });
  window.addEventListener('offline', () => setStatus('offline'));
  document.addEventListener('visibilitychange', () => {
    // 잠금: 정한 시간보다 오래 다른 앱에 있다 돌아오면 다시 잠금
    const lock = appLock.conf();
    if (document.visibilityState === 'hidden') appLock.hiddenAt = Date.now();
    else if (lock && appLock.hiddenAt && Date.now() - appLock.hiddenAt >= (lock.after ?? 5) * 60000) appLock.show();
    if (document.visibilityState === 'hidden') saveNow();
    else refreshInBackground();
  });
  window.addEventListener('pagehide', () => { saveNow(); });
}

// 아이패드·아이폰은 설치 안내가 자동으로 뜨지 않아서, 브라우저로 열었을 때 한 번 안내
function showInstallHint() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || isIPad();
  const installed = navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  if (!ios || installed || store.get('installHintClosed', false)) return;
  $('#install-hint').classList.remove('hidden');
  $('#install-hint-close').onclick = () => {
    $('#install-hint').classList.add('hidden');
    store.set('installHintClosed', true);
  };
}

async function init() {
  auth.init();
  bind();
  bindPad();
  settings.apply();
  await notes.loadLocal();
  updateAuthUI();
  const params = new URLSearchParams(location.search);
  const openToday = params.get('open') === 'today';
  const shared = params.get('shared') === '1';
  history.replaceState(null, '', location.pathname);
  renderMonth();
  if (openToday) openDay(ymd(new Date()));
  if (appLock.conf()) appLock.show();
  noteIndex.fill().catch(console.warn);
  showInstallHint();
  if (!store.get('onboarded', false)) showOnboarding();
  takeShared(shared).catch((e) => console.warn('공유받기', e));
  if (auth.connected()) { watchExpiry(); afterSignIn(); }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  }
}

init();
