const STEPS = ['주제·조사', '정보 선택', '심층 조사', '기획 검토', '이미지·글자', '검수·수정', '승인·내려받기'];
const STAGE_STEP = { search: 0, select: 1, research: 2, editorial: 2, storyboard: 3, generate: 4, review: 5, done: 6 };
const $ = (s) => document.querySelector(s);
// 링크는 http(s)만 허용한다(javascript: 같은 주소가 클릭으로 실행되지 않게).
const safeUrl = (u) => (/^https?:\/\//i.test(String(u ?? '')) ? esc(u) : '#');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let job = null;
let health = null;
let pollTimer = null;
let note = '';
const ui = { sel: new Set(), actOpen: false };

// 작업 진행 내역: 엔진이 실제로 보낸 검색어, 읽은 원문 주소, 결과 수신과 후킹 설계 기록. 닫아도 기록은 계속 쌓인다.
const ACT_LABEL = { search: '검색어', fetch: '원문 읽기', result: '수신', hook: '후킹' };
function activityPanel() {
  const list = job?.activity ?? [];
  if (!list.length) return '';
  const rows = list.slice(-80).reverse().map((a) => {
    const t = new Date(a.t).toLocaleTimeString('ko-KR', { hour12: false });
    const detail = a.kind === 'fetch' ? `<a href="${safeUrl(a.detail)}" target="_blank" rel="noopener">${esc(a.detail)}</a>` : esc(a.detail);
    return `<li><time>${t}</time><span class="badge">${esc(a.step)}</span><b>${ACT_LABEL[a.kind] ?? a.kind}</b> ${detail}</li>`;
  }).join('');
  const searches = list.filter((a) => a.kind === 'search').length;
  const fetches = list.filter((a) => a.kind === 'fetch').length;
  return `<details class="panel act" id="act" ${ui.actOpen ? 'open' : ''}><summary>작업 진행 내역 — 검색 ${searches}회 · 원문 읽기 ${fetches}회 · 전체 ${list.length}건</summary><ul>${rows}</ul></details>`;
}

// 아직 제출하지 않은 선택(체크, 라디오, 입력)은 브라우저에 임시 저장해 새로고침 뒤에도 복원한다.
const draftKey = () => 'draft:' + job.id;
function loadDraft() { try { return JSON.parse(localStorage.getItem(draftKey())) ?? {}; } catch { return {}; } }
function saveDraft(patch) { try { localStorage.setItem(draftKey(), JSON.stringify({ ...loadDraft(), ...patch })); } catch { /* 저장 불가 환경이면 무시 */ } }
function readEditorialForm() {
  const ans = {};
  for (const q of job.questions) {
    const checked = document.querySelector(`input[name="q-${CSS.escape(q.id)}"]:checked`);
    ans[q.id] = { v: checked?.value ?? '', custom: document.querySelector(`[data-custom="${CSS.escape(q.id)}"]`)?.value ?? '' };
  }
  return { ans, cardCount: $('#cardCount')?.value };
}
function restoreEditorialForm() {
  const d = loadDraft().editorial;
  if (!d) return;
  for (const q of job.questions) {
    const a = d.ans?.[q.id];
    if (!a) continue;
    const radio = [...document.querySelectorAll(`input[name="q-${CSS.escape(q.id)}"]`)].find((r) => r.value === a.v);
    if (radio) radio.checked = true;
    const custom = document.querySelector(`[data-custom="${CSS.escape(q.id)}"]`);
    if (custom) custom.value = a.custom ?? '';
  }
  if (d.cardCount && $('#cardCount')) $('#cardCount').value = d.cardCount;
}

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
// 서버가 거절하면(중복 제출, 지난 질문 등) 메시지를 보여 주고 현재 상태로 다시 그린다.
const act = async (fn) => {
  try { await fn(); } catch (e) {
    alert(e.message);
    try { if (job) job = await api('/jobs/' + job.id); } catch { /* 서버에 닿지 않으면 화면 유지 */ }
    render();
  }
};

// ---------- 공통 ----------
function renderHealth() {
  const h = health;
  $('#health').innerHTML = h
    ? `<span class="pill ${h.claude ? 'ok' : 'bad'}">조사 엔진: ${h.claude ? 'Claude Code ' + esc(h.claude) : '연결 안 됨'}</span>
       <span class="pill ${h.imageWorker?.selected === 'agy' || h.gemini.keySet ? 'ok' : 'bad'}" title="agy ${h.imageWorker?.agy.installed ? '설치됨' : '없음'} · 도구 자동 승인 ${h.imageWorker?.agy.allowAllTools ? '켜짐' : '꺼짐'} · Gemini 키 ${h.gemini.keySet ? '있음' : '없음'}">이미지 작업자: ${esc(h.imageWorker?.selected ?? 'gemini')}</span>
       <button class="ghost" id="testImg" style="padding:2px 10px;font-size:12px">이미지 1장 테스트</button>` : '';
}

function renderSteps() {
  const cur = job ? STAGE_STEP[job.stage] : -1;
  $('#steps').innerHTML = STEPS.map((s, i) => `<li class="${i < cur || (job?.stage === 'done' && i === 6) ? 'done' : i === cur ? 'cur' : ''}">${s}</li>`).join('');
}

function renderLog() {
  $('#log').innerHTML = (job?.log ?? []).slice().reverse().map((l) => `<li><time>${new Date(l.t).toLocaleTimeString('ko-KR', { hour12: false })}</time>${esc(l.msg)}</li>`).join('');
}

const STATUS_LABEL = { running: '실행 중', waiting_for_user: '사용자 답변 대기', failed: '실패(재시도 가능)', done: '완료', idle: '대기' };
function statusPill() {
  return job?.status ? `<div class="muted" style="margin-bottom:8px">상태: <b>${STATUS_LABEL[job.status] ?? job.status}</b> <code>${job.status}</code></div>` : '';
}

function autoPanel() {
  if (!job?.autoRunning) return '';
  return `<div class="panel busy"><div class="spin"></div><div><b>호주 뉴스 자동 제작 중…</b><div class="muted">현재 단계: ${esc(STEPS[STAGE_STEP[job.stage]] ?? job.stage)}. 끝나면 검수 화면에서 번역과 사실을 확인하고 승인하세요. 새로고침해도 이어집니다.</div></div></div>`;
}

function busyPanel() {
  if (!job.busy) return '';
  return `<div class="panel busy"><div class="spin"></div><div><b>${esc(job.busyLabel)} 진행 중…</b><div class="muted">검색·생성에는 수 분이 걸릴 수 있습니다. 새로고침해도 진행 상태는 유지됩니다.</div></div></div>`;
}
function errorPanel() {
  if (!job.error) return '';
  return `<div class="panel err"><b>작업 실패</b> — ${esc(job.error.message)}<div class="muted">${esc(job.error.hint)}</div>
    ${job.busy || !job.retry ? '' : `<div class="row"><button data-act="retry">다시 시도</button>${job.stage === 'generate' ? '<button class="ghost" data-act="placeholders">대체 배경으로 계속 (실제 이미지는 미완료로 기록)</button>' : ''}</div>`}</div>`;
}

// ---------- 단계별 화면 ----------
const DEFAULT_TOPIC = { news: 'AI 최신소식', journal: '오늘 공부한 것: ', au: '오늘의 호주 뉴스' };

function viewTopic() {
  return `<div class="panel"><h2>1. 주제 입력</h2>
    <div class="q"><b>무엇을 만들까요?</b>
      <label class="opt"><input type="radio" name="mode" value="news" checked><span>최신 소식 카드뉴스 <span class="muted">— 최근 7일 자료를 조사해 카드뉴스를 만듭니다.</span></span></label>
      <label class="opt"><input type="radio" name="mode" value="journal"><span>학습일지 → 블로그 포스트 + 요약 카드 <span class="muted">— 오늘 공부한 메모에서 개념을 골라 글과 카드를 만듭니다.</span></span></label>
      <label class="opt"><input type="radio" name="mode" value="au"><span>호주 데일리 뉴스 (한국어 번역·요약) <span class="muted">— 오늘 호주의 큰 뉴스를 자동으로 찾아 카드로 만들어 두고, 마지막에 내가 승인합니다.</span></span></label></div>
    <input type="text" id="topic" value="${DEFAULT_TOPIC.news}" placeholder="주제">
    <div data-mode-block="news"><p class="muted">주제를 입력하면 실행 시점 기준 최근 7일의 자료를 조사합니다.</p></div>
    <div data-mode-block="au" hidden><p class="muted">시드니 기준 최근 24시간의 호주 큰 뉴스 3~4건을 찾아 한국어로 요약 번역해 한 편(5~6장)으로 만듭니다. 선택·질문 없이 자동으로 진행되고, 끝나면 검수 화면에서 확인·승인합니다. 기사 사진은 쓰지 않고 단색 배경을 씁니다.</p></div>
    <div data-mode-block="journal" hidden>
      <div class="q" style="margin-top:12px"><b>학습 메모</b><div class="why">오늘 배운 내용을 자유롭게 적어 주세요 (20자 이상). 원문과 대조해 오해한 부분을 짚어 드립니다.</div>
      <textarea id="notes" style="min-height:140px" placeholder="예: RAG는 검색으로 가져온 문서를 프롬프트에 넣어 답하게 하는 방식. 임베딩은 문장을 벡터로 바꾸는 것..."></textarea></div>
      <div class="q"><b>참고 링크 (선택)</b><div class="why">한 줄에 하나씩. 링크가 있으면 원문을 읽고 대조합니다.</div>
      <textarea id="links" placeholder="https://..."></textarea></div></div>
    <div class="q" style="margin-top:12px"><b>편집 방향 (선택)</b><div class="why">독자·형식·표지(제목) 방향을 이미 정했다면 적어 주세요. 적은 항목은 다시 묻지 않습니다.</div>
    <textarea id="brief" placeholder="예: AI를 처음 접하는 대학생에게 소개하고 싶어. 목록형과 이야기형을 비교해 추천해 줘."></textarea></div>
    <div class="row"><button data-act="start">시작</button></div></div>`;
}

// 학습일지: 메모가 부족하다고 표시된 점과, 메모를 보완해 다시 정리하는 입력란
function gapsPanel() {
  if (job.mode !== 'journal' || !job.gaps?.length) return '';
  return `<div class="panel err"><b>메모에서 부족한 점</b> <span class="muted">— 아래에서 메모를 보완해 다시 정리할 수 있습니다.</span><ul>${job.gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul></div>`;
}
function notesFixPanel() {
  if (job.mode !== 'journal') return '';
  const failedSearch = job.stage === 'search' && !!job.error && !job.busy;
  if (job.stage === 'search' && !failedSearch) return '';
  return `<details class="panel" ${failedSearch ? 'open' : ''}><summary><b>메모 보완하고 다시 정리</b></summary>
    <textarea id="fixNotes" style="min-height:130px;margin-top:10px">${esc(job.notes)}</textarea>
    <textarea id="fixLinks" placeholder="참고 링크(한 줄에 하나)">${esc((job.links ?? []).join('\n'))}</textarea>
    <div class="row"><button data-act="fixNotes" ${job.busy ? 'disabled' : ''}>보완한 메모로 다시 정리</button></div></details>`;
}

function viewSearching() {
  const s = job.search;
  return `<div class="panel"><h2>1. 조사 중</h2><p>주제 <b>${esc(job.topic)}</b></p>
    ${s ? (job.mode === 'journal' ? `<p class="muted">기준일 ${s.to} · 메모에서 개념을 정리하는 중</p>` : `<p class="muted">기준 시각 ${esc(s.asOfLabel)} · 조사 기간 ${s.from} ~ ${s.to} (최근 ${s.days}일)</p>`) : ''}</div>`;
}

function viewSelect() {
  const s = job.search;
  const widen = `<div class="row"><span class="muted">자료가 더 필요하면:</span>
      <button class="ghost" data-act="widen" data-days="14" ${job.busy ? 'disabled' : ''}>14일로 넓혀 다시 조사</button>
      <button class="ghost" data-act="widen" data-days="30" ${job.busy ? 'disabled' : ''}>30일로 넓혀 다시 조사</button></div>`;
  return `<div class="panel"><h2>2. 다룰 ${job.mode === 'journal' ? '개념' : '소식'} 선택</h2>
    <p class="muted">${job.mode === 'journal' ? `기준일 ${s.to}` : `기준 시각 ${esc(s.asOfLabel)} · 조사 기간 ${s.from} ~ ${s.to} (최근 ${s.days}일)`} · 후보 ${job.candidates.length}건${s.dropped ? ` · 기간 밖/날짜 불명 ${s.dropped}건 제외` : ''}</p>
    ${s.shortage ? `<div class="panel err" style="margin:8px 0"><b>자료가 부족합니다.</b> 최근 ${s.days}일 안에서 ${job.candidates.length}건만 확인됐습니다. 기간을 넓힐까요?${widen}</div>` : ''}
    ${job.candidates.map((c) => `<label class="cand ${ui.sel.has(c.id) ? 'sel' : ''}"><input type="checkbox" data-act="pick" data-id="${c.id}" ${ui.sel.has(c.id) ? 'checked' : ''}>
      <div><div class="t">${esc(c.title)}</div><div class="muted">${c.category ? `<span class="badge">${esc(c.category)}</span>` : ''}게시일 ${esc(c.date)} · 발표·변경일 ${esc(c.announcedOn || '미확인')} · ${esc(c.source)} ${c.opened === undefined ? '' : c.opened ? '<span class="badge ok">원문 열람 확인</span>' : '<span class="badge warn">원문 미확인(검색 요약 기준)</span>'}</div><div>${esc(c.summary)}</div>${c.value ? `<div><b>선택할 가치</b> ${esc(c.value)}</div>` : ''}${c.uncertainty ? `<div class="muted"><b>불확실성</b> ${esc(c.uncertainty)}</div>` : ''}${c.url.startsWith('memo:') ? '<span class="muted">링크 없음 (내 메모 기준)</span>' : `<a href="${safeUrl(c.url)}" target="_blank" rel="noopener">원문 열기</a>`}</div></label>`).join('')}
    <div class="row"><button data-act="select" ${ui.sel.size < 1 || ui.sel.size > 3 || job.busy ? 'disabled' : ''}>선택한 ${ui.sel.size}건으로 진행 (1~3개)</button>
    ${s.shortage || job.mode === 'journal' ? '' : widen}</div></div>`;
}

function viewResearch() {
  return `<div class="panel"><h2>3. 심층 조사</h2><p class="muted">선택한 소식의 원문과 근거를 확인하고 편집 방향을 제안하는 중입니다.</p></div>`;
}

function viewEditorial() {
  const qs = job.questions.map((q) => `<div class="q"><b>${esc(q.label)}</b><div class="why">${esc(q.why)}</div>
    ${q.options.map((o) => `<label class="opt"><input type="radio" name="q-${esc(q.id)}" value="${esc(o)}" ${o === q.recommended ? 'checked' : ''}><span>${esc(o)}${o === q.recommended ? '<span class="tag">추천</span>' : ''}</span></label>`).join('')}
    <label class="opt"><input type="radio" name="q-${esc(q.id)}" value="__custom"><input type="text" data-custom="${esc(q.id)}" placeholder="직접 입력"></label></div>`).join('');
  const KIND = { verified: ['확인한 사실', 'ok'], claim: ['발표 주체의 주장', 'warn'], unverified: ['아직 확인하지 못함', 'bad'] };
  const facts = job.research.map((r) => {
    const groups = ['verified', 'claim', 'unverified'].map((k) => {
      const list = r.facts.filter((f) => (f.kind ?? 'verified') === k);
      if (!list.length) return '';
      return `<div style="margin-top:8px"><span class="badge ${KIND[k][1]}">${KIND[k][0]} ${list.length}건</span><ul>${list.map((f) => `<li>${esc(f.claim)} ${f.url ? `<a href="${safeUrl(f.url)}" target="_blank" rel="noopener">근거</a>` : ''}${f.evidence ? `<div class="muted">${esc(f.evidence)}</div>` : ''}</li>`).join('')}</ul></div>`;
    }).join('');
    const c = r.conditions;
    const cond = (r.changes || c) ? `<div style="margin-top:8px"><b>무엇이 달라졌나</b> ${esc(r.changes ?? '미확인')}</div>${c ? `<dl class="sb" style="margin-top:6px"><dt>대상</dt><dd>${esc(c.who)}</dd><dt>시작</dt><dd>${esc(c.since)}</dd><dt>지역</dt><dd>${esc(c.region)}</dd><dt>요금제</dt><dd>${esc(c.plan)}</dd>${c.other ? `<dt>기타</dt><dd>${esc(c.other)}</dd>` : ''}</dl>` : ''}` : '';
    const disc = r.discrepancies?.length ? `<div class="panel err" style="margin:8px 0"><b>자료 간 불일치 — 카드 원고를 확정하기 전에 확인하세요</b><ul>${r.discrepancies.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>` : '';
    return `<details open><summary><b>${esc(r.headline)}</b></summary>${disc}${cond}${groups}${r.caveats ? `<div class="muted" style="margin-top:8px">유의: ${esc(r.caveats)}</div>` : ''}</details>`;
  }).join('');
  const cmp = job.comparison;
  const cmpHtml = cmp ? `<div class="panel"><h3>형식 비교 (이 소식에 맞는 두 가지)</h3>${cmp.options.map((o) => `<div class="sb"><div class="ti">${esc(o.name)}${o.name === cmp.recommended ? '<span class="tag">추천</span>' : ''}</div>
      <dl><dt>적합</dt><dd>${esc(o.fits)}</dd><dt>장점</dt><dd>${esc(o.pros)}</dd><dt>단점</dt><dd>${esc(o.cons)}</dd></dl></div>`).join('')}
    <div><b>추천 이유</b> ${esc(cmp.reason)}</div></div>` : '';
  const known = Object.entries(job.answers).filter(([k]) => ['audience', 'format', 'hook'].includes(k));
  const knownHtml = known.length ? `<div class="panel"><h3>이미 정해진 항목 (다시 묻지 않습니다)</h3>${known.map(([k, v]) => `<div>· ${esc({ audience: '독자', format: '형식', hook: '표지 방향' }[k])}: ${esc(v)}</div>`).join('')}</div>` : '';
  return `<div class="panel"><h2>3. 편집 방향 선택</h2><p class="muted">추천 답이 미리 선택되어 있습니다. 바꾸고 싶은 항목만 고르세요.</p>${facts}</div>
    ${cmpHtml}${knownHtml}
    <div class="panel">${qs}
    <div class="q"><b>카드 장수</b><div class="why">처음에는 5장으로 전체 흐름을 확인하는 것을 권합니다.</div>
    <select id="cardCount" style="width:auto">${(job.mode === 'journal' ? [3, 4, 5, 6, 7, 8] : [5, 6, 7, 8]).map((n) => `<option ${n === (job.mode === 'journal' ? 4 : 5) ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    <div class="row"><button data-act="answers" ${job.busy ? 'disabled' : ''}>이 방향으로 스토리보드 만들기</button></div></div>`;
}

function hookPanel() {
  const h = job.hookDesign;
  if (!h) return '';
  return `<div class="panel"><h3>첫 카드 후킹 설계 (스토리보드와 별도로 먼저 설계)</h3>
    <div><b>독자 관심</b> ${esc(h.interest)}</div>
    ${h.candidates.map((c, i) => `<div class="sb"><div class="ti">후보 ${i + 1}. ${esc(c.text)}${c.text === h.chosen ? '<span class="tag">선정</span>' : ''}</div>
      <dl><dt>근거</dt><dd>${esc(c.evidence)}</dd><dt>과장 위험</dt><dd>${esc(c.risk)}</dd></dl></div>`).join('')}
    <div><b>선정 이유</b> ${esc(h.reason)}</div></div>`;
}

function viewStoryboard() {
  const sb = job.storyboard;
  return hookPanel() + `<div class="panel"><h2>4. 카드별 기획 검토 <span class="muted">v${sb.version}</span></h2>
    <p class="muted">${sb.cards.length}장의 역할·제목·핵심 문장·출처·그림 계획입니다. 변경을 요청하거나 승인하세요.</p>
    ${sb.cards.map((c) => `<div class="sb"><div class="role">${c.n}. ${esc(c.role)}</div><div class="ti">${esc(c.title)}</div><div>${esc(c.body)}</div>
      <dl><dt>출처</dt><dd>${c.source ? `<a href="${safeUrl(c.source.url)}" target="_blank" rel="noopener">${esc(c.source.title)}</a>` : '<span class="muted">없음</span>'}</dd><dt>그림</dt><dd>${esc(c.visual)}</dd></dl></div>`).join('')}
    <textarea id="fb" placeholder="변경 요청 예: 3번 카드는 수치를 빼고 쉽게 풀어 써 주세요."></textarea>
    <div class="row"><button class="ghost" data-act="revise" ${job.busy ? 'disabled' : ''}>변경 요청</button><button data-act="approveSb" ${job.busy ? 'disabled' : ''}>기획 승인 → 제작 시작</button></div></div>`;
}

function imgBadge(c) {
  const i = c.image;
  if (!i) return '<span class="badge warn">이미지 대기</span>';
  if (i.status === 'ok') return `<span class="badge ok" title="${esc((i.terms ?? '') + ' / ' + (i.depiction ?? ''))}">${esc(i.category ?? '생성 이미지')} · ${esc(i.model)}</span>`;
  if (i.status === 'placeholder') return `<span class="badge warn" title="${esc(i.note)}">대체 배경 (실제 생성 미완료)</span>`;
  return `<span class="badge bad" title="${esc(i.note)}">이미지 실패</span>`;
}

function postPanel() {
  if (job.mode !== 'journal') return '';
  if (!job.post) return `<div class="panel"><h3>블로그 포스트</h3><div class="muted">${job.busy ? '포스트를 작성하는 중…' : '아직 작성되지 않았습니다.'}</div></div>`;
  const review = job.stage === 'review';
  return `<details class="panel" open><summary><b>블로그 포스트 (post.md)</b> — ${esc(job.post.title)}</summary>
    <textarea readonly id="postMd" style="min-height:320px;margin-top:10px;font-family:ui-monospace,Consolas,monospace;font-size:13px">${esc(job.post.markdown)}</textarea>
    <div class="row"><button class="ghost" data-act="copyPost">복사</button>
    ${review ? `<button class="ghost" data-act="rewritePost" ${job.busy ? 'disabled' : ''}>포스트 다시 쓰기 (카드를 고친 뒤)</button>` : ''}
    <span class="muted">ZIP에 post.md로 들어갑니다. 카드 내용을 고쳤다면 다시 써서 맞추세요.</span></div></details>`;
}

// 그림 계획(영어 이미지 프롬프트)의 앞부분에서 검색어 초안을 만든다. 사람이 고쳐 쓴다.
function defaultStockQuery(c) {
  const stop = new Set(['a', 'an', 'the', 'of', 'and', 'with', 'in', 'on', 'to', 'for', 'flat', 'vector', 'illustration', 'style', 'soft', 'minimal', 'minimalist', 'portrait', 'composition', 'showing', 'scene', 'image']);
  const words = (c.imagePrompt || '').toLowerCase().match(/[a-z]{3,}/g) ?? [];
  return words.filter((w) => !stop.has(w)).slice(0, 4).join(' ');
}

function viewCards() {
  const cards = job.storyboard.cards;
  const review = job.stage === 'review';
  const head = { generate: ['5. 이미지와 글자 제작', '승인된 기획에 맞춰 카드를 만들고 있습니다. 글자는 이미지 위에 따로 배치됩니다.'], review: ['6. 검수와 부분 수정', '고칠 카드만 지정하세요. 나머지 카드는 그대로 유지됩니다.'], done: ['7. 승인 완료', '카드별 PNG, 전체 ZIP, 출처·이미지 사용 기록을 내려받을 수 있습니다.'] }[job.stage];
  return `<div class="panel"><h2>${head[0]}</h2><p class="muted">${head[1]}</p>
    <div class="grid">${cards.map((c) => `<div class="cardbox"><canvas data-n="${c.n}"></canvas>
      <div>${imgBadge(c)}<span class="badge" data-ovf="${c.n}">글자 확인 중</span>${c.qa ? (c.qa.ok ? '<span class="badge ok">사실·출처 OK</span>' : `<span class="badge bad" title="${esc(c.qa.issue)}">사실 확인 필요</span>`) : ''}</div>
      ${c.qa && !c.qa.ok ? `<div class="muted">⚠ ${esc(c.qa.issue)}</div>` : ''}
      ${review ? `<details><summary>이 카드 수정</summary><textarea data-ins="${c.n}" placeholder="수정할 내용"></textarea>
        <div class="row"><select data-scope="${c.n}" style="width:auto"><option value="both">글+그림</option><option value="text">글만</option><option value="image">그림만</option></select>
        <button data-act="reviseCard" data-n="${c.n}" ${job.busy ? 'disabled' : ''}>수정</button></div></details>
      <details><summary>CC0·퍼블릭 도메인 사진으로 바꾸기</summary><div class="row"><input type="text" data-stockq="${c.n}" placeholder="영어 검색어 (예: server rack)" value="${esc(defaultStockQuery(c))}"><button class="ghost" data-act="stockSearch" data-n="${c.n}">검색</button></div><div id="stock-${c.n}" class="stock"></div></details>` : ''}</div>`).join('')}</div>
    ${postPanel()}
    ${review ? `<div class="row"><button data-act="approveFinal" ${job.busy || job.error ? 'disabled' : ''}>최종 승인</button></div>` : ''}
    ${job.stage === 'done' ? '<div class="row"><button data-act="download">PNG·ZIP 내려받기</button><button class="ghost" data-act="reopen">승인 해제하고 수정하기</button><span id="dlState" class="muted"></span></div><div id="exportCheck"></div>' : ''}</div>`;
}

async function paintCards() {
  const total = job.storyboard.cards.length;
  for (const c of job.storyboard.cards) {
    const canvas = document.querySelector(`canvas[data-n="${c.n}"]`);
    if (!canvas) continue;
    const img = await loadImage(c.image?.file ? `/api/jobs/${job.id}/images/${c.image.file}` : null);
    const { overflow } = renderCard(canvas, c, total, img, { asOf: job.search?.to, journal: job.mode === 'journal', au: job.mode === 'au' });
    const badge = document.querySelector(`[data-ovf="${c.n}"]`);
    if (badge) { badge.className = 'badge ' + (overflow ? 'bad' : 'ok'); badge.textContent = overflow ? '글자 넘침' : '글자 OK'; }
  }
}

// ---------- 렌더 ----------
function render() {
  renderSteps(); renderLog();
  const v = $('#view');
  if (!job) { v.innerHTML = note + viewTopic(); return; }
  let body = '';
  switch (job.stage) {
    case 'search': body = viewSearching() + notesFixPanel(); break;
    case 'select': body = gapsPanel() + viewSelect() + notesFixPanel(); break;
    case 'research': body = viewResearch(); break;
    case 'editorial': body = viewEditorial(); break;
    case 'storyboard': body = viewStoryboard(); break;
    default: body = job.storyboard ? viewCards() : '';
  }
  if (job.autoRunning) body = '';
  v.innerHTML = note + statusPill() + autoPanel() + busyPanel() + errorPanel() + activityPanel() + body;
  if (job.stage === 'editorial' && !job.busy) restoreEditorialForm();
  if (job.storyboard && ['generate', 'review', 'done'].includes(job.stage)) paintCards();
  if (job.busy || job.autoRunning) startPolling();
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      const next = await api('/jobs/' + job.id);
      const changed = next.updatedAt !== job.updatedAt;
      job = next;
      if (changed) render();
      if (!job.busy && !job.autoRunning) { clearInterval(pollTimer); pollTimer = null; render(); loadJobs(); }
    } catch { /* 서버 재시작 중일 수 있음: 다음 주기에 다시 시도 */ }
  }, 1500);
}

function setJob(j) {
  job = j; note = '';
  ui.sel = new Set(j ? (j.selected?.length ? j.selected : (loadDraft().sel ?? [])).filter((id) => j.candidates.some((c) => c.id === id)) : []);
  if (j) { localStorage.setItem('lastJob', j.id); history.replaceState(null, '', '#' + j.id); }
  render();
}

async function loadJobs() {
  const list = await api('/jobs');
  $('#jobs').innerHTML = '<option value="">이전 작업…</option>' + list.map((j) => `<option value="${j.id}" ${job?.id === j.id ? 'selected' : ''}>${esc(j.topic)} · ${esc(j.stage)}</option>`).join('');
}

const CHECK_CLASS = { '통과': 'ok', '미확인': 'warn', '실패': 'bad' };
async function showExportCheck() {
  const r = await api(`/jobs/${job.id}/export-check`);
  const rows = r.rows.map((x) => `<li><span class="badge ${CHECK_CLASS[x.status]}">${x.status}</span><b>${esc(x.item)}</b> — ${esc(x.detail)}</li>`).join('');
  const human = r.human.map((h) => `<li>${esc(h)}</li>`).join('');
  const box = document.querySelector('#exportCheck');
  if (box) box.innerHTML = `<h3>내보낸 파일 점검 — 통과 ${r.summary['통과']} · 미확인 ${r.summary['미확인']} · 실패 ${r.summary['실패']}</h3><ul class="chk">${rows}</ul><h3>내가 직접 확인할 부분</h3><ul class="chk">${human}</ul>`;
}

async function downloadAll() {
  const state = $('#dlState');
  const total = job.storyboard.cards.length;
  for (const c of job.storyboard.cards) {
    state.textContent = `PNG 만드는 중 ${c.n}/${total}…`;
    const canvas = document.createElement('canvas');
    const img = await loadImage(c.image?.file ? `/api/jobs/${job.id}/images/${c.image.file}` : null);
    const { overflow } = renderCard(canvas, c, total, img, { asOf: job.search?.to, journal: job.mode === 'journal', au: job.mode === 'au' });
    await api(`/jobs/${job.id}/png`, 'POST', { n: c.n, dataUrl: canvas.toDataURL('image/png'), overflow });
  }
  state.textContent = '내보낸 파일을 점검하는 중…';
  await showExportCheck();
  state.textContent = 'ZIP 다운로드를 시작합니다.';
  location.href = `/api/jobs/${job.id}/download.zip`;
}

function collectAnswers() {
  const a = {};
  for (const q of job.questions) {
    const checked = document.querySelector(`input[name="q-${CSS.escape(q.id)}"]:checked`);
    a[q.id] = checked?.value === '__custom' ? document.querySelector(`[data-custom="${CSS.escape(q.id)}"]`).value.trim() : checked?.value ?? '';
  }
  a.cardCount = $('#cardCount').value;
  return a;
}

// ---------- 이벤트 ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act], #testImg, #newJob');
  if (!t) return;
  const a = t.dataset.act;
  // 같은 버튼을 연달아 눌러도 한 번만 보내도록 즉시 비활성화한다(실패하면 act()가 다시 그린다).
  if (t.tagName === 'BUTTON' && a && a !== 'pick') t.disabled = true;
  if (t.id === 'newJob') return act(async () => { localStorage.removeItem('lastJob'); history.replaceState(null, '', location.pathname); job = null; note = ''; render(); });
  if (t.id === 'testImg') return act(async () => {
    t.disabled = true; t.textContent = '생성 중…';
    const r = await api('/health/test-image', 'POST');
    note = r.ok ? `<div class="panel"><b>이미지 테스트 성공</b> (${esc(r.worker ?? '')} · ${esc(r.model)}${r.width ? ` · ${r.width}×${r.height}` : ''} · ${Math.round((r.bytes ?? 0) / 1024)}KB, 파일 확인됨)<br><img src="${r.dataUrl}" style="max-width:240px;border-radius:8px"></div>`
      : `<div class="panel err"><b>이미지 테스트 실패</b> — ${esc(r.message)}<div class="muted">${esc(r.hint)}</div></div>`;
    t.disabled = false; t.textContent = '이미지 1장 테스트'; render();
  });
  if (a === 'pick') return; // change 이벤트에서 처리
  act(async () => {
    if (a === 'start') {
      const topic = $('#topic').value.trim();
      if (!topic) return alert('주제를 입력하세요.');
      const mode = document.querySelector('input[name="mode"]:checked')?.value ?? 'news';
      const body = { topic, brief: $('#brief').value.trim(), mode };
      if (mode === 'journal') {
        body.notes = $('#notes').value.trim();
        body.links = $('#links').value.split('\n').map((l) => l.trim()).filter(Boolean);
        if (body.notes.length < 20) return alert('학습 메모를 20자 이상 적어 주세요.');
      }
      setJob(await api('/jobs', 'POST', body)); loadJobs();
    } else if (a === 'widen') setJob(await api(`/jobs/${job.id}/widen`, 'POST', { days: Number(t.dataset.days) }));
    else if (a === 'select') setJob(await api(`/jobs/${job.id}/select`, 'POST', { ids: [...ui.sel] }));
    else if (a === 'answers') setJob(await api(`/jobs/${job.id}/answers`, 'POST', { answers: collectAnswers(), version: job.qVersion }));
    else if (a === 'revise') setJob(await api(`/jobs/${job.id}/storyboard/revise`, 'POST', { feedback: $('#fb').value }));
    else if (a === 'approveSb') setJob(await api(`/jobs/${job.id}/storyboard/approve`, 'POST'));
    else if (a === 'reviseCard') {
      const n = t.dataset.n;
      setJob(await api(`/jobs/${job.id}/cards/${n}/revise`, 'POST', { instruction: document.querySelector(`[data-ins="${n}"]`).value, scope: document.querySelector(`[data-scope="${n}"]`).value }));
    } else if (a === 'approveFinal') setJob(await api(`/jobs/${job.id}/approve`, 'POST'));
    else if (a === 'placeholders') setJob(await api(`/jobs/${job.id}/use-placeholders`, 'POST'));
    else if (a === 'fixNotes') setJob(await api(`/jobs/${job.id}/notes`, 'POST', { notes: $('#fixNotes').value, links: $('#fixLinks').value.split('\n').map((l) => l.trim()).filter(Boolean) }));
    else if (a === 'stockSearch') {
      const n = t.dataset.n;
      const box = $('#stock-' + n);
      box.textContent = '검색 중…';
      try {
        const r = await api(`/jobs/${job.id}/cards/${n}/stock?q=${encodeURIComponent(document.querySelector(`[data-stockq="${n}"]`).value)}`);
        box.innerHTML = r.results.length ? r.results.map((x) => `<div class="stockitem"><img src="${esc(x.thumbUrl)}" loading="lazy" alt=""><div class="muted">${esc(x.title.slice(0, 48))}<br>${esc(x.license)} · ${esc(x.creator.slice(0, 28))} · ${x.width}×${x.height}<br><a href="${safeUrl(x.pageUrl)}" target="_blank" rel="noopener">파일 페이지</a></div><button data-act="stockUse" data-n="${n}" data-id="${esc(x.id)}">이 이미지 사용</button></div>`).join('')
          : '<div class="muted">CC0·퍼블릭 도메인 결과가 없습니다. 검색어를 바꿔 보세요.</div>';
      } finally { t.disabled = false; }
    }
    else if (a === 'stockUse') setJob(await api(`/jobs/${job.id}/cards/${t.dataset.n}/stock`, 'POST', { pageId: t.dataset.id }));
    else if (a === 'reopen') setJob(await api(`/jobs/${job.id}/reopen`, 'POST'));
    else if (a === 'copyPost') { await navigator.clipboard.writeText(job.post.markdown); alert('포스트 마크다운을 복사했습니다.'); }
    else if (a === 'rewritePost') setJob(await api(`/jobs/${job.id}/post/rewrite`, 'POST'));
    else if (a === 'retry') setJob(await api(`/jobs/${job.id}/retry`, 'POST'));
    else if (a === 'download') await downloadAll();
  });
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.name === 'mode') {
    document.querySelectorAll('[data-mode-block]').forEach((el) => { el.hidden = el.dataset.modeBlock !== t.value; });
    const topic = $('#topic');
    if (topic && Object.values(DEFAULT_TOPIC).includes(topic.value)) topic.value = DEFAULT_TOPIC[t.value];
  }
  if (t.dataset?.act === 'pick') {
    t.checked ? ui.sel.add(t.dataset.id) : ui.sel.delete(t.dataset.id);
    saveDraft({ sel: [...ui.sel] });
    const keep = window.scrollY; render(); window.scrollTo(0, keep);
  }
  if (job?.stage === 'editorial' && t.closest('#view') && (t.name?.startsWith('q-') || t.id === 'cardCount')) saveDraft({ editorial: readEditorialForm() });
  if (t.id === 'jobs' && t.value) act(async () => setJob(await api('/jobs/' + t.value)));
});

document.addEventListener('input', (e) => {
  if (job?.stage === 'editorial' && e.target.dataset?.custom) saveDraft({ editorial: readEditorialForm() });
});

(async function init() {
  health = await api('/health').catch(() => null);
  renderHealth();
  await loadJobs();
  const id = location.hash.slice(1) || localStorage.getItem('lastJob');
  if (id) { try { setJob(await api('/jobs/' + id)); } catch { render(); } } else render();
  loadJobs();
})();

// 진행 내역을 펼쳤는지 기억해 다시 그려도 상태가 유지되게 한다.
document.addEventListener('toggle', (e) => {
  if (e.target?.id === 'act') ui.actOpen = e.target.open;
}, true);
