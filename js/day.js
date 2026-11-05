// day.js: 하루 화면(필기장)·확대·종이 배경·펜 압력·올가미
// (일반 스크립트: index.html에 적힌 순서대로 읽히고 전역 이름을 서로 함께 씀. 순서를 바꾸지 말 것)
'use strict';

// ---------- 하루 화면 (필기)
function isIPad() {
  return /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

const pad = {
  canvas: null, ctx: null, overlay: null, octx: null,
  scale: 1, dpr: 1,
  doc: blankNote(), pageIdx: 0, loading: false,
  get note() { return this.doc.pages[this.pageIdx] || this.doc.pages[0]; },
  undo: [], redo: [],
  tool: 'pen',
  colors: store.get('colors', { pen: COLORS[0], hl: '#facc15' }),
  sizeIdx: store.get('sizeIdx', 1),
  // 손가락은 기본으로 화면 이동, 필기는 펜으로만
  fingerDraw: store.get('fingerDraw2', false),
  recentTouch: [],
  penSeen: store.get('penSeen', false),
  active: null,
  scroll: null,
  rafPending: false,
  lastEdit: 0,
  hover: null,
};

function layoutPad() {
  const kind = pad.note.kind;
  const isMedia = kind === 'photo' || kind === 'voice';
  const isText = kind === 'text';
  const ta = $('#text-page');
  $('#media-page').classList.toggle('hidden', !isMedia);
  if (isMedia) {
    $('#day-view').classList.add('text-mode');
    $('.page-wrap').classList.add('hidden');
    $('#add-page').classList.add('hidden');
    ta.classList.add('hidden');
    $('#text-todos').classList.add('hidden');
    ta.dataset.pageId = '';
    if ($('#media-page').dataset.pageId !== pad.note.id || !$('#media-page').children.length) {
      $('#media-page').dataset.pageId = pad.note.id;
      renderMediaPage();
    }
    return;
  }
  $('#media-page').dataset.pageId = '';
  $('#day-view').classList.toggle('text-mode', isText);
  $('.page-wrap').classList.toggle('hidden', isText);
  $('#add-page').classList.toggle('hidden', isText);
  ta.classList.toggle('hidden', !isText);
  if (isText) {
    if (ta.dataset.pageId !== pad.note.id) { ta.value = pad.note.text || ''; ta.dataset.pageId = pad.note.id; }
    renderTextTodos();
    return;
  }
  $('#text-todos').classList.add('hidden');
  ta.dataset.pageId = '';
  const wrap = $('#page-scroll');
  if (!wrap.clientWidth) return;
  const cssW = Math.round(Math.max(280, Math.min(wrap.clientWidth - 24, 1100)) * (pad.zoom || 1));
  pad.scale = cssW / PAGE_W;
  $('#paper-select').value = pad.note.paper || 'lined';
  const cssH = Math.round(pad.note.height * pad.scale);
  pad.dpr = Math.min(Math.max(window.devicePixelRatio || 1, 2), Math.sqrt(16e6 / (cssW * cssH)));
  for (const c of [pad.canvas, pad.overlay]) {
    c.style.width = cssW + 'px';
    c.style.height = cssH + 'px';
    c.width = Math.round(cssW * pad.dpr);
    c.height = Math.round(cssH * pad.dpr);
  }
  redraw();
  $('#add-page').disabled = pad.note.height >= PAGE_H * MAX_PAGES;
}

function setTransform(ctx) {
  const k = pad.scale * pad.dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(k, 0, 0, k, 0, 0);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// 다크 모드에서는 검은 잉크를 밝게 보여줌 (저장되는 색은 그대로). AI 변환 이미지는 항상 밝은 바탕
let darkInk = false;
const DARK_INK = { '#1f2328': '#e8eaed' };
const inkColor = (c) => (darkInk && DARK_INK[c]) || c;

function drawPaper(ctx) {
  ctx.save();
  drawPaperKind(ctx);
  ctx.strokeStyle = cssVar('--page-break');
  ctx.setLineDash([10, 10]);
  ctx.beginPath();
  for (let y = PAGE_H; y < pad.note.height; y += PAGE_H) { ctx.moveTo(0, y); ctx.lineTo(PAGE_W, y); }
  ctx.stroke();
  ctx.restore();
}

// 획을 부드럽게: 손떨림 보정 → 필압(펜) 또는 속도(손가락·마우스)로 굵기 → 외곽선을 채워서 그림
// 촘촘한 점(손떨림)만 다듬고, 크게 움직인 곳은 모양을 그대로 둠
function smoothPoints(p, k = 0.45, scale = 4) {
  if (p.length < 3) return p.map((q) => q.slice());
  const out = [p[0].slice()];
  for (let i = 1; i < p.length; i++) {
    const a = out[i - 1], b = p[i];
    const d = Math.hypot(b[0] - p[i - 1][0], b[1] - p[i - 1][1]);
    const kk = k * Math.max(0, 1 - d / scale);
    out.push([a[0] + (b[0] - a[0]) * (1 - kk), a[1] + (b[1] - a[1]) * (1 - kk), b[2]]);
  }
  out[out.length - 1] = p[p.length - 1].slice(); // 끝점은 손을 뗀 자리 그대로
  return out;
}

function drawStroke(ctx, s, live = false) {
  const p = s.points;
  if (!p.length) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = ctx.fillStyle = inkColor(s.color);
  if (s.tool === 'hl') {
    const q = smoothPoints(uniquePoints(p), 0.5);
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = s.size;
    ctx.beginPath();
    ctx.moveTo(q[0][0], q[0][1]);
    if (q.length === 1) ctx.lineTo(q[0][0] + 0.1, q[0][1]);
    for (let i = 1; i < q.length - 1; i++) {
      ctx.quadraticCurveTo(q[i][0], q[i][1], (q[i][0] + q[i + 1][0]) / 2, (q[i][1] + q[i + 1][1]) / 2);
    }
    if (q.length > 1) ctx.lineTo(q[q.length - 1][0], q[q.length - 1][1]);
    ctx.stroke();
  } else {
    ctx.fill(penPath(s, live));
  }
  ctx.restore();
}

// 펜 획을 매끄러운 외곽선(Path2D)으로 변환. 완성된 획은 캐시
let pathCache = new WeakMap(); // 압력 설정을 바꾸면 새로 만듦
function penPath(s, live) {
  if (!live && pathCache.has(s)) return pathCache.get(s);
  const pts = inkPoints(s);
  const outline = window.PerfectFreehand.getStroke(live ? pts.concat(pad.active?.predicted || []) : pts, {
    size: s.size * 1.2,
    thinning: 0.5,
    smoothing: 0.6,
    streamline: 0.45,
    simulatePressure: false,
    last: !live,
  });
  const path = new Path2D();
  if (outline.length) {
    path.moveTo(outline[0][0], outline[0][1]);
    for (let i = 1; i < outline.length; i++) {
      const [x0, y0] = outline[i], [x1, y1] = outline[(i + 1) % outline.length];
      path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    }
    path.closePath();
  }
  if (!live) pathCache.set(s, path);
  return path;
}

// 압력값 보정: 애플 펜슬은 가볍게 쓰면 0.05~0.2 정도라 너무 가늘어지므로 범위를 넓힘
// 예전 버전에 중복 저장된 좌표(같은 구간이 반복됨) 제거
function uniquePoints(points) {
  const seen = new Set();
  return points.filter((q) => {
    const k = q[0] + ',' + q[1];
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function inkPoints(s) {
  const p = uniquePoints(s.points);
  const isPen = s.pen ?? !p.every((q) => q[2] === 0.5);
  if (!isPen) return p.map((q) => [q[0], q[1], 0.5]);
  const pr = p.map((q) => q[2]);
  // 예전 버전은 압력 0을 0.5로 잘못 저장했음 → 그런 값은 주변 압력으로 채움
  if (s.pen === undefined) {
    const real = pr.filter((v) => v !== 0.5).sort((x, y) => x - y);
    if (real.length && real[real.length >> 1] < 0.35) {
      let lastReal = real[real.length >> 1];
      for (let i = 0; i < pr.length; i++) {
        if (pr[i] === 0.5) pr[i] = lastReal;
        else lastReal = pr[i];
      }
    }
  }
  const [base, mult] = pressureCurve();
  return p.map((q, i) => [q[0], q[1], Math.min(1, base + pr[i] * mult)]);
}

function redraw(skip) {
  darkInk = cssVar('--is-dark') === '1';
  setTransform(pad.ctx);
  drawPaper(pad.ctx);
  for (const s of pad.note.strokes) if (!skip?.has(s)) drawStroke(pad.ctx, s);
  renderOverlay();
}

function renderOverlay() {
  pad.rafPending = false;
  setTransform(pad.octx);
  if (pad.active?.stroke) drawStroke(pad.octx, pad.active.stroke, true);
  if (lasso.path || lasso.sel.size) lassoOverlay(pad.octx);
  const h = pad.hover;
  if (h && (pad.tool === 'eraser' || pad.active?.erase)) {
    pad.octx.beginPath();
    pad.octx.arc(h[0], h[1], SIZES.eraser[pad.sizeIdx] / 2, 0, Math.PI * 2);
    pad.octx.strokeStyle = '#6b7280';
    pad.octx.lineWidth = 1.5 / pad.scale;
    pad.octx.stroke();
  }
}

function requestOverlay() {
  if (pad.rafPending) return;
  pad.rafPending = true;
  requestAnimationFrame(renderOverlay);
}

function toPage(e) {
  const r = pad.canvas.getBoundingClientRect();
  return [(e.clientX - r.left) / pad.scale, (e.clientY - r.top) / pad.scale];
}

function makePoint(e) {
  const [x, y] = toPage(e);
  let pr = 0.5;
  if (e.pointerType === 'pen') {
    // 펜이 닿는 순간/떼는 순간에는 압력이 0으로 오므로 직전 값을 사용
    const last = pad.active?.stroke?.points.at(-1);
    pr = e.pressure > 0 ? e.pressure : last ? last[2] : 0.15;
  }
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(pr * 100) / 100];
}

function distToSeg(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  let t = len ? ((px - a[0]) * dx + (py - a[1]) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

function eraseAt(x, y) {
  const r = SIZES.eraser[pad.sizeIdx] / 2;
  const kept = pad.note.strokes.filter((s) => {
    const reach = r + s.size / 2;
    const p = s.points;
    if (p.length === 1) return Math.hypot(x - p[0][0], y - p[0][1]) > reach;
    for (let i = 1; i < p.length; i++) if (distToSeg(x, y, p[i - 1], p[i]) <= reach) return false;
    return true;
  });
  if (kept.length !== pad.note.strokes.length) {
    pad.note.strokes = kept;
    pad.active.changed = true;
    redraw();
  }
}

function snapshot() { return { strokes: pad.note.strokes.slice(), height: pad.note.height }; }
function pushUndo(snap = snapshot()) {
  pad.undo.push(snap);
  if (pad.undo.length > 200) pad.undo.shift();
  pad.redo = [];
  updateUndoUI();
}
function restore(from, to) {
  const snap = from.pop();
  if (!snap) return;
  to.push(snapshot());
  const resize = snap.height !== pad.note.height;
  pad.note.strokes = snap.strokes;
  pad.note.height = snap.height;
  resize ? layoutPad() : redraw();
  updateUndoUI();
  saveSoon();
}
function updateUndoUI() {
  $('#undo').disabled = !pad.undo.length;
  $('#redo').disabled = !pad.redo.length;
}

// ---------- 확대·축소: 두 손가락 벌리기, Ctrl+휠, 도구 줄 [−][100%][+]
function setZoom(z, focus) {
  z = Math.max(0.5, Math.min(3, Math.round(z * 100) / 100));
  if (z === pad.zoom) return;
  const sc = $('#page-scroll');
  const r = sc.getBoundingClientRect();
  const fx = focus ? focus.x - r.left : sc.clientWidth / 2, fy = focus ? focus.y - r.top : sc.clientHeight / 2;
  // 손가락 사이(또는 화면 가운데)에 있던 자리가 그대로 보이게
  const rx = (sc.scrollLeft + fx) / Math.max(1, sc.scrollWidth), ry = (sc.scrollTop + fy) / Math.max(1, sc.scrollHeight);
  pad.zoom = z;
  layoutPad();
  sc.scrollLeft = rx * sc.scrollWidth - fx;
  sc.scrollTop = ry * sc.scrollHeight - fy;
  $('#zoom-label').textContent = Math.round(z * 100) + '%';
}

const pinch = { pts: new Map(), start: null, raf: 0 };
function pinchDown(e) {
  pinch.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch.pts.size === 2) {
    const [a, b] = [...pinch.pts.values()];
    pinch.start = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: pad.zoom };
    // 두 번째 손가락이 닿으면 그리던·밀던 것은 취소하고 확대로
    if (pad.active?.pointerType === 'touch') { pad.active = null; requestOverlay(); }
    pad.scroll = null;
    return true;
  }
  return false;
}
function pinchMove(e) {
  if (!pinch.pts.has(e.pointerId)) return false;
  pinch.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!pinch.start || pinch.pts.size < 2) return false;
  const [a, b] = [...pinch.pts.values()];
  const z = pinch.start.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.start.d);
  cancelAnimationFrame(pinch.raf);
  pinch.raf = requestAnimationFrame(() => setZoom(z, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }));
  return true;
}
function pinchUp(e) {
  const was = pinch.start;
  pinch.pts.delete(e.pointerId);
  if (pinch.pts.size < 2) pinch.start = null;
  return !!was;
}

// ---------- 종이 배경 (탭마다): 줄 / 모눈 / 점 / 무지
function drawPaperKind(ctx) {
  const kind = pad.note.paper || 'lined';
  const h = pad.note.height;
  ctx.strokeStyle = ctx.fillStyle = cssVar('--paper-line');
  ctx.lineWidth = 1;
  if (kind === 'lined') {
    ctx.beginPath();
    for (let y = 70; y < h; y += 50) { ctx.moveTo(40, y); ctx.lineTo(PAGE_W - 40, y); }
    ctx.stroke();
  } else if (kind === 'grid') {
    ctx.beginPath();
    for (let y = 40; y < h; y += 40) { ctx.moveTo(0, y); ctx.lineTo(PAGE_W, y); }
    for (let x = 40; x < PAGE_W; x += 40) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    ctx.stroke();
  } else if (kind === 'dot') {
    for (let y = 40; y < h; y += 40) for (let x = 40; x < PAGE_W; x += 40) { ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill(); }
  }
}

// ---------- 펜 압력 감도 (설정): 가볍게 쓰는 사람은 굵게 보정
const PRESSURE = { light: [0.32, 2.2], normal: [0.25, 1.6], heavy: [0.15, 1.1] };
function pressureCurve() { return PRESSURE[store.get('pressure', 'normal')] || PRESSURE.normal; }

// ---------- 올가미: 둘러싸서 옮기기·색 바꾸기·지우기
const lasso = {
  sel: new Set(),
  path: null,
  drag: null,
  active: null,
  bbox() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of this.sel) for (const p of s.points) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    const m = 12;
    return { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
  },
  clear() {
    this.sel.clear();
    this.path = null;
    this.drag = null;
    $('#sel-bar').classList.add('hidden');
    if (pad.ctx) { redraw(); requestOverlay(); }
  },
  showBar() {
    $('#sel-bar').classList.toggle('hidden', !this.sel.size);
    $('#sel-count').textContent = `${this.sel.size}개 선택`;
  },
};
function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function lassoDown(e) {
  const [x, y] = toPage(e);
  lasso.active = { id: e.pointerId };
  if (lasso.sel.size) {
    const b = lasso.bbox();
    if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) {
      // 선택한 것 옮기기 시작: 원래 자리에서는 잠시 지우고 덮개 화면에 따라 그림
      lasso.drag = { x, y, dx: 0, dy: 0 };
      redraw(lasso.sel);
      requestOverlay();
      return;
    }
  }
  lasso.sel.clear();
  lasso.showBar();
  redraw();
  lasso.path = [[x, y]];
  requestOverlay();
}
function lassoMove(e) {
  const [x, y] = toPage(e);
  if (lasso.drag) { lasso.drag.dx = x - lasso.drag.x; lasso.drag.dy = y - lasso.drag.y; }
  else if (lasso.path) lasso.path.push([x, y]);
  requestOverlay();
}
function lassoUp() {
  lasso.active = null;
  if (lasso.drag) {
    const { dx, dy } = lasso.drag;
    lasso.drag = null;
    if (Math.hypot(dx, dy) > 1) {
      pushUndo();
      const moved = new Set();
      pad.note.strokes = pad.note.strokes.map((s) => {
        if (!lasso.sel.has(s)) return s;
        const t = { ...s, points: s.points.map((p) => [Math.round((p[0] + dx) * 10) / 10, Math.round((p[1] + dy) * 10) / 10, p[2]]) };
        moved.add(t);
        return t;
      });
      lasso.sel = moved;
      saveSoon();
    }
    redraw();
    requestOverlay();
    return;
  }
  const poly = lasso.path || [];
  lasso.path = null;
  if (poly.length > 4) {
    for (const s of pad.note.strokes) {
      const inside = s.points.filter((p) => inPolygon(p[0], p[1], poly)).length;
      if (inside / s.points.length >= 0.5) lasso.sel.add(s);
    }
  }
  lasso.showBar();
  requestOverlay();
}
function lassoOverlay(ctx) {
  ctx.save();
  ctx.lineWidth = 1.5 / pad.scale;
  ctx.setLineDash([6 / pad.scale, 4 / pad.scale]);
  ctx.strokeStyle = cssVar('--accent');
  if (lasso.path) {
    ctx.beginPath();
    lasso.path.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
  }
  if (lasso.sel.size) {
    const dx = lasso.drag?.dx || 0, dy = lasso.drag?.dy || 0;
    if (lasso.drag) {
      ctx.save();
      ctx.translate(dx, dy);
      ctx.setLineDash([]);
      for (const s of lasso.sel) drawStroke(ctx, s);
      ctx.restore();
    }
    const b = lasso.bbox();
    ctx.strokeRect(b.x0 + dx, b.y0 + dy, b.x1 - b.x0, b.y1 - b.y0);
  }
  ctx.restore();
}
function recolorSelection(color) {
  if (!lasso.sel.size) return;
  pushUndo();
  const next = new Set();
  pad.note.strokes = pad.note.strokes.map((s) => {
    if (!lasso.sel.has(s)) return s;
    const t = { ...s, color };
    next.add(t);
    return t;
  });
  lasso.sel = next;
  redraw();
  requestOverlay();
  saveSoon();
}
function deleteSelection() {
  if (!lasso.sel.size) return;
  pushUndo();
  pad.note.strokes = pad.note.strokes.filter((s) => !lasso.sel.has(s));
  lasso.clear();
  saveSoon();
}

