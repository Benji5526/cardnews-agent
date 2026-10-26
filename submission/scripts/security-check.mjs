import http from 'node:http';
import fs from 'node:fs';

const req = (method, path, { headers = {}, body } = {}) => new Promise((resolve) => {
  const r = http.request({ host: '127.0.0.1', port: 4310, method, path, headers }, (res) => {
    let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
  });
  r.on('error', (e) => resolve({ status: 'ERR', body: String(e).slice(0, 80), headers: {} }));
  if (body !== undefined) r.write(body);
  r.end();
});
const J = { 'content-type': 'application/json' };
const rows = [];
const check = (name, got, want, extra = '') => { const ok = Array.isArray(want) ? want.includes(got) : got === want; rows.push(`${ok ? 'OK  ' : 'FAIL'} ${name} → ${got} (기대 ${want})${extra ? ' ' + extra : ''}`); };

// 정상 요청
let r = await req('GET', '/api/health', { headers: { host: 'localhost:4310' } });
check('정상 GET /api/health (Host localhost)', r.status, 200);
r = await req('GET', '/', { headers: { host: '127.0.0.1:4310' } });
check('정상 GET / (정적 파일)', r.status, 200, `CSP=${r.headers['content-security-policy'] ? '있음' : '없음'} nosniff=${r.headers['x-content-type-options']}`);

// H2: DNS 리바인딩 — 다른 Host
r = await req('GET', '/api/jobs', { headers: { host: 'evil.example:4310' } });
check('H2 다른 Host로 작업 목록 조회', r.status, 421);
r = await req('POST', '/api/jobs', { headers: { host: 'evil.example:4310', ...J }, body: JSON.stringify({ topic: 'x' }) });
check('H2 다른 Host로 작업 생성', r.status, 421);

// M2/H2: 교차 사이트 요청
r = await req('POST', '/api/jobs', { headers: { host: 'localhost:4310', origin: 'https://evil.example', ...J }, body: JSON.stringify({ topic: 'x' }) });
check('H2 다른 Origin의 POST', r.status, 403);
r = await req('POST', '/api/health/test-image', { headers: { host: 'localhost:4310', 'content-type': 'text/plain' }, body: 'x' });
check('M2 text/plain POST(단순 교차 사이트 요청 형식)', r.status, 415);
r = await req('POST', '/api/health/test-image', { headers: { host: 'localhost:4310' } });
check('M2 Content-Type 없는 POST', r.status, 415);
r = await req('POST', '/api/jobs', { headers: { host: 'localhost:4310', origin: 'http://localhost:4310', ...J }, body: JSON.stringify({ topic: '' }) });
check('정상 Origin의 JSON POST(주제 비어 400)', r.status, 400);

// M4: 본문 크기
r = await req('POST', '/api/jobs', { headers: { host: 'localhost:4310', ...J }, body: JSON.stringify({ topic: 'x', brief: 'a'.repeat(100_000) }) });
check('M4 100KB 본문', r.status, 413, r.body.slice(0, 40));
r = await req('POST', '/api/jobs/20261023-4a5145/storyboard/revise', { headers: { host: 'localhost:4310', ...J }, body: '{"feedback": [broken' });
check('깨진 JSON 본문', r.status, [400], `본문=${r.body.slice(0, 50)}`);

// L2: 잘못된 타입
r = await req('POST', '/api/jobs/20261023-4a5145/select', { headers: { host: 'localhost:4310', ...J }, body: JSON.stringify({ ids: 'c1' }) });
check('L2 ids가 문자열', r.status, [409, 400], r.body.slice(0, 60));

// 경로 조작
r = await req('GET', '/api/jobs/..%2F..%2Fpackage.json', { headers: { host: 'localhost:4310' } });
check('경로 조작 작업 ID', r.status, 404);
r = await req('GET', '/api/jobs/20261023-4a5145/images/..%2Fjob.json', { headers: { host: 'localhost:4310' } });
check('경로 조작 이미지 이름', r.status, 404);

console.log(rows.join('\n'));
console.log(rows.some((x) => x.startsWith('FAIL')) ? 'RESULT: 실패 있음' : 'RESULT: 전부 통과');
