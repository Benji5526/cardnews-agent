// 오늘의 호주 뉴스 카드뉴스를 자동으로 만들기 시작한다. (npm run daily)
// 서버가 꺼져 있으면 먼저 켜고, 작업을 만든 뒤 바로 돌아온다. 만들어진 카드는 브라우저에서 확인·승인한다.
//   - 하루에 한 번 실행되게 하려면 Windows 작업 스케줄러에 등록한다(README "매일 실행하기").
//   - 외부에 게시하지 않는다. 승인과 내려받기는 사람이 한다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 4310;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 하트비트: 실행할 때마다 data/daily-log.jsonl에 한 줄을 남긴다. 파일이 오늘 날짜로 갱신되지 않았다면 그날은 멈춘 것이다.
//   --wait 를 주면 제작이 끝날 때까지 기다렸다가 최종 상태(검수 대기·실패)도 기록한다.
const WAIT = process.argv.includes('--wait');
// --mode fw: 한국·동남아 음식·웰니스 뉴스 (기본은 호주 데일리 뉴스)
const MODE = process.argv.includes('--mode') && process.argv[process.argv.indexOf('--mode') + 1] === 'fw' ? 'fw' : 'au';
const TOPIC = MODE === 'fw' ? '한국·동남아 음식·웰니스 뉴스' : '오늘의 호주 뉴스';
const LOG = path.join(ROOT, 'data', 'daily-log.jsonl');
const beat = (status, detail = '', extra = {}) => {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), status, detail, ...extra }) + '\n');
  } catch {
    /* 로그 실패가 제작을 막지 않는다 */
  }
};
const fail = (msg, extra) => {
  console.error(msg);
  beat('failed', msg, extra);
  process.exit(1);
};

const healthy = async () => {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch {
    return false;
  }
};

if (!(await healthy())) {
  console.log('서버가 꺼져 있어 먼저 시작합니다…');
  // Windows에서 Node 24는 .cmd를 셸 없이 직접 실행하지 못하므로(EINVAL) 셸을 거친다.
  const child = spawn('npm start', { shell: true, cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    up = await healthy();
  }
  if (!up) {
    fail('서버를 시작하지 못했습니다. 터미널에서 `npm start`를 직접 실행해 오류를 확인하세요.');
  }
}

const res = await fetch(`${BASE}/api/jobs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ mode: MODE, topic: TOPIC }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  fail(`작업을 만들지 못했습니다 (HTTP ${res.status}): ${body.error ?? ''}`);
}
console.log(`자동 제작을 시작했습니다. 약 10분 뒤 검수 화면에서 확인·승인하세요:\n${BASE}/#${body.id}`);
beat('started', '자동 제작 시작', { jobId: body.id, mode: MODE });

if (WAIT) {
  // 최대 40분. 끝나면 검수 대기(waiting_for_user)인지 실패(failed)인지 기록한다.
  let last = null;
  for (let i = 0; i < 480; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    last = await fetch(`${BASE}/api/jobs/${body.id}`).then((r) => r.json()).catch(() => null);
    if (last && last.status && last.status !== 'running') break;
  }
  if (last?.status === 'waiting_for_user' || last?.status === 'done') {
    beat('ready', '검수 대기', { jobId: body.id, stage: last.stage });
    console.log('제작이 끝났습니다. 검수 화면에서 확인·승인하세요.');
  } else {
    fail(`제작이 완료되지 않았습니다 (상태: ${last?.status ?? '확인 불가'}): ${last?.error?.message ?? ''}`, { jobId: body.id });
  }
}
