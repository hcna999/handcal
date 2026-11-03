// 기본 동작 확인: 로컬 서버를 띄우고 구글 연결 없이(이 기기에만 저장) 주요 흐름을 브라우저로 돌려 봄
// 사용: npm i -D playwright && node tests/smoke.mjs   (오류가 있으면 종료 코드 1)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// 프로젝트에 설치했든 전역에 설치했든 찾도록 require로 불러옴
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

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };

const browser = await chromium.launch();
const errors = [];
try {
  for (const vp of [{ name: '아이패드', width: 1180, height: 820 }, { name: '폴드 접힘', width: 412, height: 915 }]) {
    const ctx = await browser.newContext({ viewport: vp, serviceWorkers: 'block' });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`${vp.name}: ${e.message}`));
    // 구글 연결 없이 시험
    await p.route(/config\.js/, (r) => r.fulfill({ contentType: 'text/javascript', body: "window.APP_CONFIG={GOOGLE_CLIENT_ID:''}" }));
    await p.route('https://accounts.google.com/**', (r) => r.fulfill({ body: '' }));
    // 첫 실행 안내·설치 안내는 건너뜀 (안내 자체는 따로 확인)
    await p.addInitScript(() => { localStorage.setItem('onboarded', 'true'); localStorage.setItem('installHintClosed', 'true'); });
    await p.goto(base);
    await p.waitForSelector('.cell');
    check(`[${vp.name}] 월간 달력`, (await p.$$('.cell')).length >= 28);

    // 오늘 열기 → 키보드 메모(기본) → 할 일
    await p.click('.cell.today');
    await p.waitForTimeout(400);
    check(`[${vp.name}] 새 날짜는 키보드 메모`, await p.evaluate(() => pad.note.kind === 'text'));
    await p.click('#text-page');
    await p.keyboard.type('회의 메모');
    await p.keyboard.press('Enter');
    await p.keyboard.type('[] 보고서 제출');
    await p.waitForTimeout(500);
    check(`[${vp.name}] [] → ☐ 할 일`, (await p.inputValue('#text-page')).includes('☐ 보고서 제출'));

    // 손글씨 탭으로 전환해서 마우스로 한 획
    await p.click('.kind-toggle');
    await p.waitForTimeout(300);
    const box = await p.$eval('#canvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y }; });
    await p.mouse.move(box.x + 60, box.y + 120);
    await p.mouse.down();
    await p.mouse.move(box.x + 200, box.y + 160, { steps: 8 });
    await p.mouse.up();
    check(`[${vp.name}] 손글씨 탭에 획 저장`, await p.evaluate(() => pad.note.strokes.length === 1));

    // 저장 뒤 달력·할 일 모아보기
    await p.click('#back-btn');
    await p.waitForTimeout(500);
    check(`[${vp.name}] 달력 칸 필기 표시`, !!(await p.$('.cell.today .ink')));
    await p.click('[data-view=todo] >> visible=true');
    await p.waitForTimeout(600);
    check(`[${vp.name}] 할 일 모아보기`, (await p.$$eval('#todo-items .todo-row', (r) => r.map((x) => x.textContent))).includes('보고서 제출'));
    await p.click('[data-view=week] >> visible=true');
    await p.waitForTimeout(400);
    check(`[${vp.name}] 주간 보기`, (await p.$$('.wcell')).length === 7);
    await p.click('[data-view=list] >> visible=true');
    await p.waitForTimeout(600);
    check(`[${vp.name}] 메모 모아보기`, (await p.$$('.list-item')).length >= 1);

    // 새로고침 뒤에도 남는지
    await p.reload();
    await p.waitForSelector('#list-items');
    await p.click('[data-view=month] >> visible=true');
    await p.click('.cell.today');
    await p.waitForTimeout(500);
    check(`[${vp.name}] 새로고침 뒤 탭 유지`, await p.evaluate(() => pad.doc.pages.length === 2));
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}

for (const e of errors) console.log('✗ 페이지 오류:', e);
const failed = results.filter((r) => !r.ok).length + errors.length;
console.log(failed ? `\n실패 ${failed}개` : `\n모두 통과 (${results.length}개)`);
process.exit(failed ? 1 : 0);
