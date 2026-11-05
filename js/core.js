// core.js: 공통 도구·저장소·구글 로그인·드라이브·필기 노트 저장/동기화
// (일반 스크립트: index.html에 적힌 순서대로 읽히고 전역 이름을 서로 함께 씀. 순서를 바꾸지 말 것)
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
