import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export class EngineError extends Error {
  /** true면 같은 작업을 이어서 반복해도 소용없는 오류(키·한도 문제)라 남은 카드를 건너뛴다. */
  constructor(message: string, public hint = '', public fatal = false) {
    super(message);
  }
}

const CLAUDE_BIN = () => process.env.CLAUDE_BIN || 'claude';
const CLAUDE_MODEL = () => process.env.CLAUDE_MODEL || 'sonnet';

export function claudeVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn(CLAUDE_BIN(), ['--version']);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('close', (code) => resolve(code === 0 ? out.trim() : null));
  });
}

/** 문자열 안의 괄호를 무시하고 첫 번째 JSON 객체/배열의 끝 위치를 찾는다. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** JSON 객체/배열을 응답 텍스트에서 꺼낸다 (코드펜스·앞뒤 설명 허용). */
/** 문자열을 인식하며 괄호를 세어, 끝까지 짝이 안 맞고 모자라기만 하면 닫는 괄호를 덧붙인다. 어긋난 경우(닫는 괄호 종류가 틀림)는 그대로 둔다. */
function closeUnbalanced(s: string): string {
  const stack: string[] = [];
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return s;
    }
  }
  if (inStr || !stack.length) return s;
  return s + stack.reverse().join('');
}