function capture(id) {
  try { pad.canvas.setPointerCapture(id); } catch { /* 이미 떨어진 포인터 */ }
}

function onPointerDown(e) {
  if (e.pointerType === 'touch' && pinchDown(e)) return;
  if (e.pointerType === 'pen') {
    // 손바닥이 먼저 닿아 그려지던 획은 취소
    if (pad.active?.pointerType === 'touch') { pad.active = null; requestOverlay(); }
    if (!pad.penSeen) {
      pad.penSeen = true;
      store.set('penSeen', true);
      dropRecentTouchStrokes();
      if (pad.fingerDraw) { setFingerDraw(false); toast('펜이 감지돼서 손가락은 화면 이동용으로 바꿨어요'); }
    }
  }
  if (e.pointerType === 'touch' && !pad.fingerDraw) {
    if (!pad.scroll) {
      pad.scroll = { id: e.pointerId, x: e.clientX, y: e.clientY };
      capture(e.pointerId);
    }
    return;
  }
  const eraserButton = e.button === 5 || (e.buttons & 32);
  if (pad.active || pad.loading || (e.button > 0 && !eraserButton)) return;
  // 넓게 닿는 터치는 손바닥으로 간주
  if (e.pointerType === 'touch' && Math.max(e.width || 0, e.height || 0) > 40) return;
  e.preventDefault();
  capture(e.pointerId);
  if (pad.tool === 'lasso' && !eraserButton) { lassoDown(e); return; }
  const pt = makePoint(e);
  pad.hover = pt;
  if (pad.tool === 'eraser' || eraserButton) {
    pad.active = { id: e.pointerId, erase: true, before: snapshot(), changed: false };
    eraseAt(pt[0], pt[1]);
    requestOverlay();
  } else {
    const tool = pad.tool;
    const stroke = { tool, color: pad.colors[tool], size: SIZES[tool][pad.sizeIdx], points: [pt] };
    if (e.pointerType === 'pen') stroke.pen = true;
    pad.active = { id: e.pointerId, pointerType: e.pointerType, stroke, predicted: [] };
    requestOverlay();
  }
}

