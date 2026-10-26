import express, { NextFunction, Request, Response } from 'express';
import archiver from 'archiver';
import fs from 'node:fs';
import path from 'node:path';
import { EngineError, claudeVersion, geminiStatus } from './engines.js';
import { generateCardImage, inspectImage, workerStatus } from './imageWorker.js';
import { searchStock } from './stock.js';
import { LABELS, launch } from './pipeline.js';
import { Job, getJob, jobDir, listJobs, log, newJob, recoverInterrupted, save } from './store.js';

const app = express();
const PORT = Number(process.env.PORT) || 4310;
const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

// 보안: DNS 리바인딩·교차 사이트 요청 방어.
// - Host가 로컬 주소가 아니면 거절(리바인딩된 도메인으로 들어온 요청 차단)
// - 상태를 바꾸는 요청은 Origin이 로컬일 때만, 그리고 application/json만 받는다(교차 사이트에서는 사전 요청 없이 보낼 수 없는 형식)
app.use((req, res, next) => {
  if (!LOCAL_HOSTS.has(String(req.headers.host ?? '').toLowerCase())) return res.status(421).json({ error: '허용되지 않은 호스트입니다.' });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try { ok = LOCAL_HOSTS.has(new URL(origin).host.toLowerCase()); } catch { /* 형식이 이상한 Origin은 거절 */ }
      if (!ok) return res.status(403).json({ error: '허용되지 않은 출처입니다.' });
    }
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return res.status(415).json({ error: 'application/json만 받습니다.' });
  }
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://upload.wikimedia.org https://thumb.wikimedia.org; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
// 카드 PNG 업로드만 큰 본문을 허용하고, 나머지는 작게 제한한다.
app.use(/^\/api\/jobs\/[\w-]+\/png$/, express.json({ limit: '12mb' }));
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.resolve(process.cwd(), 'public')));

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = fn(req, res);
    if (out instanceof Promise) out.catch(next);
  } catch (e) {
    next(e);
  }
};

const need = (req: Request): Job => {
  const job = getJob(String(req.params.id));
  if (!job) throw new HttpError(404, '작업을 찾을 수 없습니다.');
  return job;
};

/** 화면과 API가 쓰는 한 줄 상태: 실행 중 / 사용자 답변 대기 / 실패 / 완료 */
const statusOf = (job: Job) => (job.busy ? 'running' : job.error ? 'failed' : job.stage === 'done' ? 'done'
  : ['select', 'editorial', 'storyboard', 'review'].includes(job.stage) ? 'waiting_for_user' : 'idle');

/** 작업이 진행 중이면 상태를 바꾸기 전에 거절한다. 진행 중인 작업이 나중에 오래된 상태를 덮어쓰는 것을 막는다. */
const idle = (job: Job) => {
  if (job.busy) throw new HttpError(409, '진행 중인 작업이 있습니다. 끝난 뒤 다시 시도하세요.');
};

const view = (job: Job) => ({ ...job, status: statusOf(job), busyLabel: job.busy ? LABELS[job.busy] ?? job.busy : null });

app.get('/api/health', wrap(async (_req, res) => {
  res.json({ claude: await claudeVersion(), gemini: geminiStatus(), imageWorker: workerStatus() });
}));

let testingImage = false;
app.post('/api/health/test-image', wrap(async (_req, res) => {
  if (testingImage) throw new HttpError(409, '이미지 테스트가 이미 진행 중입니다.');
  testingImage = true;
  try {
    const r = await generateCardImage('A simple flat illustration of a blue paper airplane on a plain white background.', path.resolve(process.cwd(), 'data', 'tmp'));
    res.json({ ok: true, model: r.model, worker: r.worker, width: r.width, height: r.height, bytes: r.buf.length, dataUrl: `data:image/${r.ext === 'jpg' ? 'jpeg' : r.ext};base64,${r.buf.toString('base64')}` });
  } catch (e) {
    const err = e as EngineError;
    res.status(200).json({ ok: false, message: err.message, hint: err.hint });
  } finally {
    testingImage = false;
  }
}));

app.get('/api/jobs', wrap((_req, res) => res.json(listJobs())));

