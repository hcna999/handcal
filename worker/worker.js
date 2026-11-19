// 필기 캘린더 중계 서버 (Cloudflare Worker)
//  1) 구글 로그인 유지: 인증 코드 → 토큰 교환, 토큰 자동 갱신 (클라이언트 보안 비밀번호는 여기에만 보관)
//  2) 네이버 캘린더 읽기: CalDAV로 일정을 가져와 JSON으로 전달
//
// 환경 변수 (Cloudflare 대시보드 → Worker → 설정 → 변수 및 비밀)
//   ALLOWED_ORIGIN        https://hcna999.github.io
//   GOOGLE_CLIENT_ID      xxxx.apps.googleusercontent.com
//   GOOGLE_CLIENT_SECRET  (비밀) 구글 클라이언트 보안 비밀번호
//   OWNER_EMAIL           (비밀) 앱을 쓸 구글 계정 메일
//   NAVER_ID              (비밀) 네이버 아이디
//   NAVER_APP_PASSWORD    (비밀) 네이버 애플리케이션 비밀번호
//   NAVER_CALDAV_URL      (선택) 기본값 https://caldav.calendar.naver.com
//   TIMEZONE              (선택) 기본값 Asia/Seoul
//   CALENDAR_COLORS       (선택) {"캘린더 이름":"#a48ce0"} 형식으로 캘린더 색 직접 지정

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Inbox-Token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(req.url);
    try {
      let body;
      if (url.pathname === '/auth/exchange' && req.method === 'POST') body = await exchange(env, await req.json());
      else if (url.pathname === '/auth/refresh' && req.method === 'POST') body = await refresh(env, await req.json());
      else if (url.pathname === '/feed/token' && req.method === 'POST') {
        await requireOwner(req, env);
        body = await feedTokenCreate(env, await req.json());
      } else if (url.pathname === '/feed/token' && req.method === 'GET') {
        await requireOwner(req, env);
        body = await feedTokenGet(env);
      } else if (url.pathname === '/feed/memos.ics' && req.method === 'GET') {
        return await serveFeed(env, url, cors, 'memos');
      } else if (url.pathname === '/feed/tasks.ics' && req.method === 'GET') {
        return await serveFeed(env, url, cors, 'tasks');
      } else if (url.pathname === '/feed/all.ics' && req.method === 'GET') {
        return await serveFeed(env, url, cors, 'all');
      } else if (url.pathname === '/inbox/config' && req.method === 'GET') {
        await requireOwner(req, env);
        body = await inboxConfigGet(env);
      } else if (url.pathname === '/inbox/config' && req.method === 'POST') {
        await requireOwner(req, env);
        body = await inboxConfigSet(env, await req.json(), url.origin);
      } else if (url.pathname === '/inbox/add' && req.method === 'POST') {
        await requireInboxToken(req, env);
        body = await inboxAdd(env, await req.json());
      } else if (url.pathname === '/inbox/undo' && req.method === 'POST') {
        await requireInboxToken(req, env);
        body = await inboxUndo(env);
      } else if (url.pathname === '/inbox/summary' && req.method === 'GET') {
        await requireInboxToken(req, env);
        body = await inboxSummary(env, url.searchParams.get('date'));
      } else if (url.pathname.startsWith('/telegram/webhook/') && req.method === 'POST') {
        const secret = url.pathname.slice('/telegram/webhook/'.length);
        body = await handleTelegramWebhook(env, secret, await req.json());
      } else if (url.pathname === '/naver/events' && req.method === 'GET') {
        await requireOwner(req, env);
        body = await naverEvents(env, url.searchParams.get('start'), url.searchParams.get('end'));
      } else if (url.pathname === '/naver/test' && req.method === 'GET') {
        await requireOwner(req, env);
        body = await naverTest(env);
      } else if (url.pathname === '/naver/debug' && req.method === 'GET') {
        await requireOwner(req, env);
        body = await naverDebug(env);
      } else if (url.pathname === '/link/create' && req.method === 'POST') {
        await requireOwner(req, env);
        body = await linkCreate(env, await req.json());
      } else if (url.pathname === '/link/claim' && req.method === 'POST') {
        body = await linkClaim(env, await req.json()); // 아직 로그인 안 된 창이 부르므로 주인 확인 없음(코드 자체가 열쇠)
      } else if (['/ocr', '/transcribe'].includes(url.pathname) || url.pathname.startsWith('/refine/')) {
        throw httpError(501, 'gemini_disabled', 'Gemini API 연결이 비활성화되었습니다. 외부 API 호출을 하지 않습니다.');
      } else if (url.pathname === '/') {
        body = { ok: true, service: 'handcal', link: !!env.HANDCAL_KV, naver: !!(env.NAVER_ID && env.NAVER_APP_PASSWORD), google: !!env.GOOGLE_CLIENT_SECRET, gemini: false, feed: !!env.HANDCAL_KV, inbox: !!env.HANDCAL_KV };
      } else return json({ error: 'not_found' }, 404, cors);
      return json(body, 200, cors);
    } catch (e) {
      return json({ error: e.code || 'error', message: String(e.message || e) }, e.status || 500, cors);
    }
  },
  scheduled(event, env, ctx) {},
};

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}

function httpError(status, code, message) {
  const e = new Error(message || code);
  e.status = status;
  e.code = code;
  return e;
}

// ---------- 구글 로그인
async function googleToken(env, params) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params }),
  });
  const data = await r.json();
  if (!r.ok) throw httpError(r.status === 400 || r.status === 401 ? 401 : 502, data.error || 'google_error', data.error_description || JSON.stringify(data));
  return data;
}

function emailFromIdToken(idToken) {
  try {
    const part = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(part)).email || '';
  } catch { return ''; }
}

function checkOwner(env, email) {
  if (env.OWNER_EMAIL && (email || '').toLowerCase() !== env.OWNER_EMAIL.trim().toLowerCase()) {
    throw httpError(403, 'not_owner', '허용되지 않은 구글 계정이에요');
  }
}

async function exchange(env, { code }) {
  if (!code) throw httpError(400, 'no_code');
  const t = await googleToken(env, { code, grant_type: 'authorization_code', redirect_uri: 'postmessage' });
  checkOwner(env, emailFromIdToken(t.id_token));
  if (t.refresh_token && env.HANDCAL_KV) {
    await env.HANDCAL_KV.put('owner_refresh_token', t.refresh_token).catch(() => {});
  }
  return { access_token: t.access_token, expires_in: t.expires_in, refresh_token: t.refresh_token || null };
}

async function refresh(env, { refresh_token }) {
  if (!refresh_token) throw httpError(400, 'no_refresh_token');
  const t = await googleToken(env, { refresh_token, grant_type: 'refresh_token' });
  if (env.HANDCAL_KV) {
    await env.HANDCAL_KV.put('owner_refresh_token', refresh_token).catch(() => {});
  }
  return { access_token: t.access_token, expires_in: t.expires_in };
}

// 네이버 일정은 앱 주인의 구글 토큰이 있어야만 조회 가능
const ownerCache = new Map();
async function requireOwner(req, env) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) throw httpError(401, 'no_token');
  if ((ownerCache.get(token) || 0) > Date.now()) return;
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token));
  const info = await r.json().catch(() => ({}));
  if (!r.ok) throw httpError(401, 'invalid_token', '구글 토큰이 만료됐어요');
  if (info.aud !== env.GOOGLE_CLIENT_ID && info.azp !== env.GOOGLE_CLIENT_ID) throw httpError(403, 'wrong_client');
  checkOwner(env, info.email);
  if (ownerCache.size > 50) ownerCache.clear();
  ownerCache.set(token, Date.now() + Math.min(Number(info.expires_in) || 300, 3000) * 1000);
}

