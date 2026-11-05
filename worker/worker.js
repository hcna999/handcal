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
//   GEMINI_API_KEY        (비밀) 손글씨 → 글자 변환용 (aistudio.google.com 무료 키)
//   GEMINI_MODEL          (선택) 먼저 쓸 모델. 기본 순서: gemini-2.5-flash → 2.5-flash-lite → …
//   CALENDAR_COLORS       (선택) {"캘린더 이름":"#a48ce0"} 형식으로 캘린더 색 직접 지정

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
      } else if (url.pathname === '/naver/debug' && req.method === 'GET') {
        await requireOwner(req, env);
        body = await naverDebug(env);
      } else if (url.pathname === '/ocr' && req.method === 'POST') {
        await requireOwner(req, env);
        body = await ocr(env, await req.json());
      } else if (url.pathname === '/transcribe' && req.method === 'POST') {
        await requireOwner(req, env);
        body = await transcribe(env, await req.json());
      } else if (url.pathname === '/link/create' && req.method === 'POST') {
        await requireOwner(req, env);
        body = await linkCreate(env, await req.json());
      } else if (url.pathname === '/link/claim' && req.method === 'POST') {
        body = await linkClaim(env, await req.json()); // 아직 로그인 안 된 창이 부르므로 주인 확인 없음(코드 자체가 열쇠)
      } else if (url.pathname === '/refine/register' && req.method === 'POST') {
        await requireOwner(req, env);
        body = await refineRegister(env, await req.json());
      } else if (url.pathname === '/refine/status' && req.method === 'GET') {
        await requireOwner(req, env);
        body = await refineStatus(req, env);
      } else if (url.pathname === '/refine/run' && req.method === 'POST') {
        await requireOwner(req, env);
        const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
        body = await refineRun(env, { dry: url.searchParams.get('dry') === '1', token, body: await req.json().catch(() => ({})) });
      } else if (url.pathname === '/') {
        body = { ok: true, service: 'handcal', link: !!env.HANDCAL_KV, naver: !!(env.NAVER_ID && env.NAVER_APP_PASSWORD), google: !!env.GOOGLE_CLIENT_SECRET, gemini: !!env.GEMINI_API_KEY };
      } else return json({ error: 'not_found' }, 404, cors);
      return json(body, 200, cors);
    } catch (e) {
      return json({ error: e.code || 'error', message: String(e.message || e) }, e.status || 500, cors);
    }
  },
  scheduled(event, env, ctx) {
    ctx.waitUntil(refineRun(env, { dry: false, scheduled: true }).catch((e) => console.error('refine cron:', e.message)));
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

// ---------- 손글씨 → 글자 (Gemini)
const OCR_PROMPT = `이 이미지는 태블릿에 손으로 쓴 메모 또는 회의 필기야. 아래 항목을 JSON으로 답해.
1) text: 손글씨를 보이는 그대로 글자로 옮겨. 줄바꿈, 목록 기호(-, •, 숫자), 화살표(→)는 유지해. 읽기 어려운 글자는 문맥으로 추정하되 확신이 없으면 [?]를 붙여. 그림·도형은 [그림: 짧은 설명]으로 적어. 내용을 고치거나 덧붙이지 마. 영어로 쓴 부분은 영어 그대로.
2) summary: 핵심 내용을 한국어 1~3문장으로 요약. 내용이 너무 짧거나 의미가 없으면 빈 문자열.
3) todos: 해야 할 일 목록. 담당자나 기한이 적혀 있으면 포함. 없으면 빈 배열.
4) decisions: 결정된 사항 목록. 없으면 빈 배열.`;

const OCR_SCHEMA = {
  type: 'OBJECT',
  properties: {
    text: { type: 'STRING' },
    summary: { type: 'STRING' },
    todos: { type: 'ARRAY', items: { type: 'STRING' } },
    decisions: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['text', 'summary', 'todos', 'decisions'],
};

// Gemini에 그림·소리와 함께 물어보고 JSON으로 받음. 무료 서버가 붐비거나(503) 늦으면 더 가벼운 모델로 넘어감
async function geminiJson(env, parts, schema, { deadlineMs = 50000 } = {}) {
  if (!env.GEMINI_API_KEY) throw httpError(500, 'gemini_not_configured', '서버에 GEMINI_API_KEY가 설정되지 않았어요');
  const models = [...new Set([env.GEMINI_MODEL, 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-flash-latest'].filter(Boolean))];
  const perModelMs = Number(env.GEMINI_TIMEOUT_MS) || 20000;
  const deadline = Date.now() + deadlineMs;
  const fails = [];
  for (const model of models) {
    const remaining = deadline - Date.now();
    if (remaining < 3000) break;
    const generationConfig = { temperature: 0.2, responseMimeType: 'application/json', responseSchema: schema };
    // 받아쓰기에는 생각 단계가 필요 없음 → 끄면 훨씬 빠름 (2.5 계열만 지원)
    if (/^gemini-2\.5-flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
    let r;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ parts }], generationConfig }),
        signal: AbortSignal.timeout(Math.min(perModelMs, remaining)),
      });
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') { fails.push({ model, kind: 'timeout' }); continue; }
      throw e;
    }
    const data = await r.json().catch(() => ({}));
    const msg = data.error?.message || '';
    if (r.status === 400 && /API key/i.test(msg)) throw httpError(502, 'gemini_key', 'Gemini API 키가 올바르지 않아요');
    // 없는 모델(404), 사용량 초과(429, 무료 한도는 모델마다 따로), 붐빔(500/503) → 다음 모델
    if ([404, 429, 500, 503].includes(r.status)) {
      fails.push({ model, kind: r.status === 429 ? 'quota' : r.status === 404 ? 'missing' : 'busy', msg });
      continue;
    }
    if (!r.ok) throw httpError(502, 'gemini_error', `Gemini ${r.status}: ${msg.slice(0, 200)}`);
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    let out;
    try { out = JSON.parse(text); } catch { out = { text }; }
    return { out, model, tried: fails.map((f) => `${f.model}:${f.kind}`) };
  }
  const kinds = new Set(fails.map((f) => f.kind));
  const detail = fails.map((f) => `${f.model}:${f.kind}`).join(', ');
  if (kinds.has('busy') || kinds.has('timeout')) throw httpError(503, 'gemini_busy', `지금 Gemini 무료 서버가 붐벼요. 1~2분 뒤 다시 시도해 주세요. (${detail})`);
  if (kinds.has('quota')) throw httpError(429, 'gemini_quota', `무료 사용량을 다 썼어요. 잠시 후(또는 내일) 다시 시도해 주세요. (${detail})`);
  throw httpError(502, 'gemini_model', `사용 가능한 Gemini 모델을 찾지 못했어요. (${detail})`);
}

