// tests/gcal.mjs: Google Calendar Bridge (gcal.js) 단위 및 동작 검증 테스트
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const gcalCode = await readFile(join(__dirname, '../js/gcal.js'), 'utf-8');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

function createMockEnv(initialStore = {}) {
  const storeMap = { ...initialStore };
  const elements = new Map();

  const getOrCreateEl = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        textContent: '',
        classList: {
          classes: new Set(),
          toggle(cls, force) {
            if (force === undefined) {
              if (this.classes.has(cls)) { this.classes.delete(cls); return false; }
              this.classes.add(cls); return true;
            }
            if (force) this.classes.add(cls);
            else this.classes.delete(cls);
            return force;
          },
          contains(cls) { return this.classes.has(cls); },
          add(cls) { this.classes.add(cls); },
          remove(cls) { this.classes.delete(cls); },
        },
      });
    }
    return elements.get(id);
  };

  const segButtons = [
    { dataset: { on: '1' }, classList: { classes: new Set(), toggle(c, f) { f ? this.classes.add(c) : this.classes.delete(c); } } },
    { dataset: { on: '0' }, classList: { classes: new Set(), toggle(c, f) { f ? this.classes.add(c) : this.classes.delete(c); } } },
  ];

  const ctx = {
    console,
    Date,
    JSON,
    Set,
    Map,
    encodeURIComponent,
    clearTimeout,
    setTimeout,
    store: {
      get: (k, def) => (storeMap[k] !== undefined ? storeMap[k] : def),
      set: (k, v) => { storeMap[k] = v; },
      del: (k) => { delete storeMap[k]; },
      _data: storeMap,
    },
    CFG: { GOOGLE_CLIENT_ID: 'test-client-id' },
    auth: {
      _connected: true,
      connected() { return this._connected; },
    },
    $: (sel) => {
      if (sel.startsWith('#')) return getOrCreateEl(sel.slice(1));
      return null;
    },
    document: {
      querySelectorAll: (sel) => {
        if (sel === '#gcal-seg button') return segButtons;
        return [];
      },
    },
    memos: {
      _items: [],
      all() { return this._items; },
    },
    drive: {
      folderId: 'folder123',
      async ensureFolder() { return this.folderId; },
      async read(fileId) { return { v: 1, map: {} }; },
      async update(fileId, payload) {},
      async create(name, payload) { return { id: 'new_map_file' }; },
    },
    DRIVE: 'https://www.googleapis.com/drive/v3/files',
    gapi: async (url, opts = {}) => {},
    segButtons,
    elements,
  };

  vm.createContext(ctx);
  vm.runInContext(gcalCode + '\n;this.gcal = gcal; this.renderGcalStatus = renderGcalStatus; this.nextDayStr = nextDayStr;', ctx);
  return ctx;
}

