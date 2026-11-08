#!/usr/bin/env node
// 从"已在浏览器里登录的 chat.deepseek.com 页面"里读取当前 token
//
// 用法:
//   node scripts/grab-web-token.mjs                 # 默认连 127.0.0.1:9222
//   CDP_PORT=9333 node scripts/grab-web-token.mjs
//   node scripts/grab-web-token.mjs --write         # 顺便写回 DSH 凭据库
//
// 只读 localStorage，不导航、不点击、不改页面内容。token 只打印指纹。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';

const PORT = process.env.CDP_PORT || '9222';
const WRITE = process.argv.includes('--write');
const DSH = path.join(homedir(), '.dsh');
const CRED = path.join(DSH, '.credentials.yaml');
const fp = (t) => (t ? createHash('sha256').update(t).digest('hex').slice(0, 12) : '-');

function open(url, tries = 6) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const go = () => {
      const ws = new WebSocket(url);
      let settled = false;
      const t = setTimeout(() => { if (!settled) { settled = true; try { ws.close(); } catch {} reject(new Error('open timeout')); } }, 5000);
      ws.onopen = () => { if (settled) return; settled = true; clearTimeout(t); resolve(ws); };
      ws.onerror = () => {
        if (settled) return; settled = true; clearTimeout(t);
        if (++n >= tries) reject(new Error('handshake refused（端口没开，或 Edge 在等你点"允许"）'));
        else setTimeout(go, 250 * n);
      };
    };
    go();
  });
}

function rpc(ws, method, params = {}, sessionId = null) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    const on = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== id) return;
      ws.removeEventListener('message', on);
      clearTimeout(timer);
      m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result);
    };
    const timer = setTimeout(() => { ws.removeEventListener('message', on); reject(new Error(method + ' timeout')); }, 8000);
    ws.addEventListener('message', on);
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
}

const ws = await open(`ws://127.0.0.1:${PORT}/devtools/browser`);
const { targetInfos = [] } = await rpc(ws, 'Target.getTargets');
let page = targetInfos.find((t) => t.type === 'page' && /chat\.deepseek\.com/.test(t.url));

// 没有现成页面就临时开一个（读完关掉，不动你已有的标签）
let createdId = null;
if (!page && !process.argv.includes('--no-new-tab')) {
  const { targetId } = await rpc(ws, 'Target.createTarget', { url: 'https://chat.deepseek.com/', background: true });
  createdId = targetId;
  console.log('已临时打开一个 chat.deepseek.com 标签，等待登录态加载…');
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 800));
    const { targetInfos: tl = [] } = await rpc(ws, 'Target.getTargets');
    page = tl.find((t) => t.targetId === targetId);
    if (page && /^https:\/\/chat\.deepseek\.com/.test(page.url)) break;
  }
}
if (!page) {
  console.error('没找到 chat.deepseek.com 的页面。当前标签：');
  for (const t of targetInfos.filter((x) => x.type === 'page')) console.error('  - ' + t.url.slice(0, 90));
  process.exit(1);
}
console.log('页面: ' + String(page.title ?? '').slice(0, 50) + ' | ' + page.url.slice(0, 80));

const { sessionId } = await rpc(ws, 'Target.attachToTarget', { targetId: page.targetId, flatten: true });
const r = await rpc(ws, 'Runtime.evaluate', {
  expression: `(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = localStorage.getItem(k) || '';
      if (/token|auth|user/i.test(k) || /^[A-Za-z0-9_-]{40,}$/.test(v)) out[k] = v.slice(0, 200);
    }
    return JSON.stringify(out);
  })()`,
  returnByValue: true,
}, sessionId);
await rpc(ws, 'Target.detachFromTarget', { sessionId }).catch(() => {});
if (createdId) { await rpc(ws, 'Target.closeTarget', { targetId: createdId }).catch(() => {}); console.log('已关闭临时标签'); }
ws.close();

const entries = JSON.parse(r.result?.value ?? '{}');
const keys = Object.keys(entries);
console.log('候选键: ' + (keys.join(', ') || '（空）'));

// 网页把 token 存成 JSON 信封：{"value":"<token>","__version":"0"}，先拆信封再判断
function unwrap(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      for (const k of ['value', 'token', 'accessToken', 'access_token']) {
        if (typeof j?.[k] === 'string' && j[k].length >= 30) return j[k];
      }
    } catch {}
    return null;
  }
  return /^[A-Za-z0-9_\-+/=.]{30,}$/.test(s) ? s : null;
}

let token = null;
let keyName = null;
for (const k of keys.filter((x) => /userToken|access_?token|^token$/i.test(x))) {
  const v = unwrap(entries[k]);
  if (v) { token = v; keyName = k; break; }
}
if (!token) {
  for (const [k, v] of Object.entries(entries)) {
    const u = unwrap(v);
    if (u && (!token || u.length > token.length)) { token = u; keyName = k; }
  }
}
if (!token) { console.error('没有从 localStorage 里认出 token，键值如下：'); console.error(JSON.stringify(entries, null, 2)); process.exit(1); }

console.log(`选中键: ${keyName} | token 指纹: ${fp(token)} | 长度: ${token.length}`);

// 和凭据库里的比对
let stored = null;
try { stored = readFileSync(CRED, 'utf8').match(/DEEPSEEK_WEB_TOKEN:\s*(\S+)/)?.[1] ?? null; } catch {}
console.log(`凭据库现有: ${fp(stored)}${stored === token ? '（与页面一致）' : '（与页面不同）'}`);

// 用这个 token 验一下是否有效
try {
  const res = await fetch('https://chat.deepseek.com/api/v0/users/current', {
    headers: {
      authorization: 'Bearer ' + token,
      'x-client-version': '2.2.0', 'x-client-bundle-id': 'com.deepseek.chat',
      'x-client-platform': 'web', 'x-client-locale': 'zh_CN',
      accept: 'application/json', origin: 'https://chat.deepseek.com', referer: 'https://chat.deepseek.com/',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/156.0.0.0',
    },
  });
  const text = await res.text();
  let code = '?', rotated = null;
  try { const j = JSON.parse(text); code = j.code; rotated = j?.data?.biz_data?.token ?? null; } catch {}
  console.log(`接口校验: HTTP ${res.status} code=${code} 轮换后指纹=${fp(rotated)}`);
} catch (e) {
  console.log('接口校验失败: ' + e.message);
}

if (WRITE) {
  if (!stored) { console.error('凭据库里没有 DEEPSEEK_WEB_TOKEN 字段，跳过写入'); process.exit(1); }
  const src = readFileSync(CRED, 'utf8');
  copyFileSync(CRED, CRED + '.bak-token-grab');
  writeFileSync(CRED, src.replace(/(DEEPSEEK_WEB_TOKEN:\s*)\S+/, `$1${token}`), 'utf8');
  console.log('已写回凭据库（备份 .bak-token-grab）。DSH 可能需要重启才重新读取。');
}
