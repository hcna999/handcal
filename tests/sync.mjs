// 동기화·안정성 확인: 두 기기 수정 합치기(충돌 사본), 색인 파일, 오프라인 표시, 앱 잠금
// 구글 드라이브는 가짜(메모리)로 흉내 냄.  사용: node tests/sync.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };
const errors = [];

// 가짜 구글 드라이브 (두 기기가 함께 씀)
const files = {};
let fid = 0;
const bump = () => new Date(Date.now() + ++fid * 1000).toISOString();
async function fakeDrive(p) {
  await p.route('https://www.googleapis.com/**', async (r) => {
    const req = r.request();
    const u = new URL(req.url());
    const J = (o) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(o) });
    const meta = (id) => ({ id, name: files[id].name, modifiedTime: files[id].t });
    const id = u.pathname.split('/').pop();
    if (req.method() === 'GET' && u.pathname === '/drive/v3/files') {
      const q = u.searchParams.get('q');
      if (q.includes('folder')) return J({ files: [{ id: 'F' }] });
      const m = /name='([^']+)'/.exec(q);
      return J({ files: Object.keys(files).filter((k) => !m || files[k].name === m[1]).map(meta) });
    }
    if (req.method() === 'GET' && u.searchParams.get('fields') === 'modifiedTime') return J({ modifiedTime: files[id].t });
    if (req.method() === 'GET' && u.searchParams.get('alt') === 'media') return r.fulfill({ contentType: 'application/json', body: files[id].data });
    if (req.method() === 'POST') {
      const body = req.postData();
      const name = JSON.parse(body.split('\r\n\r\n')[1].split('\r\n')[0]).name;
      const nid = 'f' + Object.keys(files).length + '_' + Date.now();
      files[nid] = { name, data: body.split('\r\n\r\n')[2].split('\r\n--')[0], t: bump() };
      return J(meta(nid));
    }
    if (req.method() === 'PATCH') { files[id].data = req.postData(); files[id].t = bump(); return J(meta(id)); }
    if (req.method() === 'DELETE') { delete files[id]; return r.fulfill({ status: 204 }); }
    J({});
  });
}

