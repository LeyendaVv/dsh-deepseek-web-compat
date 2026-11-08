#!/usr/bin/env node
// 还原 patch-all.mjs 的改动：把 lib 目录里所有 *.bak-compat 备份覆盖回原文件
import { readdirSync, copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const LIB = process.env.DSWEB_LIB
  || path.join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-deepseek-web-free', 'lib');

if (!existsSync(LIB)) { console.error('目录不存在：' + LIB); process.exit(1); }

let n = 0;
for (const name of readdirSync(LIB)) {
  if (!name.endsWith('.bak-compat')) continue;
  const bak = path.join(LIB, name);
  const target = path.join(LIB, name.slice(0, -'.bak-compat'.length));
  copyFileSync(bak, target);
  unlinkSync(bak);
  n++;
  console.log('还原 ' + path.basename(target));
}
console.log(n ? `完成，还原 ${n} 个文件` : '没有找到 .bak-compat 备份，未做改动');
