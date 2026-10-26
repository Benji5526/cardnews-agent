// 두 작업의 내용이 서로 섞이지 않았는지 검사한다. 주소(URL)는 빼고 본문 용어만 본다.
// 사용: node scripts/leak-check.cjs <작업A id> <작업B id>
const fs = require('fs');
const load = (id) => JSON.parse(fs.readFileSync(`data/jobs/${id}/job.json`, 'utf8'));
const [ida, idb] = process.argv.slice(2);
const KA = ['HTTP', '404', 'ETag', '301', '302', '410'];
const KB = ['flexbox', 'grid', 'z-index', 'CSS', 'gap', 'stacking'];
const body = (j) => JSON.stringify([j.candidates, j.research, j.questions, j.storyboard?.cards, j.hookDesign, j.gaps, j.post])
  .replace(/https?:\/\/[^"\s\\]+/g, '').toLowerCase();
const check = (name, j, own, other) => {
  const t = body(j);
  const has = (ks) => ks.filter((k) => t.includes(k.toLowerCase()));
  console.log(`${name} (${j.id}) 자기 용어: ${has(own).join(', ') || '없음'} | 상대 용어: ${has(other).join(', ') || '없음'} | 주제: ${j.topic} | qVersion ${j.qVersion} | 확정 로그 ${j.log.filter((l) => l.msg.includes('편집 방향 확정')).length}회`);
};
const a = load(ida);
const b = load(idb);
check('A', a, KA, KB);
check('B', b, KB, KA);
console.log('두 job.json 모두 올바른 JSON이고 id가 서로 다름:', a.id !== b.id);
