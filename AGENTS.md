# 필기 캘린더: 개발 안내 (AI·개발자용)

이 문서는 이 저장소를 이어서 개발하는 AI 코딩 도구(Claude Code, Codex, Cursor, Gemini CLI, Antigravity 등)와 사람을 위한 안내다.
사용자 설치 방법은 `README.md`, 개인정보 안내는 `privacy.md`, 진행 중인 계획은 `docs/`에 있다.

> **이 문서는 항상 최신이어야 한다.** 기능·파일 구조·데이터 형식·드라이브 파일·서버 경로·환경 변수·배포 방법을 바꾸면 **같은 커밋에서 이 문서도 고친다.**
> 계획(`docs/PLAN-*.md`)의 단계를 끝내면 그 문서의 체크 표시와 이 문서를 함께 갱신한다.
> GitHub Actions `Check`가 코드만 바뀌고 이 문서가 그대로면 경고를 남긴다.

## 한눈에

- 한 사람이 아이패드(애플 펜슬), 갤럭시(폴드·폰), 윈도우에서 같이 쓰는 **개인용 캘린더 + 메모 앱**.
- **빌드 단계가 없는 순수 HTML/CSS/JS** 앱(PWA). 프레임워크와 npm 의존성이 없다. 외부 라이브러리는 `vendor/perfect-freehand.js` 하나뿐이다.
- 앱 화면은 GitHub Pages(`https://hcna999.github.io/handcal/`)에서, 중계 서버는 Cloudflare Worker(`worker/`)에서 돌아간다.
- 데이터는 사용자의 **구글 드라이브** `필기캘린더` 폴더에 저장된다. 서버 DB는 없다.

## 파일

| 파일 | 내용 |
|---|---|
| `index.html` | 화면 뼈대. 스크립트/CSS 주소 끝의 `?v=NN`은 캐시를 깨는 버전 |
| `app.js` | 앱 전체 로직 (약 2700줄, `// ---------- 제목` 주석으로 구역이 나뉨) |
| `style.css` | 스타일. 색은 `:root` 변수, 다크 모드는 `prefers-color-scheme` + `data-theme` |
| `config.js` | 공개 설정: `GOOGLE_CLIENT_ID`, `WORKER_URL` (비밀값 아님) |
| `sw.js` | 서비스 워커(오프라인 캐시, 네트워크 우선). `CACHE = 'handcal-vNN'` |
| `worker/worker.js` | Cloudflare Worker: 구글 로그인 유지, 네이버 캘린더(CalDAV) 읽기, 손글씨 OCR(Gemini) |
| `worker/wrangler.toml` | Worker 배포 설정 (`keep_vars = true`: 대시보드 변수를 지우지 않음) |
| `.github/workflows/deploy-worker.yml` | `worker/**`가 바뀌면 Cloudflare에 자동 배포 |
| `tests/smoke.mjs` | 브라우저 기본 동작 확인 스크립트 (아래 "확인 방법") |
| `tests/features.mjs` | 기능 확인: 공휴일·음력, 기한 읽기, 검색, 내보내기, 사진 탭, 주간 시간표 |
| `tests/sync.mjs` | 동기화·안정성 확인: 두 기기 합치기·충돌 사본, 색인 파일, 오프라인 표시, 앱 잠금 (가짜 드라이브) |
| `tests/ux.mjs` | 화면 조작 확인: Esc, 탭 삭제·되돌리기·휴지통, 첫 실행 안내, 길게 누르기, ＋, 아래 탭 바 |
| `.github/workflows/check.yml` | 푸시마다 기본 동작 확인 + AGENTS.md 최신화 경고 |
| `docs/PLAN-ocr-refine.md` | 계획: 손글씨 변환을 유료 모델로 주기적으로 다듬기 |
| `docs/PLAN-improvements.md` | 계획: 기능·UI·UX 개선 목록(0~4단계, 우선순위순) |

## app.js 구역

`날짜` → `저장소(localStorage·IndexedDB)` → `구글 로그인` → `구글 드라이브` → `필기 노트(기기 저장+드라이브 동기화)` → `일정(메모 일정·네이버)` → `화면 상태` → `월간/주간/메모 모아보기/할 일 모아보기` → `하루 화면(필기 캔버스)` → `필기 탭` → `필기 → 글자(OCR 자동 변환 대기열, 달력 요약)` → `동기화 상태` → `로그인 UI` → `구글 Tasks 연동` → `설정(글자 크기·화면 모드)` → `시작(bind, init)`

## 데이터 구조

### 하루 메모: 드라이브 `필기캘린더/YYYY-MM-DD.json`

