// searchStock 필터가 어느 단계에서 결과를 줄이는지 확인하는 점검 스크립트. 사용: npx tsx scripts/stock-debug.mts "server rack"
const q = process.argv[2] ?? 'server rack';
const qs = new URLSearchParams({ action: 'query', format: 'json', prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1600', generator: 'search', gsrnamespace: '6', gsrlimit: '40', gsrsearch: `${q} filetype:bitmap` });
const r = await fetch('https://commons.wikimedia.org/w/api.php?' + qs, { headers: { 'User-Agent': 'cardnews-agent-local/0.1 (local study project)' } });
const j: any = await r.json();
const pages = Object.values(j.query?.pages ?? {}) as any[];
const FREE = /^(cc0|public domain|pd)\b/i;
let n = { total: pages.length, noInfo: 0, license: 0, mime: 0, size: 0, host: 0, ok: 0 };
for (const p of pages) {
  const ii = p.imageinfo?.[0];
  if (!ii) { n.noInfo++; continue; }
  const lic = ii.extmetadata?.LicenseShortName?.value ?? '';
  if (!FREE.test(lic)) { n.license++; continue; }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(ii.mime)) { n.mime++; continue; }
  if (Math.min(ii.width, ii.height) < 700 || Math.max(ii.width, ii.height) < 1200) { n.size++; console.log('  크기 제외', p.title.slice(0, 40), ii.width, ii.height); continue; }
  const u = ii.thumburl || ii.url;
  if (new URL(u).host !== 'upload.wikimedia.org') { n.host++; console.log('  호스트 제외', new URL(u).host, u.slice(0, 110)); continue; }
  n.ok++;
}
console.log(q, JSON.stringify(n));
