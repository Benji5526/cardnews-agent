// 카드 렌더러: 배경 이미지(없으면 대체 그라디언트) 위에 글자를 별도로 배치한다.
// 미리보기와 최종 PNG가 같은 함수를 쓰므로 화면에서 본 모양이 그대로 저장된다.
const CARD_W = 1080, CARD_H = 1350, PAD = 72;
const FONT = '"Pretendard","Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif';
const PALETTES = [['#1d2b64', '#f8cdda'], ['#0f2027', '#2c5364'], ['#42275a', '#734b6d'], ['#134e5e', '#71b280'], ['#2b5876', '#4e4376'], ['#3a1c71', '#ffaf7b']];

// 한국어 줄바꿈: 단어(띄어쓰기) 단위로 채우되, 한 단어가 줄보다 길면 글자 단위로 끊는다.
function wrapKo(ctx, text, maxW) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let cur = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = cur ? cur + ' ' + word : word;
      if (ctx.measureText(next).width <= maxW) { cur = next; continue; }
      if (cur) lines.push(cur);
      cur = '';
      if (ctx.measureText(word).width <= maxW) { cur = word; continue; }
      for (const ch of word) {
        if (ctx.measureText(cur + ch).width > maxW && cur) { lines.push(cur); cur = ch; } else cur += ch;
      }
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

function fitBlock(ctx, text, weight, size, minSize, maxLines, maxW, lh) {
  for (let s = size; s >= minSize; s -= 2) {
    ctx.font = `${weight} ${s}px ${FONT}`;
    const lines = wrapKo(ctx, text, maxW);
    if (lines.length <= maxLines) return { lines, size: s, lh: Math.round(s * lh), overflow: false };
  }
  ctx.font = `${weight} ${minSize}px ${FONT}`;
  const lines = wrapKo(ctx, text, maxW);
  return { lines: lines.slice(0, maxLines), size: minSize, lh: Math.round(minSize * lh), overflow: true };
}

function drawBackground(ctx, img, n) {
  if (img) {
    const r = Math.max(CARD_W / img.width, CARD_H / img.height);
    const w = img.width * r, h = img.height * r;
    ctx.drawImage(img, (CARD_W - w) / 2, (CARD_H - h) / 2, w, h);
  } else {
    const [a, b] = PALETTES[(n - 1) % PALETTES.length];
    const g = ctx.createLinearGradient(0, 0, CARD_W, CARD_H);
    g.addColorStop(0, a); g.addColorStop(1, b);
    ctx.fillStyle = g; ctx.fillRect(0, 0, CARD_W, CARD_H);
  }
  const shade = ctx.createLinearGradient(0, CARD_H * 0.25, 0, CARD_H);
  shade.addColorStop(0, 'rgba(0,0,0,0)'); shade.addColorStop(0.55, 'rgba(0,0,0,.62)'); shade.addColorStop(1, 'rgba(0,0,0,.86)');
  ctx.fillStyle = shade; ctx.fillRect(0, 0, CARD_W, CARD_H);
  // 상단 칩·쪽수가 그림 위에서도 읽히도록 위쪽도 살짝 어둡게 한다.
  const top = ctx.createLinearGradient(0, 0, 0, 240);
  top.addColorStop(0, 'rgba(0,0,0,.55)'); top.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = top; ctx.fillRect(0, 0, CARD_W, 240);
}

// 반환: { overflow: boolean } — 글자가 잘리거나 영역을 벗어나면 true
// meta: { asOf: 'YYYY-MM-DD' 조사 기준일, journal: 학습일지 모드 여부 }
// 카드 위 칩(role)과 같은 말로 시작하는 제목이면 반복되는 앞부분을 뗀다. ("바로잡은 점: 쉼표는 에러" → "쉼표는 에러")
function displayTitle(card) {
  const role = (card.role || '').trim();
  const t = (card.title || '').trim();
  if (role && t.startsWith(role)) {
    const rest = t.slice(role.length).replace(/^[\s:：\-–—·]+/, '');
    if (rest.length >= 2) return rest;
  }
  return t;
}

function renderCard(canvas, card, total, img, meta = {}) {
  canvas.width = CARD_W; canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  drawBackground(ctx, img, card.n);
  const maxW = CARD_W - PAD * 2;
  const cover = card.n === 1;
  ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#fff';

  const title = fitBlock(ctx, displayTitle(card), 800, cover ? 96 : 78, 52, 4, maxW, 1.28);
  const body = fitBlock(ctx, card.body, 500, 42, 32, 6, maxW, 1.55);
  const bottom = CARD_H - 150;
  const bodyH = body.lines.length * body.lh;
  const titleH = title.lines.length * title.lh;
  const top = bottom - bodyH - 36 - titleH;

  // 역할 칩 + 페이지
  ctx.font = `700 30px ${FONT}`;
  const chipW = ctx.measureText(card.role).width + 40;
  ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.beginPath(); ctx.roundRect(PAD, 84, chipW, 54, 27); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.fillText(card.role, PAD + 20, 121);
  ctx.textAlign = 'right'; ctx.font = `500 30px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.8)';
  ctx.fillText(`${card.n} / ${total}`, CARD_W - PAD, 121); ctx.textAlign = 'left';

  ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 12;
  ctx.fillStyle = '#fff'; ctx.font = `800 ${title.size}px ${FONT}`;
  title.lines.forEach((l, i) => ctx.fillText(l, PAD, top + title.size + i * title.lh - (title.lh - title.size) / 2));
  ctx.font = `500 ${body.size}px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.94)';
  const bodyTop = top + titleH + 36;
  body.lines.forEach((l, i) => ctx.fillText(l, PAD, bodyTop + body.size + i * body.lh - (body.lh - body.size) / 2));
  ctx.shadowBlur = 0;

  if (card.source) {
    let host = card.source.url;
    try { host = new URL(card.source.url).hostname.replace(/^www\./, ''); } catch {}
    ctx.font = `500 26px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.75)';
    let label = `출처: ${card.source.title} (${host})`;
    while (ctx.measureText(label).width > maxW && label.length > 12) label = label.slice(0, -2);
    if (label !== `출처: ${card.source.title} (${host})`) label += '…';
    ctx.fillText(label, PAD, CARD_H - 72);
  }
  // 하단 보조줄: 표지에는 기준일·원문 게시일, 생성 이미지에는 AI 생성 표시
  ctx.font = `500 24px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.7)';
  if (card.n === 1 && meta.asOf) {
    // 학습일지는 모델이 준 원문 게시일을 확인할 수 없으므로 게시일 대신 확인일만 표시한다.
    // 발표·변경일이 확인된 경우만 "발표"로 표시하고, 아니면 게시일을 "보도 기준"으로 밝히며 발표일은 미확인으로 둔다.
    const posted = card.source?.date ? ` · 발표·변경 ${card.source.date}` : card.source?.reportedOn ? ` · 게시 ${card.source.reportedOn} · 발표일 미확인` : '';
    ctx.fillText(meta.journal ? `확인일 ${meta.asOf}` : `기준일 ${meta.asOf}${posted}`, PAD, CARD_H - 112);
  }
  if (card.image?.status === 'ok') {
    ctx.textAlign = 'right'; ctx.fillText(card.image.category === 'CC0·퍼블릭 도메인' ? `이미지: ${card.image.license} · Wikimedia Commons` : 'AI 생성 이미지', CARD_W - PAD, CARD_H - 112); ctx.textAlign = 'left';
  }
  const overflow = title.overflow || body.overflow || top < 190;
  return { overflow };
}

function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => resolve(null);
    i.src = src;
  });
}