// ---------- 네이버 CalDAV
const PROPFIND_PRINCIPAL = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';
const PROPFIND_HOME = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>';
const PROPFIND_CALS = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:prop><d:resourcetype/><d:displayname/><a:calendar-color/><n:color/><n:calendar-color/><n:bgcolor/><c:supported-calendar-component-set/></d:prop></d:propfind>'.replace('xmlns:a=', 'xmlns:n="http://calendar.naver.com/" xmlns:a=');
const reportQuery = (start, end) =>
  '<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
  '<d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">' +
  `<c:time-range start="${start}" end="${end}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;

const davBase = (env) => (env.NAVER_CALDAV_URL || 'https://caldav.calendar.naver.com').replace(/\/$/, '');

async function dav(env, method, url, body, depth) {
  if (!env.NAVER_ID || !env.NAVER_APP_PASSWORD) throw httpError(500, 'naver_not_configured', '서버에 네이버 아이디/비밀번호가 설정되지 않았어요');
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: 'Basic ' + btoa(`${env.NAVER_ID}:${env.NAVER_APP_PASSWORD}`),
      'Content-Type': 'application/xml; charset=utf-8',
      Depth: String(depth),
    },
    body,
  });
  const text = await r.text();
  if (r.status === 401 || r.status === 403) throw httpError(502, 'naver_auth', `네이버 로그인 실패(${r.status}): 아이디와 애플리케이션 비밀번호를 확인하세요`);
  if (!r.ok) throw httpError(502, 'naver_error', `네이버 CalDAV ${method} ${r.status}: ${text.slice(0, 200)}`);
  return text;
}

const tagRe = (name) => new RegExp(`<(?:[\\w-]+:)?${name}(?=[\\s/>])[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i');
const first = (xml, name) => { const m = tagRe(name).exec(xml); return m ? m[1] : null; };
const responses = (xml) => xml.split(/<(?:[\w-]+:)?response(?=[\s>])[^>]*>/i).slice(1).map((s) => s.split(/<\/(?:[\w-]+:)?response>/i)[0]);
function decodeXml(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}
const hrefIn = (xml) => { const h = xml && first(xml, 'href'); return h ? decodeXml(h.trim()) : null; };
const CSS_COLORS = { red: '#ff0000', orange: '#ffa500', yellow: '#ffff00', green: '#008000', blue: '#0000ff', purple: '#800080', pink: '#ffc0cb', brown: '#a52a2a', gray: '#808080', grey: '#808080', black: '#000000', navy: '#000080', teal: '#008080', olive: '#808000', maroon: '#800000', violet: '#ee82ee', gold: '#ffd700', coral: '#ff7f50', salmon: '#fa8072', orchid: '#da70d6', lavender: '#e6e6fa', skyblue: '#87ceeb', crimson: '#dc143c', indigo: '#4b0082', tomato: '#ff6347' };
const hexColor = (c) => {
  const v = (c || '').trim();
  const m = /#([0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-f])/i.exec(v);
  if (m) return m[1].length === 3 ? '#' + m[1].split('').map((x) => x + x).join('') : m[0];
  return CSS_COLORS[v.toLowerCase()] || null;
};
const normColor = (c) => hexColor(c) || '#03c75a';
// 응답 안에서 이름에 color가 들어간 속성 중 색 값이 있는 첫 번째
function anyColor(xml) {
  const re = /<((?:[\w-]+:)?[\w-]*colou?r[\w-]*)(?=[\s>])[^>]*>([^<]*)<\/\1>/gi;
  let m;
  while ((m = re.exec(xml))) { const c = hexColor(m[2]); if (c) return c; }
  return null;
}
// 선택: Worker 변수 CALENDAR_COLORS = {"캘린더 이름":"#a48ce0"} 로 캘린더 색 직접 지정
function colorOverrides(env) {
  try { return JSON.parse(env.CALENDAR_COLORS || '{}'); } catch { return {}; }
}

let calCache = null;
const calCacheReq = (env) => new Request(`https://handcal-internal.local/naver-cals-${encodeURIComponent(env.NAVER_ID || 'default')}`);
async function clearCalCache(env) {
  calCache = null;
  try { await caches?.default?.delete(calCacheReq(env)); } catch {}
}
async function calendars(env) {
  if (calCache && Date.now() - calCache.at < 3600e3) return calCache.cals;
  try {
    if (env.HANDCAL_KV) {
      const kv = await env.HANDCAL_KV.get('naver_cals', 'json');
      if (kv?.cals?.length && Date.now() - (kv.at || 0) < 6 * 3600e3) {
        calCache = { at: Date.now(), cals: kv.cals };
        return kv.cals;
      }
    }
    const hit = await caches?.default?.match(calCacheReq(env));
    if (hit) {
      const cals = await hit.json();
      if (Array.isArray(cals) && cals.length) {
        calCache = { at: Date.now(), cals };
        return cals;
      }
    }
  } catch {}
  const base = davBase(env);
  const abs = (h) => new URL(h, base + '/').toString();

  let principal = null;
  for (const p of ['/', '/.well-known/caldav']) {
    try {
      const x = await dav(env, 'PROPFIND', base + p, PROPFIND_PRINCIPAL, 0);
      const h = hrefIn(first(x, 'current-user-principal'));
      if (h) { principal = abs(h); break; }
    } catch (e) {
      if (e.code === 'naver_auth') throw e;
    }
  }
  if (!principal) throw httpError(502, 'naver_discovery', '네이버 CalDAV 주소를 찾지 못했어요');

  const x2 = await dav(env, 'PROPFIND', principal, PROPFIND_HOME, 0);
  const homeHref = hrefIn(first(x2, 'calendar-home-set'));
  const home = homeHref ? abs(homeHref) : principal;

  const x3 = await dav(env, 'PROPFIND', home, PROPFIND_CALS, 1);
  const cals = [];
  for (const r of responses(x3)) {
    const rt = first(r, 'resourcetype') || '';
    if (!/<(?:[\w-]+:)?calendar[\s/>]/i.test(rt)) continue;
    const comps = first(r, 'supported-calendar-component-set');
    if (comps && !/VEVENT/i.test(comps)) continue;
    const name = decodeXml((first(r, 'displayname') || '').trim()) || '네이버 캘린더';
    const over = colorOverrides(env)[name];
    cals.push({
      href: abs(hrefIn(r)),
      name,
      color: hexColor(over) || hexColor(first(r, 'calendar-color')) || anyColor(r) || '#03c75a',
    });
  }
  calCache = { at: Date.now(), cals };
  try {
    if (cals.length) {
      await caches?.default?.put(calCacheReq(env), new Response(JSON.stringify(cals), { headers: { 'Cache-Control': 'max-age=21600' } }));
      if (env.HANDCAL_KV) await env.HANDCAL_KV.put('naver_cals', JSON.stringify({ at: Date.now(), cals }), { expirationTtl: 86400 });
    }
  } catch {}
  return cals;
}

async function naverTest(env) {
  await clearCalCache(env);
  const cals = await calendars(env);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
  const r = await naverEvents(env, start, end, true);
  return { calendars: cals.map((c) => ({ name: c.name, color: c.color })), eventsThisMonth: r.events.length, sample: r.events.slice(0, 5), stats: r.stats, warnings: r.warnings };
}

// 진단용: 첫 캘린더의 이번 달 REPORT 원본 응답 일부 (일정 제목 등 개인 내용이 보일 수 있음)
async function naverDebug(env) {
  await clearCalCache(env);
  const cals = await calendars(env);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const out = [];
  for (const cal of cals.slice(0, 2)) {
    try {
      const x = await dav(env, 'REPORT', cal.href, reportQuery(fmtDav(start), fmtDav(end)), 1);
      out.push({ calendar: cal.name, href: cal.href, length: x.length, responses: responses(x).length, head: x.slice(0, 1500) });
    } catch (e) {
      out.push({ calendar: cal.name, href: cal.href, error: e.message });
    }
  }
  // 캘린더 목록 원본(색 속성 확인용)과 일정 원본 1건
  let calProps = null, ics = null;
  try {
    const base = davBase(env);
    const home = new URL(cals[0].href).toString().replace(/[^/]+\/?$/, '');
    const x = await dav(env, 'PROPFIND', home, '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>', 1);
    calProps = x.slice(0, 6000);
    const cal = cals.find((c) => /차장방|기자재/.test(c.name)) || cals[0];
    const stat = {};
    const v = await fetchCalendarEventsRaw(env, cal, start, end, stat);
    ics = v.slice(0, 2500);
    void base;
  } catch (e) { calProps = calProps || 'ERR ' + e.message; }
  return { reports: out, calProps, ics };
}

async function fetchCalendarEventsRaw(env, cal, start, end) {
  const x = await dav(env, 'REPORT', cal.href, reportQuery(fmtDav(start), fmtDav(end)), 1);
  const hrefs = responses(x).map(hrefIn).filter((h) => h && !/\/$/.test(h)).slice(0, 2);
  if (!hrefs.length) return '';
  const mx = await dav(env, 'REPORT', cal.href, multigetQuery(hrefs), 1);
  const data = first(mx, 'calendar-data');
  return data ? decodeXml(data) : mx;
}

const fmtDav = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const multigetQuery = (hrefs) =>
  '<?xml version="1.0" encoding="utf-8"?><c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
  '<d:prop><d:getetag/><c:calendar-data/></d:prop>' +
  hrefs.map((h) => `<d:href>${h.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</d:href>`).join('') +
  '</c:calendar-multiget>';

// 한 캘린더의 기간 내 VEVENT 수집. 네이버가 REPORT 응답에 본문(calendar-data)을 안 넣어주면
// 주소(href)만 모아서 calendar-multiget으로 다시 받고, 그것도 안 되면 하나씩 GET
async function fetchCalendarEvents(env, cal, start, end, stat) {
  const x = await dav(env, 'REPORT', cal.href, reportQuery(fmtDav(start), fmtDav(end)), 1);
  const vevents = [];
  const missing = [];
  const rs = responses(x);
  stat.responses = rs.length;
  for (const r of rs) {
    const data = first(r, 'calendar-data');
    if (data && /BEGIN:VCALENDAR/i.test(decodeXml(data))) vevents.push(...parseICS(decodeXml(data)));
    else {
      const h = hrefIn(r);
      if (h && !/\/$/.test(h)) missing.push(h);
    }
  }
  stat.inline = vevents.length;
  stat.missing = missing.length;
  for (let i = 0; i < missing.length; i += 50) {
    const batch = missing.slice(i, i + 50);
    let got = 0;
    try {
      const mx = await dav(env, 'REPORT', cal.href, multigetQuery(batch), 1);
      for (const r of responses(mx)) {
        const data = first(r, 'calendar-data');
        if (data) { const v = parseICS(decodeXml(data)); vevents.push(...v); got += v.length; }
      }
    } catch (e) {
      stat.multigetError = e.message;
    }
    if (!got) {
      const base = davBase(env) + '/';
      await Promise.all(batch.slice(0, 30).map(async (h) => {
        try {
          const r = await fetch(new URL(h, base).toString(), { headers: { Authorization: 'Basic ' + btoa(`${env.NAVER_ID}:${env.NAVER_APP_PASSWORD}`) } });
          if (r.ok) vevents.push(...parseICS(await r.text()));
        } catch {}
      }));
      stat.usedGet = true;
    }
  }
  stat.vevents = vevents.length;
  return vevents;
}

const eventCache = new Map();
async function naverEvents(env, startIso, endIso, noCache) {
  const start = new Date(startIso), end = new Date(endIso);
  if (isNaN(start) || isNaN(end) || end <= start || end - start > 400 * DAY) throw httpError(400, 'bad_range');
  const key = start.toISOString() + end.toISOString();
  const hit = eventCache.get(key);
  if (!noCache && hit && Date.now() - hit.at < 60e3) return hit.data;

  const tz = validTz(env.TIMEZONE) || 'Asia/Seoul';
  const cals = await calendars(env);
  const warnings = [];
  const events = [];
  const stats = [];
  await Promise.all(cals.map(async (cal) => {
    const stat = { calendar: cal.name };
    stats.push(stat);
    try {
      const vevents = await fetchCalendarEvents(env, cal, start, end, stat);
      const ex = expandEvents(vevents, cal, start.getTime(), end.getTime(), tz);
      stat.events = ex.length;
      events.push(...ex);
    } catch (e) {
      if (e.code === 'naver_auth') throw e;
      warnings.push(`${cal.name}: ${e.message}`);
    }
  }));
  // 캘린더 목록도 함께 (앱에서 캘린더별로 켜고 끄기)
  const data = { events, warnings, stats, calendars: cals.map((c) => ({ name: c.name, color: c.color })) };
  if (events.length && eventCache.size > 30) eventCache.clear();
  if (events.length || warnings.length === 0) eventCache.set(key, { at: Date.now(), data });
  return data;
}

// ---------- iCalendar 해석
const DAY = 86400e3;
const WDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function parseICS(text) {
  const lines = text.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n').map((l) => l.replace(/\s+$/, ''));
  const out = [];
  let cur = null, depth = 0;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; depth = 0; continue; }
    if (line === 'END:VEVENT') { if (cur) out.push(cur); cur = null; continue; }
    if (!cur) continue;
    if (line.startsWith('BEGIN:')) { depth++; continue; }
    if (line.startsWith('END:')) { depth--; continue; }
    if (depth > 0) continue;
    const m = /^([A-Za-z0-9-]+)((?:;[^:]*)?):(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1].toUpperCase();
    const params = {};
    for (const p of m[2].split(';').filter(Boolean)) {
      const i = p.indexOf('=');
      if (i > 0) params[p.slice(0, i).toUpperCase()] = p.slice(i + 1).replace(/^"|"$/g, '');
    }
    const prop = { value: m[3], params };
    if (name === 'EXDATE') (cur.EXDATE ||= []).push(prop);
    else cur[name] = prop;
  }
  return out;
}

