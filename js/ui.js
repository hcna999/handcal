// ui.js: 떠 있는 메뉴·빠른 동작·창·안내·설정
// (일반 스크립트: index.html에 적힌 순서대로 읽히고 전역 이름을 서로 함께 씀. 순서를 바꾸지 말 것)
'use strict';

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
  goalModalCtx = null; // 다른 창을 열면 목표 창 다시 그리기가 그 창을 덮어쓰지 않게
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
const UI_SCALES = [0.75, 0.85, 0.92, 1, 1.1, 1.2, 1.35, 1.5];

// 화면 면적이 클수록 글자를 키우고, 터치 기기는 조금 크게(손가락), 마우스 기기는 조금 작게
// 접은 화면·좁은 휴대폰(440px 이하)에서는 글자를 콤팩트하게 맞춰 한 번에 더 많은 내용을 표시함
function autoFontPx() {
  const w = window.innerWidth, h = window.innerHeight;
  if (w <= 440) return 12;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const f = 9.5 + 0.0065 * Math.sqrt(w * h) + (coarse ? 0.5 : -1);
  return Math.max(12, Math.min(18, f));
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
