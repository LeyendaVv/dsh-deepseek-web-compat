#!/usr/bin/env node
// DeepSeek 网页版（chat.deepseek.com）凭据与协议诊断三合一
//
//   node scripts/diag.mjs live                 用凭据库里的 token 打一次真实接口并分类
//   node scripts/diag.mjs offline <capture.json>   把抓到的 challenge 响应喂给插件 WASM 解析器
//   node scripts/diag.mjs health [--interval 600]  常驻体检（默认 10 分钟）
//
// token 只从 DSH 凭据库读取，不打印、不落盘。
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';

const DSH = path.join(homedir(), '.dsh');
const CRED = path.join(DSH, '.credentials.yaml');
const LIB = process.env.DSWEB_LIB
  || path.join(DSH, 'profiles', 'desktop', 'node_modules', 'dsh-deepseek-web-free', 'lib');
const OUT = path.join(DSH, 'deepseek-web');

const UA = process.env.DSWEB_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/156.0.0.0';

const HEADERS = {
  'x-client-version': '2.2.0',
  'x-client-bundle-id': 'com.deepseek.chat',
  'x-client-platform': 'web',
  'x-client-locale': 'zh_CN',
  accept: 'application/json',
  origin: 'https://chat.deepseek.com',
  referer: 'https://chat.deepseek.com/',
  'user-agent': UA,
};

const fp = (t) => (t ? createHash('sha256').update(t).digest('hex').slice(0, 12) : null);

function readToken() {
  try {
    return readFileSync(CRED, 'utf8').match(/DEEPSEEK_WEB_TOKEN:\s*(\S+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function classify(status, text) {
  let body;
  try { body = JSON.parse(text); } catch {
    return { ok: false, kind: /Request Blocked|Too Many Requests/i.test(text) ? 'waf' : 'non-json', status, detail: text.slice(0, 120) };
  }
  const code = body?.code;
  if (code === 0) return { ok: true, kind: 'valid', code, status, detail: 'ok' };
  if (code === 40002 || code === 40003) return { ok: false, kind: 'invalid-token', code, status, detail: `${code} ${body?.msg ?? ''} → 需要重新登录` };
  if (code === 42901 || status === 429) return { ok: false, kind: 'rate-limited', code, status, detail: `${code ?? ''} 限频，等冷却` };
  return { ok: false, kind: 'rejected', code, status, detail: `${code} ${body?.msg ?? ''}` };
}

function notify(title, message) {
  if (process.platform !== 'win32') return;
  const ps = "Add-Type -AssemblyName System.Windows.Forms;" +
    "$n=New-Object System.Windows.Forms.NotifyIcon;" +
    "$n.Icon=[System.Drawing.SystemIcons]::Warning;$n.Visible=$true;" +
    `$n.ShowBalloonTip(15000,'${title.replace(/'/g, "''")}','${message.replace(/'/g, "''")}',[System.Windows.Forms.ToolTipIcon]::Warning);` +
    'Start-Sleep -Seconds 6;$n.Dispose()';
  try { const c = spawn('powershell', ['-NoProfile', '-Command', ps], { detached: true, stdio: 'ignore' }); c.unref(); } catch {}
}

async function probeLive() {
  const token = readToken();
  if (!token) return { ok: false, kind: 'no-token', detail: '凭据库里没有 DEEPSEEK_WEB_TOKEN（去设置里登录一次）' };
  const res = await fetch('https://chat.deepseek.com/api/v0/users/current', {
    headers: { ...HEADERS, authorization: 'Bearer ' + token },
  });
  const text = await res.text();
  const r = classify(res.status, text);
  let rotated = null;
  try { rotated = JSON.parse(text)?.data?.biz_data?.token ?? null; } catch {}
  return { at: new Date().toISOString(), ...r, token: fp(token), rotated: fp(rotated) };
}

async function offline(capturePath) {
  const wasmDir = path.join(path.dirname(LIB), 'wasm');
  const bytes = new Uint8Array(readFileSync(path.join(wasmDir, 'deepseek_web_core_bg.wasm')));
  const mod = await import(pathToFileURL(path.join(wasmDir, 'deepseek_web_core.js')).href);
  await mod.default({ module_or_path: bytes });

  const raw = readFileSync(capturePath, 'utf8');
  const meta = JSON.stringify({
    schemaVersion: 2, operation: 'create_pow_challenge', status: 200,
    headers: [['content-type', 'application/json']], bodyText: raw.trim(),
  });
  const parsed = JSON.parse(mod.parse_response_json(meta, new Uint8Array()));
  console.log(JSON.stringify(parsed, null, 2));
  if (!parsed.ok) {
    console.log('\n解析失败。若正文确实是 JSON，说明响应结构变了（插件 WASM 需要更新）；');
    console.log('若是 HTML，说明被反爬拦截（换浏览器 UA / 等冷却）。');
    process.exit(1);
  }
}

async function health(intervalSec) {
  mkdirSync(OUT, { recursive: true });
  const log = path.join(OUT, 'health.jsonl');
  const state = path.join(OUT, 'state.json');
  const alert = path.join(OUT, 'ALERT.txt');

  const cycle = async () => {
    let r;
    try { r = await probeLive(); } catch (e) { r = { ok: false, kind: 'network', detail: String(e.message || e) }; }
    appendFileSync(log, JSON.stringify(r) + '\n');
    writeFileSync(state, JSON.stringify(r, null, 2));
    if (!r.ok) {
      writeFileSync(alert, `[${r.at ?? ''}] ${r.kind}: ${r.detail}\n`);
      notify('DeepSeek Web 凭据异常', String(r.detail).slice(0, 120));
    } else {
      try { if (existsSync(alert)) writeFileSync(alert, ''); } catch {}
    }
    console.log(`${r.ok ? '✅' : '❌'} ${r.at ?? ''} ${r.kind} ${r.detail ?? ''}`);
    return r;
  };

  if (intervalSec <= 0) { const r = await cycle(); process.exitCode = r.ok ? 0 : 1; return; }
  console.log(`每 ${intervalSec}s 体检一次 → ${log}`);
  for (;;) { await cycle(); await new Promise((r) => setTimeout(r, intervalSec * 1000)); }
}

const cmd = process.argv[2] || 'live';
const arg = process.argv[3];
const iIdx = process.argv.indexOf('--interval');
const interval = iIdx > 0 ? Number(process.argv[iIdx + 1]) || 600 : 600;

if (cmd === 'live') {
  const r = await probeLive();
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.ok ? 0 : 1;
} else if (cmd === 'offline') {
  if (!arg) { console.error('用法: diag.mjs offline <capture.json>'); process.exit(2); }
  await offline(arg);
} else if (cmd === 'health') {
  await health(arg === '--once' ? 0 : interval);
} else {
  console.error('用法: diag.mjs live | offline <capture.json> | health [--interval 600]');
  process.exit(2);
}
