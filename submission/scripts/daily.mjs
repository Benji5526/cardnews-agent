// 오늘의 호주 뉴스 카드뉴스를 자동으로 만들기 시작한다. (npm run daily)
// 서버가 꺼져 있으면 먼저 켜고, 작업을 만든 뒤 바로 돌아온다. 만들어진 카드는 브라우저에서 확인·승인한다.
//   - 하루에 한 번 실행되게 하려면 Windows 작업 스케줄러에 등록한다(README "매일 실행하기").
//   - 외부에 게시하지 않는다. 승인과 내려받기는 사람이 한다.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 4310;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    console.error('서버를 시작하지 못했습니다. 터미널에서 `npm start`를 직접 실행해 오류를 확인하세요.');
    process.exit(1);
  }
}

const res = await fetch(`${BASE}/api/jobs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ mode: 'au', topic: '오늘의 호주 뉴스' }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`작업을 만들지 못했습니다 (HTTP ${res.status}): ${body.error ?? ''}`);
  process.exit(1);
}
console.log(`자동 제작을 시작했습니다. 약 10분 뒤 검수 화면에서 확인·승인하세요:\n${BASE}/#${body.id}`);
