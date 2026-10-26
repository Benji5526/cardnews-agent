# API_SPEC

화면(`public/`)이 서버(`src/server.ts`)에 요청하는 약속. 기본 주소 `http://localhost:4310/api`. 본문은 JSON, 오류는 `{ "error": "메시지" }`와 4xx/5xx.

## 작업 모델

`Job`은 `data/jobs/<id>/job.json`에 저장된다. 주요 필드: `autoRunning`(호주 데일리 뉴스가 단계들을 이어서 실행 중, 이 동안 `status`는 `running`), `status`(`running`/`waiting_for_user`/`failed`/`done`/`idle`, 응답에서 계산), `qVersion`(질문이 새로 만들어질 때마다 +1), `mode`(news|journal), `notes`, `links`, `post`(학습일지 포스트 `{title, markdown, at}`), `hookDesign`(첫 카드 후킹 설계), `activity`(검색어·원문 읽기·결과 수신·후킹 설계 기록 `{t, step, kind: search|fetch|result|hook, detail}`, 최대 400건), `stage`, `busy`(실행 중인 작업 이름 또는 null), `busyLabel`, `error`(`{message, hint, label}`), `retry`(재시도할 작업), `search`(기준 시각·기간), `candidates`(소식·개념 후보: `title`, `summary`, `category`, `date`=게시일, `announcedOn`=실제 발표·변경일 또는 "미확인", `value`=선택할 가치, `uncertainty`=불확실성, `opened`=원문을 실제로 열었는지(엔진의 WebFetch 이벤트로 서버가 확인), `url`), `gaps`(학습일지: 메모의 부족한 점), `selected`, `research`(소식별 `changes`, `conditions{who,since,region,plan,other}`, `discrepancies[]`, `facts[{kind: verified\|claim\|unverified, claim, evidence, url}]`, `caveats`), `exportMeta`(내보낸 PNG별 글자 넘침 측정값), `comparison`, `questions`, `answers`, `storyboard`, `finalApproved`, `log`.

`stage`: `search → select → research → editorial → storyboard → generate → review → done`.
사용자 답변을 기다리는 단계(`select`, `editorial`, `storyboard`, `review`)는 정상 상태다. 오래 걸리는 단계는 요청 즉시 `202`와 Job을 돌려주고 백그라운드에서 진행하며, 화면은 `GET /jobs/:id`를 폴링한다(`busy`가 null이 될 때까지).

## 엔드포인트