const unescapeText = (s) => s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();

function validTz(tz) {
  if (!tz) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; }
}

function tzOffset(tz, utcMs) {
  if (tz === 'UTC') return 0;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - utcMs;
}
const wallToUtc = (wall, tz) => wall - tzOffset(tz, wall - tzOffset(tz, wall));
const utcToWall = (ms, tz) => ms + tzOffset(tz, ms);

// 반환: { allDay, wall(그 지역 시각을 UTC 숫자로 표현), tz }
function parseDT(prop, defTz) {
  if (!prop) return null;
  const v = prop.value.trim();
  if (prop.params.VALUE === 'DATE' || /^\d{8}$/.test(v)) {
    return { allDay: true, wall: Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8)), tz: null };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (m[7]) return { allDay: false, wall: utcToWall(wall, defTz), tz: defTz };
  const tz = validTz(prop.params.TZID) || defTz;
  return { allDay: false, wall: utcToWall(wallToUtc(wall, tz), defTz), tz: defTz };
}

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec((v || '').trim());
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 * DAY) + ((+m[3] || 0) * DAY) + ((+m[4] || 0) * 3600e3) + ((+m[5] || 0) * 60e3) + ((+m[6] || 0) * 1e3);
  return m[1] === '-' ? -ms : ms;
}

function monthDays(y, m0, byday, bymonthday) {
  const d0 = new Date(Date.UTC(y, m0, 1));
  const yy = d0.getUTCFullYear(), mm = d0.getUTCMonth();
  const len = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  const out = new Set();
  for (const d of bymonthday) {
    const day = d > 0 ? d : len + d + 1;
    if (day >= 1 && day <= len) out.add(Date.UTC(yy, mm, day));
  }
  const firstDow = d0.getUTCDay();
  for (const b of byday) {
    const days = [];
    for (let d = 1 + ((b.wd - firstDow + 7) % 7); d <= len; d += 7) days.push(d);
    if (!b.n) days.forEach((d) => out.add(Date.UTC(yy, mm, d)));
    else {
      const d = b.n > 0 ? days[b.n - 1] : days[days.length + b.n];
      if (d) out.add(Date.UTC(yy, mm, d));
    }
  }
  return [...out].sort((a, b) => a - b);
}

// 반복 일정의 발생 시각(wall)을 순서대로 생성
function* occurrences(startWall, rule, untilWall, fromWall, toWall) {
  const freq = rule.FREQ;
  const interval = Math.max(1, parseInt(rule.INTERVAL || '1', 10) || 1);
  const count = rule.COUNT ? parseInt(rule.COUNT, 10) : Infinity;
  const byday = (rule.BYDAY || '').split(',').map((s) => {
    const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(s.trim());
    return m ? { n: m[1] ? parseInt(m[1], 10) : 0, wd: WDAYS.indexOf(m[2]) } : null;
  }).filter(Boolean);
  const bymonthday = rule.BYMONTHDAY ? rule.BYMONTHDAY.split(',').map(Number).filter(Boolean) : [];
  const bymonth = rule.BYMONTH ? rule.BYMONTH.split(',').map((n) => Number(n) - 1) : [];
  const s = new Date(startWall);
  const timeMs = ((startWall % DAY) + DAY) % DAY;
  const sDay = startWall - timeMs;
  const defaultDays = (byday.length ? [] : [s.getUTCDate()]);

  // 횟수 제한이 없으면 조회 기간 근처로 건너뛰기
  let k = 0;
  if (count === Infinity && fromWall > startWall) {
    const unit = freq === 'DAILY' ? DAY : freq === 'WEEKLY' ? 7 * DAY : 0;
    if (unit) k = Math.max(0, Math.floor((fromWall - startWall) / (unit * interval)) - 1);
  }
  let produced = 0;
  for (let guard = 0; guard < 5000; guard++, k++) {
    let cands = [];
    if (freq === 'DAILY') cands = [startWall + k * interval * DAY];
    else if (freq === 'WEEKLY') {
      const wkst = Math.max(0, WDAYS.indexOf(rule.WKST || 'MO'));
      const dow = new Date(sDay).getUTCDay();
      const weekStart = sDay - ((dow - wkst + 7) % 7) * DAY + k * interval * 7 * DAY;
      const days = byday.length ? byday.map((b) => b.wd) : [dow];
      cands = days.map((wd) => weekStart + ((wd - wkst + 7) % 7) * DAY + timeMs);
    } else if (freq === 'MONTHLY') {
      cands = monthDays(s.getUTCFullYear(), s.getUTCMonth() + k * interval, byday, bymonthday.length ? bymonthday : defaultDays).map((d) => d + timeMs);
    } else if (freq === 'YEARLY') {
      const y = s.getUTCFullYear() + k * interval;
      for (const mo of bymonth.length ? bymonth : [s.getUTCMonth()]) {
        cands.push(...monthDays(y, mo, byday, bymonthday.length ? bymonthday : defaultDays).map((d) => d + timeMs));
      }
    } else { yield startWall; return; }
    cands.sort((a, b) => a - b);
    for (const c of cands) {
      if (c < startWall) continue;
      if (c > untilWall || produced >= count || c > toWall) return;
      produced++;
      yield c;
    }
  }
}

const ymdUTC = (ms) => new Date(ms).toISOString().slice(0, 10);