export function extractJson<T>(text: string, expect?: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = [fenced?.[1], text].filter((x): x is string => !!x);
  // 모델이 가끔 `...다.","}]`처럼 닫는 괄호 앞에 따옴표나 쉼표를 흘린다. 원본을 먼저 시도하고, 안 되면 보정본을 시도한다.
  const repair = (s: string) => s.replace(/,\s*"\s*([}\]])/g, '$1').replace(/,\s*([}\]])/g, '$1');
  // 앞쪽 후보가 모두 실패할 때만 뒤쪽(보정·괄호 닫기)을 쓴다.
  const candidates = [...raw, ...raw.map(repair), ...raw.map((x) => closeUnbalanced(repair(x)))];
  let fallback: T | undefined;
  for (const body of candidates) {
    // 응답은 객체이므로 앞말 속 "[1]" 같은 배열보다 객체를 먼저 찾는다.
    for (const m of [...body.matchAll(/\{/g), ...body.matchAll(/\[/g)]) {
      const from = m.index;
      const end = balancedEnd(body, from);
      if (end < 0) continue;
      let parsed: T;
      try {
        parsed = JSON.parse(body.slice(from, end + 1)) as T;
      } catch { continue; /* 다음 후보 위치를 시도한다 */ }
      // 기대하는 키(예: items)가 있는 객체를 우선한다. 앞말 속 예시 JSON을 잘못 고르지 않기 위함.
      if (!expect || (parsed && typeof parsed === 'object' && expect in (parsed as object))) return parsed;
      fallback ??= parsed;
    }
  }
  // expect가 지정됐는데 그 키를 가진 객체가 없으면, 안쪽 조각을 잘못 고르지 않고 해석 실패로 처리한다(자동 재시도 대상).
  if (fallback !== undefined && !expect) return fallback;
  throw new EngineError('조사 엔진의 응답 JSON을 해석하지 못했습니다.', '다시 시도해 주세요. 반복되면 주제를 더 구체적으로 적어 보세요.');
}

export interface ActivityEvent {
  kind: 'search' | 'fetch' | 'result';
  detail: string;
}
export interface AskOpts {
  tools?: string[];
  timeoutMs?: number;
  onEvent?: (e: ActivityEvent) => void;
  /** 응답 JSON에 반드시 있어야 하는 최상위 키 */
  expect?: string;
  /** true면 JSON 대신 응답 텍스트 전체를 돌려준다(마크다운 본문 등) */
  raw?: boolean;
}

/** stream-json 한 줄에서 검색어·원문 읽기·결과 수신 이벤트를 뽑는다. */
function toActivity(ev: any, names: Map<string, string>): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  const content: any[] = Array.isArray(ev?.message?.content) ? ev.message.content : [];
  if (ev?.type === 'assistant') {
    for (const c of content) {
      if (c.type !== 'tool_use') continue;
      names.set(c.id, c.name);
      if (c.name === 'WebSearch') out.push({ kind: 'search', detail: String(c.input?.query ?? '') });
      else if (c.name === 'WebFetch') out.push({ kind: 'fetch', detail: String(c.input?.url ?? '') });
    }
  } else if (ev?.type === 'user') {
    for (const c of content) {
      if (c.type !== 'tool_result') continue;
      const tool = names.get(c.tool_use_id);
      if (tool !== 'WebSearch' && tool !== 'WebFetch') continue;
      const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
      out.push({ kind: 'result', detail: `${tool === 'WebSearch' ? '검색 결과' : '원문'} 수신 · ${text.replace(/\s+/g, ' ').slice(0, 140)}` });
    }
  }
  return out;
}

/** Claude Code CLI를 비대화 모드로 호출한다. 웹 검색·원문 읽기만 허용한다. */
function askClaudeOnce<T>(prompt: string, opts: AskOpts = {}): Promise<T> {
  const tools = (opts.tools ?? ['WebSearch', 'WebFetch']).join(',');
  const args = [
    '-p', '--model', CLAUDE_MODEL(), '--output-format', 'stream-json', '--verbose',
    '--allowedTools', tools, '--strict-mcp-config', '--disable-slash-commands',
    '--setting-sources', '', '--no-session-persistence',
  ];
  args.push('--tools', tools);
  return new Promise<T>((resolve, reject) => {
    const p = spawn(CLAUDE_BIN(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    let pending = '';
    let final: { is_error?: boolean; result?: string } | null = null;
    const names = new Map<string, string>();
    const timer = setTimeout(() => {
      p.kill();
      reject(new EngineError('조사 엔진 응답 시간이 초과되었습니다.', '네트워크 상태를 확인하고 다시 시도하세요.'));
    }, opts.timeoutMs ?? 300_000);
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'result') final = ev;
      else for (const a of toActivity(ev, names)) opts.onEvent?.(a);
    };
    p.stdout.on('data', (d) => {
      pending += d;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      lines.forEach(handleLine);
    });
    p.stderr.on('data', (d) => (err += d));
    p.on('error', () => {
      clearTimeout(timer);
      reject(new EngineError('Claude Code CLI를 실행할 수 없습니다.', 'claude가 설치·로그인되어 있는지 확인하세요 (CLAUDE_BIN 환경변수로 경로 지정 가능).'));
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      handleLine(pending);
      try {
        if (!final) throw new EngineError(`조사 엔진 응답을 읽지 못했습니다 (종료 코드 ${code}). ${err.slice(0, 200)}`, '다시 시도해 주세요.');
        if (final.is_error || code !== 0) {
          throw new EngineError(`조사 엔진 오류: ${(final.result ?? err).slice(0, 300)}`, '로그인 상태·사용 한도를 확인한 뒤 다시 시도하세요.');
        }
        if (opts.raw) return resolve((final.result ?? '') as unknown as T);
        try {
          resolve(extractJson<T>(final.result ?? '', opts.expect));
        } catch (parseErr) {
          // 원인 분석용으로 마지막 비정상 응답을 data/에 남긴다.
          try { fs.writeFileSync(path.resolve(process.cwd(), 'data', 'debug-last-bad-response.txt'), final.result ?? ''); } catch { /* 기록 실패는 무시 */ }
          throw parseErr;
        }
      } catch (e) {
        reject(e);
      }
    });
    p.stdin.end(prompt);
  });
}

/** 응답 형식 오류(JSON 해석 실패)는 한 번 자동 재시도한다. 시간 초과·로그인 오류는 바로 알린다. */
export async function askClaude<T>(prompt: string, opts: AskOpts = {}): Promise<T> {
  try {
    return await askClaudeOnce<T>(prompt, opts);
  } catch (e) {
    if (e instanceof EngineError && e.message.includes('JSON')) return askClaudeOnce<T>(`${prompt}\n\n(이전 응답은 유효한 JSON이 아니었습니다. 설명 없이 JSON 하나만 출력하세요.)`, opts);
    throw e;
  }
}

export function geminiStatus() {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  return { keySet: !!key, model: process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image' };
}

export class NoImageKeyError extends EngineError {}

/** Gemini 이미지 모델로 4:5 이미지를 한 장 만든다. */
export async function generateImage(prompt: string): Promise<{ buf: Buffer; ext: string; model: string }> {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const { model } = geminiStatus();
  if (!key) throw new NoImageKeyError('GEMINI_API_KEY가 설정되지 않았습니다.', '.env 파일에 키를 넣고 서버를 다시 시작하세요.');
  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '4:5' } },
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new EngineError('이미지 서버에 연결하지 못했습니다.', '네트워크를 확인하고 다시 시도하세요.');
  }
  if (!res.ok) {
    const raw = await res.text();
    let body = raw.slice(0, 300);
    try { body = JSON.parse(raw)?.error?.message ?? body; } catch { /* JSON이 아니면 원문 일부를 그대로 보여준다 */ }
    const config = res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404;
    const hint = res.status === 429 ? '무료 한도를 초과했습니다. 잠시 후 다시 시도하거나 한도를 확인하세요.'
      : config ? 'API 키·모델 이름(GEMINI_IMAGE_MODEL)·지역 제한을 확인하세요. 설정을 고친 뒤 서버를 다시 시작하고 다시 시도하세요.' : '잠시 후 다시 시도하세요.';
    throw new EngineError(`이미지 생성 실패 (HTTP ${res.status}): ${body}`, hint, config || res.status === 429);
  }
  const json = (await res.json()) as any;
  const parts: any[] = json?.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p) => p.inlineData?.data || p.inline_data?.data);
  const data = img?.inlineData ?? img?.inline_data;
  if (!data?.data) {
    throw new EngineError('이미지 모델이 이미지를 돌려주지 않았습니다 (안전 필터 또는 프롬프트 문제일 수 있음).', '그림 계획을 수정하거나 다시 시도하세요.');
  }
  const mime: string = data.mimeType ?? data.mime_type ?? 'image/png';
  return { buf: Buffer.from(data.data, 'base64'), ext: mime.includes('jpeg') ? 'jpg' : 'png', model };
}
