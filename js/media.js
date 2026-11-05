// media.js: 사진·음성 메모
// (일반 스크립트: index.html에 적힌 순서대로 읽히고 전역 이름을 서로 함께 씀. 순서를 바꾸지 말 것)
'use strict';

// ---------- 사진·음성 메모 (탭 종류 'photo', 'voice')
// 파일은 기기 IndexedDB('blob:id')에 먼저 두고, 동기화할 때 드라이브 '필기캘린더' 폴더에 올려 driveId를 기록
const mediaUrls = new Map(); // media id → 화면용 주소
async function mediaBlob(m) {
  let blob = await idb.get('blob:' + m.id).catch(() => null);
  if (!blob && m.driveId && auth.connected()) {
    const res = await authFetch(`${DRIVE}/${m.driveId}?alt=media`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    blob = await res.blob();
    await idb.set('blob:' + m.id, blob);
  }
  return blob;
}
async function mediaUrl(m) {
  if (mediaUrls.has(m.id)) return mediaUrls.get(m.id);
  const blob = await mediaBlob(m);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  mediaUrls.set(m.id, url);
  return url;
}
async function mediaDataUrl(m) {
  const blob = await mediaBlob(m);
  if (!blob) return null;
  return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
}

// 사진은 긴 쪽 1600px JPEG로 줄여 저장 (용량 절약)
async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  return { blob, w: c.width, h: c.height };
}

async function addPhotos(page, files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try {
      const { blob, w, h } = await shrinkImage(f);
      const m = { id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), type: 'image', mime: 'image/jpeg', w, h };
      await idb.set('blob:' + m.id, blob);
      page.media.push(m);
    } catch (e) { console.warn(e); toast('사진을 읽지 못했어요'); }
  }
}

// 녹음 → 16kHz 모노 WAV로 바꿔서 중계 서버 Gemini로 받아쓰기 (최대 6분)
async function toWav16k(blob, maxSec = 360) {
  const buf = await blob.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const audio = await ctx.decodeAudioData(buf);
  ctx.close?.();
  const sec = Math.min(audio.duration, maxSec);
  const off = new OfflineAudioContext(1, Math.ceil(sec * 16000), 16000);
  const src = off.createBufferSource();
  src.buffer = audio;
  src.connect(off.destination);
  src.start(0);
  const pcm = (await off.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); out.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, 16000, true); out.setUint32(28, 32000, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  w(36, 'data'); out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return { wav: new Blob([out], { type: 'audio/wav' }), cut: audio.duration > maxSec };
}
const blobToB64 = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(b); });