function onPointerMove(e) {
  if (e.pointerType === 'touch' && pinchMove(e)) return;
  if (lasso.active && e.pointerId === lasso.active.id) { lassoMove(e); return; }
  if (pad.scroll && e.pointerId === pad.scroll.id) {
    const sc = $('#page-scroll');
    sc.scrollTop -= e.clientY - pad.scroll.y;
    sc.scrollLeft -= e.clientX - pad.scroll.x;
    pad.scroll.x = e.clientX;
    pad.scroll.y = e.clientY;
    return;
  }
  if (!pad.active || e.pointerId !== pad.active.id) {
    if (pad.tool === 'eraser' && e.pointerType !== 'touch') { pad.hover = makePoint(e); requestOverlay(); }
    return;
  }
  // 아이패드 사파리는 이미 받은 이동 이벤트를 다시 보내는 경우가 있어 시간순으로 새것만 사용
  const list = e.getCoalescedEvents?.() || [];
  for (const ev of list.length ? list : [e]) {
    if (ev.timeStamp <= (pad.active.lastTime ?? -1)) continue;
    pad.active.lastTime = ev.timeStamp;
    const pt = makePoint(ev);
    if (pad.active.erase) eraseAt(pt[0], pt[1]);
    else {
      const pts = pad.active.stroke.points, last = pts[pts.length - 1];
      if (Math.abs(pt[0] - last[0]) + Math.abs(pt[1] - last[1]) >= 0.5) pts.push(pt);
      else last[2] = pt[2];
    }
    pad.hover = pt;
  }
  if (pad.active.stroke) {
    const pred = e.getPredictedEvents?.() || [];
    pad.active.predicted = pred.slice(0, 2).map(makePoint);
  }
  requestOverlay();
}