const toList = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

async function ocr(env, body) {
  const image = String(body?.image || '').replace(/^data:image\/\w+;base64,/, '');
  if (!image || image.length > 15e6) throw httpError(400, 'bad_image', '이미지가 없거나 너무 커요');
  const terms = Array.isArray(body.glossary) ? body.glossary.map(String).filter(Boolean).slice(0, 80) : [];
  const prompt = OCR_PROMPT
    + (body.date ? `\n(필기 날짜: ${String(body.date).slice(0, 10)})` : '')
    + (terms.length ? `\n(자주 쓰는 고유명사·용어집 — 이 표기를 우선 따를 것: ${terms.join(', ')})` : '');
  const { out, model, tried } = await geminiJson(env, [{ text: prompt }, { inline_data: { mime_type: 'image/png', data: image } }], OCR_SCHEMA);
  return { text: String(out.text || ''), summary: String(out.summary || ''), todos: toList(out.todos), decisions: toList(out.decisions), model, tried };
}

// ---------- 음성 → 글자 (Gemini). 앱이 16kHz 모노 WAV로 바꿔서 보냄
const TRANSCRIBE_PROMPT = `이 녹음은 한국어 음성 메모 또는 회의 녹음이야. 아래 항목을 JSON으로 답해.
1) text: 말한 내용을 빠짐없이 받아 적어. 말하는 사람이 여럿이면 줄을 바꿔. 군말(음, 어)은 빼고, 들리지 않는 부분은 [?]로 표시해.
2) summary: 핵심을 한국어 1~3문장으로. 짧으면 빈 문자열.
3) todos: 해야 할 일 목록 (담당자·기한이 들리면 포함). 없으면 빈 배열.`;
const TRANSCRIBE_SCHEMA = {
  type: 'OBJECT',
  properties: { text: { type: 'STRING' }, summary: { type: 'STRING' }, todos: { type: 'ARRAY', items: { type: 'STRING' } } },
  required: ['text', 'summary', 'todos'],
};
async function transcribe(env, body) {
  const audio = String(body?.audio || '');
  const mime = /^audio\/[\w.+-]+$/.test(body?.mime || '') ? body.mime : 'audio/wav';
  if (!audio || audio.length > 19e6) throw httpError(400, 'bad_audio', '녹음이 없거나 너무 길어요 (6분 이하)');
  const { out, model, tried } = await geminiJson(env, [{ text: TRANSCRIBE_PROMPT }, { inline_data: { mime_type: mime, data: audio } }], TRANSCRIBE_SCHEMA, { deadlineMs: 55000 });
  return { text: String(out.text || ''), summary: String(out.summary || ''), todos: toList(out.todos), model, tried };
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

// ---------- 손글씨 유료 모델 다듬기 (PLAN-ocr-refine)
const REFINE_PROMPT = `당신은 한국어 손글씨 메모를 판독·교정하는 편집자입니다.
첨부된 이미지는 태블릿에 손으로 쓴 메모이고, [초벌]은 빠른 무료 모델이 먼저 읽은 결과입니다.
1) 이미지를 직접 다시 읽고, 초벌에서 잘못 읽은 글자를 고치세요 (예: 흘림체 오독 교정).
2) 문맥상 말이 되게 다듬되, 이미지에 없는 내용을 추가하거나 의미를 바꾸지 마세요.
3) 확신이 없는 글자는 [?]를 붙여 남기세요. 그림·도형은 [그림: 짧은 설명]으로 둡니다.
4) [용어집]의 고유명사 표기를 우선 따르세요. 날짜·일정은 [문맥]을 참고만 하세요.
5) 할 일(todos) 문구가 바뀌었다면 todoMap에 {from: 기존 초벌 할 일, to: 다듬은 할 일}로 짝지어 주세요.
6) 새로 발견한 사람 이름·부서·프로젝트·약어 등 고유명사는 properNouns에 넣어 주세요.`;

const REFINE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    text: { type: 'STRING' },
    summary: { type: 'STRING' },
    todos: { type: 'ARRAY', items: { type: 'STRING' } },
    decisions: { type: 'ARRAY', items: { type: 'STRING' } },
    changes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { from: { type: 'STRING' }, to: { type: 'STRING' }, reason: { type: 'STRING' } },
        required: ['from', 'to'],
      },
    },
    properNouns: { type: 'ARRAY', items: { type: 'STRING' } },
    todoMap: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { from: { type: 'STRING' }, to: { type: 'STRING' } },
        required: ['from', 'to'],
      },
    },
  },
  required: ['text', 'summary', 'todos', 'decisions', 'changes', 'properNouns', 'todoMap'],
};

