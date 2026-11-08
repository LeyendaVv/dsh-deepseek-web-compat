#!/usr/bin/env node
// 补丁 A4：currentUser() 失败时也按业务码分类
// 少了这条，token 失效会以笼统的 "DeepSeek Web request failed"（DSH 显示 UNKNOWN）冒出来，
// 而不是明确的"登录态失效，请重新登录"。
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const targets = process.argv.slice(2);
const dirs = targets.length
  ? targets.map((t) => (t.endsWith('.js') ? t : path.join(t, 'lib', 'config-DACadRbL.js')))
  : [
      path.join(homedir(), '.dsh', 'plugin-sources', 'dsh-deepseek-web-free', 'lib', 'config-DACadRbL.js'),
      path.join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-deepseek-web-free', 'lib', 'config-DACadRbL.js'),
    ];

const OLD = `\tthrowIfProtocolError(parsed);
\tif (parsed.response.type !== "account")`;

const NEW = `\t// current_user 失败时也按业务码分类：token 失效给 REAUTH_REQUIRED，而不是笼统的 PROTOCOL
\tif (!parsed.ok) {
\t\tlet serverCode;
\t\tlet serverMsg = "";
\t\ttry {
\t\t\tconst b = JSON.parse(String(raw?.text ?? "").trim());
\t\t\tif (typeof b?.code === "number") serverCode = b.code;
\t\t\tif (typeof b?.msg === "string") serverMsg = b.msg;
\t\t} catch {}
\t\tif (serverCode === 40002 || serverCode === 40003) {
\t\t\tthrow new DeepSeekWebError("DeepSeek Web 登录态失效（code " + serverCode + " " + serverMsg + "），请重新登录", ERROR_CODES.REAUTH_REQUIRED, { status: raw?.status });
\t\t}
\t\tthrow new DeepSeekWebError("DeepSeek Web 账号校验失败（code " + (serverCode ?? "?") + " " + serverMsg + "）", ERROR_CODES.AUTH, { status: raw?.status });
\t}
\tif (parsed.response.type !== "account")`;

for (const file of dirs) {
  if (!existsSync(file)) { console.log('跳过（不存在）: ' + file); continue; }
  const src = readFileSync(file, 'utf8');
  if (src.includes('current_user 失败时也按业务码分类')) { console.log('已打过: ' + file); continue; }
  if (!src.includes(OLD)) { console.log('锚点未找到: ' + file); continue; }
  try {
    writeFileSync(file, src.replace(OLD, NEW), 'utf8');
    console.log('已应用: ' + file);
  } catch (e) {
    console.log('写入失败（可能被占用）: ' + file + ' → ' + e.message);
  }
}