async function transcribeInto(date, pageId, m) {
  if (!CFG.WORKER_URL || !auth.connected()) return toast('음성을 글자로 바꾸려면 구글 로그인과 중계 서버가 필요해요');
  const status = $('#voice-status');
  if (status) status.textContent = '글자로 바꾸는 중…';
  try {
    const { wav, cut } = await toWav16k(await mediaBlob(m));
    const res = await authFetch(`${CFG.WORKER_URL.replace(/\/$/, '')}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: await blobToB64(wav), mime: 'audio/wav', date }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || 'HTTP ' + res.status), { code: data.error });
    // 받아쓴 글 + 찾은 할 일(☐)을 이 탭 글에 덧붙임
    const add = [data.text.trim(), ...(data.todos || []).map((t) => '☐ ' + t)].filter(Boolean).join('\n');
    const open = state.view === 'day' && state.date === date;
    const doc = open ? pad.doc : await notes.get(date);
    const page = doc.pages.find((p) => p.id === pageId);
    if (!page) return;
    page.text = (page.text ? page.text.replace(/\n*$/, '\n\n') : '') + add;
    m.transcribed = true;
    const pm = page.media.find((x) => x.id === m.id);
    if (pm) pm.transcribed = true;
    if (open) { saveSoon(); if (pad.note.id === pageId) renderMediaPage(); renderTabs(); }
    else await notes.put(date, cloneDoc(doc));
    refreshDigest(date, doc);
    if (cut) toast('6분이 넘는 녹음은 앞 6분만 글자로 바꿨어요', 5000);
  } catch (e) {
    handleErr(e);
  } finally {
    const st = $('#voice-status');
    if (st) st.textContent = '';
  }
}

const recorder = { rec: null, chunks: [], started: 0, timer: null };
async function toggleRecord() {
  const page = pad.note;
  if (recorder.rec) { recorder.rec.stop(); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { return toast('마이크를 쓸 수 없어요. 브라우저 설정에서 마이크를 허용해 주세요', 5000); }
  const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  recorder.rec = rec;
  recorder.chunks = [];
  recorder.started = Date.now();
  rec.ondataavailable = (e) => { if (e.data.size) recorder.chunks.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(recorder.timer);
    const blob = new Blob(recorder.chunks, { type: rec.mimeType || 'audio/webm' });
    const dur = Math.round((Date.now() - recorder.started) / 1000);
    recorder.rec = null;
    const m = { id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), type: 'audio', mime: blob.type, dur };
    await idb.set('blob:' + m.id, blob);
    page.media.push(m);
    saveSoon();
    renderMediaPage();
    renderTabs();
    transcribeInto(state.date, page.id, m);
  };
  rec.start(1000);
  recorder.timer = setInterval(() => {
    const s = Math.round((Date.now() - recorder.started) / 1000);
    const b = $('#rec-btn');
    if (b) b.textContent = `■ 멈추기 ${Math.floor(s / 60)}:${pad2(s % 60)}`;
  }, 500);
  renderMediaPage();
}

function renderMediaPage() {
  const box = $('#media-page');
  const page = pad.note;
  const date = state.date;
  const items = [];
  if (page.kind === 'photo') {
    const bar = el('div', 'media-bar');
    const pick = el('label', 'pill primary media-pick');
    const input = el('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = async () => { await addPhotos(page, [...input.files]); saveSoon(); renderMediaPage(); renderTabs(); };
    pick.append(icon('photo'), el('span', null, '사진 찍기·고르기'), input);
    bar.append(pick);
    items.push(bar);
    const grid = el('div', 'photo-grid');
    for (const m of page.media) {
      const fig = el('figure', 'photo');
      const img = el('img');
      img.alt = '사진';
      if (m.w && m.h) img.style.aspectRatio = `${m.w} / ${m.h}`;
      mediaUrl(m).then((u) => { if (u) img.src = u; }).catch(() => { img.alt = '사진을 불러오지 못했어요'; });
      img.onclick = () => mediaUrl(m).then((u) => u && openModal('사진', [Object.assign(el('img', 'photo-full'), { src: u })]));
      const del = el('button', 'photo-del', '✕');
      del.setAttribute('aria-label', '사진 지우기');
      del.onclick = () => {
        if (!confirm('이 사진을 지울까요?')) return;
        page.media = page.media.filter((x) => x !== m);
        saveSoon();
        renderMediaPage();
      };
      fig.append(img, del);
      grid.append(fig);
    }
    if (page.media.length) items.push(grid);
    else items.push(el('p', 'muted-text', '사진을 찍거나 앨범에서 골라 넣으세요. 다른 앱에서 "공유 → 필기캘린더"로도 넣을 수 있어요(안드로이드).'));
  } else {
    const bar = el('div', 'media-bar');
    const rec = el('button', 'pill ' + (recorder.rec ? 'danger' : 'primary'), recorder.rec ? '■ 멈추기' : '● 녹음 시작');
    rec.id = 'rec-btn';
    rec.onclick = toggleRecord;
    bar.append(rec, Object.assign(el('span', 'muted-text'), { id: 'voice-status' }));
    items.push(bar);
    for (const m of page.media) {
      const row = el('div', 'voice-row');
      const audio = el('audio');
      audio.controls = true;
      audio.preload = 'none';
      mediaUrl(m).then((u) => { if (u) audio.src = u; }).catch(() => {});
      row.append(audio, el('span', 'muted-text', m.dur ? `${Math.floor(m.dur / 60)}:${pad2(m.dur % 60)}` : ''));
      if (!m.transcribed) {
        const again = el('button', 'pill', '글자로 바꾸기');
        again.onclick = () => transcribeInto(date, page.id, m);
        row.append(again);
      }
      items.push(row);
    }
    if (!page.media.length) items.push(el('p', 'muted-text', '녹음하면 AI가 받아 적고, 말한 할 일은 ☐로 넣어요. (구글 로그인·중계 서버 필요)'));
  }
  // 사진 설명·받아쓴 글 (검색·요약·할 일에 쓰임)
  const ta = el('textarea', 'media-text');
  ta.placeholder = page.kind === 'photo' ? '사진 설명 (검색에 쓰여요)' : '받아쓴 글 (직접 고칠 수 있어요)';
  ta.value = page.text || '';
  ta.rows = page.kind === 'photo' ? 3 : 10;
  ta.oninput = () => { page.text = ta.value; saveSoon(); };
  items.push(ta);
  box.replaceChildren(...items);
}

// 안드로이드 '공유 → 필기캘린더'로 받은 글·링크·사진을 오늘 메모에 넣음 (sw.js가 share-inbox 캐시에 보관)
async function takeShared(flag) {
  if (!flag || !('caches' in window)) return false;
  const cache = await caches.open('share-inbox');
  const metaRes = await cache.match('./share-meta');
  if (!metaRes) return false;
  const meta = await metaRes.json();
  const ds = ymd(new Date());
  const doc = await notes.get(ds);
  const text = [meta.title, meta.text, meta.url].filter(Boolean).join('\n').trim();
  if (text) {
    let page = doc.pages.find((p) => p.kind === 'text');
    if (!page) { page = blankPage('text'); if (doc.pages.length < MAX_TABS) doc.pages.push(page); }
    page.text = (page.text ? page.text.replace(/\n*$/, '\n\n') : '') + text;
  }
  const files = [];
  for (const f of meta.files || []) {
    const r = await cache.match(f.key);
    if (r) files.push(new File([await r.blob()], f.name || 'photo', { type: f.type }));
    await cache.delete(f.key);
  }
  if (files.length) {
    let page = doc.pages.find((p) => p.kind === 'photo');
    if (!page && doc.pages.length < MAX_TABS) { page = blankPage('photo'); doc.pages.push(page); }
    if (page) await addPhotos(page, files);
  }
  await cache.delete('./share-meta');
  await notes.put(ds, cloneDoc(doc));
  refreshDigest(ds, doc);
  toast('공유받은 내용을 오늘 메모에 넣었어요');
  await openDay(ds, { push: true });
  return true;
}
