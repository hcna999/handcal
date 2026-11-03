// 화면 조작 확인: Esc, 탭 삭제·되돌리기·휴지통, 첫 실행 안내, 날짜 길게 누르기, ＋, 아래 탭 바
// 사용: node tests/ux.mjs [스크린샷 폴더]   (오류가 있으면 종료 코드 1)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const shots = process.argv[2];
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
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };
const errors = [];

async function newPage(browser, viewport, { onboarded = true, touch = false } = {}) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block', hasTouch: touch, isMobile: touch });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  await p.route(/config\.js/, (r) => r.fulfill({ contentType: 'text/javascript', body: "window.APP_CONFIG={GOOGLE_CLIENT_ID:''}" }));
  await p.route('https://accounts.google.com/**', (r) => r.fulfill({ body: '' }));
  await p.addInitScript((ob) => {
    localStorage.setItem('installHintClosed', 'true');
    if (ob) localStorage.setItem('onboarded', 'true');
  }, onboarded);
  await p.goto(base);
  await p.waitForSelector('.cell');
  return { p, ctx };
}

const browser = await chromium.launch();
try {
  // 첫 실행 안내
  {
    const { p, ctx } = await newPage(browser, { width: 1180, height: 820 }, { onboarded: false });
    check('첫 실행 안내가 뜸', await p.isVisible('#onboard'));
    for (let i = 0; i < 4; i++) await p.click('#onboard-next');
    check('안내 끝나면 닫힘', !(await p.isVisible('#onboard')));
    await ctx.close();
  }
  // Esc는 메뉴만 닫음
  {
    const { p, ctx } = await newPage(browser, { width: 1180, height: 820 });
    await p.click('.cell.today');
    await p.waitForTimeout(400);
    await p.click('#settings-btn');
    await p.keyboard.press('Escape');
    check('Esc: 설정만 닫히고 하루 화면 유지', !(await p.isVisible('#settings')) && (await p.evaluate(() => state.view)) === 'day');
    await p.keyboard.press('Escape');
    check('Esc 한 번 더: 달력으로', (await p.evaluate(() => state.view)) === 'month');

    // 글이 있는 타자 탭 삭제 → 확인 + 되돌리기 + 휴지통
    await p.click('.cell.today');
    await p.waitForTimeout(400);
    await p.click('#text-page');
    await p.keyboard.type('지우면 안 되는 메모');
    await p.click('.page-tab.add');
    await p.waitForTimeout(200);
    await p.click('.page-tab >> nth=0');
    await p.waitForTimeout(200);
    await p.click('.page-tab.active .page-tab-x');
    await p.waitForTimeout(300);
    check('탭 삭제 후 되돌리기 버튼', await p.isVisible('#toast-action'));
    check('휴지통에 들어감', (await p.evaluate(() => trash.list().length)) === 1);
    await p.click('#toast-action');
    await p.waitForTimeout(300);
    check('되돌리기로 탭이 돌아옴', await p.evaluate(() => pad.doc.pages.some((x) => (x.text || '').includes('지우면 안 되는'))));
    if (shots) await p.screenshot({ path: `${shots}/ux-day-ipad.png` });
    await ctx.close();
  }
  // 휴대폰: 아래 탭 바, ＋, 날짜 길게 누르기
  {
    const { p, ctx } = await newPage(browser, { width: 412, height: 915 }, { touch: true });
    check('휴대폰 아래 탭 바', await p.isVisible('#bottom-tabs'));
    check('휴대폰 상단 제목이 잘리지 않음', await p.$eval('#month-title', (h) => h.scrollWidth <= h.clientWidth + 1), await p.textContent('#month-title'));
    if (shots) await p.screenshot({ path: `${shots}/ux-month-phone.png` });
    // 날짜 길게 누르기 → 할 일 추가
    const cell = await p.$('.cell.today');
    const b = await cell.boundingBox();
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await p.mouse.down();
    await p.waitForTimeout(650);
    await p.mouse.up();
    check('날짜 길게 누르기 메뉴', await p.isVisible('#pop-menu'));
    if (shots) await p.screenshot({ path: `${shots}/ux-longpress-phone.png` });
    await p.click('.pop-item >> text=할 일 추가');
    await p.fill('.pop-input input', '견적서 보내기');
    await p.press('.pop-input input', 'Enter');
    await p.waitForTimeout(500);
    check('길게 눌러 넣은 할 일이 달력에 보임', ((await p.textContent('.cell.today .digest')) || '').includes('견적서'));
    check('길게 누른 뒤 날짜가 열리지 않음', (await p.evaluate(() => state.view)) === 'month');
    // ＋ → 오늘 메모
    await p.click('#fab');
    await p.waitForTimeout(500);
    check('＋는 오늘 메모를 엶', (await p.evaluate(() => state.view + ' ' + (state.date === ymd(new Date())))) === 'day true');
    check('하루 화면에서는 아래 탭 바 숨김', !(await p.isVisible('#bottom-tabs')));
    if (shots) await p.screenshot({ path: `${shots}/ux-day-phone.png` });
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
for (const e of errors) console.log('✗ 페이지 오류:', e);
const failed = results.filter((r) => !r).length + errors.length;
console.log(failed ? `\n실패 ${failed}개` : `\n모두 통과 (${results.length}개)`);
process.exit(failed ? 1 : 0);