function onPointerUp(e) {
  if (e.pointerType === 'touch' && pinchUp(e)) { pad.scroll = null; return; }
  if (lasso.active && e.pointerId === lasso.active.id) { lassoUp(e); return; }
  if (pad.scroll && e.pointerId === pad.scroll.id) { pad.scroll = null; return; }
  if (!pad.active || e.pointerId !== pad.active.id) return;
  const a = pad.active;
  pad.active = null;
  if (a.erase) {
    if (a.changed) { pushUndo(a.before); saveSoon(); }
  } else {
    pushUndo();
    if (a.pointerType === 'touch') pad.recentTouch.push({ stroke: a.stroke, at: Date.now() });
    pad.note.strokes.push(a.stroke);
    drawStroke(pad.ctx, a.stroke);
    saveSoon();
  }
  if (e.pointerType === 'touch') pad.hover = null;
  requestOverlay();
}

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}
async function saveNow() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!state.date) return;
  const date = state.date;
  try { await notes.put(date, cloneDoc(pad.doc)); }
  catch (e) { handleErr(e); }
  if (docEmpty(pad.doc)) { autoOcr.drop(date); digests.remove(date); }
  else if (docNeedsOcr(pad.doc)) { pad.lastEdit = Date.now(); autoOcr.touch(date); }
  if (!docEmpty(pad.doc)) refreshDigest(date, pad.doc);
  if (!auth.connected()) setStatus();
  if (state.view === 'day' && state.date === date) renderOcr();
}