async function run() {
  console.log('--- Google Calendar Bridge (gcal.js) 단위 테스트 ---');

  // 1. nextDayStr 검증
  const env1 = createMockEnv();
  check('nextDayStr 일반 날짜', env1.nextDayStr('2026-11-09') === '2026-11-10');
  check('nextDayStr 월말 전환', env1.nextDayStr('2026-10-31') === '2026-11-01');
  check('nextDayStr 연말 전환', env1.nextDayStr('2026-12-31') === '2027-01-01');
  check('nextDayStr 윤년 2월 28일', env1.nextDayStr('2024-02-28') === '2024-02-29');

  // 2. _eventBody 변환 로직
  const allDayMemo = {
    id: 'm1',
    title: '단지 임장',
    start: '2026-11-15',
    allDay: true,
  };
  const body1 = env1.gcal._eventBody(allDayMemo);
  check('종일 일정 summary', body1.summary === '단지 임장');
  check('종일 일정 start.date', body1.start.date === '2026-11-15');
  check('종일 일정 end.date는 start 익일 (exclusive)', body1.end.date === '2026-11-16');

  const multiDayMemo = {
    id: 'm2',
    title: '휴가',
    start: '2026-11-15',
    end: '2026-11-18',
    allDay: true,
  };
  const body2 = env1.gcal._eventBody(multiDayMemo);
  check('다일 종일 일정 end.date 유지', body2.end.date === '2026-11-18');

  const timedMemo = {
    id: 'm3',
    title: '부동산 미팅',
    start: '2026-11-15T14:00:00+09:00',
    end: '2026-11-15T15:30:00+09:00',
    allDay: false,
  };
  const body3 = env1.gcal._eventBody(timedMemo);
  check('시간 일정 start.dateTime', body3.start.dateTime === timedMemo.start && body3.start.timeZone === 'Asia/Seoul');
  check('시간 일정 end.dateTime', body3.end.dateTime === timedMemo.end && body3.end.timeZone === 'Asia/Seoul');

  const noTitleMemo = { id: 'm4', start: '2026-11-15', allDay: true };
  const body4 = env1.gcal._eventBody(noTitleMemo);
  check('제목 없는 메모 기본값', body4.summary === '(제목 없음)');

  // 3. on() 활성화 조건
  const env2 = createMockEnv({ gcalOn: false });
  check('gcalOn이 false면 on()은 false', env2.gcal.on() === false);

  env2.store.set('gcalOn', true);
  check('gcalOn=true, auth.connected=true면 on()은 true', env2.gcal.on() === true);

  env2.auth._connected = false;
  check('auth 미연결이면 on()은 false', env2.gcal.on() === false);

  env2.auth._connected = true;
  env2.CFG.GOOGLE_CLIENT_ID = '';
  check('CLIENT_ID 없으면 on()은 false', env2.gcal.on() === false);

  // 4. ensureCalendar() - 캘린더 생성 및 기존 캘린더 검색
  const apiCalls = [];
  const env3 = createMockEnv({ gcalOn: true });
  env3.gapi = async (url, opts = {}) => {
    apiCalls.push({ url, method: opts.method || 'GET', body: opts.body });
    if (url.includes('/users/me/calendarList')) {
      return { items: [{ id: 'existing_cal_id', summary: 'HandCalendar' }] };
    }
    return {};
  };

  const calId1 = await env3.gcal.ensureCalendar();
  check('기존 HandCalendar 탐색 성공', calId1 === 'existing_cal_id');
  check('calId 로컬 저장소 캐시', env3.store.get('gcalCalId') === 'existing_cal_id');

  // calId 캐시된 경우 api 호출 없이 반환
  apiCalls.length = 0;
  const calIdCached = await env3.gcal.ensureCalendar();
  check('calId 캐시 시 API 재호출 없음', calIdCached === 'existing_cal_id' && apiCalls.length === 0);

  // HandCalendar 없을 때 자동 생성
  const env4 = createMockEnv({ gcalOn: true });
  const createdCalls = [];
  env4.gapi = async (url, opts = {}) => {
    createdCalls.push({ url, method: opts.method || 'GET', body: opts.body });
    if (url.includes('/users/me/calendarList')) {
      return { items: [{ id: 'primary', summary: 'user@example.com' }] };
    }
    if (url.endsWith('/calendars') && opts.method === 'POST') {
      return { id: 'new_handcal_id', summary: 'HandCalendar' };
    }
    return {};
  };
  const calIdNew = await env4.gcal.ensureCalendar();
  check('HandCalendar 없을 때 신규 생성', calIdNew === 'new_handcal_id');
  check('신규 calId 로컬 저장', env4.store.get('gcalCalId') === 'new_handcal_id');

  // 5. upsert() - 생성 및 수정
  const env5 = createMockEnv({ gcalOn: true, gcalCalId: 'test_cal' });
  const upsertCalls = [];
  env5.gapi = async (url, opts = {}) => {
    upsertCalls.push({ url, method: opts.method || 'GET', body: opts.body });
    if (opts.method === 'POST') return { id: 'gcal_ev_1' };
    if (opts.method === 'PUT') return { id: 'gcal_ev_1' };
    return {};
  };

  await env5.gcal.upsert(allDayMemo);
  check('새 메모 upsert 시 POST 호출', upsertCalls.some((c) => c.method === 'POST' && c.url.includes('/events')));
  check('map에 memo.id 매핑 저장', env5.gcal.map['m1'] === 'gcal_ev_1');
  check('dirty 플래그 설정', env5.gcal.dirty === true);

  // 기존 메모 수정 (PUT)
  upsertCalls.length = 0;
  await env5.gcal.upsert({ ...allDayMemo, title: '단지 임장 (완료)' });
  check('기존 메모 수정 시 PUT 호출', upsertCalls.some((c) => c.method === 'PUT' && c.url.includes('/events/gcal_ev_1')));

  // 6. remove() - 삭제
  const removeCalls = [];
  env5.gapi = async (url, opts = {}) => {
    removeCalls.push({ url, method: opts.method || 'GET' });
    return {};
  };
  await env5.gcal.remove('m1');
  check('remove 시 DELETE 호출', removeCalls.some((c) => c.method === 'DELETE' && c.url.includes('/events/gcal_ev_1')));
  check('map에서 memoId 제거됨', env5.gcal.map['m1'] === undefined);

  // 7. 403 권한 오류 감지 및 problem 세팅
  const env6 = createMockEnv({ gcalOn: true, gcalCalId: 'test_cal' });
  env6.gapi = async () => {
    const err = new Error('HTTP 403: Request had insufficientPermissions');
    throw err;
  };
  let threw = false;
  try {
    await env6.gcal.api('/users/me/calendarList');
  } catch (e) {
    threw = true;
    check('403 오류 시 silent 플래그 설정', e.silent === true);
  }
  check('API 에러 던짐', threw);
  check('problem이 "scope"로 세팅됨', env6.gcal.problem === 'scope');

  // 8. renderGcalStatus() UI 상태 렌더링
  const statusEl = env6.$('#gcal-status');
  const reauthBtn = env6.$('#gcal-reauth');

  // 8-1. 꺼짐
  env6.store.set('gcalOn', false);
  env6.renderGcalStatus();
  check('꺼짐 상태 텍스트', statusEl.textContent === '꺼져 있어요');

  // 8-2. 켜짐 & 미로그인
  env6.store.set('gcalOn', true);
  env6.auth._connected = false;
  env6.renderGcalStatus();
  check('로그인 필요 상태 텍스트', statusEl.textContent === '구글 로그인 후 연동돼요');

  // 8-3. 켜짐 & 권한 부족 (scope)
  env6.auth._connected = true;
  env6.gcal.problem = 'scope';
  env6.renderGcalStatus();
  check('권한 부족 상태 텍스트', statusEl.textContent.includes('Calendar 권한이 필요해요'));
  check('권한 부족 시 reauth 버튼 표시 (hidden 제거)', !reauthBtn.classList.contains('hidden'));

  // 8-4. 켜짐 & 정상
  env6.gcal.problem = null;
  env6.renderGcalStatus();
  check('정상 연동 상태 텍스트', statusEl.textContent === '구글 캘린더 HandCalendar와 연동됨');
  check('정상 연동 시 reauth 버튼 숨김', reauthBtn.classList.contains('hidden'));

  // 9. 앱이 실제로 저장하는 형식: 현지 자정을 ISO(UTC)로 적은 종일 일정 → 현지 날짜 그대로
  const realAllDay = { id: 'r1', title: '실제 형식', allDay: true, start: new Date(2026, 10, 15).toISOString(), end: new Date(2026, 10, 16).toISOString(), updated: 5 };
  const body9 = env1.gcal._eventBody(realAllDay);
  check('현지 자정 ISO 종일 일정이 하루 밀리지 않음', body9.start.date === '2026-11-15' && body9.end.date === '2026-11-16', JSON.stringify(body9));
  const realMulti = { ...realAllDay, end: new Date(2026, 10, 18).toISOString() };
  check('여러 날 종일 일정 끝 날짜', env1.gcal._eventBody(realMulti).end.date === '2026-11-18');

  // 10. 전체 동기화: 안 바뀐 일정은 다시 올리지 않고, 메모 일정을 못 받았으면 모르는 일정을 지우지 않음
  const env10 = createMockEnv({ gcalOn: true, gcalCalId: 'cal10' });
  const calls10 = [];
  env10.gapi = async (url, opts = {}) => {
    if (url.includes('/calendar/v3')) calls10.push({ url, method: opts.method || 'GET' });
    if (opts.method === 'POST') return { id: 'ev_' + calls10.length };
    return { files: [] };
  };
  env10.memos._items = [realAllDay];
  env10.memos.sync = async () => {};
  await env10.gcal.syncAll();
  const firstWrites = calls10.filter((c) => c.method !== 'GET').length;
  await env10.gcal.syncAll();
  check('안 바뀐 일정은 다시 올리지 않음', firstWrites === 1 && calls10.filter((c) => c.method !== 'GET').length === 1, JSON.stringify(calls10));
  env10.memos._items = [{ ...realAllDay, title: '고침', updated: 6 }];
  await env10.gcal.syncAll();
  check('바뀐 일정만 PUT', calls10.filter((c) => c.method === 'PUT').length === 1);
  await env10.gcal.syncAll(true);
  check('force면 안 바뀐 일정도 다시 올림', calls10.filter((c) => c.method === 'PUT').length === 2);

  env10.gcal.map.other = 'ev_other'; // 다른 기기가 만든 일정 (이 기기 메모 목록에는 아직 없음)
  env10.memos.sync = async () => { throw new Error('offline'); };
  await env10.gcal.syncAll();
  check('메모 일정을 못 받으면 모르는 일정을 지우지 않음', env10.gcal.map.other === 'ev_other' && !calls10.some((c) => c.method === 'DELETE'));
  env10.memos.sync = async () => {};
  await env10.gcal.syncAll();
  check('메모 일정을 받은 뒤에는 없는 일정 정리', env10.gcal.map.other === undefined && calls10.some((c) => c.method === 'DELETE' && c.url.includes('ev_other')));

  // 최종 결과
  const failed = results.filter((r) => !r).length;
  console.log(`\n결과: ${results.length - failed}/${results.length} 통과`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