app.post('/api/jobs', wrap((req, res) => {
  const topic = String(req.body?.topic ?? '').trim().slice(0, 200);
  if (!topic) throw new HttpError(400, '주제를 입력하세요.');
  const mode = req.body?.mode === 'journal' ? 'journal' : 'news';
  const notes = String(req.body?.notes ?? '').trim().slice(0, 8000);
  const links = (Array.isArray(req.body?.links) ? req.body.links : []).map(String).map((l: string) => l.trim()).filter((l: string) => /^https?:\/\//.test(l)).slice(0, 10);
  if (mode === 'journal' && notes.length < 20) throw new HttpError(400, '학습 메모를 20자 이상 적어 주세요.');
  const job = newJob(topic, String(req.body?.brief ?? '').trim().slice(0, 600), { mode, notes, links });
  launch(job, 'search', 7);
  res.status(202).json(view(job));
}));

app.get('/api/jobs/:id', wrap((req, res) => res.json(view(need(req)))));

// 자료가 부족할 때 기간을 넓혀 다시 조사
app.post('/api/jobs/:id/widen', wrap((req, res) => {
  const job = need(req);
  const days = Number(req.body?.days);
  if (![14, 30].includes(days)) throw new HttpError(400, '14일 또는 30일만 선택할 수 있습니다.');
  launch(job, 'search', days);
  res.status(202).json(view(job));
}));

app.post('/api/jobs/:id/select', wrap((req, res) => {
  const job = need(req);
  idle(job);
  if (job.stage !== 'select') throw new HttpError(409, '정보 선택 단계가 아닙니다.');
  const ids: string[] = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((id: string) => job.candidates.some((c) => c.id === id));
  if (ids.length < 1 || ids.length > 3) throw new HttpError(400, '소식을 1~3개 선택하세요.');
  job.selected = ids;
  job.answers = {};
  job.hookDesign = null;
  log(job, `선택: ${ids.length}건`);
  launch(job, 'research');
  res.status(202).json(view(job));
}));

app.post('/api/jobs/:id/answers', wrap((req, res) => {
  const job = need(req);
  if (job.busy) throw new HttpError(409, '이미 이 답변으로 작업이 진행 중입니다. 같은 답변은 한 번만 처리됩니다.');
  if (job.stage !== 'editorial') throw new HttpError(409, '지난 질문에 대한 답변입니다. 현재 작업은 바뀌지 않았습니다. 화면을 새로고침해 현재 단계를 확인하세요.');
  if (Number(req.body?.version) !== job.qVersion) throw new HttpError(409, '지난 질문 버전에 대한 답변입니다. 현재 작업은 바뀌지 않았습니다. 화면을 새로고침해 현재 질문에 다시 답하세요.');
  const rawA = (req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {}) as Record<string, unknown>;
  const a: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawA)) if (/^[a-z][a-z0-9_]{0,31}$/.test(k) && typeof v === 'string') a[k] = v.trim().slice(0, 500);
  for (const q of job.questions) if (!a[q.id]?.trim()) throw new HttpError(400, `"${q.label}"에 답해 주세요.`);
  const minCards = job.mode === 'journal' ? 3 : 5;
  job.answers = { ...job.answers, ...a, cardCount: String(Math.min(8, Math.max(minCards, Number(a.cardCount) || minCards))) };
  log(job, '편집 방향 확정. 스토리보드를 작성합니다.');
  launch(job, 'storyboard');
  res.status(202).json(view(job));
}));

app.post('/api/jobs/:id/storyboard/revise', wrap((req, res) => {
  const job = need(req);
  idle(job);
  const feedback = String(req.body?.feedback ?? '').trim().slice(0, 2000);
  if (job.stage !== 'storyboard' || !feedback) throw new HttpError(400, '스토리보드 단계에서 변경 요청 내용을 입력하세요.');
  launch(job, 'storyboard', feedback);
  res.status(202).json(view(job));
}));

app.post('/api/jobs/:id/storyboard/approve', wrap((req, res) => {
  const job = need(req);
  if (job.stage !== 'storyboard' || !job.storyboard) throw new HttpError(409, '스토리보드 단계가 아닙니다.');
  log(job, '스토리보드 승인. 이미지 제작을 시작합니다.');
  launch(job, 'generate');
  res.status(202).json(view(job));
}));