// 펜을 처음 쓰기 직전 몇 초 사이에 손으로 그려진 획(손바닥 오작동)을 지움
function dropRecentTouchStrokes() {
  const recent = new Set(pad.recentTouch.filter((r) => Date.now() - r.at < 5000).map((r) => r.stroke));
  pad.recentTouch = [];
  if (!recent.size) return;
  pushUndo();
  pad.note.strokes = pad.note.strokes.filter((s) => !recent.has(s));
  redraw();
  saveSoon();
}

function setFingerDraw(v) {
  pad.fingerDraw = v;
  store.set('fingerDraw2', v);
  $('#finger-mode').textContent = v ? '손가락: 필기' : '손가락: 화면 이동';
}

function buildToolbar() {
  const colors = $('#colors');
  for (const c of COLORS) {
    const b = el('button', 'swatch');
    b.style.background = c;
    b.dataset.color = c;
    b.setAttribute('aria-label', '색상 ' + c);
    colors.append(b);
  }
  const sizes = $('#sizes');
  [4, 8, 13].forEach((px, i) => {
    const b = el('button', 'size');
    b.dataset.size = i;
    b.setAttribute('aria-label', ['가늘게', '보통', '굵게'][i]);
    const dot = el('span');
    dot.style.width = dot.style.height = px + 'px';
    b.append(dot);
    sizes.append(b);
  });
  syncToolbar();
}

