#!/usr/bin/env node
// 常驻"token 保管员"：只建立**一条** CDP 连接，定时从已登录的 chat.deepseek.com
// 页面读 userToken 并写回 DSH 凭据库。
//
// 为什么要常驻：Edge 的远程调试授权是**按连接**弹的。每次新开连接都可能弹一次
// 「是否允许远程调试」。保持一条长连接，就只在你第一次启动时弹一次。
//
// 用法: node scripts/token-keeper.mjs [--interval 1800] [--port 9222] [--once]
import { readFileSync, writeFileSync, copyFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';

const args = process.argv.slice(2);
const num = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? Number(args[i + 1]) || dflt : dflt; };
const PORT = num('--port', 9222);
const INTERVAL = num('--interval', 1800) * 1000;
const ONCE = args.includes('--once');

const DSH = path.join(homedir(), '.dsh');
const CRED = path.join(DSH, '.credentials.yaml');
const OUT = path.join(DSH, 'deepseek-web');
mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'token-keeper.log');

const fp = (t) => (t ? createHash('sha256').update(t).digest('hex').slice(0, 12) : '-');
const log = (m) => { const line = `${new Date().toISOString()} ${m}`; appendFileSync(LOG, line + '\n'); console.log(line); };

let ws = null;
let seq = 0;

function connect() {
  return new Promise((resolve, reject) => {
    let n = 0;
    const go = () => {
      const sock = new WebSocket(`ws://127.0.0.1:${PORT}/devtools/browser`);
      let settled = false;
      const t = setTimeout(() => { if (!settled) { settled = true; try { sock.close(); } catch {} reject(new Error('open timeout')); } }, 15000);
      sock.onopen = () => { if (settled) return; settled = true; clearTimeout(t); resolve(sock); };
      sock.onerror = () => {
        if (settled) return; settled = true; clearTimeout(t);
        if (++n >= 3) reject(new Error('handshake refused（可能有人在等你点"允许"）'));
        else setTimeout(go, 1500 * n);
      };
      sock.onclose = () => { if (ws === sock) { ws = null; log('连接断开，等待重连'); } };
    };
    go();
  });
}

async function ensure() {
  if (ws && ws.readyState === 1) return ws;
  log('建立 CDP 连接（浏览器可能弹一次授权框，请点"允许"）');
  ws = await connect();
  log('连接就绪');
  return ws;
}

function rpc(method, params = {}, sessionId = null) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const on = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== id) return;
      ws.removeEventListener('message', on);
      clearTimeout(timer);
      m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result);
    };
    const timer = setTimeout(() => { ws.removeEventListener('message', on); reject(new Error(method + ' timeout')); }, 10000);
    ws.addEventListener('message', on);
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
}

function unwrapToken(v) {
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

function writeCredential(token) {
  const src = readFileSync(CRED, 'utf8');
  const hasKey = /DEEPSEEK_WEB_TOKEN:\s*\S+/.test(src);
  copyFileSync(CRED, CRED + '.bak-token-keeper');
  if (hasKey) {
    writeFileSync(CRED, src.replace(/(DEEPSEEK_WEB_TOKEN:\s*)\S+/, `$1${token}`), 'utf8');
    return true;
  }
  // 凭据被 DSH 清掉时，keeper 负责把它补回去（插到 refs: 块的末尾）
  const lines = src.split(/\r?\n/);
  let refsAt = lines.findIndex((l) => l.trim() === 'refs:');
  if (refsAt < 0) { lines.push('refs:'); refsAt = lines.length - 1; }
  let insertAt = refsAt + 1;
  while (insertAt < lines.length && /^\s{2}\S/.test(lines[insertAt])) insertAt++;
  lines.splice(insertAt, 0, `  DEEPSEEK_WEB_TOKEN: ${token}`);
  writeFileSync(CRED, lines.join('\n'), 'utf8');
  return true;
}

async function cycle() {
  const sock = await ensure();
  const { targetInfos = [] } = await rpc('Target.getTargets');
  let page = targetInfos.find((t) => t.type === 'page' && /^https:\/\/chat\.deepseek\.com/.test(t.url));
  let createdId = null;

  // 没有现成页面就自己开一个后台标签，读完立刻关掉（不需要用户一直开着页面）
  if (!page) {
    const { targetId } = await rpc('Target.createTarget', { url: 'https://chat.deepseek.com/', background: true });
    createdId = targetId;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 600));
      const tl = (await rpc('Target.getTargets')).targetInfos ?? [];
      page = tl.find((t) => t.targetId === targetId);
      if (page && /^https:\/\/chat\.deepseek\.com/.test(page.url)) break;
    }
    log(page ? '已临时打开页面读取（读完会关闭）' : '临时页面试打开失败');
  }
  if (!page) return 'no-page';

  const { sessionId } = await rpc('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  let value = null;
  try {
    const r = await rpc('Runtime.evaluate', { expression: 'localStorage.getItem("userToken") || ""', returnByValue: true }, sessionId);
    value = r.result?.value ?? null;
  } finally {
    await rpc('Target.detachFromTarget', { sessionId }).catch(() => {});
    if (createdId) await rpc('Target.closeTarget', { targetId: createdId }).catch(() => {});
  }

  const token = unwrapToken(value);
  if (!token) { log('页面上没有可用 userToken（可能已退出登录）'); return 'no-token'; }

  // 先验一下再写：避免把浏览器里过期的 token 覆盖到凭据库
  let valid = false;
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
    valid = /"code"\s*:\s*0\b/.test(text);
    if (!valid) log('浏览器里的 token 也失效了（code 非 0），可能浏览器已退出登录');
  } catch (e) {
    log('校验请求失败：' + e.message);
    return 'verify-failed';
  }
  if (!valid) return 'browser-logged-out';

  let stored = null;
  try { stored = readFileSync(CRED, 'utf8').match(/DEEPSEEK_WEB_TOKEN:\s*(\S+)/)?.[1] ?? null; } catch {}
  if (stored === token) { log(`无需更新（指纹 ${fp(token)}）`); return 'same'; }

  if (writeCredential(token)) { log(`已更新凭据库：${fp(stored)} → ${fp(token)}`); return 'updated'; }
  return 'write-failed';
}

if (ONCE) {
  const r = await cycle();
  log('单次结束：' + r);
  try { ws?.close(); } catch {}
  process.exitCode = r === 'updated' || r === 'same' ? 0 : 1;
} else {
  log(`保管员启动：端口 ${PORT}，间隔 ${INTERVAL / 60000} 分钟`);
  for (;;) {
    try { await cycle(); } catch (e) { log('本轮失败：' + e.message); ws = null; }
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
}
