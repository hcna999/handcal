// tests/worker-inbox.mjs: 빠른 추가 자연어 파서 및 토큰 설정 단위 테스트
import { _test } from '../worker/worker.js';

const { parseQuickInput, buildEventTimestamps, inboxConfigGet, inboxConfigSet } = _test;

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

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
  };
}

async function run() {
  console.log('--- Worker 빠른 추가(Inbox) 테스트 ---');
  // 기준 시각: 2026-11-19 17:00 KST (목요일) = 2026-11-19T08:00:00Z
  const now = Date.parse('2026-11-19T08:00:00Z');

  // 1. 자연어 시간 일정
  const p1 = parseQuickInput('내일 3시 치과 예약', now, 'Asia/Seoul');
  check('내일 3시 → 2026-11-20 15:00 event', p1.kind === 'event' && p1.date === '2026-11-20' && p1.startTime === '15:00' && p1.title === '치과 예약', JSON.stringify(p1));

  // 2. 시간 범위 일정
  const p2 = parseQuickInput('11/25 14:00~16:30 팀 미팅', now, 'Asia/Seoul');
  check('11/25 범위 시간 event', p2.kind === 'event' && p2.date === '2026-11-25' && p2.startTime === '14:00' && p2.endTime === '16:30' && p2.title === '팀 미팅', JSON.stringify(p2));

  // 3. 날짜만 있는 종일 일정
  const p3 = parseQuickInput('12월 1일 연차', now, 'Asia/Seoul');
  check('12월 1일 종일 event', p3.kind === 'event' && p3.date === '2026-12-01' && p3.allDay === true && p3.title === '연차', JSON.stringify(p3));

  // 4. 요일 + 저녁 반
  const p4 = parseQuickInput('금요일 저녁 7시 반 저녁약속', now, 'Asia/Seoul');
  check('금요일 저녁 7시 반 → 2026-11-20 19:30', p4.kind === 'event' && p4.date === '2026-11-20' && p4.startTime === '19:30' && p4.title === '저녁약속', JSON.stringify(p4));

  // 5. 할 일
  const p5 = parseQuickInput('할일 내일 우유 사기', now, 'Asia/Seoul');
  check('할일 강제 + 내일', p5.kind === 'todo' && p5.date === '2026-11-20' && p5.title === '우유 사기', JSON.stringify(p5));

  const p6 = parseQuickInput('☐ 택배 보내기', now, 'Asia/Seoul');
  check('☐ 접두어 할 일 (오늘)', p6.kind === 'todo' && p6.date === '2026-11-19' && p6.title === '택배 보내기', JSON.stringify(p6));

  // 6. 일반 메모 (날짜/시간 없음)
  const p7 = parseQuickInput('오늘 프로젝트 아이디어 정리해보기', now, 'Asia/Seoul');
  // '오늘'이 들어가도 45자 이내 한 줄이면 종일 일정이 될 수 있으므로, 날짜 없는 순수 메모 테스트:
  const p8 = parseQuickInput('장볼 목록: 계란, 두부, 양파', now, 'Asia/Seoul');
  check('날짜 없는 텍스트 → 오늘 note', p8.kind === 'note' && p8.date === '2026-11-19' && p8.title === '장볼 목록: 계란, 두부, 양파', JSON.stringify(p8));

  const p9 = parseQuickInput('메모 내일 회의 안건 정리', now, 'Asia/Seoul');
  check('메모 강제 접두어', p9.kind === 'note' && p9.date === '2026-11-20' && p9.title === '회의 안건 정리', JSON.stringify(p9));
  void p7;

  // 7. 명령어
  check('/오늘 조회', parseQuickInput('/오늘', now, 'Asia/Seoul').action === 'summary' && parseQuickInput('/오늘', now, 'Asia/Seoul').date === '2026-11-19');
  check('/내일 조회', parseQuickInput('/내일', now, 'Asia/Seoul').date === '2026-11-20');
  check('/취소 명령', parseQuickInput('/취소', now, 'Asia/Seoul').action === 'undo');
  check('/connect 토큰', parseQuickInput('/connect abc123', now, 'Asia/Seoul').token === 'abc123');

  // 8. buildEventTimestamps (KST → UTC 변환 정확성)
  const tsAllDay = buildEventTimestamps('2026-11-20', null, null, true, 'Asia/Seoul');
  check('종일 일정 KST 자정 → UTC', tsAllDay.start === '2026-11-19T15:00:00.000Z' && tsAllDay.end === '2026-11-20T15:00:00.000Z', JSON.stringify(tsAllDay));

  const tsTimed = buildEventTimestamps('2026-11-20', '15:00', null, false, 'Asia/Seoul');
  check('시간 일정 15:00 KST → 06:00~07:00Z', tsTimed.start === '2026-11-20T06:00:00.000Z' && tsTimed.end === '2026-11-20T07:00:00.000Z', JSON.stringify(tsTimed));

  // 9. inboxConfigGet / inboxConfigSet
  const kv = makeKV();
  const env = { HANDCAL_KV: kv };
  const c0 = await inboxConfigGet(env);
  check('초기 상태 토큰 없음', c0.token === null && c0.telegramConnected === false);

  const c1 = await inboxConfigSet(env, { refresh_token: 'RT_1', issueToken: true }, 'https://example.workers.dev');
  check('토큰 발급 성공', typeof c1.token === 'string' && c1.token.length >= 20);

  const c2 = await inboxConfigGet(env);
  check('토큰 조회 일치', c2.token === c1.token && c2.hasRefreshToken === true);

  const failed = results.filter((r) => !r).length;
  console.log(failed ? `\n실패 ${failed}개` : `\n모두 통과 (${results.length}개)`);
  if (failed) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
