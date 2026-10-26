// Wikimedia Commons 검색 응답 확인용(개발 중 점검). 사용: node scripts/commons-probe.cjs "검색어"
const q = process.argv[2] || 'server rack';
const params = new URLSearchParams({
  action: 'query', format: 'json', generator: 'search', gsrnamespace: '6', gsrlimit: '30',
  gsrsearch: `${q} filetype:bitmap`, prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1080', origin: '*',
});
(async () => {
  const t0 = Date.now();
  const r = await fetch('https://commons.wikimedia.org/w/api.php?' + params, { headers: { 'User-Agent': 'cardnews-agent-local/0.1 (local study project)' }, signal: AbortSignal.timeout(40000) });
  const j = await r.json();
  const pages = Object.values(j.query?.pages ?? {});
  console.log(`http ${r.status} ${Date.now() - t0}ms 결과 ${pages.length}건`);
  const lic = new Map();
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    const name = ii?.extmetadata?.LicenseShortName?.value ?? '(없음)';
    lic.set(name, (lic.get(name) || 0) + 1);
  }
  console.log('라이선스 분포:', [...lic].map(([k, v]) => `${k} ${v}`).join(' | '));
  const free = pages.filter((p) => /^(public domain|pd|cc0)/i.test(p.imageinfo?.[0]?.extmetadata?.LicenseShortName?.value ?? ''));
  console.log('PD/CC0만:', free.length, '건');
  for (const p of free.slice(0, 6)) {
    const ii = p.imageinfo[0]; const m = ii.extmetadata;
    console.log('-', p.title.slice(0, 50), '|', m.LicenseShortName.value, '|', (m.Artist?.value ?? '').replace(/<[^>]+>/g, '').slice(0, 30), '|', `${ii.width}x${ii.height}`, ii.mime, '| thumb', !!ii.thumburl, '|', new URL(ii.url).host);
  }
})().catch((e) => console.log('실패', String(e).slice(0, 100)));
