// sync.js: 동기화 상태·로그인 UI·연결 코드·구글 Tasks
// (일반 스크립트: index.html에 적힌 순서대로 읽히고 전역 이름을 서로 함께 씀. 순서를 바꾸지 말 것)
'use strict';

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
    syncGoals().catch(console.warn);
    refineNews.sync().then(showRefineNews).catch(console.warn);
    setTimeout(() => backup.run().catch((e) => console.warn('백업 실패', e)), 15000);
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

// 8자리 1회용 코드로 연결 정보 받기 (아직 로그인 전이라 주인 확인 없이 부름).
// 서버 KV는 다른 지역에 퍼지는 데 몇 초 걸릴 수 있어 '없음'이면 잠깐씩 다시 시도
async function claimLinkCode(code) {
  if (!CFG.WORKER_URL) throw new Error('중계 서버 주소가 없어요');
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${CFG.WORKER_URL.replace(/\/$/, '')}/link/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.r) return data;
    if (data.error !== 'code_not_found') throw new Error(data.message || 'HTTP ' + res.status);
    if (i < 3) await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error('코드가 없거나 5분이 지났어요. 새 코드를 만들어 주세요.');
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
  const desc = el('p', 'muted-text', '다른 브라우저(또는 안티그래비티 자동화 창)에서 구글 팝업 로그인이 막힐 때, 이미 로그인된 브라우저에서 1회용 코드를 만들어 그 창에 넣으면 같은 구글 드라이브에 연결돼요.');
  box.append(desc);
  if (curRefresh || curAuth?.token) {
    const codeBox = el('div', 'link-code hidden');
    const makeBtn = el('button', 'pill primary', '1회용 코드 만들기 (5분)');
    makeBtn.onclick = async () => {
      makeBtn.disabled = true;
      try {
        const res = await authFetch(`${CFG.WORKER_URL.replace(/\/$/, '')}/link/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ r: curRefresh, a: curAuth }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw Object.assign(new Error(data.message || 'HTTP ' + res.status), { code: data.error });
        codeBox.replaceChildren(el('strong', 'link-code-num', data.code), el('span', 'muted-text', '5분 안에 한 번만 쓸 수 있어요. 쓰면 바로 없어져요.'));
        codeBox.classList.remove('hidden');
        navigator.clipboard?.writeText(data.code).catch(() => {});
      } catch (e) {
        if (e.code === 'kv_missing') showLongCode();
        else handleErr(e);
      } finally {
        makeBtn.disabled = false;
      }
    };
    // 서버에 KV가 없을 때만: 예전 긴 연결 코드(리프레시 토큰 자체)
    const showLongCode = () => {
      const payload = btoa(unescape(encodeURIComponent(JSON.stringify({ r: curRefresh, a: curAuth }))));
      const copyBtn = el('button', 'pill', '긴 연결 코드 복사하기');
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(payload);
          toast('연결 코드를 복사했어요! 연결할 창에 붙여넣으세요.');
        } catch {
          prompt('아래 연결 코드를 복사하세요:', payload);
        }
      };
      codeBox.replaceChildren(
        el('p', 'warn-text', '⚠ 서버에 1회용 코드 저장소가 없어 긴 코드를 써야 해요. 이 코드는 구글 드라이브 메모와 할 일을 열 수 있는 열쇠예요. 내 기기끼리만 쓰고 다른 사람에게 보내지 마세요. 새어 나갔다면 ⚙ → 로그아웃 후 다시 로그인하면 이전 코드는 못 써요.'),
        copyBtn,
      );
      codeBox.classList.remove('hidden');
    };
    box.append(makeBtn, codeBox);
  }
  const input = el('input');
  input.type = 'text';
  input.placeholder = '받은 코드 넣기 (예: K7P2-Q9XM)';
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
    syncGoals().catch(console.warn);
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
