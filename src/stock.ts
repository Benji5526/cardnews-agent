import { EngineError } from './engines.js';
import { inspectImage } from './imageWorker.js';

/** Wikimedia Commons에서 CC0·퍼블릭 도메인으로 표시된 이미지만 찾는다. 라이선스 표시는 Commons 메타데이터 기준이다. */
const API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'cardnews-agent-local/0.1 (local study project)';
// Wikimedia 소유의 이미지 호스트만 허용한다(원본은 upload, 큰 원본의 축소본은 thumb).
const ALLOWED_HOSTS = new Set(['upload.wikimedia.org', 'thumb.wikimedia.org']);
const FREE = /^(cc0|public domain|pd)\b/i;
const MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 15 * 1024 * 1024;

export interface StockImage {
  id: string;
  title: string;
  creator: string;
  license: string;
  licenseUrl: string;
  pageUrl: string;
  thumbUrl: string;
  url: string;
  width: number;
  height: number;
  mime: string;
}

const strip = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/\s+/g, ' ').trim();

function parsePage(p: any): StockImage | null {
  const ii = p?.imageinfo?.[0];
  const m = ii?.extmetadata ?? {};
  const license: string = m.LicenseShortName?.value ?? '';
  if (!ii || !FREE.test(license) || !MIMES.has(ii.mime)) return null;
  // 카드는 4:5 세로 구도로 잘라 쓰므로 너무 작은 이미지는 제외한다.
  if (Math.min(ii.width, ii.height) < 700 || Math.max(ii.width, ii.height) < 1200) return null;
  const url: string = ii.thumburl || ii.url;
  const thumb: string = ii.thumburl || ii.url;
  try {
    if (new URL(url).protocol !== 'https:' || !ALLOWED_HOSTS.has(new URL(url).host)) return null;
  } catch {
    return null;
  }
  return {
    id: String(p.pageid),
    title: String(p.title ?? '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''),
    creator: strip(String(m.Artist?.value ?? '')) || '작가 미상',
    license,
    licenseUrl: String(m.LicenseUrl?.value ?? (/cc0/i.test(license) ? 'https://creativecommons.org/publicdomain/zero/1.0/' : '')),
    pageUrl: String(ii.descriptionurl ?? ''),
    thumbUrl: thumb,
    url,
    width: ii.width,
    height: ii.height,
    mime: ii.mime,
  };
}

async function api(params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams({ action: 'query', format: 'json', prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1600', ...params });
  let res: Response;
  try {
    res = await fetch(`${API}?${qs}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new EngineError('이미지 검색 서버(Wikimedia Commons)에 연결하지 못했습니다.', '네트워크를 확인하고 다시 시도하세요.');
  }
  if (!res.ok) throw new EngineError(`이미지 검색 실패 (HTTP ${res.status})`, '잠시 후 다시 시도하세요.');
  return res.json();
}

/** 검색어로 CC0·퍼블릭 도메인 후보를 찾는다. */
export async function searchStock(query: string): Promise<StockImage[]> {
  const q = query.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (q.length < 2) throw new EngineError('검색어를 2글자 이상 입력하세요.');
  const j = await api({ generator: 'search', gsrnamespace: '6', gsrlimit: '40', gsrsearch: `${q} filetype:bitmap` });
  const pages = Object.values(j.query?.pages ?? {}) as any[];
  return pages.map(parsePage).filter((x): x is StockImage => !!x).slice(0, 12);
}

/** 사용자가 고른 한 장을 서버가 다시 조회해 라이선스를 재확인하고 내려받는다. 클라이언트가 보낸 주소는 쓰지 않는다. */
export async function fetchStock(pageId: string): Promise<{ info: StockImage; buf: Buffer; ext: string; width?: number; height?: number }> {
  if (!/^\d{1,12}$/.test(pageId)) throw new EngineError('올바르지 않은 이미지 번호입니다.');
  const j = await api({ pageids: pageId });
  const page = (Object.values(j.query?.pages ?? {}) as any[])[0];
  const info = parsePage(page);
  if (!info) throw new EngineError('이 이미지는 CC0·퍼블릭 도메인으로 확인되지 않거나 사용할 수 없는 형식입니다.', '다른 이미지를 고르세요.');
  let res: Response;
  try {
    res = await fetch(info.url, { headers: { 'User-Agent': UA }, redirect: 'error', signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new EngineError('이미지를 내려받지 못했습니다.', '다시 시도하세요.');
  }
  if (!res.ok) throw new EngineError(`이미지 내려받기 실패 (HTTP ${res.status})`, '다시 시도하세요.');
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw new EngineError('이미지 파일이 너무 큽니다.', '다른 이미지를 고르세요.');
  // content-length가 없어도 한도를 넘으면 읽기를 멈춘다.
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > MAX_BYTES) throw new EngineError('이미지 파일이 너무 큽니다.', '다른 이미지를 고르세요.');
    chunks.push(Buffer.from(chunk));
  }
  const buf = Buffer.concat(chunks);
  const check = inspectImage(buf);
  if (!check) throw new EngineError('내려받은 파일이 올바른 이미지가 아닙니다.', '다른 이미지를 고르세요.');
  return { info, buf, ext: check.ext, width: check.width, height: check.height };
}
