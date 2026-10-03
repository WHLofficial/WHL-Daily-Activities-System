// 基础 HTTP 工具：统一响应、错误、请求体解析

export class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export async function readBody(request: Request): Promise<any> {
  const raw = await request.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

export function nowISO(): string {
  return new Date().toISOString();
}

// 存量时间列（created_at / mirrored_at 等 datetime('now') 默认值）统一是空格格式，写侧走本函数；
// 这些列禁改用 toISOString() 混写——同日「T > 空格」会让 ORDER BY 在一天内错序。新列一律 nowISO()。
export function nowSql(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}