```json
{ "v": 2, "date": "2026-11-02", "updated": 1730000000000,
  "pages": [
    { "id": "p…", "kind": "text", "height": 1414, "strokes": [], "text": "회의 메모\n☐ 보고서 제출" },
    { "id": "p…", "height": 1414, "strokes": [ { "tool": "pen", "color": "#1f2328", "size": 4, "pen": true, "points": [[x, y, 압력], …] } ],
      "ocr": { "text": "…", "summary": "…", "todos": ["…"], "decisions": [], "done": [false], "at": 0, "sig": "획수:점수" } }
  ] }
```

- `pages`는 **탭**이며 최대 5개(`MAX_TABS`)다. `kind`: 없음=손글씨, `'text'`=키보드 메모, `'photo'`=사진, `'voice'`=음성. 새 날짜는 키보드 메모로 시작한다.
- 사진·음성 탭은 `media: [{id, type:'image'|'audio', mime, w, h, dur, driveId, transcribed}]`와 `text`(사진 설명·받아쓴 글)를 가진다. 파일은 기기 IndexedDB `blob:<id>`에 먼저 두고, 동기화 때 드라이브에 `media-날짜-id.jpg|webm|m4a`로 올려 `driveId`를 기록한다(`uploadMedia`). 다른 기기는 `driveId`로 내려받는다(`mediaBlob`).
- 좌표는 폭 1000 기준의 논리 단위다(`PAGE_W`=1000, `PAGE_H`=1414이고 종이를 늘리면 높이가 PAGE_H씩 커진다).
- 예전 형식(v1: 최상위에 `strokes`, `ocr`)은 `normalize()`가 첫 탭으로 바꿔 읽는다. **이 호환성을 깨지 말 것.**
- 각 탭의 `t`는 마지막으로 바뀐 시각, 문서의 `gone{탭id: 시각}`은 지운 탭 기록이다. `notes.put`이 이전 저장본과 비교해 자동으로 채운다(`stampPages`).
- **두 기기 동시 수정**: 올리기 직전 드라이브 파일 `modifiedTime`이 마지막으로 맞춘 시각(`remoteTime`)과 다르면 내려받아 탭 단위로 합친다(`notes.mergeRemote` → `mergeDocs`). 다른 탭은 둘 다 살리고, 같은 탭을 둘 다 고쳤으면 최신 것을 쓰고 다른 쪽은 '충돌 사본' 탭(`conflict: true`)으로 남긴다.
- `ocr.sig`가 지금 획 상태(`inkSig`)와 다르면 다시 변환할 대상이다.

### 그 밖의 드라이브 파일 (같은 폴더)

| 파일 | 내용 | 합치는 방식 |
|---|---|---|
| `trash.json` | 지운 탭 30일 보관(휴지통) `{탭id: {date, page, at, t}}` | 항목별 `t` 최신 (`syncedStore`) |
| `templates.json` | 메모 서식 `{id: {name, text, order, t}}` | 항목별 `t` 최신 (`syncedStore`) |
| `events.json` | 앱에서 적는 "메모 일정" | id별 `updated`가 최신인 쪽 |
| `digests.json` | 달력 칸 한 줄 요약 `{날짜: {text, todos, at}}` | 날짜별 `at`이 최신인 쪽 |
| `index.json` | 날짜별 색인 `{날짜: {p: 미리보기[{kind,text,ink}], todos, u, t}}` — 목록·검색·할 일을 문서를 다 읽지 않고 그림 | 항목별 `t` 최신 (`noteIndex`) |
| `prefs.json` | 기기끼리 같이 쓰는 설정. 지금은 `hiddenCals: {list: [끈 캘린더 이름…]}` | 항목별 `t` 최신 (`syncedStore`) |
| `gtasks.json` | 할 일 ↔ 구글 Tasks 작업 연결표 `{키: {id, done, list, t}}` | 키별 `t`가 최신인 쪽 |

- 드라이브 권한은 `drive.file`이라 **앱이 만든 파일만** 볼 수 있다.

### 기기 저장

- IndexedDB `handcal` / store `kv`에 키 `note:YYYY-MM-DD`로 하루 메모를 보관한다(드라이브 사본).
- localStorage에는 `auth`, `refresh`(구글 리프레시 토큰), `pending`(드라이브에 아직 안 올린 날짜), `digests`, `localEvents`, `gtasksMap`, `ocrQueue`, 화면 설정(`theme`, `uiScale`, `calView`, `panelHidden2`, `fingerDraw2`, `sideOpen` …), `naverCals`(마지막으로 받은 네이버 캘린더 이름·색 목록)가 있다.

## 화면 구성 (요약)