function expandEvents(vevents, cal, fromMs, toMs, tz) {
  const out = [];
  const overrides = new Map(); // UID -> Set(recurrence wall)
  for (const ev of vevents) {
    if (!ev['RECURRENCE-ID'] || !ev.UID) continue;
    const r = parseDT(ev['RECURRENCE-ID'], tz);
    if (r) {
      if (!overrides.has(ev.UID.value)) overrides.set(ev.UID.value, new Set());
      overrides.get(ev.UID.value).add(r.wall);
    }
  }
  const fromWall = utcToWall(fromMs, tz) - DAY, toWall = utcToWall(toMs, tz) + DAY;
  const eventColor = (ev) => {
    if (ev.COLOR) { const c = hexColor(ev.COLOR.value); if (c) return c; }
    for (const k of Object.keys(ev)) {
      if (/COLOU?R/.test(k) && ev[k] && ev[k].value) { const c = hexColor(ev[k].value); if (c) return c; }
    }
    return cal.color;
  };

  for (const ev of vevents) {
    if (ev.STATUS?.value === 'CANCELLED') continue;
    const st = parseDT(ev.DTSTART, tz);
    if (!st) continue;
    const uid = ev.UID?.value || Math.random().toString(36).slice(2);
    let dur;
    const en = parseDT(ev.DTEND, tz);
    if (en) dur = en.wall - st.wall;
    else if (ev.DURATION) dur = parseDuration(ev.DURATION.value) ?? 0;
    else dur = st.allDay ? DAY : 0;
    if (st.allDay) dur = Math.max(DAY, Math.round(dur / DAY) * DAY);
    const title = ev.SUMMARY ? unescapeText(ev.SUMMARY.value) || '(제목 없음)' : '(제목 없음)';
    const color = eventColor(ev);

    const emit = (wall) => {
      if (wall > toWall || wall + dur < fromWall) return;
      if (st.allDay) {
        out.push({ id: `${uid}@${ymdUTC(wall)}`, title, allDay: true, start: ymdUTC(wall), end: ymdUTC(wall + dur), calendar: cal.name, color });
      } else {
        const s = wallToUtc(wall, tz), e = wallToUtc(wall + dur, tz);
        out.push({ id: `${uid}@${s}`, title, allDay: false, start: new Date(s).toISOString(), end: new Date(e).toISOString(), calendar: cal.name, color });
      }
    };

    if (!ev.RRULE || ev['RECURRENCE-ID']) { emit(st.wall); continue; }

    const rule = {};
    for (const part of ev.RRULE.value.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) rule[part.slice(0, i).toUpperCase()] = part.slice(i + 1);
    }
    let untilWall = Infinity;
    if (rule.UNTIL) {
      const u = parseDT({ value: rule.UNTIL, params: {} }, tz);
      if (u) untilWall = u.allDay ? u.wall + DAY - 1 : u.wall;
    }
    const skip = new Set(overrides.get(uid) || []);
    for (const ex of ev.EXDATE || []) {
      for (const v of ex.value.split(',')) {
        const d = parseDT({ value: v, params: ex.params }, tz);
        if (d) skip.add(st.allDay ? d.wall - (d.wall % DAY) : d.wall);
      }
    }
    for (const wall of occurrences(st.wall, rule, untilWall, fromWall - dur, toWall)) {
      if (!skip.has(wall)) emit(wall);
    }
  }
  return out;
}

// ---------- 1회용 연결 코드: 로그인된 기기의 연결 정보를 KV에 5분만 맡기고, 8자리 코드로 한 번만 꺼내 감
// (Worker는 요청마다 다른 실행 단위에서 돌 수 있어 메모리 보관은 믿을 수 없으므로 KV 필수)
const LINK_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0·O·1·I 뺌 → 32^8 ≈ 1조 가지
const linkNorm = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
async function linkCreate(env, body) {
  if (!env.HANDCAL_KV) throw httpError(501, 'kv_missing', '서버에 KV 저장소(HANDCAL_KV)가 연결되지 않았어요');
  const r = String(body?.r || '');
  if (!r || r.length > 4000) throw httpError(400, 'bad_payload', '연결 정보가 없어요');
  const rnd = crypto.getRandomValues(new Uint8Array(8));
  const code = [...rnd].map((b) => LINK_ABC[b % 32]).join('');
  const a = body?.a && typeof body.a === 'object' ? { token: String(body.a.token || ''), expires: Number(body.a.expires) || 0 } : null;
  await env.HANDCAL_KV.put('link:' + code, JSON.stringify({ r, a, at: Date.now() }), { expirationTtl: 300 });
  return { code: code.slice(0, 4) + '-' + code.slice(4), expiresIn: 300 };
}
async function linkClaim(env, body) {
  if (!env.HANDCAL_KV) throw httpError(501, 'kv_missing', '서버에 KV 저장소(HANDCAL_KV)가 연결되지 않았어요');
  const code = linkNorm(body?.code);
  if (code.length !== 8) throw httpError(400, 'bad_code', '코드는 8자리예요');
  const raw = await env.HANDCAL_KV.get('link:' + code, 'json');
  if (!raw?.r) throw httpError(404, 'code_not_found', '코드가 없거나 5분이 지났어요');
  await env.HANDCAL_KV.delete('link:' + code); // 한 번 쓰면 끝
  return { r: raw.r, a: raw.a };
}

// 테스트용으로 내보냄 (Workers 런타임에는 영향 없음)

// ---------- iCal 피드 토큰 관리
async function feedTokenCreate(env, body) {
  if (!env.HANDCAL_KV) throw httpError(501, 'kv_missing', 'KV 저장소(HANDCAL_KV)가 연결되지 않았어요');
  const refresh_token = String(body?.refresh_token || '');
  if (!refresh_token) throw httpError(400, 'no_refresh_token', '리프레시 토큰이 필요해요');

  const meta = await env.HANDCAL_KV.get('feed_meta', 'json');
  if (meta?.token) {
    await env.HANDCAL_KV.delete('feed:' + meta.token).catch(() => {});
  }

  const token = crypto.randomUUID();
  await env.HANDCAL_KV.put('feed:' + token, JSON.stringify({ refresh_token, at: Date.now() }));
  await env.HANDCAL_KV.put('feed_meta', JSON.stringify({ token, at: Date.now() }));
  return { token };
}

async function feedTokenGet(env) {
  if (!env.HANDCAL_KV) throw httpError(501, 'kv_missing', 'KV 저장소(HANDCAL_KV)가 연결되지 않았어요');
  const meta = await env.HANDCAL_KV.get('feed_meta', 'json');
  return { token: meta?.token || null };
}

// ---------- iCal 피드 서빙 (외부 캘린더 구독용)
async function serveFeed(env, url, cors, type) {
  if (!env.HANDCAL_KV) return new Response('KV 저장소 없음', { status: 501 });

  const token = url.searchParams.get('token');
  if (!token) return new Response('?token= 파라미터가 필요해요', { status: 401 });

  const cacheKey = `feedcache:${token}:${type}`;
  const cached = await env.HANDCAL_KV.get(cacheKey);
  if (cached) return icsResponse(cached, cors);

  const data = await env.HANDCAL_KV.get('feed:' + token, 'json');
  if (!data?.refresh_token) return new Response('유효하지 않은 피드 토큰이에요', { status: 401 });

  let access_token;
  try {
    const t = await googleToken(env, { refresh_token: data.refresh_token, grant_type: 'refresh_token' });
    access_token = t.access_token;
  } catch (e) {
    return new Response('구글 토큰 갱신 실패: ' + e.message, { status: 502 });
  }

  let ics;
  const tz = validTz(env.TIMEZONE) || 'Asia/Seoul';
  try {
    if (type === 'memos') {
      const events = await readEventsFromDrive(access_token);
      ics = buildMemosIcs(events, tz);
    } else if (type === 'tasks') {
      const tasks = await readTasksFromGoogle(access_token);
      ics = buildTasksIcs(tasks);
    } else {
      const [events, tasks] = await Promise.all([
        readEventsFromDrive(access_token),
        readTasksFromGoogle(access_token),
      ]);
      ics = buildAllIcs(events, tasks, tz);
    }
  } catch (e) {
    return new Response('피드 생성 실패: ' + e.message, { status: 502 });
  }

  await env.HANDCAL_KV.put(cacheKey, ics, { expirationTtl: 300 }).catch(() => {});
  return icsResponse(ics, cors);
}

