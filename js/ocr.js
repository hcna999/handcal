// ocr.js: 손글씨 → 글자(AI 변환)·달력 요약·안티그래비티 다듬기 도우미
// (일반 스크립트: index.html에 적힌 순서대로 읽히고 전역 이름을 서로 함께 씀. 순서를 바꾸지 말 것)
'use strict';

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
      if (/^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(raw.trim())) {
        parsed = await claimLinkCode(raw.trim()); // 8자리 1회용 코드
      } else {
        try {
          parsed = JSON.parse(decodeURIComponent(escape(atob(raw))));
        } catch {
          parsed = { r: raw };
        }
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
    refineNews.put(`${date}:${pageId}`, { date, pageId, changes: (changes || []).slice(0, 5), at: Date.now() });
    if (auth.connected()) {
      await Promise.all([notes.flush(), digests.sync(), glossary.sync(), refineNews.sync(), gtasks.run(false)]).catch((e) => console.warn(e));
    }
    return { ok: true, date, pageId, changesCount: (changes || []).length };
  },
};
