// 集成测试：验证补丁后的错误分类（不需要网络；依赖已打补丁的插件）
// 运行: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const LIB = process.env.DSWEB_LIB
  || path.join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-deepseek-web-free', 'lib');
const CFG = path.join(LIB, 'config-DACadRbL.js');
const available = existsSync(CFG) && !process.env.SKIP_INTEGRATION;

let mod;
if (available) mod = await import(pathToFileURL(CFG).href);

async function classifyWith(bodyText, headers = [['content-type', 'application/json']]) {
  const client = new mod.c({});
  client.http.send = async () => ({ status: 200, headers, text: bodyText, body: new Uint8Array() });
  try {
    await client.solveCompletionPow('dummy-token');
    return { code: null };
  } catch (e) {
    return { code: e?.code, message: e?.message };
  } finally {
    try { await client.dispose(); } catch {}
  }
}

test('40002 Missing Token → REAUTH_REQUIRED', { skip: !available }, async () => {
  const r = await classifyWith('{"code":40002,"msg":"Missing Token","data":null}');
  assert.equal(r.code, 'DEEPSEEK_WEB_REAUTH_REQUIRED');
});

test('40003 invalid token → REAUTH_REQUIRED', { skip: !available }, async () => {
  const r = await classifyWith('{"code":40003,"msg":"Authorization Failed (invalid token)","data":null}');
  assert.equal(r.code, 'DEEPSEEK_WEB_REAUTH_REQUIRED');
});

test('42901 限频 → AUTH 类（可重试，不致命）', { skip: !available }, async () => {
  const r = await classifyWith('{"code":42901,"msg":"too many requests","data":null}');
  assert.equal(r.code, 'DEEPSEEK_WEB_AUTH');
});

test('HTML 拦截页 → WAF 类', { skip: !available }, async () => {
  const r = await classifyWith('<html><body>Request Blocked</body></html>', [['content-type', 'text/html']]);
  assert.equal(r.code, 'DEEPSEEK_WEB_WAF');
});