- 상단: 달력/하루 이동, 검색(돋보기), 설정(톱니바퀴 + 동기화 상태 점). 로그인·동기화 버튼은 설정 안 "계정" 칸에 있다.
- 왼쪽 캘린더 목록 창(`#cal-side`, 상단 ☰ `#side-btn`): 작은 달력(`renderMiniCal`, 날짜 누르면 그날 열기, 제목 누르면 그 달로) + 캘린더별 보이기 체크(`renderCalFilter`). 900px 이상은 옆에 붙고 열림 여부를 `sideOpen`에 기억, 좁으면 왼쪽 서랍으로 덮는다.
- 캘린더 끄고 켜기: 일정마다 `calKey(ev)`(네이버 캘린더 이름 / `메모 일정` / `공휴일`)로 묶고, `prefs`의 `hiddenCals`에 든 것은 `events.on`·`holidayOn`·검색에서 뺀다. 네이버 목록은 Worker `/naver/events` 응답의 `calendars`에서 온다.
- 휴대폰(600px 미만): 보기 전환 [월·주·메모·할 일]은 화면 아래 탭 바(`#bottom-tabs`), 오른쪽 아래 ＋(`#fab`, 길게 누르면 종류 선택).
- 하루 화면: 탭 줄 → (손글씨면) 도구 줄 → 필기장. 손글씨 위에 변환 결과 한 줄 카드(`#ocr-panel`). 일정은 상단 "일정" 버튼의 시트/패널.
- 떠 있는 메뉴는 `showMenu(e, items)`, 길게 누르기는 `onLongPress`, Esc·뒤로는 `closeTopLayer()`가 위에 열린 것부터 닫는다.
- 아직 만들지 않은 기능의 버튼은 `data-soon` 속성으로 숨긴다(완성하면 속성을 지운다).

## 할 일·기한·공휴일·검색·내보내기

- 할 일 글에서 기한을 읽는다(`parseDue`, 기준은 메모 날짜): 오늘·내일·모레, '금요일까지', '다음주 월요일', '11/7', '7일까지', '3일 뒤', '월말'. 할 일 모아보기는 기한순(지남·오늘·내일·이번 주·나중·기한 없음)·날짜순. 구글 Tasks 마감일도 이 기한(없으면 메모 날짜)이다.
- 음력은 브라우저 내장 한국 달력(`Intl.DateTimeFormat('ko-KR-u-ca-dangi')`, `lunarOf`)으로 계산한다. 공휴일·대체공휴일은 `holidaysOf(연도)`가 규칙으로 만든다(선거일 등 임시 공휴일은 없음). 설정 '음력 표시'(끔/1일·15일/매일).
- 전체 검색(돋보기, Ctrl+K, `/`)은 메모·변환된 손글씨·음성 글·사진 설명·할 일·일정 제목을 찾는다(`runSearch`).
- 내보내기(설정 또는 하루 화면 ⋯): 기간을 골라 마크다운 파일 저장 / PDF(인쇄 창) / 공유(`exportRange`).
- 안드로이드 공유 대상: `manifest.webmanifest`의 `share_target` → `sw.js`가 `share-inbox` 캐시에 두고 `./?shared=1`로 열기 → `takeShared`가 오늘 메모(글)·사진 탭에 넣는다.

## 할 일

- 키보드 메모에서 `☐`/`[ ]`로 시작하는 줄(`☑`/`[x]`는 완료)과 손글씨 OCR의 `todos`가 할 일이다(`todosOf`, `TODO_RE`).
- 구글 Tasks와 양방향으로 맞춘다(`gtasks` 객체). 앱이 만든 작업은 Tasks의 `필기캘린더` 목록에 들어간다. `필기캘린더`와 기본 목록(`@default`)에 직접 만든 작업은 마감일(없으면 오늘) 메모로 가져온다.
- 할 일 키는 `hc:날짜:hash(탭id|글)`이다. 글을 고치면 다른 할 일로 취급한다.

## 중계 서버 (worker/worker.js)

| 경로 | 하는 일 |
|---|---|
| `POST /auth/exchange` | 구글 인증 코드 → 토큰 (클라이언트 보안 비밀번호는 서버에만) |
| `POST /auth/refresh` | 리프레시 토큰으로 새 액세스 토큰 |
| `GET /naver/events?start&end` | 네이버 캘린더 일정(CalDAV, 반복 일정 펼침), 읽기 전용. 응답 `{events, calendars:[{name,color}], warnings, stats}` |
| `POST /ocr` | 손글씨 PNG → Gemini로 글자·요약·할 일 (붐비면 다른 모델로, `geminiJson`) |
| `POST /transcribe` | 녹음(앱이 16kHz 모노 WAV로 바꿔 보냄, 최대 6분) → 받아쓴 글·요약·할 일 |
| `GET /naver/test`, `/naver/debug` | 진단용 |