function icsResponse(ics, cors) {
  return new Response(ics, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

// ---------- Google Drive에서 events.json 읽기
async function readEventsFromDrive(access_token) {
  const qr = await fetch(
    "https://www.googleapis.com/drive/v3/files?q=name%3D'events.json'+and+trashed%3Dfalse&spaces=drive&fields=files(id)&orderBy=modifiedTime+desc&pageSize=1",
    { headers: { Authorization: 'Bearer ' + access_token } }
  );
  if (!qr.ok) throw new Error(`Drive 검색 실패 (${qr.status})`);
  const { files } = await qr.json().catch(() => ({ files: [] }));
  if (!files?.length) return [];

  const fr = await fetch(
    'https://www.googleapis.com/drive/v3/files/' + files[0].id + '?alt=media',
    { headers: { Authorization: 'Bearer ' + access_token } }
  );
  if (!fr.ok) throw new Error(`Drive 읽기 실패 (${fr.status})`);

  const raw = await fr.json().catch(() => null);
  if (!raw) return [];
  const list = Array.isArray(raw?.events) ? raw.events : Array.isArray(raw) ? raw : Object.values(raw);
  return list.filter((e) => e && !e.deleted && e.id && e.title);
}

// ---------- Google Tasks에서 미완료 할 일 읽기
async function readTasksFromGoogle(access_token) {
  const TASKS_BASE = 'https://tasks.googleapis.com/tasks/v1';
  const headers = { Authorization: 'Bearer ' + access_token };

  const lr = await fetch(TASKS_BASE + '/users/@me/lists?maxResults=50', { headers });
  if (!lr.ok) return [];
  const { items: lists } = await lr.json().catch(() => ({ items: [] }));
  if (!lists?.length) return [];

  const tasks = [];
  await Promise.all(
    lists.map(async (list) => {
      const tr = await fetch(
        `${TASKS_BASE}/lists/${list.id}/tasks?showCompleted=false&showHidden=false&maxResults=100&fields=items(id,title,due,status,notes)`,
        { headers }
      ).catch(() => null);
      if (!tr?.ok) return;
      const { items } = await tr.json().catch(() => ({ items: [] }));
      for (const t of items || []) {
        if (t.status === 'needsAction' && t.due && (t.title || '').trim()) {
          tasks.push({
            id: t.id,
            title: t.title.trim(),
            due: t.due.slice(0, 10),
            list: list.title,
          });
        }
      }
    })
  );
  return tasks;
}

// ---------- iCal (RFC 5545) 생성 헬퍼
function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n|\r/g, '\\n');
}

function icsFold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let buf = '';
  let len = 0;
  for (const ch of line) {
    const chLen = enc.encode(ch).length;
    if (len + chLen > (out.length === 0 ? 75 : 74)) {
      out.push(buf);
      buf = ' ';
      len = 1;
    }
    buf += ch;
    len += chLen;
  }
  if (buf) out.push(buf);
  return out.join('\r\n');
}

function dtStampNow() {
  return new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
}

function nextDateStr(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function buildVevent(uid, dtstart, dtend, summary, lastmod) {
  const lines = [
    'BEGIN:VEVENT',
    'UID:' + uid,
    'DTSTAMP:' + dtStampNow(),
    'DTSTART' + dtstart,
    'DTEND' + dtend,
    icsFold('SUMMARY:' + icsEscape(summary)),
  ];
  if (lastmod) lines.push('LAST-MODIFIED:' + lastmod);
  lines.push('END:VEVENT');
  return lines.join('\r\n');
}

// 메모 일정의 start/end는 기기 현지 자정을 ISO(UTC)로 적은 값. 글자를 그대로 자르면 한국 시간에서는 하루 전날이 되므로 tz 기준 날짜로 바꿈
function feedDay(v, tz) {
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const ms = Date.parse(s);
  if (isNaN(ms)) return s.slice(0, 10);
  return ymdUTC(utcToWall(ms, tz));
}

function buildMemosIcs(events, tz = 'Asia/Seoul') {
  const header = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HandCalendar//HandCal//KO',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:필기캘린더 메모 일정',
    'X-WR-TIMEZONE:Asia/Seoul',
  ];
  const vevents = events.map((ev) => {
    const uid = icsEscape(ev.id) + '@handcal';
    const lastmod = ev.updated ? new Date(ev.updated).toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z' : null;

    if (ev.allDay) {
      const startDay = feedDay(ev.start, tz);
      const startStr = startDay.replace(/-/g, '');
      const endStr = ev.end ? feedDay(ev.end, tz).replace(/-/g, '') : nextDateStr(startDay);
      const endFinal = endStr <= startStr ? nextDateStr(startDay) : endStr;
      return buildVevent(uid, ';VALUE=DATE:' + startStr, ';VALUE=DATE:' + endFinal, ev.title || '(제목 없음)', lastmod);
    } else {
      const startUtc = new Date(ev.start).toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
      const endUtc = ev.end
        ? new Date(ev.end).toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z'
        : startUtc;
      return buildVevent(uid, ':' + startUtc, ':' + endUtc, ev.title || '(제목 없음)', lastmod);
    }
  });
  return [...header, ...vevents, 'END:VCALENDAR'].join('\r\n') + '\r\n';
}

function buildTasksIcs(tasks) {
  const header = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HandCalendar//HandCal//KO',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:필기캘린더 할 일',
    'X-WR-TIMEZONE:Asia/Seoul',
  ];
  const vevents = tasks.map((t) => {
    const uid = icsEscape(t.id) + '@handcal-tasks';
    const dateStr = t.due.replace(/-/g, '');
    const nextStr = nextDateStr(t.due);
    return buildVevent(uid, ';VALUE=DATE:' + dateStr, ';VALUE=DATE:' + nextStr, '☐ ' + (t.title || '할 일'), null);
  });
  return [...header, ...vevents, 'END:VCALENDAR'].join('\r\n') + '\r\n';
}

function buildAllIcs(events, tasks, tz = 'Asia/Seoul') {
  const header = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HandCalendar//HandCal//KO',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:필기캘린더 (전체)',
    'X-WR-TIMEZONE:Asia/Seoul',
  ];
  const memoLines = buildMemosIcs(events, tz).split('\r\n');
  const memoEvents = [];
  let inEvent = false;
  let cur = [];
  for (const l of memoLines) {
    if (l === 'BEGIN:VEVENT') { inEvent = true; cur = [l]; }
    else if (l === 'END:VEVENT') { cur.push(l); memoEvents.push(cur.join('\r\n')); inEvent = false; }
    else if (inEvent) cur.push(l);
  }

  const taskLines = buildTasksIcs(tasks).split('\r\n');
  const taskEvents = [];
  inEvent = false;
  cur = [];
  for (const l of taskLines) {
    if (l === 'BEGIN:VEVENT') { inEvent = true; cur = [l]; }
    else if (l === 'END:VEVENT') { cur.push(l); taskEvents.push(cur.join('\r\n')); inEvent = false; }
    else if (inEvent) cur.push(l);
  }

  return [...header, ...memoEvents, ...taskEvents, 'END:VCALENDAR'].join('\r\n') + '\r\n';
}

// ---------- 빠른 추가 (Inbox API & 텔레그램 Webhook)
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

async function getInboxMeta(env) {
  if (!env.HANDCAL_KV) throw httpError(501, 'kv_missing', 'KV 저장소(HANDCAL_KV)가 연결되지 않았어요');
  return (await env.HANDCAL_KV.get('inbox_meta', 'json')) || {};
}

async function getOwnerRefreshToken(env) {
  const meta = await getInboxMeta(env);
  if (meta.refresh_token) return meta.refresh_token;
  const backed = await env.HANDCAL_KV.get('owner_refresh_token');
  if (backed) return backed;
  const fmeta = await env.HANDCAL_KV.get('feed_meta', 'json');
  if (fmeta?.token) {
    const fdata = await env.HANDCAL_KV.get('feed:' + fmeta.token, 'json');
    if (fdata?.refresh_token) return fdata.refresh_token;
  }
  throw httpError(400, 'no_refresh_token', '구글 로그인 정보가 서버에 없어요. 앱 설정 → 빠른 추가에서 연동 토큰을 발급해 주세요.');
}

async function getOwnerAccessToken(env) {
  const rt = await getOwnerRefreshToken(env);
  const t = await googleToken(env, { refresh_token: rt, grant_type: 'refresh_token' });
  return t.access_token;
}

async function requireInboxToken(req, env) {
  const meta = await getInboxMeta(env);
  if (!meta.token) throw httpError(401, 'inbox_not_configured', '빠른 추가 토큰이 아직 발급되지 않았어요');
  const hdr = req.headers.get('X-Inbox-Token') || (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!hdr || hdr !== meta.token) throw httpError(401, 'invalid_inbox_token', '연동 토큰이 맞지 않아요');
}

async function inboxConfigGet(env) {
  const meta = await getInboxMeta(env);
  return {
    token: meta.token || null,
    hasRefreshToken: !!(meta.refresh_token || await env.HANDCAL_KV.get('owner_refresh_token')),
    telegramConnected: !!meta.tgBotToken,
    telegramBotUsername: meta.tgBotUsername || null,
    telegramChatCount: Array.isArray(meta.tgChatIds) ? meta.tgChatIds.length : 0,
  };
}

