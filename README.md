# 필기 캘린더

아이패드(애플 펜슬), 갤럭시(S펜·터치), 윈도우(마우스·펜)에서 함께 쓰는 개인용 필기 캘린더 + 메모 + 목표 관리 PWA 앱입니다.

- **월간·주간 달력**: 네이버 캘린더(CalDAV 읽기 전용)와 메모 일정이 함께 표시되며, 음력 및 대한민국 공휴일, 상단 할 일 마감 알림 줄(`오늘 마감 N · 기한 지남 N`) 제공
- **날짜별 다채로운 탭 (최대 5개)**: 손글씨 필기장(펜/형광펜/지우개/올가미/종이서식/압력감도), 키보드 메모, 사진 첨부(카메라·앨범), 음성 녹음 메모
- **손글씨 OCR & AI 정밀 다듬기**: 필기를 Gemini AI로 텍스트·할 일·요약으로 변환하며, 개인 용어집 기반 정밀 다듬기 및 초벌 비교/되돌리기 지원
- **스마트 할 일 & 구글 Tasks 연동**: 메모 내 `☐` 기호와 손글씨 할 일을 모아보고, '금요일까지' 등 자연어 기한을 자동 인식하며 구글 Tasks와 양방향 동기화
- **인생 목표 사다리**: 버킷리스트 / 연간 / 월간 / 주간 4단계 독립 목표 관리. 일일 메모 작성 시 목표 사다리가 연계되어 하루와 인생을 연결
- **완전한 데이터 소유 & 안전한 동기화**:
  - 구글 드라이브 `필기캘린더` 폴더에 날짜별 파일(`YYYY-MM-DD.json`)로 저장 (별도 서버 DB 없음)
  - 두 기기 동시 수정 시 탭 단위 자동 병합(충돌 사본 보존)
  - 월간 자동 백업(`backup-YYYY-MM.json`) 및 30일 휴지통 보관
  - 기기 간 8자리 1회용 연결 코드로 간편 로그인 이전
  - 오프라인 PWA 지원 및 앱 잠금(생체 인증 / PIN)

`config.js`에 클라이언트 ID가 없으면 기기에만 저장되는 로컬 모드로 동작합니다.

---

## 1. 구글 연결 설정 (최초 1회, 약 10분)

1. https://console.cloud.google.com 접속 → 상단에서 **새 프로젝트** 생성 (이름 예: `handcal`)
2. **API 및 서비스 → 라이브러리**에서 아래 두 개를 검색해 **사용** 클릭
   - Google Drive API
   - Google Calendar API
3. **Google 인증 플랫폼(OAuth 동의 화면)**
   - 앱 이름: `필기 캘린더`, 지원 이메일: 본인 메일
   - 대상(User type): **외부(External)**
   - 게시 상태는 **테스트(Testing)** 그대로 두고, **테스트 사용자**에 본인 구글 계정 추가
4. **클라이언트(사용자 인증 정보) → OAuth 클라이언트 ID 만들기**
   - 애플리케이션 유형: **웹 애플리케이션**
   - **승인된 JavaScript 원본**에 추가:
     - `https://<깃허브아이디>.github.io` (2단계에서 올릴 주소)
     - `http://localhost:8000` (PC에서 테스트용, 선택)
5. 만들어진 **클라이언트 ID**(`xxxx.apps.googleusercontent.com`)를 `config.js`에 붙여넣기

   ```js
   window.APP_CONFIG = { GOOGLE_CLIENT_ID: 'xxxx.apps.googleusercontent.com' };
   ```

> 처음 로그인할 때 "Google에서 확인하지 않은 앱" 경고가 나오는데, 본인이 만든 앱이므로 **고급 → 계속**을 누르면 됩니다.
> 앱은 직접 만든 파일(`drive.file`)과 캘린더 일정에만 접근합니다. 드라이브의 다른 파일은 볼 수 없습니다.

## 1-2. 중계 서버 (네이버 캘린더 + 로그인 유지) — Cloudflare 무료

브라우저 앱은 네이버 캘린더에 직접 접속할 수 없어서 작은 서버(`worker/worker.js`)를 거칩니다.
이 서버가 구글 로그인도 계속 유지해 줘서 1시간마다 다시 로그인할 필요가 없어집니다.

