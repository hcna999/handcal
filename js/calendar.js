// calendar.js: 월간 달력·메모 모아보기·할 일 모아보기·기한 읽기·음력·공휴일·검색
// (일반 스크립트: index.html에 적힌 순서대로 읽히고 전역 이름을 서로 함께 씀. 순서를 바꾸지 말 것)
'use strict';

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
  const isCal = v === 'month' || v === 'week';
  document.querySelectorAll('#side-nav button').forEach((b) => {
    const on = b.dataset.nav === (isCal ? 'cal' : v);
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $('#view-seg').classList.toggle('hidden', !isCal);
  $('#cal-side').classList.toggle('non-cal', !isCal);
  $('#grid').classList.toggle('hidden', v !== 'month');
  $('.weekdays').classList.toggle('hidden', v === 'list' || v === 'todo' || v === 'goals');
  $('#todo-view').classList.toggle('hidden', v !== 'todo');
  $('#goals-view').classList.toggle('hidden', v !== 'goals');
  $('#month-view').classList.toggle('week-mode', v === 'week');
  $('#week-grid').classList.toggle('hidden', v !== 'week');
  $('#list-view').classList.toggle('hidden', v !== 'list');
  for (const id of ['#prev-month', '#next-month', '#today-btn']) $(id).classList.toggle('hidden', v === 'list' || v === 'todo' || v === 'goals');
  renderDueBar();
  renderGoalBar();
  miniState.month = v === 'week' && state.weekStart ? new Date(addDays(state.weekStart, 3).getFullYear(), addDays(state.weekStart, 3).getMonth(), 1) : state.month;
  renderMiniCal();
  if (v === 'todo') return renderTodos();
  if (v === 'goals') return renderGoalsView();
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
  if (v === 'month' || v === 'week') store.set('calMode', v); // 사이드 '달력'을 누르면 마지막에 보던 월/주로
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
    line.title = `${h}시 (눌러서 일정 추가)`;
    line.onclick = (e) => {
      e.stopPropagation();
      const ds = ymd(day);
      const sh = pad2(h);
      showMenu(e, [
        {
          label: `${h}시 메모 일정 추가`,
          icon: 'check',
          keepOpen: true,
          fn: () => showMenu(null, [{
            input: {
              placeholder: `${h}시 일정 제목`,
              onSubmit: async (v) => {
                if (!v.trim()) return;
                const start = new Date(`${ds}T${sh}:00:00`);
                const end = new Date(+start + 3600e3); // 23시도 한 시간짜리가 되게 (자정 넘김)
                memos.add({ title: v.trim(), start, end, allDay: false });
                rerender();
                toast(`${ds} ${h}시에 일정을 추가했어요`);
              }
            }
          }])
        },
        { label: `${ds} 하루 열기`, icon: 'pen', fn: () => openDay(ds) },
      ]);
    };
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
    if (it.e.isMemo) {
      b.onclick = (e) => {
        e.stopPropagation();
        openDay(ymd(it.e.start)).then(() => {
          setPanel(true);
          startEditEvent(it.e);
        });
      };
    }
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
  for (const ds of allNoteDates()) {
    for (const t of noteIndex.get(ds)?.todos || []) {
      if (t.done) continue;
      const due = parseDue(t.text, parseYmd(ds));
      if (!due) continue;
      if (due === today) dueToday++;
      else if (due < today) overdue++;
    }
  }
  // 사이드 '할 일' 개수는 알림 줄을 오늘 숨겨도 계속 보여 줌
  const badge = $('#side-todo-badge');
  badge.textContent = String(dueToday + overdue);
  badge.classList.toggle('hidden', !(dueToday || overdue));
  badge.classList.toggle('over', overdue > 0);
  $('#side-nav [data-nav=todo]').setAttribute('aria-label', dueToday || overdue ? `할 일, 마감 ${dueToday + overdue}개` : '할 일');
  const show = (dueToday || overdue) && store.get('dueBarHidden', '') !== today && (state.calView === 'month' || state.calView === 'week');
  bar.classList.toggle('hidden', !show);
  if (!show) return;
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
  $('#search-results').replaceChildren(el('p', 'muted-text', '메모·손글씨·할 일·일정 제목·목표에서 찾아요.'));
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
  if (!q) { box.replaceChildren(el('p', 'muted-text', '메모·손글씨·할 일·일정 제목·목표에서 찾아요.')); return; }
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
  // 목표(버킷리스트·연간·월간·주간): 날짜가 아니라 기간에 속하므로 맨 위에 따로 보여 주고, 누르면 그 기간의 목표 창
  const goalHits = goals.live().map(([id, g]) => ({ id, ...g }))
    .filter((g) => GOAL_LEVELS[g.level] && (g.title || '').toLowerCase().includes(q))
    .sort((a, b) => (!!a.doneAt - !!b.doneAt) || GOAL_ORDER.indexOf(b.level) - GOAL_ORDER.indexOf(a.level) || String(b.period).localeCompare(String(a.period)))
    .slice(0, 30)
    .map((g) => {
      const d = g.level === 'year' ? new Date(+g.period, 0, 1) : g.level === 'month' ? parseYmd(g.period + '-01') : g.level === 'week' ? parseYmd(g.period) : new Date();
      const b = el('button', 'search-hit search-goal' + (g.doneAt ? ' done' : ''));
      b.append(el('span', 'search-date', goalLabel(g.level, d)), el('span', 'search-type', g.level === 'bucket' ? '버킷' : '목표'), markText((g.doneAt ? '✓ ' : '') + g.title, q));
      b.onclick = () => { $('#search-ov').classList.add('hidden'); openGoalModal(g.level, d); };
      return b;
    });
  const seen = new Set();
  const uniq = hits.filter((h) => { const k = h.ds + h.type + h.text; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => b.ds.localeCompare(a.ds)).slice(0, 150);
  if (!uniq.length && !goalHits.length) { box.replaceChildren(el('p', 'muted-text', '찾는 내용이 없어요.')); return; }
  box.replaceChildren(el('p', 'muted-text', `${uniq.length + goalHits.length}개 찾음`), ...goalHits, ...uniq.map((h) => {
    const d = parseYmd(h.ds);
    const b = el('button', 'search-hit');
    b.append(el('span', 'search-date', `${d.getFullYear() === new Date().getFullYear() ? '' : d.getFullYear() + '. '}${d.getMonth() + 1}/${d.getDate()} (${WD[d.getDay()]})`), el('span', 'search-type', h.type), markText(h.text, q));
    b.onclick = () => { $('#search-ov').classList.add('hidden'); openDay(h.ds); };
    return b;
  }));
}