const memKv = new Map();
async function kvKey(env) {
  const secret = env.GOOGLE_CLIENT_SECRET || env.GEMINI_API_KEY || 'handcal-default-key';
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function saveRefreshToken(env, token) {
  memKv.set('refresh_token', token);
  if (!env.HANDCAL_KV) return 'memory';
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await kvKey(env), new TextEncoder().encode(token)));
  const b64 = (u8) => btoa(String.fromCharCode(...u8));
  await env.HANDCAL_KV.put('refresh_token', JSON.stringify({ iv: b64(iv), data: b64(enc), at: Date.now() }));
  return 'kv';
}
async function loadRefreshToken(env) {
  if (env.HANDCAL_KV) {
    const raw = await env.HANDCAL_KV.get('refresh_token', 'json').catch(() => null);
    if (raw?.iv && raw?.data) {
      try {
        const u8 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
        const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8(raw.iv) }, await kvKey(env), u8(raw.data));
        return new TextDecoder().decode(dec);
      } catch {}
    }
  }
  return memKv.get('refresh_token') || null;
}

async function refineRegister(env, body) {
  const rt = String(body?.refresh_token || '').trim();
  if (!rt) throw httpError(400, 'no_refresh_token', '리프레시 토큰이 없어요');
  const storage = await saveRefreshToken(env, rt);
  return { ok: true, storage };
}