async function inboxConfigSet(env, body, origin) {
  const meta = await getInboxMeta(env);
  if (body?.refresh_token) meta.refresh_token = String(body.refresh_token);
  if (body?.issueToken || !meta.token) {
    meta.token = crypto.randomUUID().replace(/-/g, '');
  }
  if (body?.disconnectTelegram) {
    if (meta.tgBotToken) {
      await fetch(`https://api.telegram.org/bot${meta.tgBotToken}/deleteWebhook`, { method: 'POST' }).catch(() => {});
    }
    delete meta.tgBotToken;
    delete meta.tgBotUsername;
    delete meta.tgSecret;
    delete meta.tgChatIds;
  } else if (body?.telegramBotToken) {
    const botToken = String(body.telegramBotToken).trim();
    const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const meData = await meRes.json().catch(() => ({}));
    if (!meRes.ok || !meData.ok) {
      throw httpError(400, 'invalid_bot_token', '텔레그램 봇 토큰이 유효하지 않아요 (@BotFather 토큰을 확인하세요)');
    }
    const secret = crypto.randomUUID().replace(/-/g, '');
    const webhookUrl = `${origin.replace(/\/$/, '')}/telegram/webhook/${secret}`;
    const whRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message'] }),
    });
    const whData = await whRes.json().catch(() => ({}));
    if (!whRes.ok || !whData.ok) {
      throw httpError(502, 'webhook_failed', '텔레그램 Webhook 등록 실패: ' + (whData.description || whRes.status));
    }
    meta.tgBotToken = botToken;
    meta.tgBotUsername = meData.result?.username || '';
    meta.tgSecret = secret;
    if (!Array.isArray(meta.tgChatIds)) meta.tgChatIds = [];
  }
  if (body?.telegramChatId) {
    const cid = String(body.telegramChatId).trim();
    if (cid) {
      meta.tgChatIds = Array.from(new Set([...(meta.tgChatIds || []), cid]));
    }
  }
  meta.updatedAt = Date.now();
  await env.HANDCAL_KV.put('inbox_meta', JSON.stringify(meta));
  return {
    token: meta.token,
    telegramConnected: !!meta.tgBotToken,
    telegramBotUsername: meta.tgBotUsername || null,
    telegramChatCount: Array.isArray(meta.tgChatIds) ? meta.tgChatIds.length : 0,
  };
}

// ---------- Google Drive 읽기/쓰기 헬퍼 (필기캘린더 폴더)
async function ensureDriveFolder(access_token) {
  const q = encodeURIComponent("name='필기캘린더' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const r = await fetch(`${DRIVE_FILES}?q=${q}&fields=files(id)&spaces=drive`, {
    headers: { Authorization: 'Bearer ' + access_token },
  });
  if (!r.ok) throw httpError(502, 'drive_error', `드라이브 폴더 조회 실패 (${r.status})`);
  const data = await r.json();
  if (data.files?.length) return data.files[0].id;
  const c = await fetch(`${DRIVE_FILES}?fields=id`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '필기캘린더', mimeType: 'application/vnd.google-apps.folder' }),
  });
  if (!c.ok) throw httpError(502, 'drive_error', `드라이브 폴더 생성 실패 (${c.status})`);
  return (await c.json()).id;
}

async function driveFindInFolder(access_token, folderId, name) {
  const safeName = name.replace(/'/g, "\\'");
  const q = encodeURIComponent(`'${folderId}' in parents and name='${safeName}' and trashed=false`);
  const r = await fetch(`${DRIVE_FILES}?q=${q}&fields=files(id,modifiedTime)&spaces=drive`, {
    headers: { Authorization: 'Bearer ' + access_token },
  });
  if (!r.ok) throw httpError(502, 'drive_error', `드라이브 파일 검색 실패 (${r.status})`);
  const data = await r.json();
  return data.files?.[0] || null;
}

async function driveReadJson(access_token, fileId) {
  const r = await fetch(`${DRIVE_FILES}/${fileId}?alt=media`, {
    headers: { Authorization: 'Bearer ' + access_token },
  });
  if (!r.ok) throw httpError(502, 'drive_error', `드라이브 파일 읽기 실패 (${r.status})`);
  return await r.json().catch(() => null);
}

async function driveWriteJson(access_token, folderId, name, existingFileId, obj) {
  if (existingFileId) {
    const r = await fetch(`${DRIVE_UPLOAD}/${existingFileId}?uploadType=media&fields=id,modifiedTime`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify(obj),
    });
    if (!r.ok) throw httpError(502, 'drive_error', `드라이브 파일 수정 실패 (${r.status})`);
    return await r.json();
  }
  const b = 'hc' + Math.random().toString(36).slice(2);
  const body =
    `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name, parents: [folderId], mimeType: 'application/json' }) +
    `\r\n--${b}\r\nContent-Type: application/json\r\n\r\n` +
    JSON.stringify(obj) +
    `\r\n--${b}--`;
  const r = await fetch(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id,modifiedTime`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': `multipart/related; boundary=${b}` },
    body,
  });
  if (!r.ok) throw httpError(502, 'drive_error', `드라이브 파일 생성 실패 (${r.status})`);
  return await r.json();
}

// ---------- 한국어 자연어 빠른 입력 파서
const KO_WDAYS = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const pad2w = (n) => String(n).padStart(2, '0');
const addDaysYmd = (baseYmd, delta) => {
  const [y, m, d] = baseYmd.split('-').map(Number);
  return ymdUTC(Date.UTC(y, m - 1, d + delta));
};

function resolveHour(period, hour, isColon) {
  let h = Number(hour);
  if (period) {
    if (/오후|저녁|밤/.test(period)) {
      if (h >= 1 && h <= 11) h += 12;
    } else if (/오전|아침|새벽/.test(period)) {
      if (h === 12) h = 0;
    }
  } else if (!isColon && h >= 1 && h <= 6) {
    // '3시 치과'처럼 오전/오후 없이 1~6시로 적으면 일상 일정상 오후로 해석
    h += 12;
  }
  return Math.max(0, Math.min(23, h));
}

