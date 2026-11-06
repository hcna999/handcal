// goals.js: 버킷리스트·연간·월간·주간 목표 (저장, 목표 화면, 할 일 쓸 때 보는 사다리, 달력 위 한 줄)
// (일반 스크립트: index.html에 적힌 순서대로 읽히고 전역 이름을 서로 함께 씀. 순서를 바꾸지 말 것)
'use strict';

// rec: 사다리가 짧아야 계속 읽게 되므로 권장 개수를 넘으면 살짝 알려만 줌(막지는 않음)
const GOAL_LEVELS = {
  bucket: { name: '버킷리스트', ph: '언젠가 꼭 해 보고 싶은 것', rec: 0 },
  year: { name: '연간 목표', ph: '올해 이루고 싶은 것', rec: 5 },
  month: { name: '월간 목표', ph: '이번 달에 이룰 것', rec: 3 },
  week: { name: '주간 목표', ph: '이번 주에 이룰 것', rec: 3 },
};
const GOAL_ORDER = ['bucket', 'year', 'month', 'week'];

// 기간 값: 연간 '2026', 월간 '2026-11', 주간은 그 주 일요일 날짜 '2026-11-01'(앱의 주는 일요일 시작), 버킷리스트는 기간 없음
function goalPeriod(level, d) {
  if (level === 'year') return String(d.getFullYear());
  if (level === 'month') return ymd(d).slice(0, 7);
  if (level === 'week') return ymd(sundayOf(d));
  return '';
}

function goalShift(level, d, n) {
  if (level === 'year') return new Date(d.getFullYear() + n, 0, 1);
  if (level === 'month') return new Date(d.getFullYear(), d.getMonth() + n, 1);
  if (level === 'week') return addDays(sundayOf(d), 7 * n);
  return d;
}

