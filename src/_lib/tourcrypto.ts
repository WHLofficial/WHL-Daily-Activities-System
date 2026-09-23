// 赛事系统兼容密码哈希（与 WHL-tournament-management-system worker/lib/crypto.ts 保持一致）。
// 账号真源已搬到 auth 认证中心，本模块现只服务：兼容模式的旧账密登录校验（只读，
// api.ts 的 tourVerifyPassword）与本地联调种子数据的哈希生成（scripts/gen-tour-hash.mjs）。
// 密码格式为单串 `pbkdf2$iter$salt_b64$hash_b64`；迭代数等参数不要单方面改动，需与赛事系统同步。

const PBKDF2_ITERATIONS = 25_000; // 与赛事系统一致（Workers 免费档 CPU 预算内取值）

const enc = new TextEncoder();

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(input)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256),
  );
}

export async function tourHashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(await derive(password, salt, PBKDF2_ITERATIONS))}`;
}

export async function tourVerifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  const expected = fromB64(parts[3]);
  const actual = await derive(password, fromB64(parts[2]), iterations);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}
