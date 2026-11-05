// events.js: 일정(네이버·메모 일정) 불러오기·보관, 화면 상태
// (일반 스크립트: index.html에 적힌 순서대로 읽히고 전역 이름을 서로 함께 씀. 순서를 바꾸지 말 것)
'use strict';

// ---------- 일정
// 메모 일정: 앱에서 직접 적는 일정. 드라이브의 events.json으로 기기 간 동기화
const memos = {
  fileId: null,
  syncing: null,
  all() { return store.get('localEvents', []); },
  save(list) { store.set('localEvents', list); },
  visible(s, e) {
    return this.all()
      .filter((x) => !x.deleted)
      .map((x) => ({ ...x, start: new Date(x.start), end: new Date(x.end), color: '#2563eb', editable: true, source: 'memo' }))
      .filter((x) => x.start < e && x.end > s);
  },
  add(ev) {
    const list = this.all();
    list.push({ id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: ev.title, allDay: ev.allDay, start: ev.start.toISOString(), end: ev.end.toISOString(), updated: Date.now() });
    this.save(list);
    this.sync().catch(handleErr);
  },
  update(id, ev) {
    this.save(this.all().map((x) => (x.id === id ? { ...x, title: ev.title, allDay: ev.allDay, start: ev.start.toISOString(), end: ev.end.toISOString(), updated: Date.now() } : x)));
    this.sync().catch(handleErr);
  },
  remove(id) {
    this.save(this.all().map((x) => (x.id === id ? { id, deleted: true, updated: Date.now() } : x)));
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
      const q = encodeURIComponent(`'${fid}' in parents and name='events.json' and trashed=false`);
      const r = await gapi(`${DRIVE}?q=${q}&fields=files(id)`);
      this.fileId = r.files[0]?.id || null;
    }
    let remote = [];
    if (this.fileId) {
      const d = await drive.read(this.fileId);
      const data = typeof d === 'string' ? JSON.parse(d) : d;
      remote = Array.isArray(data?.events) ? data.events : [];
    }
    const byId = new Map();
    for (const x of [...remote, ...this.all()]) {
      const cur = byId.get(x.id);
      if (!cur || (x.updated || 0) > (cur.updated || 0)) byId.set(x.id, x);
    }
    const cutoff = Date.now() - 90 * 86400e3;
    const merged = [...byId.values()].filter((x) => !x.deleted || x.updated > cutoff).sort((a, b) => (a.id < b.id ? -1 : 1));
    const before = JSON.stringify(this.all());
    this.save(merged);
    const sortedRemote = [...remote].sort((a, b) => (a.id < b.id ? -1 : 1));
    if (JSON.stringify(sortedRemote) !== JSON.stringify(merged)) {
      const payload = { v: 1, events: merged };
      if (this.fileId) await drive.update(this.fileId, payload);
      else this.fileId = (await drive.create('events.json', payload)).id;
    }
    return before !== JSON.stringify(merged);
  },
};

