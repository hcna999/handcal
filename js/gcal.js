// gcal.js: 구글 캘린더 브릿지 (메모 일정 → HandCalendar 보조 캘린더 연동)
// (일반 스크립트: index.html에 적힌 순서대로 읽히고 전역 이름을 서로 함께 씀. 순서를 바꾸지 말 것)
'use strict';

const GCAL_API = 'https://www.googleapis.com/calendar/v3';
const GCAL_CAL_NAME = 'HandCalendar';

// 메모 일정의 start/end는 현지 자정을 ISO(UTC)로 적은 값이라, 글자를 그대로 자르면 한국 시간에서는 하루 전날이 됨
function localDateStr(v) {
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d)) return s.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function nextDayStr(ymdStr) {
  const d = new Date(ymdStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const gcal = {
  calId: store.get('gcalCalId', null),
  map: store.get('gcalMap', {}), // memoId → gcalEventId
  synced: store.get('gcalSynced', {}), // memoId → 마지막으로 구글에 올린 memo.updated (이 기기 기준, 안 바뀐 일정은 다시 올리지 않음)
  mapFileId: null,
  dirty: false,
  timer: null,
  running: null,
  problem: null, // null | 'scope' | 'api'

  on() { return store.get('gcalOn', false) && !!CFG.GOOGLE_CLIENT_ID && auth.connected(); },

  // ---- API 래퍼: 403 scope/api 오류 감지
  async api(path, opts = {}) {
    try {
      const headers = opts.body ? { 'Content-Type': 'application/json' } : {};
      return await gapi(
        GCAL_API + path,
        opts.body ? { ...opts, headers: { ...headers, ...(opts.headers || {}) } } : opts,
      );
    } catch (e) {
      if (/HTTP 403/.test(e.message)) {
        this.problem = /insufficientPermissions|PERMISSION_DENIED/i.test(e.message) ? 'scope' : 'api';
        renderGcalStatus();
        e.silent = true;
      }
      throw e;
    }
  },

  // ---- 'HandCalendar' 보조 캘린더 탐색 또는 생성, ID 로컬 캐시
  async ensureCalendar() {
    if (this.calId) return this.calId;
    const r = await this.api('/users/me/calendarList');
    const found = (r.items || []).find((c) => c.summary === GCAL_CAL_NAME);
    if (found) {
      this.calId = found.id;
      store.set('gcalCalId', this.calId);
      return this.calId;
    }
    const created = await this.api('/calendars', {
      method: 'POST',
      body: JSON.stringify({ summary: GCAL_CAL_NAME }),
    });
    this.calId = created.id;
    store.set('gcalCalId', this.calId);
    return this.calId;
  },

  // ---- Drive gcal.json ↔ 로컬 맵 병합 (기기 간 매핑 공유)
  async syncMap(upload) {
    if (!this.mapFileId) {
      const fid = await drive.ensureFolder();
      const q = encodeURIComponent(`'${fid}' in parents and name='gcal.json' and trashed=false`);
      this.mapFileId = (await gapi(`${DRIVE}?q=${q}&fields=files(id)`)).files[0]?.id || null;
    }
    let remote = {};
    if (this.mapFileId) {
      const d = await drive.read(this.mapFileId);
      remote = (typeof d === 'string' ? JSON.parse(d) : d)?.map || {};
    }
    const merged = { ...remote, ...this.map };
    this.map = merged;
    store.set('gcalMap', this.map);
    if (upload && JSON.stringify(merged) !== JSON.stringify(remote)) {
      const payload = { v: 1, map: merged };
      if (this.mapFileId) await drive.update(this.mapFileId, payload);
      else this.mapFileId = (await drive.create('gcal.json', payload)).id;
    }
  },

  // ---- memo 객체 → GCal event body 변환
  _eventBody(memo) {
    if (memo.allDay) {
      const startStr = localDateStr(memo.start);
      let endStr = memo.end ? localDateStr(memo.end) : startStr;
      if (endStr <= startStr) endStr = nextDayStr(startStr); // GCal 종일 일정은 end가 exclusive
      return {
        summary: memo.title || '(제목 없음)',
        start: { date: startStr },
        end:   { date: endStr },
      };
    }
    return {
      summary: memo.title || '(제목 없음)',
      start: { dateTime: memo.start, timeZone: 'Asia/Seoul' },
      end:   { dateTime: memo.end,   timeZone: 'Asia/Seoul' },
    };
  },

  // ---- 메모 추가/수정 → GCal event 생성 또는 갱신
  async upsert(memo) {
    const calId = await this.ensureCalendar();
    const body = this._eventBody(memo);
    const existing = this.map[memo.id];
    if (existing) {
      try {
        await this.api(`/calendars/${encodeURIComponent(calId)}/events/${existing}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
        this.markSynced(memo);
        return;
      } catch (e) {
        if (!/HTTP 404/.test(e.message)) throw e;
        // 404: 구글 캘린더에서 직접 지운 경우 다시 생성
      }
    }
    const created = await this.api(`/calendars/${encodeURIComponent(calId)}/events`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    this.map[memo.id] = created.id;
    store.set('gcalMap', this.map);
    this.markSynced(memo);
    this.dirty = true;
  },

  markSynced(memo) {
    this.synced[memo.id] = memo.updated || 0;
    store.set('gcalSynced', this.synced);
  },

  // ---- 메모 삭제 → GCal event 삭제
  async remove(memoId) {
    const gcalEventId = this.map[memoId];
    if (!gcalEventId) return;
    const calId = await this.ensureCalendar();
    await this.api(`/calendars/${encodeURIComponent(calId)}/events/${gcalEventId}`, { method: 'DELETE' })
      .catch((e) => { if (!/HTTP 404/.test(e.message)) throw e; });
    delete this.map[memoId];
    store.set('gcalMap', this.map);
    if (memoId in this.synced) { delete this.synced[memoId]; store.set('gcalSynced', this.synced); }
    this.dirty = true;
  },

  // ---- 전체 동기화: memos 목록 기준으로 GCal과 맞춤 (단방향, memos → GCal)
  async _syncAll(force) {
    if (!this.on()) return;
    this.problem = null;
    // 다른 기기에서 만든 일정을 '모르는 일정'으로 보고 지우지 않도록, 먼저 메모 일정을 최신으로 받음
    let memosFresh = false;
    try { await memos.sync(); memosFresh = true; } catch (e) { console.warn('GCal 연동: 메모 일정 동기화 실패, 정리는 건너뜀', e.message); }
    await this.syncMap(false);

    const all = memos.all();
    const active = all.filter((x) => !x.deleted);
    const deleted = all.filter((x) => x.deleted);

    for (const memo of active) {
      // 이미 올린 뒤로 안 바뀐 일정은 건너뜀 (동기화 때마다 전체를 다시 올리지 않게)
      if (!force && this.map[memo.id] && this.synced[memo.id] === (memo.updated || 0)) continue;
      await this.upsert(memo);
    }

    for (const memo of deleted) {
      if (this.map[memo.id]) await this.remove(memo.id);
    }
    // 연결표에 있지만 memos에 아예 없는 항목 정리 (메모 일정을 방금 최신으로 받았을 때만: 불확실하면 지우지 않음)
    if (memosFresh) {
      const knownIds = new Set(all.map((x) => x.id));
      for (const memoId of Object.keys(this.map)) {
        if (!knownIds.has(memoId)) await this.remove(memoId);
      }
    }

    if (this.dirty) await this.syncMap(true);
    this.dirty = false;
    renderGcalStatus();
  },

  schedule() {
    if (!this.on()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.syncAll(), 2000);
  },

  // force: 안 바뀐 일정도 모두 다시 올림 (설정에서 켤 때·다시 연결할 때. 구글 캘린더에서 직접 지운 일정 복구)
  syncAll(force = false) {
    if (!this.running) {
      this.running = this._syncAll(force)
        .catch((e) => { if (e.message === 'AUTH' || !e.silent) console.warn('GCal 연동', e.message); })
        .finally(() => { this.running = null; });
    }
    return this.running;
  },
};

function renderGcalStatus() {
  const statusEl = $('#gcal-status');
  if (!statusEl) return;
  const on = store.get('gcalOn', false);
  document.querySelectorAll('#gcal-seg button').forEach((b) =>
    b.classList.toggle('active', (b.dataset.on === '1') === on));
  $('#gcal-reauth')?.classList.toggle('hidden', !(on && gcal.problem === 'scope'));
  statusEl.textContent = !on ? '꺼져 있어요'
    : !auth.connected() ? '구글 로그인 후 연동돼요'
    : gcal.problem === 'api' ? '구글 클라우드에서 Calendar API를 켜야 해요'
    : gcal.problem === 'scope' ? 'Calendar 권한이 필요해요. 아래 버튼으로 다시 연결해 주세요'
    : '구글 캘린더 HandCalendar와 연동됨';
}
