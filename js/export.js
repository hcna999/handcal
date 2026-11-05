// export.js: 내보내기(마크다운·PDF·공유)
// (일반 스크립트: index.html에 적힌 순서대로 읽히고 전역 이름을 서로 함께 씀. 순서를 바꾸지 말 것)
'use strict';

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