// 네이버 캘린더 (읽기 전용, 중계 서버 경유)
const naver = {
  enabled() { return !!CFG.WORKER_URL && auth.connected(); },
  // 로그인이 잠깐 만료됐어도 전에 받아 둔 일정은 보여줌
  known() { return !!CFG.WORKER_URL && (auth.connected() || auth.wasSignedIn()); },
  warned: false,
  async load(s, e) {
    const res = await authFetch(`${CFG.WORKER_URL.replace(/\/$/, '')}/naver/events?start=${encodeURIComponent(s.toISOString())}&end=${encodeURIComponent(e.toISOString())}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || 'HTTP ' + res.status);
      err.code = data.error;
      throw err;
    }
    if (Array.isArray(data.calendars) && data.calendars.length) {
      store.set('naverCals', data.calendars);
      renderCalFilter();
    }
    return (data.events || []).map((x) => ({
      id: x.id,
      title: x.title,
      allDay: x.allDay,
      start: x.allDay ? parseYmd(x.start) : new Date(x.start),
      end: x.allDay ? parseYmd(x.end) : new Date(x.end),
      color: x.color || '#03c75a',
      calendar: x.calendar,
      editable: false,
      source: 'naver',
    }));
  },
};

// 일정 보관: 네이버 일정은 달(YYYY-MM)마다 받아온 시각을 기억하고 기기(localStorage 'naverEvents')에 저장한다.
// 이미 받은 달은 바로 그리고(오래됐으면 뒤에서 다시 받음), 받을 때는 앞뒤 달까지 한 번에 받아 둔다.
// 메모 일정은 늘 기기 목록(memos)에서 바로 계산한다.
const EV_FRESH = 5 * 60e3; // 5분 지나면 뒤에서 새로 받음
const monthKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const monthStart = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
function monthsIn(s, e) {
  const out = [];
  for (let m = monthStart(s); m < e; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) out.push(m);
  return out;
}
const overlaps = (ev, s, e) => ev.start < e && (ev.end > s || (+ev.start === +ev.end && ev.start >= s));

const events = {
  months: null, // {YYYY-MM: 받은 시각}
  list: null, // 네이버 일정 (Date로 바꾼 것)
  version: 0, // 네이버 일정이 바뀔 때마다 1씩 (다시 그릴지 판단)
  inflight: new Map(),

  restore() {
    if (this.list) return;
    const saved = store.get('naverEvents', null);
    this.months = saved?.months || {};
    this.list = (saved?.list || []).map((x) => ({ ...x, start: new Date(x.start), end: new Date(x.end) }));
  },
  persist() {
    // 오늘 기준 앞뒤 18개월만 남김
    const now = new Date();
    const lo = monthKey(new Date(now.getFullYear(), now.getMonth() - 18, 1)), hi = monthKey(new Date(now.getFullYear(), now.getMonth() + 18, 1));
    for (const k of Object.keys(this.months)) if (k < lo || k > hi) delete this.months[k];
    const keep = this.list.filter((ev) => monthKey(ev.end) >= lo && monthKey(ev.start) <= hi);
    store.set('naverEvents', { months: this.months, list: keep });
  },
  // 이 기간을 다 받아 둔 적이 있으면 (오래됐어도) 바로 돌려줌, 아니면 null
  cached(s, e) {
    let list = memos.visible(s, e);
    if (naver.known()) {
      this.restore();
      const have = monthsIn(s, e).every((m) => this.months[monthKey(m)]);
      if (!have && naver.enabled()) return null; // 받으러 가야 함
      list = list.concat(this.list.filter((ev) => overlaps(ev, s, e)));
    }
    return list.sort(sortEvents);
  },
  fresh(s, e) {
    if (!naver.enabled()) return true; // 받을 수 없으면 있는 것으로 끝
    this.restore();
    return monthsIn(s, e).every((m) => Date.now() - (this.months[monthKey(m)] || 0) < EV_FRESH);
  },
  // 앱으로 돌아왔을 때 등: 보여주던 건 그대로 두고 다음에 뒤에서 새로 받게 함
  clear() { if (this.months) for (const k of Object.keys(this.months)) this.months[k] = 1; },
  reset() { this.months = {}; this.list = []; this.version++; store.del('naverEvents'); },

  async load(s, e) {
    if (!naver.enabled()) return this.cached(s, e);
    this.restore();
    const need = monthsIn(s, e).filter((m) => Date.now() - (this.months[monthKey(m)] || 0) >= EV_FRESH);
    if (need.length) {
      // 모자란 달 + 앞뒤 한 달씩 한 번에 (최대 12개월)
      let from = need[0], to = new Date(need[need.length - 1].getFullYear(), need[need.length - 1].getMonth() + 1, 1);
      const wider = [new Date(from.getFullYear(), from.getMonth() - 1, 1), new Date(to.getFullYear(), to.getMonth() + 1, 1)];
      if (monthsIn(wider[0], wider[1]).length <= 12) [from, to] = wider;
      try {
        // 이미 받으러 간 요청이 이 기간을 덮으면 그걸 기다림
        const last = need[need.length - 1];
        const needEnd = new Date(last.getFullYear(), last.getMonth() + 1, 1);
        const cover = [...this.inflight.values()].find((x) => x.from <= need[0] && x.to >= needEnd);
        await (cover ? cover.promise : this.fetchRange(from, to));
        naver.warned = false;
      } catch (err) {
        if (err.message === 'AUTH') throw err;
        if (!naver.warned) { naver.warned = true; toast('네이버 캘린더를 불러오지 못했어요: ' + err.message.slice(0, 100), 5000); }
        console.warn(err);
        // 실패한 달은 30초 동안 다시 요청하지 않음 (받아 둔 게 있으면 그걸로 보여줌)
        const retry = Date.now() - EV_FRESH + 30e3;
        for (const m of need) this.months[monthKey(m)] = Math.max(this.months[monthKey(m)] || 0, retry);
        return this.cached(s, e);
      }
    }
    return this.cached(s, e);
  },
  // 같은 기간을 동시에 두 번 요청하지 않음
  fetchRange(from, to) {
    const key = monthKey(from) + '~' + monthKey(to);
    if (!this.inflight.has(key)) {
      this.inflight.set(key, { from, to, promise: (async () => {
        const got = await naver.load(from, to);
        const old = this.list.filter((ev) => overlaps(ev, from, to));
        const sig = (l) => l.map((ev) => `${ev.id}|${+ev.start}|${+ev.end}|${ev.title}|${ev.color}|${ev.calendar}`).sort().join('\n');
        if (sig(old) !== sig(got)) this.version++;
        const seen = new Set();
        this.list = this.list.filter((ev) => !overlaps(ev, from, to)).concat(got).filter((ev) => {
          const k = ev.id + '|' + +ev.start;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        const now = Date.now();
        for (const m of monthsIn(from, to)) this.months[monthKey(m)] = now;
        this.persist();
      })().finally(() => this.inflight.delete(key)) });
    }
    return this.inflight.get(key).promise;
  },
  // 앞뒤 화면에 걸칠 일정을 미리 받아 둠 (넘길 때 바로 보이게, 실패해도 조용히)
  prefetch(s, e) {
    if (!naver.enabled() || this.fresh(s, e)) return;
    setTimeout(() => this.load(s, e).catch(() => {}), 300);
  },

  on(list, day) {
    const s = day, e = addDays(day, 1);
    const hidden = hiddenCals();
    return list.filter((ev) => !hidden.has(calKey(ev)) && overlaps(ev, s, e));
  },

  add(ev) { memos.add(ev); },
  update(id, ev) { memos.update(id, ev); },
  remove(ev) { memos.remove(ev.id); },
};

function sortEvents(a, b) {
  return (b.allDay - a.allDay) || (a.start - b.start) || a.title.localeCompare(b.title);
}

// ---------- 화면 상태
const state = {
  view: 'month',
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  date: null,
};
let monthToken = 0;
let dayToken = 0;