**A. 네이버 애플리케이션 비밀번호 만들기**
1. 네이버 로그인 → 내정보(https://nid.naver.com/user2/help/myInfo) → **보안설정**
2. **2단계 인증 → 애플리케이션 비밀번호 관리** → 종류 "기타", 이름 `handcal` → 생성
3. 나온 비밀번호를 복사 (네이버 비밀번호 대신 이걸 씁니다)

**B. 구글 클라이언트 보안 비밀번호 복사**
- https://console.cloud.google.com/auth/clients → 만든 클라이언트 클릭 → **클라이언트 보안 비밀번호** 복사
- https://console.cloud.google.com/auth/audience → **앱 게시**(프로덕션으로 푸시)
  - 테스트 상태로 두면 7일마다 로그인이 풀립니다. 이 앱은 민감하지 않은 권한(본인이 만든 드라이브 파일, 이메일)만 써서 심사 없이 게시됩니다.

**C. Cloudflare Worker 만들기**
1. https://dash.cloudflare.com 가입/로그인
2. **Workers & Pages → 만들기(Create) → Worker 만들기** → 이름 `handcal` → **배포(Deploy)**
3. **코드 편집(Edit code)** → 기존 코드를 모두 지우고 `worker/worker.js` 내용을 붙여넣기 → **배포**
4. Worker의 **설정(Settings) → 변수 및 비밀(Variables and Secrets)** 에서 추가

   | 이름 | 유형 | 값 |
   |---|---|---|
   | `ALLOWED_ORIGIN` | 텍스트 | `https://hcna999.github.io` |
   | `GOOGLE_CLIENT_ID` | 텍스트 | config.js의 클라이언트 ID |
   | `GOOGLE_CLIENT_SECRET` | 비밀 | B에서 복사한 값 |
   | `OWNER_EMAIL` | 비밀 | 앱에 로그인할 구글 메일 |
   | `NAVER_ID` | 비밀 | 네이버 아이디 (@naver.com 빼고) |
   | `NAVER_APP_PASSWORD` | 비밀 | A에서 만든 비밀번호 |

5. Worker 주소(`https://handcal.<아이디>.workers.dev`)를 `config.js`의 `WORKER_URL`에 넣기
6. 앱에서 **로그아웃 → 구글 로그인**을 한 번 다시 하면 끝

확인: Worker 주소를 브라우저로 열면 `"naver":true,"google":true`가 보여야 합니다.

## 1-3. 손글씨 → 글자 변환 (Gemini 무료)

1. https://aistudio.google.com/apikey 접속 → 구글 로그인 → **API 키 만들기** → 키 복사 (카드 등록 필요 없음)
2. Cloudflare Worker → **Settings → Variables and Secrets → + Add**
   - Type: **Secret**, 이름: `GEMINI_API_KEY`, 값: 복사한 키 → Deploy
3. Worker의 최신 `worker/worker.js` 코드를 다시 붙여넣고 **Deploy**
4. 확인: Worker 주소를 열었을 때 `"gemini":true`

사용: 필기 화면 왼쪽 **필기 → 글자 (AI)** → **글자로 변환**. 원문·요약·할 일·결정 사항이 나오고, 원문은 직접 고칠 수 있으며 드라이브에 함께 저장됩니다.
무료 사용분은 하루 사용량 제한이 있고, 구글이 서비스 개선에 사용할 수 있습니다.

## 1-4. 구글 Tasks 할 일 연동

1. https://console.cloud.google.com/apis/library/tasks.googleapis.com → **사용**
2. 앱의 ⚙ → **구글 Tasks 할 일 연동**에서 **구글 다시 연결**(또는 로그아웃 후 다시 로그인)로 할 일 권한 허용

할 일은 Tasks의 **필기캘린더** 목록에 날짜(마감일)와 함께 올라가고, 어느 쪽에서 체크해도 서로 반영됩니다.

## 2. 인터넷에 올리기 (GitHub Pages, 무료)

1. GitHub에서 새 저장소 생성 (예: `handcal`)
2. 이 폴더의 파일을 모두 올리기
3. 저장소 **Settings → Pages → Branch: main / root → Save**
4. 몇 분 뒤 `https://<깃허브아이디>.github.io/handcal/` 에서 열림

## 3. 각 기기에 앱처럼 설치

| 기기 | 방법 |
|---|---|
| 아이패드 | Safari로 열기 → 공유 버튼 → **홈 화면에 추가** |
| 갤럭시 | 삼성 인터넷/크롬으로 열기 → 메뉴 → **홈 화면에 추가** (또는 앱 설치) |
| 윈도우 | 엣지/크롬으로 열기 → 주소창 오른쪽 **앱 설치** 아이콘 |

각 기기에서 ⚙(설정) → **계정**에서 **구글 로그인**을 하거나, 이미 로그인된 기기에서 **연결 코드(8자리 1회용 코드)**를 생성해 다른 기기에서 입력하면 간편하게 연결됩니다.

## 참고

- 중계 서버 없이 쓰면 구글 로그인이 1시간마다 만료됩니다. 만료 후 화면을 한 번 누르면 다시 연결됩니다.
- 네이버 캘린더는 읽기만 합니다. 앱에서 적는 일정은 네이버에 저장되지 않고 "메모 일정"으로 드라이브에 저장됩니다.
- **두 기기 동시 수정**: 같은 날짜를 동시에 고쳐도 탭 단위로 자동 합쳐지며, 같은 탭을 고친 경우 최신 내용과 충돌 사본을 모두 보존합니다.
- PC에서 테스트: 이 폴더에서 `python3 -m http.server 8000` 실행 후 http://localhost:8000