function goalLabel(level, d) {
  const now = new Date();
  if (level === 'bucket') return '언젠가';
  if (level === 'year') return `${d.getFullYear()}년`;
  if (level === 'month') return (d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}년 `) + `${d.getMonth() + 1}월`;
  const s = sundayOf(d), cur = sundayOf(now);
  if (ymd(s) === ymd(cur)) return '이번 주';
  if (ymd(s) === ymd(addDays(cur, 7))) return '다음 주';
  if (ymd(s) === ymd(addDays(cur, -7))) return '지난주';
  return `${s.getMonth() + 1}.${s.getDate()} 주`;
}

// 옮기기 버튼에 쓰는 지금 기간 이름
const GOAL_NOW_NAME = { year: '올해', month: '이번 달', week: '이번 주' };

const goals = Object.assign(syncedStore('goals.json', 'goals', 36500), {
  list(level, period = '') {
    return this.live().map(([id, v]) => ({ id, ...v }))
      .filter((g) => g.level === level && (level === 'bucket' || g.period === period))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  },
  add(level, period, title) {
    const text = String(title || '').trim().slice(0, 100);
    if (!text) return null;
    const id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const order = this.list(level, period).reduce((m, g) => Math.max(m, g.order ?? 0), -1) + 1;
    this.put(id, { level, period, title: text, order, doneAt: null });
    return id;
  },
  patch(id, change) {
    const cur = this.get(id);
    if (cur) this.put(id, { ...cur, ...change });
  },
  moveTo(id, period) {
    const cur = this.get(id);
    if (!cur) return;
    const order = this.list(cur.level, period).reduce((m, g) => Math.max(m, g.order ?? 0), -1) + 1;
    this.patch(id, { period, order });
  },
});

// ---------- 오늘의 버킷리스트: 못 이룬 것 가운데 날마다 하나, ↻로 다음 것
function bucketPick(today = new Date()) {
  const open = goals.list('bucket').filter((g) => !g.doneAt);
  if (!open.length) return null;
  const day = Math.round(new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() / 864e5);
  return open[(day + store.get('bucketSpin', 0)) % open.length];
}

// 한 단계를 한 줄 글로: 첫 목표 + 나머지 개수
function goalSummary(level, d) {
  const items = goals.list(level, goalPeriod(level, d));
  const open = items.filter((g) => !g.doneAt);
  if (level === 'bucket') {
    const pick = bucketPick();
    if (pick) return { text: pick.title, empty: false, extra: 0, spin: open.length > 1 };
    return { text: items.length ? '모두 이뤘어요 ✓' : '하고 싶은 것 적기', empty: !items.length, extra: 0, spin: false };
  }
  if (open.length) return { text: open[0].title, empty: false, extra: open.length - 1, spin: false };
  return { text: items.length ? '모두 달성 ✓' : '눌러서 적기', empty: !items.length, extra: 0, spin: false };
}

const goalLineText = (s) => s.text + (s.extra ? ` 외 ${s.extra}` : '');

// ---------- 사다리 (하루 화면 맨 위 한 줄, 할 일 패널)
function goalRow(level, d) {
  const s = goalSummary(level, d);
  const row = el('div', 'goal-row');
  row.dataset.level = level;
  const open = el('button', 'goal-row-open' + (s.empty ? ' empty' : ''));
  open.type = 'button';
  open.append(el('span', 'goal-row-label', goalLabel(level, d)), el('span', 'goal-row-text', goalLineText(s)));
  open.onclick = () => openGoalModal(level, d);
  row.append(open);
  if (s.spin) {
    const spin = el('button', 'goal-spin', '↻');
    spin.type = 'button';
    spin.setAttribute('aria-label', '다른 버킷리스트 보기');
    spin.title = '다른 버킷리스트 보기';
    spin.onclick = () => { store.set('bucketSpin', store.get('bucketSpin', 0) + 1); goalsChanged(); };
    row.append(spin);
  }
  return row;
}

function renderGoalLadder(box, key, defaultOpen, d) {
  const isOpen = store.get(key, defaultOpen);
  const toggle = el('button', 'goal-toggle', isOpen ? '접기 ▴' : '▾');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', String(isOpen));
  toggle.setAttribute('aria-label', isOpen ? '목표 접기' : '목표 펼치기');
  toggle.onclick = () => {
    store.set(key, !store.get(key, defaultOpen));
    renderDayGoals();
    if (state.view === 'day') layoutPad();
  };
  if (isOpen) {
    const head = el('div', 'goal-ladder-head');
    head.append(el('strong', '', '목표'), toggle);
    box.replaceChildren(head, ...GOAL_ORDER.map((lv) => goalRow(lv, d)));
    return;
  }
  // 접혔을 때: 가장 가까운 기간부터 적어 둔 목표가 있는 단계 하나만
  const level = ['week', 'month', 'year', 'bucket'].find((lv) => !goalSummary(lv, d).empty) || 'week';
  const row = goalRow(level, d);
  row.append(toggle);
  box.replaceChildren(row);
}

function renderDayGoals() {
  const line = $('#goal-line'), panel = $('#goal-panel');
  if (!line || !panel || !state.date) return;
  const d = parseYmd(state.date);
  renderGoalLadder(panel, 'goalPanelOpen', !isNarrow(), d);
  // 넓은 화면에서 왼쪽 패널이 열려 있으면 같은 내용이 두 번 보이므로 위쪽 줄은 숨김
  const dup = !isNarrow() && panelVisible();
  line.classList.toggle('hidden', dup);
  if (!dup) renderGoalLadder(line, 'goalLineOpen', false, d);
}

// ---------- 달력·주간 위 한 줄
function renderGoalBar() {
  const bar = $('#goal-bar');
  if (!bar) return;
  const v = state.calView;
  const show = v === 'month' || v === 'week';
  bar.classList.toggle('hidden', !show);
  if (!show) return;
  const level = v;
  const d = v === 'week' ? state.weekStart : state.month;
  const s = goalSummary(level, d);
  const label = goalLabel(level, d);
  const open = el('button', 'goal-bar-open' + (s.empty ? ' empty' : ''));
  open.type = 'button';
  if (s.empty) open.textContent = `＋ ${label} 목표 적기`;
  else open.append(el('span', 'goal-row-label', `${label} 목표`), el('span', 'goal-row-text', goalLineText(s)));
  open.onclick = () => openGoalModal(level, d);
  const all = el('button', 'goal-bar-all', '전체 ›');
  all.type = 'button';
  all.setAttribute('aria-label', '목표 화면 열기');
  all.onclick = () => setCalView('goals');
  bar.replaceChildren(open, all);
}

// ---------- 목표 한 단계 카드 (목표 화면·창에서 같이 씀). ctx = {level, date, rerender(focus)}
function goalItemRow(g, ctx, { moveTo = null, moveLabel = '' } = {}) {
  const done = !!g.doneAt;
  const row = el('div', 'goal-item' + (done ? ' done' : ''));
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = done;
  cb.setAttribute('aria-label', `${g.title} 달성`);
  cb.onchange = () => {
    goals.patch(g.id, { doneAt: cb.checked ? Date.now() : null });
    if (cb.checked && g.level === 'bucket') toast('이룬 것에 담았어요');
    goalsChanged();
  };
  const title = el('button', 'goal-title', g.title);
  title.type = 'button';
  title.title = '눌러서 고치기';
  title.onclick = () => {
    const input = el('input', 'goal-edit');
    input.value = g.title;
    input.maxLength = 100;
    input.setAttribute('aria-label', '목표 고치기');
    let closed = false;
    const finish = (save) => {
      if (closed) return;
      closed = true;
      const v = input.value.trim();
      if (save && v && v !== g.title) goals.patch(g.id, { title: v });
      goalsChanged();
    };
    input.onkeydown = (e) => {
      e.stopPropagation(); // Esc가 창까지 닫지 않게
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') finish(false);
    };
    input.onblur = () => finish(true);
    title.replaceWith(input);
    input.focus();
  };
  row.append(cb, title);
  if (done && g.level === 'bucket') {
    const at = new Date(g.doneAt);
    row.append(el('span', 'goal-done-at', `${at.getFullYear()}.${at.getMonth() + 1}.${at.getDate()}`));
  }
  if (moveTo) {
    const mv = el('button', 'pill goal-move', moveLabel);
    mv.type = 'button';
    mv.onclick = () => { goals.moveTo(g.id, moveTo); goalsChanged(); };
    row.append(mv);
  }
  const del = el('button', 'goal-del', '×');
  del.type = 'button';
  del.setAttribute('aria-label', `${g.title} 지우기`);
  del.onclick = () => {
    const saved = goals.get(g.id);
    goals.del(g.id);
    goalsChanged();
    toast('목표를 지웠어요', 5000, { label: '되돌리기', fn: () => { goals.put(g.id, saved); goalsChanged(); } });
  };
  row.append(del);
  return row;
}

function goalSection(ctx, focus = false) {
  const { level } = ctx;
  const meta = GOAL_LEVELS[level];
  const sec = el('section', 'goal-sec');
  sec.dataset.level = level;
  const head = el('div', 'goal-sec-head');
  head.append(el('h3', '', meta.name));
  if (level !== 'bucket') {
    const nav = el('div', 'goal-nav');
    const arrow = (txt, aria, n) => {
      const b = el('button', 'arrow', txt);
      b.type = 'button';
      b.setAttribute('aria-label', aria);
      b.onclick = () => { ctx.date = goalShift(level, ctx.date, n); ctx.rerender(); };
      return b;
    };
    nav.append(arrow('‹', '이전 기간', -1), el('span', 'goal-nav-label', goalLabel(level, ctx.date)), arrow('›', '다음 기간', 1));
    head.append(nav);
  }
  sec.append(head);

  const form = el('form', 'goal-add');
  form.autocomplete = 'off';
  const input = el('input', 'goal-add-input');
  input.placeholder = meta.ph + (meta.rec ? ` (${meta.rec}개 권장)` : '');
  input.maxLength = 100;
  input.setAttribute('aria-label', `${meta.name} 추가`);
  input.enterKeyHint = 'done';
  const addBtn = el('button', 'pill primary', '추가');
  form.append(input, addBtn);
  form.onsubmit = (e) => {
    e.preventDefault();
    if (goals.add(level, goalPeriod(level, ctx.date), input.value)) goalsChanged(level);
  };
  sec.append(form);

  const period = goalPeriod(level, ctx.date);
  const items = goals.list(level, period);
  const open = items.filter((g) => !g.doneAt);
  const done = items.filter((g) => g.doneAt);
  const nowDate = new Date();
  const nowPeriod = goalPeriod(level, nowDate);
  const moveOpts = level !== 'bucket' && period < nowPeriod ? { moveTo: nowPeriod, moveLabel: `${GOAL_NOW_NAME[level]}로 옮기기` } : {};

  if (!items.length) sec.append(el('p', 'muted-text goal-empty', level === 'bucket' ? '언젠가 해 보고 싶은 것을 부담 없이 적어 보세요.' : '아직 적은 목표가 없어요.'));
  for (const g of open) sec.append(goalItemRow(g, ctx, moveOpts));
  if (meta.rec && open.length > meta.rec) sec.append(el('p', 'muted-text goal-empty', `${meta.rec}개까지가 한눈에 보기 좋아요.`));
  if (level === 'bucket') {
    if (done.length) {
      sec.append(el('h4', 'goal-sub', `이룬 것 ${done.length}`));
      for (const g of done.sort((a, b) => b.doneAt - a.doneAt)) sec.append(goalItemRow(g, ctx));
    }
  } else {
    for (const g of done) sec.append(goalItemRow(g, ctx));
  }

  // 지금 기간을 볼 때만 바로 앞 기간에 못 끝낸 것을 보여 줌 (더 오래된 것은 ‹로 찾아감: 끝없이 쌓이지 않게)
  if (level !== 'bucket' && period === nowPeriod) {
    const prev = goalShift(level, nowDate, -1);
    const left = goals.list(level, goalPeriod(level, prev)).filter((g) => !g.doneAt);
    if (left.length) {
      sec.append(el('h4', 'goal-sub', `${goalLabel(level, prev)} 못 끝낸 것`));
      for (const g of left) sec.append(goalItemRow(g, ctx, { moveTo: nowPeriod, moveLabel: `${GOAL_NOW_NAME[level]}로 옮기기` }));
    }
  }
  if (focus) setTimeout(() => input.focus(), 0);
  return sec;
}

// ---------- 목표 달성 통계 요약 배지
function goalStatsBar() {
  const now = new Date();
  const yList = goals.list('year', goalPeriod('year', now));
  const mList = goals.list('month', goalPeriod('month', now));
  const wList = goals.list('week', goalPeriod('week', now));
  const bList = goals.list('bucket');

  const yDone = yList.filter((g) => g.doneAt).length;
  const mDone = mList.filter((g) => g.doneAt).length;
  const wDone = wList.filter((g) => g.doneAt).length;
  const bDone = bList.filter((g) => g.doneAt).length;

  const bar = el('div', 'goals-stats-bar');
  const makeBadge = (label, done, total) => {
    const b = el('div', 'goal-stat-badge');
    b.append(el('span', 'goal-stat-label', label), el('strong', 'goal-stat-num', total != null ? `${done}/${total}` : `${done}개`));
    return b;
  };
  bar.append(
    makeBadge('올해 달성', yDone, yList.length),
    makeBadge('이달 달성', mDone, mList.length),
    makeBadge('이번 주 달성', wDone, wList.length),
    makeBadge('이룬 버킷', bDone, null)
  );
  return bar;
}

// ---------- 목표 화면
const goalView = { ctxs: null };
function renderGoalsView(focusLevel = null) {
  $('#month-title').textContent = '목표';
  if (!goalView.ctxs) {
    goalView.ctxs = GOAL_ORDER.map((level) => ({ level, date: new Date(), rerender: () => renderGoalsView() }));
  }
  $('#goals-body').replaceChildren(goalStatsBar(), ...goalView.ctxs.map((ctx) => goalSection(ctx, ctx.level === focusLevel)));
}

// ---------- 목표 창 (하루 화면·달력에서 그 자리를 떠나지 않고 고치기)
let goalModalCtx = null;
function renderGoalModal(focus = false) {
  if (!goalModalCtx) return;
  $('#modal-title').textContent = GOAL_LEVELS[goalModalCtx.level].name;
  $('#modal-body').replaceChildren(goalSection(goalModalCtx, focus));
}
function openGoalModal(level, d) {
  const ctx = { level, date: d, rerender: () => renderGoalModal() };
  // 터치 기기는 바로 커서를 두면 키보드가 올라와 목록을 가리므로, 볼 것이 없을 때만
  const focus = !window.matchMedia('(pointer: coarse)').matches || !goals.list(level, goalPeriod(level, d)).length;
  openModal(GOAL_LEVELS[level].name, [goalSection(ctx, focus)]);
  goalModalCtx = ctx;
}

// 목표가 바뀌면 보이는 곳을 모두 다시 그림. focusLevel: 입력칸에 다시 커서를 둘 단계
function goalsChanged(focusLevel = null) {
  const modalOpen = goalModalCtx && !$('#modal').classList.contains('hidden');
  if (modalOpen) renderGoalModal(focusLevel === goalModalCtx.level);
  if (state.view === 'month') {
    renderGoalBar();
    if (state.calView === 'goals') renderGoalsView(modalOpen ? null : focusLevel);
  } else {
    renderDayGoals();
  }
}

// 다른 기기에서 고친 목표 받기: 입력 중인 칸을 지우지 않도록 글을 쓰는 중이면 다시 그리지 않음
function syncGoals() {
  return goals.sync().then(() => {
    const a = document.activeElement;
    if (!a || !a.matches('.goal-add-input, .goal-edit')) goalsChanged();
  });
}

// 아이패드를 돌리는 등 넓은/좁은 화면이 바뀌면 위쪽 줄 표시를 다시 정함
window.matchMedia('(max-width: 899px)').addEventListener?.('change', () => renderDayGoals());
