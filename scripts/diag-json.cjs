// 잘못된 모델 응답(data/debug-last-bad-response.txt)의 괄호 구조가 어디서 어긋나는지 찾는 진단 스크립트.
const fs = require('fs');
const t = fs.readFileSync(process.argv[2] || 'data/debug-last-bad-response.txt', 'utf8');
const st = [];
let inStr = false;
let broke = false;
for (let i = 0; i < t.length; i++) {
  const c = t[i];
  if (inStr) {
    if (c === '\\') i++;
    else if (c === '"') inStr = false;
    continue;
  }
  if (c === '"') { inStr = true; continue; }
  if (c === '{' || c === '[') st.push([c, i]);
  else if (c === '}' || c === ']') {
    const top = st.pop();
    if (!top || (top[0] === '{') !== (c === '}')) {
      console.log('MISMATCH at', i, 'closing', c, 'opened', top);
      console.log(JSON.stringify(t.slice(Math.max(0, i - 200), i + 60)));
      broke = true;
      break;
    }
  }
}
if (!broke) console.log('stack at end:', st.map((x) => x[0] + '@' + x[1]).join(' ') || '(balanced)');
const i = t.indexOf('"comparison"');
console.log('comparison at', i, JSON.stringify(t.slice(Math.max(0, i - 200), i + 40)));
