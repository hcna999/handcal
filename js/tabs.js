// tabs.js: 필기 탭(추가·삭제·전환·타자/손글씨)
// (일반 스크립트: index.html에 적힌 순서대로 읽히고 전역 이름을 서로 함께 씀. 순서를 바꾸지 말 것)
'use strict';

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
  renderDayGoals();
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
