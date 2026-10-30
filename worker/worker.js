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

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
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
      else if (url.pathname === '/naver/events' && req.method === 'GET') {
        await requireOwner(req, env);
        body = await naverEvents(env, url.searchParams.get('start'), url.searchParams.get('end'));
      } else if (url.pathname === '/naver/test' && req.method === 'GET') {
        await requireOwner(req, env);
        body = await naverTest(env);
      } else if (url.pathname === '/') {
        body = { ok: true, service: 'handcal', naver: !!(env.NAVER_ID && env.NAVER_APP_PASSWORD), google: !!env.GOOGLE_CLIENT_SECRET };
      } else return json({ error: 'not_found' }, 404, cors);
      return json(body, 200, cors);
    } catch (e) {
      return json({ error: e.code || 'error', message: String(e.message || e) }, e.status || 500, cors);
    }
  },
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
  return { access_token: t.access_token, expires_in: t.expires_in, refresh_token: t.refresh_token || null };
}

async function refresh(env, { refresh_token }) {
  if (!refresh_token) throw httpError(400, 'no_refresh_token');
  const t = await googleToken(env, { refresh_token, grant_type: 'refresh_token' });
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
const PROPFIND_CALS = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:prop><d:resourcetype/><d:displayname/><a:calendar-color/><c:supported-calendar-component-set/></d:prop></d:propfind>';
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
const normColor = (c) => { const m = /#[0-9a-f]{6}/i.exec(c || ''); return m ? m[0] : '#03c75a'; };

let calCache = null;
async function calendars(env) {
  if (calCache && Date.now() - calCache.at < 3600e3) return calCache.cals;
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
    cals.push({
      href: abs(hrefIn(r)),
      name: decodeXml((first(r, 'displayname') || '').trim()) || '네이버 캘린더',
      color: normColor(first(r, 'calendar-color')),
    });
  }
  calCache = { at: Date.now(), cals };
  return cals;
}

async function naverTest(env) {
  calCache = null;
  const cals = await calendars(env);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
  const r = await naverEvents(env, start, end, true);
  return { calendars: cals.map((c) => ({ name: c.name, color: c.color })), eventsThisMonth: r.events.length, sample: r.events.slice(0, 5), warnings: r.warnings };
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
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const warnings = [];
  const events = [];
  await Promise.all(cals.map(async (cal) => {
    try {
      const x = await dav(env, 'REPORT', cal.href, reportQuery(fmt(start), fmt(end)), 1);
      const vevents = [];
      for (const r of responses(x)) {
        const data = first(r, 'calendar-data');
        if (data) vevents.push(...parseICS(decodeXml(data)));
      }
      events.push(...expandEvents(vevents, cal, start.getTime(), end.getTime(), tz));
    } catch (e) {
      if (e.code === 'naver_auth') throw e;
      warnings.push(`${cal.name}: ${e.message}`);
    }
  }));
  const data = { events, warnings };
  if (eventCache.size > 30) eventCache.clear();
  eventCache.set(key, { at: Date.now(), data });
  return data;
}

// ---------- iCalendar 해석
const DAY = 86400e3;
const WDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function parseICS(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
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

    const emit = (wall) => {
      if (wall > toWall || wall + dur < fromWall) return;
      if (st.allDay) {
        out.push({ id: `${uid}@${ymdUTC(wall)}`, title, allDay: true, start: ymdUTC(wall), end: ymdUTC(wall + dur), calendar: cal.name, color: cal.color });
      } else {
        const s = wallToUtc(wall, tz), e = wallToUtc(wall + dur, tz);
        out.push({ id: `${uid}@${s}`, title, allDay: false, start: new Date(s).toISOString(), end: new Date(e).toISOString(), calendar: cal.name, color: cal.color });
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

// 테스트용으로 내보냄 (Workers 런타임에는 영향 없음)
export const _test = { parseICS, expandEvents, occurrences };