app.post('/api/jobs/:id/cards/:n/revise', wrap((req, res) => {
  const job = need(req);
  idle(job);
  const n = Number(req.params.n);
  const instruction = String(req.body?.instruction ?? '').trim().slice(0, 2000);
  const scope = ['text', 'image', 'both'].includes(req.body?.scope) ? req.body.scope : 'both';
  if (job.stage !== 'review' && job.stage !== 'done') throw new HttpError(409, '검수 단계에서만 카드를 수정할 수 있습니다.');
  if (!instruction) throw new HttpError(400, '수정 내용을 입력하세요.');
  if (job.stage === 'done') job.stage = 'review';
  launch(job, 'reviseCard', n, instruction, scope);
  res.status(202).json(view(job));
}));

// CC0·퍼블릭 도메인 이미지: 검색 결과를 보여 주고, 사람이 고른 한 장만 내려받는다.
app.get('/api/jobs/:id/cards/:n/stock', wrap(async (req, res) => {
  const job = need(req);
  const n = Number(req.params.n);
  if (!job.storyboard?.cards.some((c) => c.n === n)) throw new HttpError(404, '카드를 찾을 수 없습니다.');
  const q = String(req.query.q ?? '').trim();
  res.json({ query: q, results: await searchStock(q) });
}));

app.post('/api/jobs/:id/cards/:n/stock', wrap((req, res) => {
  const job = need(req);
  idle(job);
  const n = Number(req.params.n);
  const pageId = String(req.body?.pageId ?? '');
  if (job.stage !== 'review' && job.stage !== 'done') throw new HttpError(409, '검수 단계에서만 이미지를 바꿀 수 있습니다.');
  if (!job.storyboard?.cards.some((c) => c.n === n)) throw new HttpError(404, '카드를 찾을 수 없습니다.');
  if (!/^\d{1,12}$/.test(pageId)) throw new HttpError(400, '이미지를 고르세요.');
  if (job.stage === 'done') job.stage = 'review';
  launch(job, 'useStock', n, pageId);
  res.status(202).json(view(job));
}));

app.post('/api/jobs/:id/approve', wrap((req, res) => {
  const job = need(req);
  idle(job);
  if (job.stage !== 'review') throw new HttpError(409, '검수 단계가 아닙니다.');
  const bad = job.storyboard!.cards.filter((c) => c.image?.status === 'failed');
  if (bad.length) throw new HttpError(409, '이미지 생성이 실패한 카드가 있습니다.');
  job.finalApproved = true;
  job.stage = 'done';
  log(job, '최종 승인. 내려받을 수 있습니다.');
  save(job);
  res.json(view(job));
}));

// 이미지 생성이 막혀 있을 때(한도·키 문제) 대체 배경으로 나머지 흐름을 이어간다. 실제 생성은 미완료로 기록된다.
app.post('/api/jobs/:id/use-placeholders', wrap((req, res) => {
  const job = need(req);
  if (job.stage !== 'generate' || !job.storyboard) throw new HttpError(409, '이미지 제작 단계가 아닙니다.');
  if (job.busy) throw new HttpError(409, '진행 중인 작업이 있습니다.');
  for (const c of job.storyboard.cards) {
    if (c.image?.status !== 'ok') {
      c.image = { status: 'placeholder', prompt: c.image?.prompt ?? c.imagePrompt, category: '대체 배경(이미지 아님)', note: '이미지 생성을 쓸 수 없어 대체 그라디언트 배경 사용 (실제 이미지 생성 미완료)' };
    }
  }
  job.error = null;
  log(job, '이미지 생성 대신 대체 배경으로 계속합니다. (실제 이미지 생성은 미완료로 기록)');
  launch(job, 'review');
  res.status(202).json(view(job));
}));

