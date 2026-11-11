// 기능 확인: 공휴일·음력, 할 일 기한 읽기·정렬, 전체 검색, 내보내기, 사진 탭, 주간 시간표
// 사용: node tests/features.mjs   (오류가 있으면 종료 코드 1)
import { createServer } from 'node:http';
import { readFile, readFile as rf } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  try {
    const body = await readFile(join(root, path || 'index.html'));
    res.writeHead(200, { 'Content-Type': types[extname(path || 'index.html')] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const base = `http://localhost:${server.address().port}/`;

// 시험용 작은 PNG (단색 64x48)
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([60, 120, 230], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };
const errors = [];

// 넓은 화면: 메모·할 일·목표는 사이드 메뉴, 월·주는 달력일 때만 위에 보임. 좁은 화면: 아래 탭
const goView = async (pg, v) => {
  const sel = `[data-view=${v}] >> visible=true`;
  if (await pg.locator(sel).count()) return pg.click(sel);
  if (v === 'month' || v === 'week') {
    await pg.click('#side-nav [data-nav=cal]');
    return pg.click(sel);
  }
  return pg.click(`#side-nav [data-nav=${v}]`);
};

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, serviceWorkers: 'block', acceptDownloads: true });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.route(/config\.js/, (r) => r.fulfill({ contentType: 'text/javascript', body: "window.APP_CONFIG={GOOGLE_CLIENT_ID:''}" }));
  await p.route('https://accounts.google.com/**', (r) => r.fulfill({ body: '' }));
  await p.addInitScript(() => {
    localStorage.setItem('onboarded', 'true');
    localStorage.setItem('installHintClosed', 'true');
    if (localStorage.getItem('seeded')) return;
    localStorage.setItem('seeded', '1');
    const t = new Date();
    const at = (d, h, m = 0) => new Date(t.getFullYear(), t.getMonth(), t.getDate() + d, h, m).toISOString();
    localStorage.setItem('localEvents', JSON.stringify([
      { id: 'a', title: '주간회의', allDay: false, start: at(0, 10), end: at(0, 11), updated: 1 },
      { id: 'b', title: '고객 미팅', allDay: false, start: at(0, 10, 30), end: at(0, 12), updated: 1 },
    ]));
  });
  await p.goto(base);
  await p.waitForSelector('.cell');

  // 공휴일·음력 (2026년 대체공휴일 3/2, 5/25, 8/17, 10/5 · 설날 2/17 · 추석 9/25)
  const hol = await p.evaluate(() => Object.fromEntries(holidaysOf(2026)));
  check('2026 대체공휴일', ['2026-03-02', '2026-05-25', '2026-08-17', '2026-10-05'].every((d) => hol[d] === '대체공휴일'));
  check('설날·추석(음력)', hol['2026-02-17'] === '설날' && hol['2026-09-25'] === '추석');
  check('음력 변환', (await p.evaluate(() => JSON.stringify(lunarOf(new Date(2026, 1, 17))))) === '{"leap":false,"m":1,"d":1}');

  // 할 일 기한 읽기
  const due = await p.evaluate(() => { const b = new Date(2026, 10, 3); return ['금요일까지', '내일', '11/7', '다음주 월요일', '20일까지', '그냥'].map((x) => parseDue(x, b)); });
  check('기한 읽기', JSON.stringify(due) === JSON.stringify(['2026-11-06', '2026-11-04', '2026-11-07', '2026-11-09', '2026-11-20', null]), due.join(','));

  // 메모 쓰기 → 할 일 기한순 → 검색 → 내보내기
  await p.click('.cell.today');
  await p.waitForTimeout(400);
  await p.click('#text-page');
  await p.keyboard.type('주간회의 메모');
  await p.keyboard.press('Enter');
  await p.keyboard.type('[] 내일까지 견적서');
  await p.keyboard.press('Enter');
  await p.keyboard.type('그냥 할 일');
  await p.waitForTimeout(600);
  await p.click('#back-btn');
  await p.waitForTimeout(300);
  await goView(p, 'todo');
  await p.waitForTimeout(600);
  check('할 일 기한순 묶음', (await p.$$eval('#todo-items .todo-date', (x) => x.map((i) => i.textContent))).some((t) => t.startsWith('내일')));
  await goView(p, 'week');
  await p.waitForTimeout(400);
  check('주간 시간표 (겹치는 일정 나란히)', (await p.$$('.wtime-ev')).length === 2);
  await p.keyboard.press('Control+K');
  await p.fill('#search-input', '견적');
  await p.waitForTimeout(900);
  const hits = await p.$$eval('.search-hit', (x) => x.map((i) => i.textContent));
  check('전체 검색', hits.length === 1 && hits[0].includes('할 일'), hits.join(' | '));
  await p.click('.search-hit');
  await p.waitForTimeout(400);
  await p.click('#day-menu-btn');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#modal-body button >> text=마크다운 저장')]);
  const md = await rf(await dl.path(), 'utf8');
  check('마크다운 내보내기', md.includes('- [ ] 내일까지 견적서') && md.includes('주간회의'));
  await p.click('#modal-close');

  // 손글씨: 올가미로 골라 옮기기·확대해도 좌표 정확
  await p.evaluate(() => addPage('ink'));
  await p.waitForTimeout(200);
  const B = await p.$eval('#canvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, s: r.width / 1000 }; });
  const at = (x, y) => [B.x + x * B.s, B.y + y * B.s];
  await p.mouse.move(...at(100, 200)); await p.mouse.down(); await p.mouse.move(...at(300, 200), { steps: 6 }); await p.mouse.up();
  await p.click('[data-tool=lasso]');
  await p.mouse.move(...at(60, 150)); await p.mouse.down();
  for (const pt of [[350, 150], [350, 260], [60, 260], [60, 150]]) await p.mouse.move(...at(...pt), { steps: 4 });
  await p.mouse.up();
  await p.mouse.move(...at(200, 200)); await p.mouse.down(); await p.mouse.move(...at(250, 300), { steps: 5 }); await p.mouse.up();
  const moved = await p.evaluate(() => pad.note.strokes[0].points[0].slice(0, 2).map(Math.round));
  check('올가미로 옮기기', moved[0] === 150 && moved[1] === 300, moved.join(','));
  await p.click('#sel-done');
  await p.click('#zoom-in');
  await p.click('#zoom-in');
  await p.click('[data-tool=pen]');
  const B2 = await p.$eval('#canvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, s: r.width / 1000 }; });
  // 화면에 보이는 자리(600, 500)에 그리고, 저장된 좌표가 그 자리의 종이 좌표와 같은지
  const want = [Math.round((600 - B2.x) / B2.s), Math.round((500 - B2.y) / B2.s)];
  await p.mouse.move(600, 500); await p.mouse.down(); await p.mouse.move(680, 500, { steps: 4 }); await p.mouse.up();
  const got = await p.evaluate(() => pad.note.strokes.at(-1).points[0].slice(0, 2).map(Math.round));
  check('150% 확대에서도 좌표 정확', Math.abs(got[0] - want[0]) <= 1 && Math.abs(got[1] - want[1]) <= 1, `${got} ≈ ${want}`);
  await p.click('#zoom-label');

  // 사진 탭: 넣으면 줄여서 저장, 달력 요약에 사진 설명
  await p.evaluate(() => addPage('photo'));
  await p.setInputFiles('.media-pick input', { name: 'a.png', mimeType: 'image/png', buffer: png(64, 48) });
  await p.waitForTimeout(800);
  check('사진 탭에 사진', (await p.evaluate(() => pad.note.media.length)) === 1 && (await p.$eval('.photo img', (i) => i.naturalWidth > 0)));
  await p.fill('.media-text', '화이트보드');
  await p.waitForTimeout(600);
  await p.click('#back-btn');
  await p.waitForTimeout(400);
  await goView(p, 'month');
  // 왼쪽 캘린더 목록: '메모 일정'을 끄면 달력에서 사라지고, 켜면 돌아옴
  const chips = () => p.$$eval('.cell.today .chip:not(.spacer)', (x) => x.map((i) => i.textContent).join(' '));
  check('왼쪽 캘린더 목록 창', (await p.isVisible('#cal-side')) && (await p.$$('.mini-day')).length >= 28);
  await p.click('.cal-row >> text=메모 일정');
  await p.waitForTimeout(200);
  const off = await chips();
  await p.click('.cal-row >> text=메모 일정');
  await p.waitForTimeout(200);
  check('캘린더 끄고 켜기', !off.includes('주간회의') && (await chips()).includes('주간회의'), off);
  check('달력 요약에 사진 설명', ((await p.textContent('.cell.today .digest')) || '').includes('화이트보드'));

  // 하루 화면 할 일 패널: 메모에 ☐ 줄을 치면 패널 목록도 바로 바뀜
  await p.click('.cell.today');
  await p.waitForTimeout(400);
  await p.evaluate(() => addPage('text'));
  await p.click('#text-page');
  await p.keyboard.type('☐ 패널에 보일 일');
  await p.waitForTimeout(500);
  check('타자로 친 할 일이 할 일 패널에 바로', ((await p.textContent('#day-todo-list')) || '').includes('패널에 보일 일'));
  await p.keyboard.type('\n☐ 오늘까지 보고서 제출');
  await p.waitForTimeout(400);
  await p.click('#back-btn');
  await p.waitForTimeout(500);
  await goView(p, 'month');
  await p.waitForTimeout(300);
  const dueText = (await p.isVisible('#due-bar')) ? await p.textContent('#due-open') : '';
  check('달력 위 오늘 마감 알림 줄', dueText.includes('오늘 마감'), dueText);
  await p.click('#due-open');
  await p.waitForTimeout(400);
  check('알림 줄 누르면 할 일 보기', await p.isVisible('#todo-view'));
  await goView(p, 'month');
  await p.click('#due-close');
  check('× 누르면 오늘은 숨김', !(await p.isVisible('#due-bar')));

  // 6-1 달력 제목 눌러 날짜 바로 이동
  await p.click('#month-title');
  await p.waitForTimeout(200);
  check('날짜 바로 이동 창 열기', (await p.isVisible('#modal')) && (await p.$$('.jump-months button')).length === 12);
  await p.click('#modal-close');
  await p.waitForTimeout(100);

  // 6-2 하루 패널 할 일 추가 & 메모 일정 수정 & 6-3 탭 이름 바꾸기·순서 이동
  await p.click('.cell.today');
  await p.waitForTimeout(400);
  await p.click('#panel-toggle');
  await p.waitForTimeout(200);
  await p.fill('#day-todo-input', '패널에서 추가한 할 일');
  await p.click('#day-todo-submit');
  await p.waitForTimeout(200);
  const dayTodosTxt = await p.textContent('#day-todo-list');
  check('하루 왼쪽 패널에서 할 일 추가', dayTodosTxt.includes('패널에서 추가한 할 일'), dayTodosTxt);
  await p.evaluate(() => { const d = document.querySelector('#day-events-details'); if (d) { d.classList.remove('hidden'); d.open = true; } });
  await p.waitForTimeout(100);
  await p.click('#event-list li.editable');
  await p.waitForTimeout(150);
  check('메모 일정 수정 모드', (await p.textContent('#ev-submit')) === '저장' && (await p.inputValue('#ev-title')) === '주간회의');
  await p.fill('#ev-title', '주간회의(수정)');
  await p.click('#ev-submit');
  await p.waitForTimeout(300);
  const editedTitle = await p.textContent('#event-list .ev-title');
  check('메모 일정 수정 반영', editedTitle === '주간회의(수정)', editedTitle);

  await p.evaluate(() => { pad.doc.pages[0].title = '중요메모'; renderTabs(); saveSoon(); });
  const tabName = await p.textContent('.page-tab .page-tab-label');
  check('탭 이름 직접 지정', tabName === '중요메모', tabName);

  // 6-4 주간 보기 지금 시각 줄 & 완료한 할 일 정리 & 개인 용어집
  await p.click('#back-btn');
  await p.waitForTimeout(300);

  await p.click('#settings-btn');
  await p.waitForTimeout(200);
  const storageTxt = await p.textContent('#storage-info');
  check('설정 저장 용량 안내', storageTxt.includes('저장된 메모'), storageTxt);
  await p.click('#open-glossary');
  await p.waitForTimeout(200);
  await p.fill('#modal-body input', '홍길동, AI프로젝트');
  await p.click('#modal-body button[type=submit]');
  await p.waitForTimeout(200);
  const glossWords = await p.evaluate(() => glossary.words());
  check('개인 용어집 추가', glossWords.includes('홍길동') && glossWords.includes('AI프로젝트'), glossWords.join(','));
  await p.click('#modal-close');

  // 목표: 목표 화면에서 적기, 버킷리스트 이루기, 못 끝낸 목표 옮기기, 달력 위 한 줄, 하루 화면 사다리
  await p.evaluate(() => $('#settings').classList.add('hidden'));
  await goView(p, 'goals');
  await p.waitForTimeout(100);
  check('목표 화면 네 단계', (await p.$$('#goals-view .goal-sec')).length === 4 && (await p.textContent('#month-title')) === '목표');
  const addGoal = async (scope, level, text) => {
    await p.fill(`${scope} .goal-sec[data-level=${level}] .goal-add-input`, text);
    await p.press(`${scope} .goal-sec[data-level=${level}] .goal-add-input`, 'Enter');
    await p.waitForTimeout(50);
  };
  await addGoal('#goals-view', 'bucket', '오로라 보기');
  await addGoal('#goals-view', 'bucket', '바다 수영');
  check('목표 추가 뒤 입력칸에 커서 유지', await p.evaluate(() => document.activeElement.matches('.goal-sec[data-level=bucket] .goal-add-input')));
  await addGoal('#goals-view', 'year', '올해 목표A');
  await addGoal('#goals-view', 'month', '이달 목표A');
  await addGoal('#goals-view', 'week', '이번주 목표A');
  await addGoal('#goals-view', 'week', '이번주 목표B');
  check('버킷리스트 2개 저장', (await p.$$('#goals-view .goal-sec[data-level=bucket] .goal-item')).length === 2);

  await p.click('#goals-view .goal-sec[data-level=bucket] .goal-item:has-text("바다 수영") input[type=checkbox]');
  await p.waitForTimeout(50);
  const bucketTxt = await p.textContent('#goals-view .goal-sec[data-level=bucket]');
  const doneAt = await p.textContent('#goals-view .goal-sec[data-level=bucket] .goal-done-at');
  check('이룬 것으로 옮겨 가고 달성일 표시', bucketTxt.includes('이룬 것 1') && /^\d{4}\.\d+\.\d+$/.test(doneAt), doneAt);

  // 지난주 목표는 이번 주로 옮길 수 있음
  const weekNow = await p.evaluate(() => { goals.add('week', goalPeriod('week', addDays(new Date(), -7)), '지난주 남은 일'); goalsChanged(); return goalPeriod('week', new Date()); });
  await p.click('#goals-view .goal-item:has-text("지난주 남은 일") .goal-move');
  await p.waitForTimeout(50);
  const movedPeriod = await p.evaluate(() => goals.live().map(([, g]) => g).find((g) => g.title === '지난주 남은 일').period);
  check('지난주 목표를 이번 주로 옮기기', movedPeriod === weekNow, movedPeriod);

  // 글 고치기, 지우고 되돌리기
  await p.click('#goals-view .goal-title:has-text("이번주 목표B")');
  await p.fill('#goals-view .goal-edit', '이번주 목표B2');
  await p.press('#goals-view .goal-edit', 'Enter');
  await p.waitForTimeout(50);
  check('목표 글 고치기', (await p.textContent('#goals-view .goal-sec[data-level=week]')).includes('이번주 목표B2'));
  await p.click('#goals-view .goal-item:has-text("이번주 목표B2") .goal-del');
  await p.waitForTimeout(50);
  const afterDel = await p.textContent('#goals-view .goal-sec[data-level=week]');
  await p.click('#toast-action');
  await p.waitForTimeout(50);
  check('목표 지우고 되돌리기', !afterDel.includes('이번주 목표B2') && (await p.textContent('#goals-view .goal-sec[data-level=week]')).includes('이번주 목표B2'));

  // 달력·주간 위 한 줄
  await goView(p, 'month');
  await p.waitForTimeout(100);
  const monthBar = await p.textContent('#goal-bar');
  check('달력 위 월간 목표', monthBar.includes('이달 목표A'), monthBar);
  await goView(p, 'week');
  await p.waitForTimeout(100);
  const weekBar = await p.textContent('#goal-bar');
  check('주간 위 주간 목표', weekBar.includes('이번주 목표A') && weekBar.includes('외 2'), weekBar);
  await goView(p, 'month');
  await p.waitForTimeout(100);

  // 하루 화면: 왼쪽 패널에 네 단계, 패널을 닫으면 위쪽 한 줄
  const todayYmd = await p.evaluate(() => ymd(new Date()));
  await p.evaluate((d) => openDay(d), todayYmd);
  await p.waitForTimeout(300);
  await p.evaluate(() => setPanel(true));
  const panelTxt = await p.textContent('#goal-panel');
  check('할 일 패널 위 사다리 네 단계', (await p.$$('#goal-panel .goal-row')).length === 4 && panelTxt.includes('오로라 보기') && panelTxt.includes('올해 목표A') && panelTxt.includes('이달 목표A') && panelTxt.includes('이번주 목표A'), panelTxt);
  check('패널이 열리면 위쪽 줄은 숨김', await p.evaluate(() => $('#goal-line').classList.contains('hidden')));
  await p.evaluate(() => setPanel(false));
  const lineTxt = await p.textContent('#goal-line');
  check('패널을 닫으면 위쪽 한 줄', (await p.isVisible('#goal-line')) && lineTxt.includes('이번주 목표A') && (await p.$$('#goal-line .goal-row')).length === 1, lineTxt);
  await p.click('#goal-line .goal-toggle');
  check('위쪽 줄 펼치면 네 단계', (await p.$$('#goal-line .goal-row')).length === 4);
  await p.click('#goal-line .goal-row[data-level=month] .goal-row-open');
  await p.waitForTimeout(50);
  await addGoal('#modal-body', 'month', '창에서 쓴 월 목표');
  check('하루 화면을 떠나지 않고 창에서 목표 추가', (await p.textContent('#goal-line')).includes('외 1') && await p.evaluate(() => state.view === 'day'));
  await p.click('#modal-body .goal-item:has-text("창에서 쓴 월 목표") .goal-del');
  await p.waitForTimeout(50);
  await p.click('#toast-action', { timeout: 3000 });
  await p.waitForTimeout(50);
  check('창 안에서 지워도 되돌리기를 누를 수 있음', (await p.textContent('#modal-body')).includes('창에서 쓴 월 목표'));
  await p.click('#modal-close');

  // 다음 주 날짜를 열면 그 주 목표가 보임
  await p.evaluate(() => openDay(ymd(addDays(new Date(), 7))));
  await p.waitForTimeout(300);
  const nextWeekRow = await p.textContent('#goal-line .goal-row[data-level=week]');
  check('열어 둔 날짜 기준 목표', nextWeekRow.includes('다음 주') && !nextWeekRow.includes('이번주 목표A'), nextWeekRow);
  await p.click('#goal-line .goal-toggle');
  await p.click('#back-btn');
  await p.waitForTimeout(200);

  // 전체 검색에 목표가 나오고, 누르면 그 기간의 목표 창
  await p.click('#search-btn');
  await p.fill('#search-input', '오로라');
  await p.waitForTimeout(500);
  const goalHit = await p.$$eval('#search-results .search-goal', (x) => x.map((i) => i.textContent));
  check('전체 검색에 목표 포함', goalHit.length === 1 && goalHit[0].includes('오로라 보기') && goalHit[0].includes('버킷'), goalHit.join(' | '));
  await p.click('#search-results .search-goal');
  await p.waitForTimeout(100);
  check('검색한 목표를 누르면 목표 창', (await p.isVisible('#modal')) && (await p.textContent('#modal-body')).includes('오로라 보기') && !(await p.isVisible('#search-ov')));
  await p.click('#modal-close');

  check('백업에 목표 포함', await p.evaluate(async () => Object.keys((await backup.build()).goals).length >= 6));
  await p.reload();
  await p.waitForSelector('.cell');
  check('새로고침 뒤 목표 유지', await p.evaluate(() => goals.list('bucket').length === 2 && goals.get(goals.list('bucket')[1].id).doneAt > 0));
  await ctx.close();

  // 휴대폰: 아래 탭 5개가 화면 안에 들어오고 목표 화면이 옆으로 넘치지 않음
  const phone = await browser.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: 'block' });
  const q = await phone.newPage();
  q.on('pageerror', (e) => errors.push(e.message));
  await q.route(/config\.js/, (r) => r.fulfill({ contentType: 'text/javascript', body: "window.APP_CONFIG={GOOGLE_CLIENT_ID:''}" }));
  await q.route('https://accounts.google.com/**', (r) => r.fulfill({ body: '' }));
  await q.addInitScript(() => { localStorage.setItem('onboarded', 'true'); localStorage.setItem('installHintClosed', 'true'); });
  await q.goto(base);
  await q.waitForSelector('.cell');
  await q.click('#bottom-tabs [data-view=goals]');
  await q.waitForTimeout(100);
  const fit = await q.evaluate(() => ({ tabs: document.querySelectorAll('#bottom-tabs button').length, over: document.documentElement.scrollWidth - innerWidth, inner: $('#goals-view').scrollWidth - $('#goals-view').clientWidth }));
  check('휴대폰 탭 5개·옆으로 안 넘침', fit.tabs === 5 && fit.over <= 0 && fit.inner <= 0, JSON.stringify(fit));
  await phone.close();

  // 왼쪽 메뉴·상단 월주: 넓은 화면
  const sideCtx = await browser.newContext({ viewport: { width: 1180, height: 820 }, serviceWorkers: 'block' });
  const s = await sideCtx.newPage();
  s.on('pageerror', (e) => errors.push(e.message));
  await s.route(/config\.js/, (r) => r.fulfill({ contentType: 'text/javascript', body: "window.APP_CONFIG={GOOGLE_CLIENT_ID:''}" }));
  await s.route('https://accounts.google.com/**', (r) => r.fulfill({ body: '' }));
  await s.addInitScript(() => { localStorage.setItem('onboarded', 'true'); localStorage.setItem('installHintClosed', 'true'); });
  await s.goto(base);
  await s.waitForSelector('.cell');
  check('상단에는 월·주만', (await s.$$('#view-seg button')).length === 2 && (await s.isVisible('#view-seg')) && !(await s.isVisible('#bottom-tabs')));
  check('사이드 메뉴 네 개', (await s.$$('#side-nav button')).length === 4 && (await s.getAttribute('#side-nav [data-nav=cal]', 'aria-current')) === 'page');
  await s.click('#view-seg [data-view=week]');
  await s.click('#side-nav [data-nav=goals]');
  await s.waitForTimeout(100);
  const statsBadges = await s.$$eval('.goal-stat-badge', (bs) => bs.length);
  check('목표 화면 통계 배지 바 4개', statsBadges === 4);
  check('목표 화면은 월·주와 캘린더 목록 숨김', (await s.isVisible('#goals-view')) && !(await s.isVisible('#view-seg')) && !(await s.isVisible('#cal-filter')) && (await s.isVisible('.mini-cal')));
  await s.click('#side-nav [data-nav=cal]');
  await s.waitForTimeout(100);
  check('달력으로 돌아오면 보던 주간 보기', (await s.isVisible('#week-grid')) && (await s.isVisible('#cal-filter')));
  await s.click('#side-btn');
  const rail = await s.evaluate(() => ({ w: $('#cal-side').getBoundingClientRect().width, mini: !!$('.mini-cal').offsetParent, label: !!$('.side-nav-label').offsetParent, btn: !!$('#side-nav [data-nav=todo]').offsetParent }));
  check('닫으면 아이콘 줄만 남음', rail.w < 70 && !rail.mini && !rail.label && rail.btn, JSON.stringify(rail));
  await s.click('#side-nav [data-nav=todo]');
  await s.waitForTimeout(100);
  check('아이콘 줄에서 바로 이동', await s.isVisible('#todo-view'));
  await s.evaluate(() => openDay(ymd(new Date())));
  await s.waitForTimeout(300);
  await s.click('#text-page');
  await s.keyboard.type('☐ 오늘까지 보고서');
  await s.waitForTimeout(500);
  await s.click('#back-btn');
  await s.waitForTimeout(400);
  const badge = await s.evaluate(() => { const b = $('#side-todo-badge'); return { text: b.textContent, over: b.classList.contains('over'), on: !!b.offsetParent }; });
  check('할 일 마감 개수 표시', badge.text === '1' && badge.on, JSON.stringify(badge));
  await s.click('#side-btn');
  await s.evaluate(() => openDay(ymd(new Date())));
  await s.waitForTimeout(300);
  check('하루 화면에서는 메뉴·월주 숨김', !(await s.isVisible('#cal-side')) && !(await s.isVisible('#view-seg')));
  await s.evaluate(() => openInkTab());
  await s.waitForSelector('#pen-presets');
  const presetsCount = await s.$$eval('.preset-btn', (bs) => bs.length);
  check('펜 즐겨찾기 프리셋 4개', presetsCount === 4);
  await s.click('.preset-btn[data-preset-idx="1"]');
  const isBlue = await s.evaluate(() => pad.colors.pen === '#2563eb' && pad.tool === 'pen');
  check('펜 프리셋 선택으로 파랑펜 전환', isBlue);
  await sideCtx.close();

  // 폴드 펼침: 아래 탭, 상단 월·주와 사이드 메뉴 없음
  const foldCtx = await browser.newContext({ viewport: { width: 884, height: 1028 }, serviceWorkers: 'block' });
  const f = await foldCtx.newPage();
  f.on('pageerror', (e) => errors.push(e.message));
  await f.route(/config\.js/, (r) => r.fulfill({ contentType: 'text/javascript', body: "window.APP_CONFIG={GOOGLE_CLIENT_ID:''}" }));
  await f.route('https://accounts.google.com/**', (r) => r.fulfill({ body: '' }));
  await f.addInitScript(() => { localStorage.setItem('onboarded', 'true'); localStorage.setItem('installHintClosed', 'true'); });
  await f.goto(base);
  await f.waitForSelector('.cell');
  check('폴드 펼침은 아래 탭', (await f.isVisible('#bottom-tabs')) && !(await f.isVisible('#view-seg')) && !(await f.isVisible('#side-nav')));
  await f.click('#bottom-tabs [data-view=goals]');
  await f.waitForTimeout(100);
  check('폴드 펼침 아래 탭으로 이동', await f.isVisible('#goals-view'));
  await foldCtx.close();

  // 주간 보기 지금 시각 줄: 시간표 범위(기본 8~21시) 안에서만 그려지므로 낮 12시로 고정해서 확인.
  // 가짜 시계는 토스트 타이머까지 흔들 수 있어 다른 시험과 섞이지 않게 따로 띄움
  const noonCtx = await browser.newContext({ viewport: { width: 1180, height: 820 }, serviceWorkers: 'block' });
  const n = await noonCtx.newPage();
  n.on('pageerror', (e) => errors.push(e.message));
  await n.route(/config\.js/, (r) => r.fulfill({ contentType: 'text/javascript', body: "window.APP_CONFIG={GOOGLE_CLIENT_ID:''}" }));
  await n.route('https://accounts.google.com/**', (r) => r.fulfill({ body: '' }));
  await n.addInitScript(() => { localStorage.setItem('onboarded', 'true'); localStorage.setItem('installHintClosed', 'true'); });
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  await n.clock.setFixedTime(noon);
  await n.goto(base);
  await n.waitForSelector('.cell');
  await goView(n, 'week');
  await n.waitForTimeout(200);
  check('주간 보기 지금 시각 줄', (await n.$$('.wtime-now')).length === 1);
  await n.click('.wtime-hour');
  const menuOpened = await n.waitForSelector('#pop-menu:not(.hidden)', { timeout: 1000 }).then(() => true).catch(() => false);
  check('주간 시간표 시간 클릭 시 메뉴 열림', menuOpened);
  await noonCtx.close();

  // 외부 캘린더 구독 주소 모달 테스트
  const feedCtx = await browser.newContext({ viewport: { width: 1180, height: 820 }, serviceWorkers: 'block' });
  const fp = await feedCtx.newPage();
  fp.on('pageerror', (e) => errors.push(e.message));
  await fp.route(/config\.js/, (r) => r.fulfill({ contentType: 'text/javascript', body: "window.APP_CONFIG={GOOGLE_CLIENT_ID:'mock-id',WORKER_URL:'https://worker.test'}" }));
  await fp.route('https://accounts.google.com/**', (r) => r.fulfill({ body: '' }));
  // 실제 구글·서버에 닿지 않게 모두 가짜 응답 (실서버 응답 속도에 따라 로그인이 풀려 시험이 멈추던 문제 방지)
  await fp.route(/googleapis.com/, (r) => r.fulfill({ contentType: 'application/json', body: '{"files":[],"items":[]}' }));
  await fp.route('https://worker.test/**', (r) => r.fulfill({ contentType: 'application/json', body: '{"events":[],"calendars":[]}' }));
  let mockToken = null;
  await fp.route('https://worker.test/feed/token', (r) => {
    if (r.request().method() === 'POST') {
      mockToken = 'feed-uuid-5678';
      return r.fulfill({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: mockToken }) });
    }
    return r.fulfill({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: mockToken }) });
  });
  await fp.addInitScript(() => {
    localStorage.setItem('onboarded', 'true');
    localStorage.setItem('auth', JSON.stringify({ token: 'mock-auth', expires: Date.now() + 3600000 }));
    localStorage.setItem('refresh', JSON.stringify('mock-refresh-token'));
  });
  await fp.goto(base);
  await fp.waitForSelector('.cell');
  await fp.click('#settings-btn');
  await fp.waitForSelector('#open-feed');
  await fp.click('#open-feed');
  await fp.waitForSelector('.feed-wrap');
  check('외부 구독 모달 열림', (await fp.$('.feed-wrap')) !== null);
  await fp.click('.feed-wrap .pill.primary');
  await fp.waitForSelector('.feed-input');
  const feedInputs = await fp.$$eval('.feed-input', (els) => els.map((e) => e.value));
  check('구독 URL 3종 생성 및 토큰 포함', feedInputs.length === 3 && feedInputs.every((u) => u.includes('token=feed-uuid-5678') && (u.includes('all.ics') || u.includes('memos.ics') || u.includes('tasks.ics'))), feedInputs[0]);
  await feedCtx.close();

  // 가변형 셀 할 일·메모 2~3개 표현 및 기존 일정 우선 검증
  const cellCtx = await browser.newContext({ viewport: { width: 1180, height: 820 }, serviceWorkers: 'block' });
  const cp = await cellCtx.newPage();
  cp.on('pageerror', (e) => errors.push(e.message));
  await cp.route(/config\.js/, (r) => r.fulfill({ contentType: 'text/javascript', body: "window.APP_CONFIG={GOOGLE_CLIENT_ID:''}" }));
  await cp.route('https://accounts.google.com/**', (r) => r.fulfill({ body: '' }));
  await cp.addInitScript(() => {
    localStorage.setItem('onboarded', 'true');
    localStorage.setItem('installHintClosed', 'true');
  });
  await cp.goto(base);
  await cp.waitForSelector('.cell');

  // 1. 특정 날짜에 여러 개의 할 일과 메모 작성
  const testDate = await cp.evaluate(async () => {
    const d = new Date();
    d.setDate(d.getDate() + 2); // 이틀 뒤
    const ds = ymd(d);
    const doc = {
      v: 2,
      pages: [{
        id: 'p_test',
        kind: 'text',
        text: '☐ 장보기\n☐ 견적서 검토\n업체 미팅 진행',
        strokes: [],
      }],
      updated: Date.now(),
    };
    await notes.put(ds, doc);
    renderMonth();
    return ds;
  });

  await cp.waitForTimeout(300);
  const items = await cp.$$eval(`.cell[data-date="${testDate}"] .digest-item`, (els) => els.map((e) => e.textContent.trim()));
  check('달력 셀에 할 일·메모 가변형 2~3개 표현', items.length >= 2 && items.some((t) => t.includes('장보기')) && items.some((t) => t.includes('견적서 검토')), JSON.stringify(items));
  check('할 일 체크박스 표시 포함', items.some((t) => t.startsWith('☐')));

  // 2. 기존 일정(메모 일정) 추가 시 일정 우선 표시 확인
  const chipCount = await cp.evaluate((ds) => {
    memos.add({
      title: '현장 실사',
      allDay: true,
      start: new Date(ds + 'T00:00:00Z'),
      end: new Date(ds + 'T23:59:59Z'),
    });
    renderMonth();
    const cell = document.querySelector(`.cell[data-date="${ds}"]`);
    return cell ? cell.querySelectorAll('.chip:not(.spacer)').length : 0;
  }, testDate);

  check('기존 일정 우선 표시 (칩 렌더링)', chipCount >= 1);
  const itemsWithChip = await cp.$$eval(`.cell[data-date="${testDate}"] .digest-item`, (els) => els.map((e) => e.textContent.trim()));
  check('일정 칩이 있어도 남은 공간에 할 일 표시 유지', itemsWithChip.length >= 1, JSON.stringify(itemsWithChip));

  await cellCtx.close();
} finally {
  await browser.close();
  server.close();
}
for (const e of errors) console.log('✗ 페이지 오류:', e);
const failed = results.filter((r) => !r).length + errors.length;
console.log(failed ? `\n실패 ${failed}개` : `\n모두 통과 (${results.length}개)`);
process.exit(failed ? 1 : 0);
