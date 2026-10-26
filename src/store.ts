import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type Stage = 'search' | 'select' | 'research' | 'editorial' | 'storyboard' | 'generate' | 'review' | 'done';

export interface Candidate {
  id: string;
  /** 모델·제품·연구·개발 도구·정책·기타 */
  category?: string;
  /** 실제 발표·변경일(YYYY-MM-DD). 확인하지 못했으면 '미확인' */
  announcedOn?: string;
  /** 선택할 가치 */
  value?: string;
  /** 불확실성 */
  uncertainty?: string;
  /** 조사 중 이 원문 주소를 실제로 열어 읽었는지(엔진 이벤트로 서버가 확인) */
  opened?: boolean;
  title: string;
  summary: string;
  date: string;
  url: string;
  source: string;
}

export interface Fact {
  /** verified=원문에서 확인한 사실, claim=발표 주체의 주장, unverified=아직 확인하지 못한 내용 */
  kind?: 'verified' | 'claim' | 'unverified';
  claim: string;
  evidence: string;
  url: string;
}

export interface ResearchItem {
  id: string;
  /** 무엇이 달라졌는지 */
  changes?: string;
  /** 누가·언제부터·지역·요금제 등 사용 조건 */
  conditions?: { who: string; since: string; region: string; plan: string; other: string };
  /** 자료 간 날짜·조건 불일치 */
  discrepancies?: string[];
  headline: string;
  facts: Fact[];
  caveats: string;
}

export interface Question {
  id: string;
  label: string;
  why: string;
  options: string[];
  recommended: string;
}

export interface CardImage {
  status: 'ok' | 'placeholder' | 'failed';
  category?: string;
  worker?: string;
  /** CC0·퍼블릭 도메인 이미지의 출처·라이선스 기록 */
  license?: string;
  licenseUrl?: string;
  creator?: string;
  sourceUrl?: string;
  title?: string;
  width?: number;
  height?: number;
  tool?: string;
  terms?: string;
  depiction?: string;
  file?: string;
  model?: string;
  prompt: string;
  generatedAt?: string;
  note?: string;
}

export interface Card {
  n: number;
  role: string;
  title: string;
  body: string;
  source: { title: string; url: string; date?: string; reportedOn?: string } | null;
  visual: string;
  imagePrompt: string;
  image?: CardImage;
  qa?: { ok: boolean; issue: string };
}

export interface FormatOption {
  name: string;
  fits: string;
  pros: string;
  cons: string;
}

export interface FormatComparison {
  options: FormatOption[];
  recommended: string;
  reason: string;
}

export interface Activity {
  t: string;
  step: string;
  kind: 'search' | 'fetch' | 'result' | 'hook';
  detail: string;
}

export interface HookCandidate {
  text: string;
  evidence: string;
  risk: string;
}

export interface HookDesign {
  interest: string;
  candidates: HookCandidate[];
  chosen: string;
  reason: string;
}

export interface JobError {
  message: string;
  hint: string;
  label: string;
}

export interface Job {
  id: string;
  topic: string;
  brief: string;
  createdAt: string;
  updatedAt: string;
  stage: Stage;
  busy: string | null;
  error: JobError | null;
  retry: { action: string; args: unknown[] } | null;
  search: { asOf: string; asOfLabel: string; days: number; from: string; to: string; shortage: boolean; dropped: number } | null;
  candidates: Candidate[];
  selected: string[];
  research: ResearchItem[];
  questions: Question[];
  /** 편집 질문이 새로 만들어질 때마다 1씩 올라간다. 답변은 어떤 버전에 대한 것인지 함께 보내야 한다. */
  qVersion: number;
  /** 내보낸 PNG별로 브라우저가 알려 준 글자 넘침 여부 */
  exportMeta: Record<string, { overflow: boolean; at: string }>;
  mode: 'news' | 'journal';
  notes: string;
  links: string[];
  post: { title: string; markdown: string; at: string } | null;
  /** 학습일지: 메모에서 부족하다고 판단된 점(개념 이름·예시·링크 등) */
  gaps: string[];
  comparison: FormatComparison | null;
  hookDesign: HookDesign | null;
  activity: Activity[];
  answers: Record<string, string>;
  storyboard: { version: number; styleGuide: string; cards: Card[] } | null;
  finalApproved: boolean;
  log: { t: string; msg: string }[];
}

export const ROOT = path.resolve(process.cwd(), 'data', 'jobs');
fs.mkdirSync(ROOT, { recursive: true });

const cache = new Map<string, Job>();

export const jobDir = (id: string) => path.join(ROOT, id);