- 구글 토큰과 `OWNER_EMAIL`로 주인만 쓸 수 있다.
- 환경 변수는 Cloudflare 대시보드에 있다: `ALLOWED_ORIGIN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OWNER_EMAIL`, `NAVER_ID`, `NAVER_APP_PASSWORD`, `GEMINI_API_KEY`, (선택) `GEMINI_MODEL`, `GEMINI_TIMEOUT_MS`, `NAVER_CALDAV_URL`, `TIMEZONE`, `CALENDAR_COLORS`.

## 배포

- `main`에 푸시하면 앱 화면은 **GitHub Pages가 자동 배포**한다(1~2분).
- 같은 푸시에서 GitHub Actions `Check`(`.github/workflows/check.yml`)가 `tests/smoke.mjs`를 돌린다. 실패하면 바로 고친다.
- `worker/` 아래가 바뀌면 **GitHub Actions가 Cloudflare에 자동 배포**한다. 저장소 비밀값 `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`가 필요하다.
- 앱 파일(js/css/html)을 바꾸면 **반드시 두 곳의 버전을 함께 올린다.** 안 올리면 사용자 기기에 예전 파일이 남는다.
  - `sw.js`의 `CACHE = 'handcal-vNN'`
  - `index.html`의 `?v=NN` (모든 스크립트·CSS 주소)

## 확인 방법

```bash
npm i -D playwright   # 처음 한 번 (브라우저: npx playwright install chromium)
node tests/smoke.mjs  # 로컬 서버를 띄우고 기본 흐름을 확인, 오류가 있으면 종료 코드 1
```

- `node tests/ux.mjs [스크린샷 폴더]`, `node tests/features.mjs`, `node tests/sync.mjs`로 화면 조작·기능·동기화도 확인한다.
- 스크립트는 구글 연결 없이 "이 기기에만 저장" 모드로 돈다. 첫 실행 안내는 `localStorage.onboarded`로 건너뛴다.
- 구글·드라이브·Tasks·Worker가 얽힌 기능은 Playwright `page.route()`로 가짜 응답을 만들어 시험한다. 서비스 워커가 가로채지 않도록 `browser.newContext({ serviceWorkers: 'block' })`를 쓴다.

## 지켜야 할 것

- **비밀값을 저장소에 넣지 않는다.** 저장소는 공개(public)다. `config.js`에는 공개해도 되는 값만 둔다.
- 코드 주석과 화면 글은 **한국어**로 쓴다. 사용자는 한국어 사용자다. 기존 코드처럼 짧은 주석으로 "왜"를 적는다.
- 프레임워크나 빌드 도구를 들이지 않는다. 파일을 그대로 올리면 동작해야 한다.
- **앱 잠금**(설정 → 앱 잠금): 기기마다 PIN(SHA-256 + salt로 localStorage `lock`) + 가능하면 지문·얼굴(WebAuthn 플랫폼 인증). 화면만 잠그고 데이터는 암호화하지 않는다. 다른 앱에 정한 시간(바로/5분/30분) 이상 있다 돌아오면 다시 잠근다.
- 오프라인이면 상단 막대(`#offline-bar`)와 회색 상태 점, 다시 연결되면 밀린 것을 올리고 알린다.
- 대상 화면: 아이패드 1180×820(펜), 갤럭시 폴드 펼침 약 884×1028·접힘 약 412×915(터치), 윈도우 마우스. 글자 크기는 화면 크기로 자동 계산된다(`autoFontPx`).
- 아이패드·아이폰은 설치 안내가 자동으로 뜨지 않으므로, 브라우저로 열면 '홈 화면에 추가' 안내를 한 번 보여준다(`showInstallHint`). 홈 화면에서 열면 `manifest.webmanifest`의 `display: standalone`으로 전체 화면이 된다.
- 손가락은 기본으로 화면 이동, 필기는 펜으로만 한다.
- 손글씨 도구: 펜·형광펜·지우개·올가미(`lasso`: 둘러싸서 옮기기·색 바꾸기·지우기, 선택 막대 `#sel-bar`). 확대·축소는 두 손가락(`pinch`)·Ctrl+휠·[−][100%][+](`setZoom`, 0.5~3배, 좌표는 `toPage`가 배율 반영). 종이 배경은 탭의 `paper`('grid'|'dot'|'blank', 없으면 줄). 펜 압력 감도는 설정 `pressure`(light/normal/heavy, `pressureCurve`) — 바꾸면 `pathCache`를 새로 만든다. iPad Safari는 이미 보낸 펜 이동 이벤트를 다시 보낼 때가 있다(`lastTime`으로 거름).
- 드라이브·Tasks에서 무언가를 **지우는 코드는 보수적으로** 작성한다. 정보가 불확실하면 지우지 않는다(`gtasks._run`의 안전장치 참고).