| 메서드·경로 | 입력 | 결과 / 오류 |
|---|---|---|
| `GET /health` | - | `{claude: 버전\|null, gemini: {keySet, model}, imageWorker: {selected: agy\|gemini, agy: {installed, allowAllTools}, gemini}}` |
| `POST /health/test-image` | - | 선택된 이미지 작업자로 1장 생성. `{ok:true, worker, model, width, height, bytes, dataUrl}`(저장된 파일을 검증한 뒤에만 ok) 또는 `{ok:false, message, hint}` (항상 200) |
| `GET /jobs` | - | `[{id, topic, stage, updatedAt}]` 최신순 |
| `POST /jobs` | `{topic, brief?, mode?: news|journal|au, notes?, links?}` | 202 + Job. news는 최근 7일 조사, journal은 메모에서 개념 후보 추출(`notes` 20자 이상 필수, `links`는 http(s)만 최대 10개). `topic` 비면 400. **`mode: "au"`(호주 데일리 뉴스)는 사람의 선택 없이 서버가 검색→선택→검증→스토리보드→단색 배경→검수까지 이어서 실행**하고(`autoRunning: true`) 끝나면 `review`에서 멈춘다. 검색 기간은 시드니 기준 24시간 |
| `GET /jobs/:id` | - | Job. 없으면 404 |
| `POST /jobs/:id/widen` | `{days: 14\|30}` | 202. 기간을 넓혀 다시 조사 |
| `POST /jobs/:id/select` | `{ids: string[1..3]}` | 202. 심층 조사 시작. `stage≠select` 409, 개수 오류 400 |
| `POST /jobs/:id/answers` | `{answers: {질문id: 값, cardCount?}, version: qVersion}` | 202. 스토리보드 작성 시작. 답이 빠진 질문 400. **409**: 작업이 이미 진행 중(같은 답 중복), 편집 단계가 아님(지난 질문), `version`이 현재 `qVersion`과 다름 — 어느 경우에도 현재 작업·답변은 바뀌지 않음 |
| `POST /jobs/:id/storyboard/revise` | `{feedback}` | 202. 스토리보드 수정 (버전 증가) |
| `POST /jobs/:id/storyboard/approve` | - | 202. 이미지 제작 → 검수 |
| `POST /jobs/:id/use-placeholders` | - | 202. 이미지 생성이 막혔을 때 대체 배경으로 검수 진행 (`stage=generate`일 때만) |
| `POST /jobs/:id/cards/:n/revise` | `{instruction, scope: text\|image\|both}` | 202. 해당 카드만 수정, 나머지 유지 |
| `GET /jobs/:id/cards/:n/stock?q=` | 검색어(영어 권장) | CC0·퍼블릭 도메인 후보 최대 12건 `{results:[{id, title, creator, license, licenseUrl, pageUrl, thumbUrl, width, height}]}`. 검색어 2글자 미만·연결 실패는 409 |
| `POST /jobs/:id/cards/:n/stock` | `{pageId}` | 202. 서버가 라이선스를 다시 확인하고 허용된 Wikimedia 도메인에서 내려받아 해당 카드의 이미지만 교체(`stage`가 review/done일 때). 최종 승인은 풀림 |
| `POST /jobs/:id/reopen` | - | 최종 승인된 작업(`done`)의 승인을 풀고 `review`로 되돌림. 카드·이미지 유지 |
| `POST /jobs/:id/approve` | - | 최종 승인 (`stage=review`). 이미지 실패 카드가 있으면 409 |
| `POST /jobs/:id/notes` | `{notes, links?}` | 202. 학습일지에서 자료 부족으로 표시된 메모를 보완해 개념 정리를 다시 시작. `stage`가 select 또는 개념 정리 실패 직후(search)일 때만, 진행 중이면 409, 메모 20자 미만 400 |
| `POST /jobs/:id/post/rewrite` | - | 202. 학습일지 모드에서 카드 수정 뒤 포스트(`post`)를 다시 씀 (`stage`가 review/done일 때만) |
| `POST /jobs/:id/retry` | - | 202. 실패·중단된 작업 재시도. 없으면 409 |
| `GET /jobs/:id/images/:file` | - | 카드 배경 이미지 파일 |
| `POST /jobs/:id/png` | `{n, dataUrl: data:image/png;base64,..., overflow}` | 브라우저가 렌더한 최종 카드 PNG와 글자 넘침 측정값(`overflow`) 저장 |
| `GET /jobs/:id/export-check` | - | 내보낸 파일 점검. `{rows: [{item, status: 통과\|미확인\|실패, detail}], human: [사람이 직접 확인할 항목], summary}`. 서버가 확인할 수 없는 항목은 통과로 두지 않고 `미확인` |
| `GET /jobs/:id/download.zip` | - | 승인 후에만. `cards/card-NN.png`, `sources.json`, `sources.md`, `image_usage.json`(CC0 이미지는 작가·라이선스·파일 페이지 포함), `sources.md`에 "이미지 출처와 사용 조건" 절(+ 학습일지는 `post.md`). PNG 누락 시 409 |

## 보안 규칙

- `Host`가 `127.0.0.1:<포트>` 또는 `localhost:<포트>`가 아니면 421.
- 상태를 바꾸는 요청(GET·HEAD 이외)은 `Content-Type: application/json`이어야 하고(아니면 415), `Origin`이 있으면 로컬이어야 한다(아니면 403).
- 요청 본문은 64KB까지(`POST /jobs/:id/png`만 12MB), 초과 시 413. 서버 오류는 내부 정보 없이 일반 문구로 응답한다.
- 응답에 CSP(`script-src 'self'`), `nosniff`, `no-referrer` 헤더를 붙인다.
- 상태를 바꾸는 요청은 작업이 진행 중이면 변경 전에 409.

## 오류 처리 규칙

- 이미 작업이 실행 중이면 새 작업은 409 (`이미 진행 중인 작업이 있습니다.`).
- 엔진 오류(검색·이미지)는 응답이 아니라 `job.error`에 `{message, hint}`로 남고 `job.retry`에 재시도 정보가 저장된다. 화면은 "다시 시도" 버튼으로 `POST /jobs/:id/retry`를 호출한다.
- 키·한도 문제(HTTP 400/401/403/404/429)는 반복해도 소용없어 이미지 제작을 첫 실패에서 중단하고, 성공한 카드는 유지한다.
- 서버가 작업 중 종료되면 다음 시작 시 `busy`를 풀고 "중단됨" 오류와 재시도 정보를 남긴다.
- 조사 엔진의 JSON 응답 해석 실패는 1회 자동 재시도한다.

## 화면 쪽 저장

아직 제출하지 않은 선택(소식 체크, 편집 질문 답, 카드 장수)은 브라우저 `localStorage`의 `draft:<jobId>`에 임시 저장하고 새로고침 때 복원한다. 마지막으로 연 작업 id는 `lastJob`과 URL 해시에 남긴다.
