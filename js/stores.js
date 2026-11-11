// stores.js: 드라이브 JSON 합치기 저장소·탭 합치기·색인·앱 잠금·캘린더 켜고 끄기·소식·백업·휴지통·서식
// (일반 스크립트: index.html에 적힌 순서대로 읽히고 전역 이름을 서로 함께 씀. 순서를 바꾸지 말 것)
'use strict';

// ---------- 드라이브에 JSON 하나를 두고 항목별로 더 최근 것을 합치는 저장소 (휴지통·서식·색인)
function syncedStore(fileName, storeKey, keepDays = 60) {
  return {
    fileId: null,
    syncing: null,
    timer: null,
    // 달력 한 번 그릴 때 get을 수백 번 부르므로, 저장된 글이 그대로면 해석해 둔 것을 다시 씀
    _raw: undefined,
    _obj: null,
    all() {
      let raw = null;
      try { raw = localStorage.getItem(storeKey); } catch { /* 저장소 사용 불가 */ }
      if (raw !== this._raw || !this._obj) {
        this._raw = raw;
        try { this._obj = raw == null ? {} : JSON.parse(raw) || {}; } catch { this._obj = {}; }
      }
      return this._obj;
    },
    live() { return Object.entries(this.all()).filter(([, v]) => !v.deleted); },
    get(k) { const v = this.all()[k]; return v && !v.deleted ? v : null; },
    put(k, v) {
      const a = { ...this.all() }; // 캐시해 둔 것을 직접 고치지 않게 복사
      a[k] = { ...v, t: Date.now() };
      store.set(storeKey, a);
      this.later();
    },
    del(k) {
      const a = { ...this.all() };
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

// 밤사이 AI 다듬기 소식: 안티그래비티(argonRefine.applyResult)가 고친 탭을 드라이브 refine-news.json에 남기고,
// 내 기기가 열릴 때 아직 안 본 것을 "밤사이 손글씨 N곳을 고쳤어요 [보기]"로 한 번 알려줌 (30일 보관)
const refineNews = Object.assign(syncedStore('refine-news.json', 'refineNews', 30), {
  unseen() {
    const seen = store.get('refineSeen', 0);
    return this.live().map(([k, v]) => ({ k, ...v })).filter((x) => (x.at || 0) > seen).sort((a, b) => b.at - a.at);
  },
});
function showRefineNews() {
  const list = refineNews.unseen();
  if (!list.length) return;
  toast(`밤사이 AI가 손글씨 ${list.length}곳을 다듬었어요`, 9000, { label: '보기', fn: () => openRefineNews(list) });
}
function openRefineNews(list = refineNews.unseen()) {
  store.set('refineSeen', Date.now());
  const rows = list.length ? list.map((x) => {
    const row = el('div', 'news-row');
    const head = el('div', 'news-head');
    const d = parseYmd(x.date);
    head.append(el('strong', '', `${d.getMonth() + 1}월 ${d.getDate()}일`));
    const go = el('button', 'pill', '열어 보기');
    go.onclick = async () => {
      closeModal();
      await openDay(x.date);
      const i = pad.doc.pages.findIndex((p) => p.id === x.pageId);
      if (i >= 0) switchPage(i);
    };
    head.append(go);
    row.append(head);
    const ch = (x.changes || []).map((c) => (typeof c === 'string' ? c : `${c.from} → ${c.to}`)).filter(Boolean);
    row.append(el('p', 'muted-text', ch.length ? ch.join(' · ') : '고친 곳 목록 없음'));
    return row;
  }) : [el('p', 'muted-text', '새로 다듬은 손글씨가 없어요.')];
  rows.push(el('p', 'muted-text', '마음에 안 들면 그 탭의 변환 카드에서 [초벌로 되돌리기]를 누르세요.'));
  openModal('밤사이 AI 다듬기', rows);
}

// 자동 백업: 한 달에 한 번 드라이브에 전체 메모 묶음(backup-YYYY-MM.json)을 남기고 최근 6개만 유지
const backup = {
  running: false,
  async build() {
    const days = {};
    for (const ds of allNoteDates()) {
      try { const doc = await notes.get(ds); if (!docEmpty(doc)) days[ds] = doc; } catch (e) { console.warn('백업: 읽기 실패', ds, e); }
    }
    return {
      v: 1,
      at: new Date().toISOString(),
      days,
      events: memos.all(),
      digests: store.get('digests', {}),
      templates: store.get('templates', {}),
      glossary: store.get('glossary', {}),
      goals: store.get('goals', {}),
      prefs: store.get('prefs', {}),
    };
  },
  async run({ force = false } = {}) {
    if (this.running || !auth.connected()) return null;
    const month = ymd(new Date()).slice(0, 7);
    if (!force && store.get('backupMonth', '') === month) return null;
    this.running = true;
    try {
      const files = await drive.list();
      const name = `backup-${month}.json`;
      if (!force && files.has(name)) { store.set('backupMonth', month); return null; }
      const data = await this.build();
      const old = files.get(name);
      const res = old ? await drive.update(old.id, data) : await drive.create(name, data);
      // 오래된 백업 정리 (최근 6개만)
      const backups = [...files.keys()].filter((n) => /^backup-\d{4}-\d{2}\.json$/.test(n) && n !== name).sort().reverse();
      for (const n of backups.slice(5)) await drive.remove(files.get(n).id).catch(() => {});
      store.set('backupMonth', month);
      store.set('backupAt', Date.now());
      return { name, days: Object.keys(data.days).length, id: res?.id };
    } finally {
      this.running = false;
    }
  },
};

function openBackup() {
  const at = store.get('backupAt', 0);
  const info = el('p', 'muted-text', at
    ? `마지막 백업: ${new Date(at).toLocaleString('ko-KR')} · 구글 드라이브 '필기캘린더' 폴더의 backup-연-월.json (최근 6개 보관)`
    : '아직 백업이 없어요. 로그인해 두면 한 달에 한 번 자동으로 드라이브에 남겨요.');
  const btn = el('button', 'pill primary', '지금 백업하기');
  btn.onclick = async () => {
    if (!auth.connected()) return toast('구글 로그인 뒤에 백업할 수 있어요');
    btn.disabled = true;
    btn.textContent = '백업 중…';
    try {
      const r = await backup.run({ force: true });
      if (r) toast(`백업했어요: ${r.name} (${r.days}일치)`);
      closeModal();
    } catch (e) { handleErr(e); btn.disabled = false; btn.textContent = '지금 백업하기'; }
  };
  openModal('백업', [info, el('p', 'muted-text', '메모·손글씨·할 일·메모 일정·서식·용어집·목표·설정을 한 파일로 묶어요. 사진·녹음은 드라이브에 따로 있어 묶지 않아요.'), btn]);
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
