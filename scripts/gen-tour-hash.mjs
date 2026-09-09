// 生成赛事系统兼容密码哈希（pbkdf2$25000$salt_b64$hash_b64，与 src/_lib/tourcrypto.ts 同格式）
// 用途：冒烟测试播种赛事库管理员、手工造号
// 用法：node scripts/gen-tour-hash.mjs <密码>
const [pw] = process.argv.slice(2);
if (!pw) {
  console.error('用法: node scripts/gen-tour-hash.mjs <密码>');
  process.exit(1);
}
const te = new TextEncoder();
const b64 = (b) => btoa(String.fromCharCode(...b));
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveBits']);
const bits = new Uint8Array(
  await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 25000 }, key, 256),
);
console.log(`pbkdf2$25000$${b64(salt)}$${b64(bits)}`);