export function newJob(topic: string, brief = '', opts: { mode?: 'news' | 'journal'; notes?: string; links?: string[] } = {}): Job {
  const id = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(3).toString('hex');
  const now = new Date().toISOString();
  const job: Job = {
    id, topic, brief, mode: opts.mode ?? 'news', notes: opts.notes ?? '', links: opts.links ?? [], post: null, gaps: [], createdAt: now, updatedAt: now, stage: 'search', busy: null, error: null, retry: null,
    search: null, candidates: [], selected: [], research: [], questions: [], qVersion: 0, exportMeta: {}, comparison: null, hookDesign: null, activity: [], answers: {},
    storyboard: null, finalApproved: false, log: [],
  };
  fs.mkdirSync(path.join(jobDir(id), 'images'), { recursive: true });
  fs.mkdirSync(path.join(jobDir(id), 'out'), { recursive: true });
  cache.set(id, job);
  save(job);
  return job;
}

export function save(job: Job) {
  job.updatedAt = new Date().toISOString();
  const file = path.join(jobDir(job.id), 'job.json');
  const tmp = file + '.tmp';
  const json = JSON.stringify(job, null, 2);
  // Windows에서는 백신·색인기가 파일을 잠깐 잡고 있으면 rename이 EPERM/EBUSY로 실패할 수 있어 몇 번 다시 시도한다.
  // 저장 실패가 이벤트 콜백에서 예외로 번져 서버가 죽지 않도록, 마지막에는 직접 쓰기를 시도하고 그래도 실패하면 기록만 남긴다.
  try {
    fs.writeFileSync(tmp, json);
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (e) {
        if (i >= 5) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1));
      }
    }
  } catch {
    try {
      fs.writeFileSync(file, json);
    } catch (e2) {
      console.error('작업 저장 실패:', job.id, (e2 as Error).message);
    }
  }
}

export function log(job: Job, msg: string) {
  job.log.push({ t: new Date().toISOString(), msg });
  if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
  save(job);
}

export function addActivity(job: Job, step: string, kind: Activity['kind'], detail: string) {
  job.activity.push({ t: new Date().toISOString(), step, kind, detail });
  if (job.activity.length > 400) job.activity.splice(0, job.activity.length - 400);
  save(job);
}

export function getJob(id: string): Job | null {
  if (!/^[\w-]+$/.test(id)) return null;
  const hit = cache.get(id);
  if (hit) return hit;
  const file = path.join(jobDir(id), 'job.json');
  if (!fs.existsSync(file)) return null;
  let job: Job;
  try {
    job = JSON.parse(fs.readFileSync(file, 'utf8')) as Job;
  } catch (e) {
    // 손상된 파일 하나가 목록 조회와 서버 시작을 막지 않게 한다.
    console.error('작업 파일을 읽지 못했습니다:', id, (e as Error).message);
    return null;
  }
  job.activity ??= [];
  job.qVersion ??= 0;
  job.exportMeta ??= {};
  job.hookDesign ??= null;
  job.brief ??= '';
  job.comparison ??= null;
  job.mode ??= 'news';
  job.notes ??= '';
  job.links ??= [];
  job.post ??= null;
  job.gaps ??= [];
  // 발표·변경일이 확인되지 않은 소식의 카드 출처에 발표일로 저장돼 있던 날짜(이전 방식)를 보도 기준 날짜로 바로잡는다.
  if (job.mode === 'news' && job.storyboard) {
    for (const c of job.storyboard.cards) {
      const src = c.source;
      if (!src?.date) continue;
      const cand = job.candidates.find((x) => x.url === src.url);
      if (cand && cand.announcedOn !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(cand.announcedOn)) {
        src.reportedOn = src.date;
        delete src.date;
      }
    }
  }
  cache.set(id, job);
  return job;
}

export function listJobs(): Pick<Job, 'id' | 'topic' | 'stage' | 'updatedAt'>[] {
  return fs.readdirSync(ROOT)
    .map((id) => getJob(id))
    .filter((j): j is Job => !!j)
    .map(({ id, topic, stage, updatedAt }) => ({ id, topic, stage, updatedAt }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 서버가 작업 도중 종료됐다면 busy 상태를 풀고 재시도할 수 있게 표시한다. */
export function recoverInterrupted() {
  for (const { id } of listJobs()) {
    const job = getJob(id);
    if (!job) continue;
    if (job.busy) {
      job.error = { message: `서버가 재시작되어 "${job.busy}" 작업이 중단되었습니다.`, hint: '다시 시도를 누르면 이어서 진행합니다.', label: job.busy };
      job.busy = null;
      save(job);
    }
  }
}
