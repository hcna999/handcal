// tests/worker-feed.mjs: Worker iCal 피드 및 토큰 단위 테스트
import { _test } from '../worker/worker.js';

const { feedTokenCreate, feedTokenGet, buildMemosIcs, buildTasksIcs, buildAllIcs } = _test;

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

// 가짜 KV
function makeKV() {
  const map = new Map();
  return {
    async get(k, type) {
      const v = map.get(k);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) { map.set(k, String(v)); },
    async delete(k) { map.delete(k); },
    _map: map,
  };
}

async function run() {
  console.log('--- Worker iCal 피드 테스트 ---');

  // 1. 피드 토큰 생성
  const kv = makeKV();
  const env = { HANDCAL_KV: kv };
  const r1 = await feedTokenCreate(env, { refresh_token: 'RT_TEST_1' });
  check('토큰 발급 (UUID 반환)', typeof r1.token === 'string' && r1.token.length > 20, r1.token);

  const get1 = await feedTokenGet(env);
  check('토큰 조회 (feed_meta 확인)', get1.token === r1.token);

  const stored1 = await kv.get('feed:' + r1.token, 'json');
  check('KV에 refresh_token 보관', stored1?.refresh_token === 'RT_TEST_1');

  // 2. 재발급 시 이전 토큰 무효화
  const r2 = await feedTokenCreate(env, { refresh_token: 'RT_TEST_2' });
  check('새 토큰 발급', r2.token !== r1.token);
  const oldStored = await kv.get('feed:' + r1.token);
  check('이전 토큰 삭제됨', oldStored === null);
  const newStored = await kv.get('feed:' + r2.token, 'json');
  check('새 토큰 저장됨', newStored?.refresh_token === 'RT_TEST_2');

  // 3. buildMemosIcs - 종일 일정 및 시간 일정
  const memos = [
    { id: 'm1', title: '종일 메모 일정', allDay: true, start: '2026-11-15', end: '2026-11-15', updated: Date.now() },
    { id: 'm2', title: '시간 메모 일정', allDay: false, start: '2026-11-16T09:00:00.000Z', end: '2026-11-16T11:00:00.000Z', updated: Date.now() },
  ];
  const memoIcs = buildMemosIcs(memos);
  check('memos.ics 헤더 확인', memoIcs.includes('BEGIN:VCALENDAR') && memoIcs.includes('X-WR-CALNAME:필기캘린더 메모 일정'));
  check('memos.ics 종일 일정 (VALUE=DATE)', memoIcs.includes('DTSTART;VALUE=DATE:20261115') && memoIcs.includes('DTEND;VALUE=DATE:20261116'));
  check('memos.ics 시간 일정 (UTC Z)', memoIcs.includes('DTSTART:20261116T090000Z') && memoIcs.includes('DTEND:20261116T110000Z'));
  check('memos.ics CRLF 줄바꿈', memoIcs.includes('\r\n') && !memoIcs.replace(/\r\n/g, '').includes('\n'));

  // 4. buildTasksIcs - 마감일 있는 할 일
  const tasks = [
    { id: 't1', title: '보고서 작성 및 제출', due: '2026-11-20', list: '기본 목록' },
    { id: 't2', title: '긴 제목 테스트: ' + '가나다라마바사아자차카타파하'.repeat(5), due: '2026-11-21', list: '업무' },
  ];
  const taskIcs = buildTasksIcs(tasks);
  check('tasks.ics 헤더 확인', taskIcs.includes('BEGIN:VCALENDAR') && taskIcs.includes('X-WR-CALNAME:필기캘린더 할 일'));
  check('tasks.ics 할 일 제목 및 기호', taskIcs.includes('SUMMARY:☐ 보고서 작성 및 제출'));
  check('tasks.ics 긴 줄 접힘 (RFC 5545 fold)', taskIcs.includes('\r\n '));

  // 5. buildAllIcs - 통합 피드
  const allIcs = buildAllIcs(memos, tasks);
  check('all.ics 헤더 확인', allIcs.includes('BEGIN:VCALENDAR') && allIcs.includes('X-WR-CALNAME:필기캘린더 (전체)'));
  check('all.ics 메모 이벤트 포함', allIcs.includes('종일 메모 일정'));
  check('all.ics 할 일 이벤트 포함', allIcs.includes('☐ 보고서 작성 및 제출'));

  const failed = results.filter((r) => !r).length;
  console.log(failed ? `\n실패 ${failed}개` : `\n모두 통과 (${results.length}개)`);
  if (failed) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