async function device(browser, { signedIn = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  await p.route(/config\.js/, (r) => r.fulfill({ contentType: 'text/javascript', body: `window.APP_CONFIG={GOOGLE_CLIENT_ID:'${signedIn ? 'x' : ''}'}` }));
  await p.route('https://accounts.google.com/**', (r) => r.fulfill({ body: '' }));
  await p.route('https://tasks.googleapis.com/**', (r) => r.fulfill({ contentType: 'application/json', body: '{"items":[]}' }));
  await fakeDrive(p);
  await p.addInitScript((si) => {
    localStorage.setItem('onboarded', 'true');
    localStorage.setItem('gtasksOn', 'false');
    if (si) { localStorage.setItem('auth', JSON.stringify({ token: 't', expires: Date.now() + 3e6 })); localStorage.setItem('wasSignedIn', 'true'); }
  }, signedIn);
  await p.goto(base);
  await p.waitForSelector('.cell');
  await p.waitForTimeout(600);
  return { p, ctx };
}

const browser = await chromium.launch();
const today = new Date();
const ds = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
try {
  // 기기 A: 메모를 쓰고 올림
  const A = await device(browser);
  await A.p.click('.cell.today');
  await A.p.waitForTimeout(400);
  await A.p.click('#text-page');
  await A.p.keyboard.type('A에서 쓴 메모');
  await A.p.click('#back-btn');
  await A.p.waitForTimeout(2500);
  const docFile = () => Object.values(files).find((f) => f.name === ds + '.json');
  check('기기 A 메모가 드라이브에', !!docFile() && JSON.parse(docFile().data).pages[0].text === 'A에서 쓴 메모');
  check('색인 파일(index.json)도 올라감', !!Object.values(files).find((f) => f.name === 'index.json'));

  // 기기 B: 내려받아 같은 탭을 고치고, 새 탭도 하나 추가
  const B = await device(browser);
  await B.p.click('.cell.today');
  await B.p.waitForTimeout(600);
  check('기기 B가 A의 메모를 받음', (await B.p.inputValue('#text-page')) === 'A에서 쓴 메모');
  await B.p.click('#text-page');
  await B.p.keyboard.press('End');
  await B.p.keyboard.type(' + B가 덧붙임');
  await B.p.click('.page-tab.add');
  await B.p.keyboard.type('B의 새 탭');
  await B.p.click('#back-btn');
  await B.p.waitForTimeout(2500);

  // 기기 A: (B를 모른 채) 같은 탭을 고치고 새 탭 추가 → 올릴 때 합쳐져야 함
  await A.p.click('.cell.today');
  await A.p.waitForTimeout(400);
  await A.p.click('#text-page');
  await A.p.keyboard.press('End');
  await A.p.keyboard.type(' + A가 또 고침');
  await A.p.click('.page-tab.add');
  await A.p.keyboard.type('A의 새 탭');
  await A.p.click('#back-btn');
  await A.p.waitForTimeout(3000);
  const merged = JSON.parse(docFile().data).pages.map((x) => x.text);
  check('양쪽 새 탭이 모두 남음', merged.includes('B의 새 탭') && merged.includes('A의 새 탭'), merged.join(' | '));
  check('같은 탭을 둘 다 고치면 충돌 사본으로 보존', merged.some((t) => t.includes('A가 또 고침')) && merged.some((t) => t.includes('B가 덧붙임')));
  await A.ctx.close();
  await B.ctx.close();

  // 오프라인 표시
  const C = await device(browser, { signedIn: false });
  await C.ctx.setOffline(true);
  await C.p.evaluate(() => window.dispatchEvent(new Event('offline')));
  await C.p.waitForTimeout(200);
  check('오프라인이면 안내 막대', await C.p.isVisible('#offline-bar'));
  await C.ctx.setOffline(false);
  await C.p.evaluate(() => window.dispatchEvent(new Event('online')));
  await C.p.waitForTimeout(300);
  check('다시 연결되면 막대 사라짐', !(await C.p.isVisible('#offline-bar')));

  // 앱 잠금
  await C.p.click('#settings-btn');
  await C.p.click('#open-lock');
  const pins = await C.p.$$('.lock-form input[type=password]');
  await pins[0].fill('2468');
  await pins[1].fill('2468');
  await C.p.click('.lock-form .pill.primary');
  await C.p.reload();
  await C.p.waitForSelector('.cell');
  check('다시 열면 잠금 화면', await C.p.isVisible('#lock'));
  for (const k of '1111') await C.p.click(`.lock-key >> text="${k}"`);
  check('틀린 번호는 안 열림', await C.p.isVisible('#lock'));
  for (const k of '2468') await C.p.click(`.lock-key >> text="${k}"`);
  check('맞는 번호로 열림', !(await C.p.isVisible('#lock')));
  await C.ctx.close();

  // 네이버 일정 빠르게: 앞뒤 달 미리 받기, 기기에 저장해 다시 열 때 바로 보임 (중계 서버는 1.2초 늦게 응답)
  {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, serviceWorkers: 'block' });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    const H = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    await p.route(/config\.js/, (r) => r.fulfill({ contentType: 'text/javascript', body: "window.APP_CONFIG={GOOGLE_CLIENT_ID:'x',WORKER_URL:'https://w.test'}" }));
    await p.route('https://accounts.google.com/**', (r) => r.fulfill({ body: '' }));
    await p.route('https://tasks.googleapis.com/**', (r) => r.fulfill({ contentType: 'application/json', body: '{"items":[]}' }));
    await fakeDrive(p);
    let calls = 0;
    const d2 = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    await p.route('https://w.test/**', async (r) => {
      if (r.request().method() === 'OPTIONS') return r.fulfill({ headers: H });
      calls++;
      const u = new URL(r.request().url());
      const evs = [];
      for (let d = new Date(u.searchParams.get('start')); d < new Date(u.searchParams.get('end')); d.setDate(d.getDate() + 1)) {
        if (d.getDate() !== 15) continue;
        const n = new Date(d); n.setDate(n.getDate() + 1);
        evs.push({ id: 'e' + d2(d), title: '보름 일정', allDay: true, start: d2(d), end: d2(n), calendar: '내 캘린더', color: '#3b82f6' });
      }
      await new Promise((x) => setTimeout(x, 1200));
      r.fulfill({ headers: H, contentType: 'application/json', body: JSON.stringify({ events: evs, calendars: [{ name: '내 캘린더', color: '#3b82f6' }] }) });
    });
    await p.addInitScript(() => {
      localStorage.setItem('onboarded', 'true');
      localStorage.setItem('gtasksOn', 'false');
      localStorage.setItem('auth', JSON.stringify({ token: 't', expires: Date.now() + 3e6 }));
      localStorage.setItem('wasSignedIn', 'true');
    });
    const chips = () => p.$$eval('#grid .chip:not(.spacer)', (x) => x.filter((c) => c.textContent === '보름 일정').length);
    await p.goto(base);
    await p.waitForSelector('#grid .chip:not(.spacer)', { timeout: 10000 });
    await p.waitForTimeout(2500); // 앞뒤 달 미리 받기
    const before = calls;
    let instant = true;
    for (const dir of ['#next-month', '#next-month', '#prev-month', '#prev-month', '#prev-month']) {
      await p.click(dir);
      await p.waitForTimeout(450);
      if (!(await chips())) instant = false;
      await p.waitForTimeout(1500);
    }
    check('달 넘기면 일정이 바로 보임(미리 받아 둠)', instant, `넘기는 동안 요청 ${calls - before}번`);
    await p.reload();
    await p.waitForSelector('.cell');
    await p.waitForTimeout(300);
    check('다시 열면 저장해 둔 일정이 바로 보임', (await chips()) > 0);
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
