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
  await p.click('[data-view=todo] >> visible=true');
  await p.waitForTimeout(600);
  check('할 일 기한순 묶음', (await p.$$eval('#todo-items .todo-date', (x) => x.map((i) => i.textContent))).some((t) => t.startsWith('내일')));
  await p.click('[data-view=week] >> visible=true');
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
  await p.click('[data-view=month] >> visible=true');
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

  // 6-1 달력 제목 눌러 날짜 바로 이동
  await p.click('#month-title');
  await p.waitForTimeout(200);
  check('날짜 바로 이동 창 열기', (await p.isVisible('#modal')) && (await p.$$('.jump-months button')).length === 12);
  await p.click('#modal-close');
  await p.waitForTimeout(100);

  // 6-2 메모 일정 수정 & 6-3 탭 이름 바꾸기·순서 이동
  await p.click('.cell.today');
  await p.waitForTimeout(400);
  await p.click('#panel-toggle');
  await p.waitForTimeout(200);
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
  await p.click('[data-view=week] >> visible=true');
  await p.waitForTimeout(200);
  check('주간 보기 지금 시각 줄', (await p.$$('.wtime-now')).length === 1);

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
  await ctx.close();
} finally {
  await browser.close();
  server.close();
}
for (const e of errors) console.log('✗ 페이지 오류:', e);
const failed = results.filter((r) => !r).length + errors.length;
console.log(failed ? `\n실패 ${failed}개` : `\n모두 통과 (${results.length}개)`);
process.exit(failed ? 1 : 0);