async function refineStatus(req, env) {
  const rt = await loadRefreshToken(env);
  let token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (rt) {
    try { token = (await refresh(env, { refresh_token: rt })).access_token; } catch {}
  }
  let driveOk = false;
  if (token) {
    const r = await fetch('https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id)', {
      headers: { Authorization: 'Bearer ' + token },
    }).catch(() => null);
    driveOk = !!r?.ok;
  }
  return {
    registered: !!rt,
    kvBound: !!env.HANDCAL_KV,
    driveOk,
    model: env.REFINE_MODEL || 'gemini-2.5-pro',
    maxPages: Number(env.REFINE_MAX_PAGES_PER_RUN) || 20,
    monthlyBudgetUsd: Number(env.REFINE_MONTHLY_BUDGET_USD) || 5,
    daysBack: Number(env.REFINE_DAYS_BACK) || 14,
  };
}

async function refineOne(env, { image, draft, date, events, otherText, glossary }) {
  if (!env.GEMINI_API_KEY) throw httpError(500, 'gemini_not_configured', '서버에 GEMINI_API_KEY가 설정되지 않았어요');
  const img = String(image || '').replace(/^data:image\/\w+;base64,/, '');
  if (!img) throw httpError(400, 'bad_image', '손글씨 이미지가 없어요');
  const ctxLines = [
    REFINE_PROMPT,
    date ? `[날짜] ${date}` : '',
    Array.isArray(events) && events.length ? `[그날 일정] ${events.join(', ')}` : '',
    otherText ? `[같은 날 다른 탭 메모] ${String(otherText).slice(0, 600)}` : '',
    Array.isArray(glossary) && glossary.length ? `[용어집] ${glossary.slice(0, 120).join(', ')}` : '',
    `[초벌 글자]\n${String(draft?.text || '')}`,
    draft?.todos?.length ? `[초벌 할 일]\n${draft.todos.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');

  const models = [...new Set([env.REFINE_MODEL, 'gemini-2.5-pro', 'gemini-2.5-flash'].filter(Boolean))];
  let lastErr = null;
  for (const model of models) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: ctxLines }, { inline_data: { mime_type: 'image/png', data: img } }] }],
        generationConfig: { temperature: 0.15, responseMimeType: 'application/json', responseSchema: REFINE_SCHEMA },
      }),
      signal: AbortSignal.timeout(45000),
    }).catch((e) => { lastErr = e; return null; });
    if (!r) continue;
    const data = await r.json().catch(() => ({}));
    if ([404, 429, 500, 503].includes(r.status)) { lastErr = new Error(data.error?.message || `HTTP ${r.status}`); continue; }
    if (!r.ok) throw httpError(502, 'gemini_error', data.error?.message || `HTTP ${r.status}`);
    const raw = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    const out = JSON.parse(raw || '{}');
    const u = data.usageMetadata || {};
    const inTok = Number(u.promptTokenCount) || 1500;
    const outTok = Number(u.candidatesTokenCount) || 400;
    // 대략적인 비용 추정 (Pro 기준 입력 $1.25/1M, 출력 $10/1M)
    const costUsd = Math.round(((inTok * 1.25 + outTok * 10) / 1e6) * 10000) / 10000;
    return {
      text: String(out.text || draft?.text || ''),
      summary: String(out.summary || ''),
      todos: toList(out.todos),
      decisions: toList(out.decisions),
      changes: Array.isArray(out.changes) ? out.changes.slice(0, 20) : [],
      properNouns: toList(out.properNouns).slice(0, 30),
      todoMap: Array.isArray(out.todoMap) ? out.todoMap : [],
      model,
      tokens: inTok + outTok,
      costUsd,
    };
  }
  throw httpError(503, 'refine_failed', lastErr?.message || '다듬기 모델을 호출하지 못했어요');
}

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UP = 'https://www.googleapis.com/upload/drive/v3/files';
const strHash36 = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

async function dFetch(token, url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } });
  if (!r.ok) throw httpError(r.status, 'drive_error', `Drive ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r;
}
async function dJson(token, url, opts) { return (await dFetch(token, url, opts)).json(); }
async function dSaveJson(token, folderId, existingId, name, payload) {
  if (existingId) {
    return dJson(token, `${DRIVE_UP}/${existingId}?uploadType=media&fields=id,modifiedTime`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
  }
  const b = 'hc' + Math.random().toString(36).slice(2);
  const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folderId], mimeType: 'application/json' })}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n--${b}--`;
  return dJson(token, `${DRIVE_UP}?uploadType=multipart&fields=id,modifiedTime`, {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body,
  });
}

async function refineRun(env, { dry = false, scheduled = false, token: reqToken = '', body = {} } = {}) {
  // 1) 앱에서 현재 탭 그림+초벌을 직접 보낸 경우 즉시 1건 다듬기
  if (body?.image && body?.draft) {
    return refineOne(env, body);
  }
  // 2) 드라이브 스캔 다듬기 (예약 실행 또는 수동 일괄 실행)
  let token = reqToken;
  const rt = await loadRefreshToken(env);
  if (rt && (scheduled || !token)) {
    const t = await refresh(env, { refresh_token: rt });
    token = t.access_token;
  }
  if (!token) {
    if (scheduled) return { ok: true, skipped: 'no_token', refined: [] }; // 예약 실행인데 토큰을 아직 안 넣었으면 조용히 건너뜀
    throw httpError(400, 'no_drive_token', '서버에 등록된 드라이브 토큰이 없어요');
  }

  const fq = encodeURIComponent("name='필기캘린더' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const fr = await dJson(token, `${DRIVE_API}?q=${fq}&fields=files(id)`);
  const folderId = fr.files?.[0]?.id;
  if (!folderId) return { ok: true, refined: [], reason: 'no_folder' };

  const lq = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const lr = await dJson(token, `${DRIVE_API}?q=${lq}&fields=files(id,name,modifiedTime)&pageSize=1000`);
  const byName = new Map((lr.files || []).map((f) => [f.name, f]));

  const readJsonFile = async (name, fallback) => {
    const f = byName.get(name);
    if (!f) return { id: null, data: fallback };
    try { return { id: f.id, data: await dJson(token, `${DRIVE_API}/${f.id}?alt=media`) }; }
    catch { return { id: f.id, data: fallback }; }
  };

  const logFile = await readJsonFile('refine-log.json', { v: 1, runs: [] });
  const runs = Array.isArray(logFile.data?.runs) ? logFile.data.runs : [];
  const ym = new Date().toISOString().slice(0, 7);
  const spentUsd = runs.filter((r) => (r.date || '').startsWith(ym)).reduce((a, r) => a + (Number(r.costUsd) || 0), 0);
  const budgetUsd = Number(env.REFINE_MONTHLY_BUDGET_USD) || 5;
  if (spentUsd >= budgetUsd) return { ok: true, skipped: 'budget_exceeded', spentUsd, budgetUsd, refined: [] };

  const glFile = await readJsonFile('glossary.json', { v: 1, items: {} });
  const glItems = glFile.data?.items || {};
  const glossary = Object.entries(glItems).filter(([, v]) => !v.deleted && v.word).map(([, v]) => v.word);

  const dgFile = await readJsonFile('digests.json', { v: 1, days: {} });
  const digests = dgFile.data?.days || {};
  const gtFile = await readJsonFile('gtasks.json', { v: 1, map: {} });
  const gtMap = gtFile.data?.map || {};
  let gtChanged = false, glChanged = false, dgChanged = false;

  const daysBack = Number(env.REFINE_DAYS_BACK) || 14;
  const maxPages = Number(env.REFINE_MAX_PAGES_PER_RUN) || 20;
  const minDate = new Date(Date.now() - daysBack * DAY).toISOString().slice(0, 10);
  const targetDate = body?.date ? String(body.date).slice(0, 10) : null;
  const noteFiles = [...byName.values()]
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f.name))
    .map((f) => ({ ...f, ds: f.name.slice(0, 10) }))
    .filter((f) => (targetDate ? f.ds === targetDate : f.ds >= minDate))
    .sort((a, b) => b.ds.localeCompare(a.ds));

  const refined = [];
  let totalCost = 0, totalTokens = 0;

  for (const nf of noteFiles) {
    if (refined.length >= maxPages) break;
    const doc = await dJson(token, `${DRIVE_API}/${nf.id}?alt=media`).catch(() => null);
    if (!doc || !Array.isArray(doc.pages)) continue;
    let docChanged = false;
    for (const p of doc.pages) {
      if (refined.length >= maxPages) break;
      const o = p.ocr;
      if (!p.strokes?.length || !o || o.userEdited || o.quality === 'refined' || !o.imageId) continue;
      const sig = p.strokes.length + ':' + p.strokes.reduce((a, s) => a + (s.points?.length || 0), 0);
      if (o.sig && o.sig !== sig) continue;
      if (scheduled && Date.now() - (p.t || doc.updated || 0) < 3600e3) continue;

      // 드라이브에서 손글씨 PNG 내려받기
      let imgB64 = '';
      try {
        const ir = await dFetch(token, `${DRIVE_API}/${o.imageId}?alt=media`);
        const u8 = new Uint8Array(await ir.arrayBuffer());
        let bin = '';
        for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode(...u8.subarray(i, i + 8192));
        imgB64 = btoa(bin);
      } catch { continue; }

      const otherText = doc.pages.filter((x) => x.id !== p.id).map((x) => x.text || x.ocr?.text || '').filter(Boolean).join('\n');
      const res = await refineOne(env, { image: imgB64, draft: o, date: nf.ds, otherText, glossary });
      totalCost += res.costUsd;
      totalTokens += res.tokens;
      refined.push({ date: nf.ds, pageId: p.id, model: res.model, changes: res.changes, before: o.text, after: res.text, costUsd: res.costUsd });

      if (dry) continue;

      // 할 일 체크 상태·Tasks 연결표(todoMap) 이어받기
      const mapFromTo = new Map((res.todoMap || []).map((m) => [m.from, m.to]));
      const oldTodos = o.todos || [], oldDone = o.done || [];
      const newDone = (res.todos || []).map((nt) => {
        const direct = oldTodos.indexOf(nt);
        if (direct >= 0) return !!oldDone[direct];
        const fromIdx = oldTodos.findIndex((ot) => mapFromTo.get(ot) === nt);
        return fromIdx >= 0 ? !!oldDone[fromIdx] : false;
      });
      for (const [fromT, toT] of mapFromTo) {
        if (!fromT || !toT || fromT === toT) continue;
        const oldKey = `hc:${nf.ds}:${strHash36(p.id + '|' + fromT)}`;
        const newKey = `hc:${nf.ds}:${strHash36(p.id + '|' + toT)}`;
        if (gtMap[oldKey] && !gtMap[oldKey].deleted) {
          gtMap[newKey] = { ...gtMap[oldKey], renameTitle: toT, t: Date.now() };
          gtMap[oldKey] = { deleted: true, movedTo: newKey, t: Date.now() };
          gtChanged = true;
        }
      }

      for (const w of res.properNouns || []) {
        const k = 'w_' + strHash36(w);
        if (!glItems[k]) { glItems[k] = { word: w, source: 'ai', t: Date.now() }; glChanged = true; glossary.push(w); }
      }

      p.ocr = {
        ...o,
        draft: o.draft || { text: o.text, summary: o.summary, todos: o.todos, decisions: o.decisions, at: o.at, model: o.model },
        text: res.text,
        summary: res.summary,
        todos: res.todos,
        decisions: res.decisions,
        done: newDone,
        quality: 'refined',
        refinedAt: Date.now(),
        refinedModel: res.model,
        changes: res.changes,
      };
      p.t = Date.now();
      docChanged = true;
    }

    if (docChanged && !dry) {
      // 저장 직전 modifiedTime 재확인 (사용자가 쓰는 중이면 건너뜀)
      const meta = await dJson(token, `${DRIVE_API}/${nf.id}?fields=modifiedTime`).catch(() => null);
      if (!meta || meta.modifiedTime !== nf.modifiedTime) continue;
      doc.updated = Date.now();
      await dSaveJson(token, folderId, nf.id, nf.name, doc);
      const parts = doc.pages.map((p) => p.kind === 'text' ? (p.text || '').split('\n')[0] : p.ocr?.summary || (p.ocr?.text || '').split('\n')[0] || '').filter(Boolean);
      const text = parts.join(' · ').slice(0, 120);
      if (text) { digests[nf.ds] = { ...(digests[nf.ds] || {}), text, at: Date.now() }; dgChanged = true; }
    }
  }

  if (!dry && refined.length) {
    if (dgChanged) {
      // 다듬는 동안 기기에서 고친 요약이 있을 수 있으니 저장 직전에 다시 읽어 날짜별로 최신(at)만 덮어씀
      const latest = (await readJsonFile('digests.json', { v: 1, days: {} })).data?.days || {};
      for (const [ds, v] of Object.entries(digests)) if (!latest[ds] || (v.at || 0) > (latest[ds].at || 0)) latest[ds] = v;
      await dSaveJson(token, folderId, dgFile.id, 'digests.json', { v: 1, days: latest });
    }
    if (glChanged) await dSaveJson(token, folderId, glFile.id, 'glossary.json', { v: 1, items: glItems });
    if (gtChanged) await dSaveJson(token, folderId, gtFile.id, 'gtasks.json', { v: 1, map: gtMap });
    runs.unshift({
      at: Date.now(),
      date: new Date().toISOString().slice(0, 10),
      count: refined.length,
      tokens: totalTokens,
      costUsd: Math.round(totalCost * 10000) / 10000,
      items: refined.map(({ date, pageId, model, changes }) => ({ date, pageId, model, changes: (changes || []).slice(0, 5) })),
    });
    await dSaveJson(token, folderId, logFile.id, 'refine-log.json', { v: 1, runs: runs.slice(0, 90) });
  }

  return { ok: true, dry, refined, totalTokens, costUsd: Math.round(totalCost * 10000) / 10000, spentUsd: Math.round((spentUsd + (dry ? 0 : totalCost)) * 10000) / 10000, budgetUsd };
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
export const _test = { parseICS, expandEvents, occurrences, linkCreate, linkClaim };
