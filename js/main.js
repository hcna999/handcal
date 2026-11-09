// main.js: 시작(이벤트 연결·초기화)
// (일반 스크립트: index.html에 적힌 순서대로 읽히고 전역 이름을 서로 함께 씀. 순서를 바꾸지 말 것)
'use strict';

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
  $('#side-nav').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setCalView(b.dataset.nav === 'cal' ? (state.calView === 'month' || state.calView === 'week' ? state.calView : store.get('calMode', 'month')) : b.dataset.nav);
  });
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
  $('#open-refine-news').onclick = () => { $('#settings').classList.add('hidden'); openRefineNews(refineNews.live().map(([k, v]) => ({ k, ...v })).sort((a, b) => b.at - a.at).slice(0, 30)); };
  $('#open-backup').onclick = () => { $('#settings').classList.add('hidden'); openBackup(); };
  if ($('#token-transfer-btn')) $('#token-transfer-btn').onclick = openTokenTransfer;
  if ($('#open-feed')) $('#open-feed').onclick = openFeedModal;
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