function syncToolbar() {
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === pad.tool));
  const color = pad.colors[pad.tool];
  document.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('active', b.dataset.color === color));
  $('#colors').classList.toggle('disabled', pad.tool === 'eraser' || pad.tool === 'lasso');
  $('#sizes').classList.toggle('disabled', pad.tool === 'lasso');
  document.querySelectorAll('.size').forEach((b) => b.classList.toggle('active', Number(b.dataset.size) === pad.sizeIdx));
  if (pad.tool !== 'eraser') pad.hover = null;
  if (pad.ctx) requestOverlay();
}

function dayTitle(d) {
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${sameYear ? '' : d.getFullYear() + '년 '}${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})`;
}

async function openDay(ds, { push = true } = {}) {
  await saveNow();
  if (state.date && state.date !== ds) autoOcr.hurry(state.date);
  const fromMonth = state.view !== 'day';
  state.view = 'day';
  state.date = ds;
  if (push) history[fromMonth ? 'pushState' : 'replaceState']({ day: ds }, '', '#' + ds);
  document.body.classList.add('in-day');
  $('#day-menu-btn').classList.remove('hidden');
  hideMenu();
  $('#month-view').classList.add('hidden');
  $('#month-nav').classList.add('hidden');
  $('#day-view').classList.remove('hidden');
  $('#day-nav').classList.remove('hidden');
  if (isNarrow()) setPanel(false);
  const d = parseYmd(ds);
  $('#day-title').textContent = dayTitle(d);
  $('#ev-title').value = '';
  $('#ev-end-date').value = ds;
  $('#ev-end-date').min = ds;
  cancelEditEvent();

  pad.doc = blankNote();
  pad.pageIdx = 0;
  renderTabs();
  renderOcr();
  pad.undo = [];
  pad.redo = [];
  pad.active = null;
  pad.loading = true;
  updateUndoUI();
  $('#page-scroll').scrollTop = 0;
  layoutPad();
  renderDayEvents();

  const token = ++dayToken;
  const timer = setTimeout(() => token === dayToken && $('#loading').classList.remove('hidden'), 250);
  try {
    await notes.refreshIndex(60000).catch((e) => { if (e.message === 'AUTH') throw e; console.warn(e); });
    const note = await notes.get(ds);
    if (token !== dayToken) return;
    pad.doc = note;
    pad.pageIdx = Math.max(0, note.pages.findIndex((p) => p.strokes.length || (p.text || '').trim()));
    renderTabs();
    renderOcr();
    renderDayTodos();
    todoInk.clear();
    layoutPad();
    if (pad.note.kind === 'text') focusText();
  } catch (e) {
    handleErr(e);
  } finally {
    clearTimeout(timer);
    if (token === dayToken) { pad.loading = false; $('#loading').classList.add('hidden'); }
  }
}

async function closeDay() {
  await saveNow();
  document.body.classList.remove('in-day');
  $('#day-menu-btn').classList.add('hidden');
  autoOcr.hurry(state.date);
  dayToken++;
  const d = parseYmd(state.date);
  state.view = 'month';
  state.month = new Date(d.getFullYear(), d.getMonth(), 1);
  if (state.calView === 'week') state.weekStart = sundayOf(d);
  listState.cache.delete(state.date);
  state.date = null;
  $('#day-view').classList.add('hidden');
  $('#day-nav').classList.add('hidden');
  $('#month-view').classList.remove('hidden');
  $('#month-nav').classList.remove('hidden');
  renderMonth();
  refreshInBackground();
}