function parseQuickInput(rawText, nowMs = Date.now(), tz = 'Asia/Seoul') {
  const raw = String(rawText || '').trim();
  const nowWall = utcToWall(nowMs, tz);
  const today = ymdUTC(nowWall);
  const tomorrow = addDaysYmd(today, 1);

  if (!raw || /^(\/start|\/help|\/도움|도움말?)$/i.test(raw)) return { action: 'help' };
  const connM = /^\/connect\s+([A-Za-z0-9_-]+)$/i.exec(raw);
  if (connM) return { action: 'connect', token: connM[1] };
  if (/^(\/오늘|오늘|오늘\s*일정)$/i.test(raw)) return { action: 'summary', date: today };
  if (/^(\/내일|내일|내일\s*일정)$/i.test(raw)) return { action: 'summary', date: tomorrow };
  if (/^(\/취소|취소|\/undo|되돌리기)$/i.test(raw)) return { action: 'undo' };

  let text = raw;
  let forcedKind = null;
  if (/^(\/일정|일정[:：]?)\s+/i.test(text)) {
    forcedKind = 'event';
    text = text.replace(/^(\/일정|일정[:：]?)\s+/i, '');
  } else if (/^(\/할일|할\s*일[:：]?|☐\s*|-\s*\[\s*\]\s*|\[\s*\]\s*)/i.test(text)) {
    forcedKind = 'todo';
    text = text.replace(/^(\/할일|할\s*일[:：]?|☐\s*|-\s*\[\s*\]\s*|\[\s*\]\s*)/i, '');
  } else if (/^(\/메모|메모[:：]?)\s+/i.test(text)) {
    forcedKind = 'note';
    text = text.replace(/^(\/메모|메모[:：]?)\s+/i, '');
  }

  // 날짜 파싱
  let date = today;
  let hasDate = false;
  const nowD = new Date(nowWall);
  const curY = nowD.getUTCFullYear();
  const curM = nowD.getUTCMonth() + 1;
  const curDow = nowD.getUTCDay();

  const tryDate = (re, fn) => {
    if (hasDate) return;
    const m = re.exec(text);
    if (!m) return;
    const res = fn(m);
    if (!res) return;
    date = res;
    hasDate = true;
    text = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/[ \t]+/g, ' ').trim();
  };

  tryDate(/(?:^|\s)(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?=\s|$)/, (m) => {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${pad2w(mo)}-${pad2w(d)}`;
  });
  tryDate(/(?:^|\s)(\d{1,2})월\s*(\d{1,2})일(?=\s|$)/, (m) => {
    const mo = +m[1], d = +m[2];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const y = mo < curM - 1 ? curY + 1 : curY;
    return `${y}-${pad2w(mo)}-${pad2w(d)}`;
  });
  tryDate(/(?:^|\s)(\d{1,2})\/(\d{1,2})(?=\s|$)/, (m) => {
    const mo = +m[1], d = +m[2];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const y = mo < curM - 1 ? curY + 1 : curY;
    return `${y}-${pad2w(mo)}-${pad2w(d)}`;
  });
  tryDate(/(?:^|\s)(오늘|내일|모레|글피)(?=\s|$)/, (m) => {
    const off = { 오늘: 0, 내일: 1, 모레: 2, 글피: 3 }[m[1]];
    return addDaysYmd(today, off);
  });
  tryDate(/(?:^|\s)(이번\s*주|다음\s*주)?\s*([일월화수목금토])요일(?=\s|$)/, (m) => {
    const target = KO_WDAYS[m[2]];
    let diff = (target - curDow + 7) % 7;
    if (m[1] && /다음/.test(m[1])) {
      const daysUntilNextMon = ((1 - curDow + 7) % 7) || 7;
      const offsetFromMon = (target + 6) % 7;
      diff = daysUntilNextMon + offsetFromMon;
    } else if (!m[1] && diff === 0) {
      diff = 7; // 오늘과 같은 요일을 '수요일'이라 하면 다음 수요일
    }
    return addDaysYmd(today, diff);
  });

  // 시간 파싱 (메모 강제가 아닐 때만)
  let startTime = null;
  let endTime = null;
  if (forcedKind !== 'note') {
    const tryTime = (re, fn) => {
      if (startTime) return;
      const m = re.exec(text);
      if (!m) return;
      const res = fn(m);
      if (!res) return;
      startTime = res.start;
      endTime = res.end || null;
      text = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/[ \t]+/g, ' ').trim();
    };

    // 범위: 14:00~15:30 / 오후 2시~4시 / 2시 반-4시
    tryTime(
      /(?:^|\s)(오전|오후|저녁|밤|아침|새벽)?\s*(\d{1,2})(?::(\d{2})|\s*시(?:\s*(\d{1,2})\s*분|\s*(반))?)\s*[~\-]\s*(오전|오후|저녁|밤|아침|새벽)?\s*(\d{1,2})(?::(\d{2})|\s*시(?:\s*(\d{1,2})\s*분|\s*(반))?)(?=\s|$)/,
      (m) => {
        const isColon1 = m[3] !== undefined;
        const isColon2 = m[8] !== undefined;
        const h1 = resolveHour(m[1], m[2], isColon1);
        const m1 = isColon1 ? +m[3] : m[5] ? 30 : m[4] ? +m[4] : 0;
        const p2 = m[6] || m[1];
        const h2 = resolveHour(p2, m[7], isColon2);
        const m2 = isColon2 ? +m[8] : m[10] ? 30 : m[9] ? +m[9] : 0;
        if (m1 > 59 || m2 > 59) return null;
        return { start: `${pad2w(h1)}:${pad2w(m1)}`, end: `${pad2w(h2)}:${pad2w(m2)}` };
      }
    );
    // 단일 콜론: 14:30 / 오후 3:30
    tryTime(/(?:^|\s)(오전|오후|저녁|밤|아침|새벽)?\s*(\d{1,2}):(\d{2})(?=\s|$)/, (m) => {
      const h = resolveHour(m[1], m[2], true);
      const mi = +m[3];
      if (mi > 59) return null;
      return { start: `${pad2w(h)}:${pad2w(mi)}` };
    });
    // 단일 N시 (M분|반)
    tryTime(/(?:^|\s)(오전|오후|저녁|밤|아침|새벽)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분|\s*(반))?(?=\s|$)/, (m) => {
      const h = resolveHour(m[1], m[2], false);
      const mi = m[4] ? 30 : m[3] ? +m[3] : 0;
      if (mi > 59) return null;
      return { start: `${pad2w(h)}:${pad2w(mi)}` };
    });
  }

  const title = text.trim() || raw;
  let kind = forcedKind;
  if (!kind) {
    if (startTime) kind = 'event';
    else if (hasDate && !raw.includes('\n') && title.length <= 45) kind = 'event';
    else kind = 'note';
  }

  return {
    action: 'add',
    kind,
    date,
    startTime,
    endTime,
    allDay: kind === 'event' ? !startTime : true,
    title,
    raw,
  };
}

function buildEventTimestamps(dateStr, startTime, endTime, allDay, tz) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  if (allDay || !startTime) {
    const sWall = Date.UTC(y, mo - 1, d, 0, 0, 0);
    const eWall = Date.UTC(y, mo - 1, d + 1, 0, 0, 0);
    return {
      allDay: true,
      start: new Date(wallToUtc(sWall, tz)).toISOString(),
      end: new Date(wallToUtc(eWall, tz)).toISOString(),
    };
  }
  const [sh, sm] = startTime.split(':').map(Number);
  const sWall = Date.UTC(y, mo - 1, d, sh, sm, 0);
  let eWall;
  if (endTime) {
    const [eh, em] = endTime.split(':').map(Number);
    eWall = Date.UTC(y, mo - 1, d, eh, em, 0);
    if (eWall <= sWall) eWall = sWall + 3600e3;
  } else {
    eWall = sWall + 3600e3;
  }
  return {
    allDay: false,
    start: new Date(wallToUtc(sWall, tz)).toISOString(),
    end: new Date(wallToUtc(eWall, tz)).toISOString(),
  };
}

async function addEventToDrive(access_token, item, tz) {
  const folderId = await ensureDriveFolder(access_token);
  const existing = await driveFindInFolder(access_token, folderId, 'events.json');
  let events = [];
  if (existing) {
    const raw = await driveReadJson(access_token, existing.id);
    if (Array.isArray(raw?.events)) events = raw.events;
  }
  const ts = buildEventTimestamps(item.date, item.startTime, item.endTime, item.allDay, tz);
  const id = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const ev = {
    id,
    title: item.title,
    allDay: ts.allDay,
    start: ts.start,
    end: ts.end,
    updated: Date.now(),
  };
  events.push(ev);
  await driveWriteJson(access_token, folderId, 'events.json', existing?.id || null, { v: 1, events });
  return { ok: true, kind: 'event', id, date: item.date, startTime: item.startTime, endTime: item.endTime, allDay: ts.allDay, title: item.title };
}

async function addNoteOrTodoToDrive(access_token, item) {
  const folderId = await ensureDriveFolder(access_token);
  const fileName = `${item.date}.json`;
  const existing = await driveFindInFolder(access_token, folderId, fileName);
  const now = Date.now();
  let doc = existing ? await driveReadJson(access_token, existing.id) : null;
  if (!doc || !Array.isArray(doc.pages) || !doc.pages.length) {
    doc = { v: 2, pages: [{ id: 'p' + now.toString(36) + Math.random().toString(36).slice(2, 6), height: 1414, strokes: [], kind: 'text', text: '', t: now }], updated: now };
  }
  let page = doc.pages.find((p) => !p.conflict && p.kind === 'text');
  if (!page) {
    if (doc.pages.length < 5) {
      page = { id: 'p' + now.toString(36) + Math.random().toString(36).slice(2, 6), height: 1414, strokes: [], kind: 'text', text: '', t: now };
      doc.pages.push(page);
    } else {
      page = doc.pages[0];
      page.kind = 'text';
      page.text = page.text || '';
    }
  }
  const line = item.kind === 'todo' ? `☐ ${item.title}` : item.title;
  const cur = String(page.text || '').replace(/\s+$/, '');
  page.text = cur ? `${cur}\n${line}` : line;
  page.t = now;
  doc.updated = now;
  await driveWriteJson(access_token, folderId, fileName, existing?.id || null, doc);
  return { ok: true, kind: item.kind, date: item.date, pageId: page.id, line, title: item.title };
}

async function inboxAdd(env, body) {
  const tz = validTz(env.TIMEZONE) || 'Asia/Seoul';
  let item;
  if (body?.kind && (body?.title || body?.text)) {
    const today = ymdUTC(utcToWall(Date.now(), tz));
    item = {
      action: 'add',
      kind: ['event', 'todo', 'note'].includes(body.kind) ? body.kind : 'note',
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? body.date : today,
      startTime: body.startTime || null,
      endTime: body.endTime || null,
      allDay: body.allDay !== undefined ? !!body.allDay : !body.startTime,
      title: String(body.title || body.text).trim(),
    };
  } else {
    const parsed = parseQuickInput(body?.text || '', Date.now(), tz);
    if (parsed.action !== 'add') throw httpError(400, 'not_add_command', '추가할 내용을 입력해 주세요');
    item = parsed;
  }
  const access_token = await getOwnerAccessToken(env);
  const res = item.kind === 'event'
    ? await addEventToDrive(access_token, item, tz)
    : await addNoteOrTodoToDrive(access_token, item);
  if (env.HANDCAL_KV) {
    await env.HANDCAL_KV.put('inbox_last', JSON.stringify(res), { expirationTtl: 86400 }).catch(() => {});
  }
  return res;
}

async function inboxUndo(env) {
  if (!env.HANDCAL_KV) throw httpError(501, 'kv_missing');
  const last = await env.HANDCAL_KV.get('inbox_last', 'json');
  if (!last) return { ok: false, message: '되돌릴 최근 항목이 없어요' };
  const access_token = await getOwnerAccessToken(env);
  const folderId = await ensureDriveFolder(access_token);
  if (last.kind === 'event') {
    const existing = await driveFindInFolder(access_token, folderId, 'events.json');
    if (existing) {
      const raw = await driveReadJson(access_token, existing.id);
      const events = (raw?.events || []).map((e) => (e.id === last.id ? { id: e.id, deleted: true, updated: Date.now() } : e));
      await driveWriteJson(access_token, folderId, 'events.json', existing.id, { v: 1, events });
    }
  } else {
    const fileName = `${last.date}.json`;
    const existing = await driveFindInFolder(access_token, folderId, fileName);
    if (existing) {
      const doc = await driveReadJson(access_token, existing.id);
      const page = (doc?.pages || []).find((p) => p.id === last.pageId) || (doc?.pages || []).find((p) => p.kind === 'text');
      if (page && typeof page.text === 'string') {
        const lines = page.text.split('\n');
        const idx = lines.lastIndexOf(last.line);
        if (idx >= 0) {
          lines.splice(idx, 1);
          page.text = lines.join('\n');
          page.t = Date.now();
          doc.updated = Date.now();
          await driveWriteJson(access_token, folderId, fileName, existing.id, doc);
        }
      }
    }
  }
  await env.HANDCAL_KV.delete('inbox_last').catch(() => {});
  return { ok: true, undone: last };
}

async function inboxSummary(env, dateParam) {
  const tz = validTz(env.TIMEZONE) || 'Asia/Seoul';
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(dateParam || '')) ? dateParam : ymdUTC(utcToWall(Date.now(), tz));
  const access_token = await getOwnerAccessToken(env);
  const folderId = await ensureDriveFolder(access_token);

  const [y, mo, d] = dateStr.split('-').map(Number);
  const dayStartIso = new Date(wallToUtc(Date.UTC(y, mo - 1, d, 0, 0, 0), tz)).toISOString();
  const dayEndIso = new Date(wallToUtc(Date.UTC(y, mo - 1, d + 1, 0, 0, 0), tz)).toISOString();

  const [memoEvents, naverRes, noteFile] = await Promise.all([
    readEventsFromDrive(access_token).catch(() => []),
    env.NAVER_ID && env.NAVER_APP_PASSWORD ? naverEvents(env, dayStartIso, dayEndIso).catch(() => ({ events: [] })) : Promise.resolve({ events: [] }),
    driveFindInFolder(access_token, folderId, `${dateStr}.json`).catch(() => null),
  ]);

  const dayStartMs = Date.parse(dayStartIso), dayEndMs = Date.parse(dayEndIso);
  const fmtHm = (iso) => {
    const w = new Date(utcToWall(Date.parse(iso), tz));
    return `${pad2w(w.getUTCHours())}:${pad2w(w.getUTCMinutes())}`;
  };

  const dayEvents = [];
  for (const ev of memoEvents) {
    const s = Date.parse(ev.start), e = Date.parse(ev.end || ev.start);
    if (s < dayEndMs && (e > dayStartMs || (e === s && s >= dayStartMs))) {
      dayEvents.push({ title: ev.title, time: ev.allDay ? '종일' : fmtHm(ev.start), source: '메모' });
    }
  }
  for (const ev of naverRes.events || []) {
    if (ev.allDay) {
      if (ev.start <= dateStr && ev.end > dateStr) dayEvents.push({ title: ev.title, time: '종일', source: ev.calendar || '네이버' });
    } else {
      const s = Date.parse(ev.start), e = Date.parse(ev.end || ev.start);
      if (s < dayEndMs && (e > dayStartMs || (e === s && s >= dayStartMs))) {
        dayEvents.push({ title: ev.title, time: fmtHm(ev.start), source: ev.calendar || '네이버' });
      }
    }
  }
  dayEvents.sort((a, b) => (a.time === '종일' ? -1 : b.time === '종일' ? 1 : a.time.localeCompare(b.time)));

  const todos = [];
  const notes = [];
  if (noteFile) {
    const doc = await driveReadJson(access_token, noteFile.id).catch(() => null);
    for (const p of doc?.pages || []) {
      if (p.conflict) continue;
      if (p.kind === 'text' && p.text) {
        for (const rawLine of p.text.split('\n')) {
          const l = rawLine.trim();
          if (!l) continue;
          if (/^[☐☑✓✔]/.test(l)) todos.push(l);
          else notes.push(l);
        }
      }
    }
  }
  return { ok: true, date: dateStr, events: dayEvents, todos, notes };
}

function formatSummaryText(s) {
  const lines = [`📆 ${s.date}`];
  if (s.events.length) {
    lines.push('\n[일정]');
    for (const e of s.events) lines.push(`• ${e.time} ${e.title}`);
  }
  if (s.todos.length) {
    lines.push('\n[할 일]');
    for (const t of s.todos) lines.push(t);
  }
  if (s.notes.length) {
    lines.push('\n[메모]');
    for (const n of s.notes.slice(0, 10)) lines.push(`- ${n}`);
    if (s.notes.length > 10) lines.push(`… 외 ${s.notes.length - 10}줄`);
  }
  if (!s.events.length && !s.todos.length && !s.notes.length) {
    lines.push('등록된 일정이나 메모가 없어요.');
  }
  return lines.join('\n');
}

async function tgSend(botToken, chatId, text) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  }).catch(() => {});
}

async function handleTelegramWebhook(env, secret, update) {
  const meta = await getInboxMeta(env);
  if (!meta.tgBotToken || !meta.tgSecret || secret !== meta.tgSecret) {
    throw httpError(403, 'forbidden');
  }
  const msg = update?.message;
  const chatId = msg?.chat?.id ? String(msg.chat.id) : null;
  const text = (msg?.text || '').trim();
  if (!chatId || !text) return { ok: true };

  const tz = validTz(env.TIMEZONE) || 'Asia/Seoul';
  const parsed = parseQuickInput(text, Date.now(), tz);

  // 최초 1회 페어링: /connect <토큰>
  if (parsed.action === 'connect') {
    if (parsed.token === meta.token) {
      meta.tgChatIds = Array.from(new Set([...(meta.tgChatIds || []), chatId]));
      await env.HANDCAL_KV.put('inbox_meta', JSON.stringify(meta));
      await tgSend(meta.tgBotToken, chatId, '✅ 핸드캘린더 연결 완료!\n이제 일정·할 일·메모를 편하게 보내보세요.\n\n예시:\n• 내일 3시 치과 예약\n• 11/25 연차\n• 할일 우유 사기\n• 오늘 회의 내용 메모\n• /오늘, /내일, /취소');
    } else {
      await tgSend(meta.tgBotToken, chatId, '❌ 연결 토큰이 맞지 않아요. 핸드캘린더 ⚙ → 빠른 추가에서 토큰을 확인해 주세요.');
    }
    return { ok: true };
  }

  if (!Array.isArray(meta.tgChatIds) || !meta.tgChatIds.includes(chatId)) {
    await tgSend(meta.tgBotToken, chatId, '🔒 아직 연결되지 않은 채팅이에요.\n핸드캘린더 앱 ⚙ → [빠른 추가]에서 복사한 `/connect ...` 명령어를 먼저 보내주세요.');
    return { ok: true };
  }

  try {
    if (parsed.action === 'help') {
      await tgSend(
        meta.tgBotToken,
        chatId,
        '📌 핸드캘린더 빠른 추가 사용법\n\n' +
          '• 일정: 내일 3시 치과 / 11/25 14:00~16:00 미팅 / 12월 1일 연차\n' +
          '• 할 일: 할일 우유 사기 / ☐ 내일 서류 제출\n' +
          '• 메모: 그냥 내용 입력 (또는 메모: ...)\n' +
          '• 조회: /오늘, /내일\n' +
          '• 되돌리기: /취소'
      );
    } else if (parsed.action === 'summary') {
      const s = await inboxSummary(env, parsed.date);
      await tgSend(meta.tgBotToken, chatId, formatSummaryText(s));
    } else if (parsed.action === 'undo') {
      const r = await inboxUndo(env);
      await tgSend(meta.tgBotToken, chatId, r.ok ? `↩️ 방금 추가한 항목을 취소했어요: ${r.undone.title}` : r.message);
    } else {
      const res = await inboxAdd(env, {
        kind: parsed.kind,
        date: parsed.date,
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        allDay: parsed.allDay,
        title: parsed.title,
      });
      if (res.kind === 'event') {
        const timeTxt = res.allDay ? '종일' : `${res.startTime}${res.endTime ? '~' + res.endTime : ''}`;
        await tgSend(meta.tgBotToken, chatId, `📅 일정 추가됨\n${res.date} ${timeTxt} · ${res.title}\n(되돌리기: /취소)`);
      } else if (res.kind === 'todo') {
        await tgSend(meta.tgBotToken, chatId, `☑️ 할 일 추가됨\n${res.date} · ☐ ${res.title}\n(되돌리기: /취소)`);
      } else {
        await tgSend(meta.tgBotToken, chatId, `📝 메모 추가됨\n${res.date} · ${res.title}\n(되돌리기: /취소)`);
      }
    }
  } catch (e) {
    await tgSend(meta.tgBotToken, chatId, `⚠️ 처리 실패: ${e.message || e}`);
  }
  return { ok: true };
}

export const _test = {
  parseICS, expandEvents, occurrences, linkCreate, linkClaim,
  feedTokenCreate, feedTokenGet, buildMemosIcs, buildTasksIcs, buildAllIcs,
  parseQuickInput, buildEventTimestamps, inboxConfigGet, inboxConfigSet,
};