// 학습일지: 자료가 부족하다고 표시된 메모를 보완해 개념 정리를 다시 시작한다.
app.post('/api/jobs/:id/notes', wrap((req, res) => {
  const job = need(req);
  if (job.mode !== 'journal') throw new HttpError(409, '학습일지 작업이 아닙니다.');
  if (job.busy) throw new HttpError(409, '진행 중인 작업이 있습니다.');
  if (job.stage !== 'select' && job.stage !== 'search') throw new HttpError(409, '개념 선택 단계(또는 개념 정리 실패 직후)에서만 메모를 보완할 수 있습니다.');
  const notes = String(req.body?.notes ?? '').trim().slice(0, 8000);
  const links = (Array.isArray(req.body?.links) ? req.body.links : []).map(String).map((l: string) => l.trim()).filter((l: string) => /^https?:\/\//.test(l)).slice(0, 10);
  if (notes.length < 20) throw new HttpError(400, '학습 메모를 20자 이상 적어 주세요.');
  job.notes = notes;
  job.links = links;
  job.candidates = [];
  job.selected = [];
  job.gaps = [];
  job.hookDesign = null;
  log(job, '메모를 보완했습니다. 개념을 다시 정리합니다.');
  launch(job, 'search', 7);
  res.status(202).json(view(job));
}));

// 학습일지: 카드를 고친 뒤 포스트를 카드에 맞춰 다시 쓴다.
app.post('/api/jobs/:id/post/rewrite', wrap((req, res) => {
  const job = need(req);
  idle(job);
  if (job.mode !== 'journal' || !job.storyboard) throw new HttpError(409, '학습일지 작업이 아닙니다.');
  if (job.stage !== 'review' && job.stage !== 'done') throw new HttpError(409, '검수 단계에서만 다시 쓸 수 있습니다.');
  job.post = null;
  job.finalApproved = false;
  if (job.stage === 'done') job.stage = 'review';
  launch(job, 'writePost');
  res.status(202).json(view(job));
}));

// 최종 승인 뒤에 고칠 것이 생기면 승인을 풀고 검수 단계로 돌아간다. 카드·이미지는 그대로 유지된다.
app.post('/api/jobs/:id/reopen', wrap((req, res) => {
  const job = need(req);
  idle(job);
  if (job.stage !== 'done') throw new HttpError(409, '최종 승인된 작업만 승인을 풀 수 있습니다.');
  job.stage = 'review';
  job.finalApproved = false;
  log(job, '최종 승인을 풀고 검수 단계로 돌아왔습니다. 고친 뒤 다시 승인하세요.');
  save(job);
  res.json(view(job));
}));

app.post('/api/jobs/:id/retry', wrap((req, res) => {
  const job = need(req);
  if (!job.retry) throw new HttpError(409, '다시 시도할 작업이 없습니다.');
  const { action, args } = job.retry;
  launch(job, action, ...args);
  res.status(202).json(view(job));
}));

app.get('/api/jobs/:id/images/:file', wrap((req, res) => {
  const job = need(req);
  const file = path.basename(String(req.params.file));
  const p = path.join(jobDir(job.id), 'images', file);
  if (!fs.existsSync(p)) throw new HttpError(404, '이미지가 없습니다.');
  res.sendFile(p);
}));

// 클라이언트가 한글 줄바꿈까지 조정해 그린 최종 PNG를 저장
app.post('/api/jobs/:id/png', wrap((req, res) => {
  const job = need(req);
  const n = Number(req.body?.n);
  const m = String(req.body?.dataUrl ?? '').match(/^data:image\/png;base64,(.+)$/);
  if (!m || !job.storyboard?.cards.some((c) => c.n === n)) throw new HttpError(400, '잘못된 PNG 요청입니다.');
  fs.writeFileSync(path.join(jobDir(job.id), 'out', `card-${String(n).padStart(2, '0')}.png`), Buffer.from(m[1], 'base64'));
  job.exportMeta[String(n)] = { overflow: !!req.body?.overflow, at: new Date().toISOString() };
  save(job);
  res.json({ ok: true });
}));

type CheckStatus = '통과' | '미확인' | '실패';
interface CheckRow { item: string; status: CheckStatus; detail: string }

/** 내보낸 파일(out/*.png)과 저장된 기록을 기준으로 점검한다. 서버가 확인할 수 없는 항목은 통과로 처리하지 않고 '미확인'으로 남긴다. */
function exportChecks(job: Job): { rows: CheckRow[]; human: string[] } {
  const rows: CheckRow[] = [];
  const human: string[] = [];
  const cards = job.storyboard?.cards ?? [];
  const outDir = path.join(jobDir(job.id), 'out');
  const name = (n: number) => `card-${String(n).padStart(2, '0')}.png`;
  const add = (item: string, status: CheckStatus, detail: string) => rows.push({ item, status, detail });

  add('최종 승인', job.finalApproved ? '통과' : '실패', job.finalApproved ? '최종 승인됨' : '최종 승인 전입니다');
  const present = cards.filter((c) => fs.existsSync(path.join(outDir, name(c.n))));
  add('카드 수량·순서', present.length === cards.length && cards.length > 0 ? '통과' : '실패',
    `확정 ${cards.length}장 / 내보낸 PNG ${present.length}장 (${cards.map((c) => name(c.n)).join(', ')})`);

  const bad: string[] = [];
  for (const c of present) {
    const b = fs.readFileSync(path.join(outDir, name(c.n)));
    const ok = b.length > 20_000 && b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
    if (!ok || b.readUInt32BE(16) !== 1080 || b.readUInt32BE(20) !== 1350) bad.push(name(c.n));
  }
  add('PNG 파일 형식·크기(1080×1350)', present.length && !bad.length ? '통과' : '실패', bad.length ? `문제: ${bad.join(', ')}` : '모든 PNG가 열리고 크기가 맞습니다');

  const noMeta = present.filter((c) => !job.exportMeta[String(c.n)]);
  const over = present.filter((c) => job.exportMeta[String(c.n)]?.overflow);
  add('글자 잘림·넘침(렌더러 측정)', over.length ? '실패' : noMeta.length ? '미확인' : '통과',
    over.length ? `넘침: ${over.map((c) => c.n).join(', ')}번 카드` : noMeta.length ? `내보낼 때 측정값이 없는 카드: ${noMeta.map((c) => c.n).join(', ')}` : '렌더러가 모든 카드에서 넘침 없음으로 측정했습니다');
  human.push('모바일 크기에서 글자가 읽히는지, 그림과 겹쳐 읽기 어려운 카드가 없는지 PNG를 직접 열어 확인하세요(자동 점검은 잘림만 측정합니다).');

  const imgRows = cards.map((c) => {
    if (c.image?.status === 'ok' && c.image.file) {
      const p = path.join(jobDir(job.id), 'images', c.image.file);
      return fs.existsSync(p) && inspectImage(fs.readFileSync(p)) ? 'ok' : 'missing';
    }
    return c.image?.status ?? 'none';
  });
  const missing = cards.filter((_, i) => ['missing', 'failed', 'none'].includes(imgRows[i]));
  const ph = cards.filter((_, i) => imgRows[i] === 'placeholder');
  add('생성 이미지 파일', missing.length ? '실패' : ph.length ? '미확인' : '통과',
    missing.length ? `파일이 없거나 열리지 않는 카드: ${missing.map((c) => c.n).join(', ')}`
      : ph.length ? `${ph.map((c) => c.n).join(', ')}번 카드는 대체 배경이라 실제 이미지 생성은 확인되지 않았습니다`
        : `${cards.length}장 모두 저장된 파일이 실제 이미지로 열립니다 (작업자: ${[...new Set(cards.map((c) => c.image?.worker))].join(', ')})`);
  if (ph.length) human.push('대체 배경 카드가 있습니다. 실제 이미지가 필요하면 이미지 작업자를 연결한 뒤 해당 카드를 다시 만드세요.');

  const noSrc = cards.filter((c) => !c.source);
  add('카드별 출처', noSrc.length ? '미확인' : '통과', noSrc.length ? `출처가 없는 카드: ${noSrc.map((c) => c.n).join(', ')} (메모 기준 내용이면 정상)` : '모든 카드에 출처 링크가 있습니다');
  if (job.mode === 'news') human.push('핵심 문장 하나를 골라 날짜·조건을 원문 링크와 직접 대조하세요(앱은 원문을 다시 열어 비교하지 않습니다).');
  add('조사 기준일', job.search?.to ? '통과' : '실패', job.search?.to ? `기준일 ${job.search.to} (표지 카드에 표시됩니다)` : '기준일이 없습니다');
  human.push('표지 PNG에 기준일이 실제로 보이는지 확인하세요(코드로 그리지만 PNG에서 글자를 읽어 확인하지는 않습니다).');

  const generated = cards.filter((c) => c.image?.status === 'ok' && (c.image.category ?? '생성 이미지') === '생성 이미지');
  const stock = cards.filter((c) => c.image?.status === 'ok' && c.image.category === 'CC0·퍼블릭 도메인');
  const stockBad = stock.filter((c) => !c.image?.license || !c.image.creator || !c.image.sourceUrl);
  add('이미지 표시·출처 기록', stockBad.length ? '실패' : generated.length || stock.length ? '통과' : '미확인',
    stockBad.length ? `출처·라이선스 기록이 빠진 CC0 이미지 카드: ${stockBad.map((c) => c.n).join(', ')}`
      : generated.length || stock.length ? [generated.length ? `생성 이미지 ${generated.length}장은 "AI 생성 이미지" 표시와 도구·약관·"실제 제품 화면 아님" 기록` : '', stock.length ? `CC0·퍼블릭 도메인 ${stock.length}장은 작가·라이선스·파일 페이지 주소를 sources.md와 image_usage.json에 기록` : ''].filter(Boolean).join(' / ')
        : '실제 이미지가 없어 해당 없음');
  const facts = job.research.reduce((n, r) => n + r.facts.length, 0);
  add('근거 확인 기록', facts ? '통과' : '실패', facts ? `확인된 사실 ${facts}건과 근거 링크가 sources.json에 포함됩니다` : '근거가 없습니다');
  const flagged = cards.filter((c) => c.qa && !c.qa.ok);
  const unchecked = cards.filter((c) => !c.qa);
  add('AI 사실·출처 검수', flagged.length || unchecked.length ? '미확인' : '통과',
    flagged.length ? `확인이 필요하다고 지적된 카드: ${flagged.map((c) => c.n).join(', ')}` : unchecked.length ? `검수 결과가 없는 카드: ${unchecked.map((c) => c.n).join(', ')}` : '검수에서 지적된 카드가 없습니다');
  if (flagged.length) human.push(`검수가 지적한 카드(${flagged.map((c) => c.n).join(', ')}번)의 문장을 원문과 대조하세요.`);
  return { rows, human };
}

app.get('/api/jobs/:id/export-check', wrap((req, res) => {
  const job = need(req);
  if (!job.storyboard) throw new HttpError(409, '스토리보드가 없습니다.');
  const { rows, human } = exportChecks(job);
  const count = (s: CheckStatus) => rows.filter((r) => r.status === s).length;
  res.json({ rows, human, summary: { 통과: count('통과'), 미확인: count('미확인'), 실패: count('실패') } });
}));

app.get('/api/jobs/:id/download.zip', wrap((req, res) => {
  const job = need(req);
  if (!job.finalApproved || !job.storyboard) throw new HttpError(409, '최종 승인 후 내려받을 수 있습니다.');
  if (job.mode === 'journal' && !job.post) throw new HttpError(409, '포스트가 아직 작성되지 않았습니다.');
  const cards = job.storyboard.cards;
  const outDir = path.join(jobDir(job.id), 'out');
  const missing = cards.filter((c) => !fs.existsSync(path.join(outDir, `card-${String(c.n).padStart(2, '0')}.png`)));
  if (missing.length) throw new HttpError(409, `PNG가 아직 만들어지지 않은 카드: ${missing.map((c) => c.n).join(', ')}`);

  const picked = job.candidates.filter((c) => job.selected.includes(c.id));
  const sources = {
    topic: job.topic, asOf: job.search?.asOfLabel, window: job.search && `${job.search.from} ~ ${job.search.to}`,
    articles: picked.map(({ title, date, announcedOn, url, source }) => ({ title, date: job.mode === 'journal' ? null : date, announcedOn: job.mode === 'journal' ? undefined : announcedOn ?? '미확인', confirmedOn: job.mode === 'journal' ? job.search?.to : undefined, url: url.startsWith('memo:') ? null : url, source })),
    facts: job.research,
    cardSources: cards.map((c) => ({ card: c.n, title: c.title, source: c.source })),
  };
  const usage = cards.map((c) => ({
    card: c.n, status: c.image?.status, model: c.image?.model ?? null, generatedAt: c.image?.generatedAt ?? null,
    file: c.image?.file ?? null, worker: c.image?.worker ?? null, license: c.image?.license ?? null, licenseUrl: c.image?.licenseUrl ?? null, creator: c.image?.creator ?? null, sourceUrl: c.image?.sourceUrl ?? null, imageTitle: c.image?.title ?? null, width: c.image?.width ?? null, height: c.image?.height ?? null, prompt: c.image?.prompt, note: c.image?.note ?? null,
    category: c.image?.category ?? null, tool: c.image?.tool ?? null, terms: c.image?.terms ?? null, depiction: c.image?.depiction ?? null,
  }));
  const when = (d: string, announced?: string) => (job.mode === 'journal' ? `확인일 ${job.search?.to}` : `게시일 ${d} · 발표·변경일 ${announced && announced !== '미확인' ? announced : '미확인'}`);
  const md = `# 출처\n\n주제: ${job.topic}\n기준: ${sources.asOf} / 조사 기간 ${sources.window}\n\n${picked.map((a) => (a.url.startsWith('memo:') ? `- ${a.title} — ${a.source}, ${when(a.date, a.announcedOn)}` : `- [${a.title}](${a.url}) — ${a.source}, ${when(a.date, a.announcedOn)}`)).join('\n')}\n`;

  res.setHeader('content-type', 'application/zip');
  res.setHeader('content-disposition', `attachment; filename="cardnews-${job.id}.zip"`);
  const zip = archiver('zip');
  zip.on('error', () => res.end());
  zip.pipe(res);
  for (const c of cards) zip.file(path.join(outDir, `card-${String(c.n).padStart(2, '0')}.png`), { name: `cards/card-${String(c.n).padStart(2, '0')}.png` });
  if (job.post) zip.append(job.post.markdown, { name: 'post.md' });
  zip.append(JSON.stringify(sources, null, 2), { name: 'sources.json' });
  const stockLines = cards.filter((c) => c.image?.category === 'CC0·퍼블릭 도메인' && c.image.sourceUrl)
    .map((c) => `- 카드 ${c.n}: [${c.image!.title}](${c.image!.sourceUrl}) — ${c.image!.creator}, ${c.image!.license} (Wikimedia Commons, 사람이 직접 선택)`);
  const genLines = cards.filter((c) => c.image?.category === '생성 이미지').map((c) => `- 카드 ${c.n}: ${c.image!.tool} — 설명용 생성 이미지(실제 제품 화면·발표 장면 아님)`);
  const imageSection = stockLines.length || genLines.length ? `\n## 이미지 출처와 사용 조건\n\n${[...genLines, ...stockLines].join('\n')}\n\nCC0·퍼블릭 도메인 표시는 Commons 메타데이터 기준입니다. 게시 전에 각 파일 페이지에서 라이선스와 사진 속 인물·상표 권리를 확인하세요.\n` : '';
  zip.append(md + imageSection, { name: 'sources.md' });
  zip.append(JSON.stringify(usage, null, 2), { name: 'image_usage.json' });
  void zip.finalize();
}));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  const e = err as Error & { status?: number };
  if (e instanceof EngineError) return res.status(409).json({ error: e.message });
  if (typeof e.status === 'number' && e.status >= 400 && e.status < 500) return res.status(e.status).json({ error: e.status === 413 ? '요청이 너무 큽니다.' : '잘못된 요청입니다.' });
  console.error('서버 오류:', e);
  res.status(500).json({ error: '서버 오류가 발생했습니다. 잠시 후 다시 시도하세요.' });
});

recoverInterrupted();
const port = PORT;
app.listen(port, '127.0.0.1', () => console.log(`카드뉴스 에이전트: http://localhost:${port}`));
