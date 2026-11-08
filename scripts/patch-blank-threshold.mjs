#!/usr/bin/env node
// 补丁 B6b：把"正文为空才重试"放宽成"正文少于 8 个非空白字符也重试"
// 原因：实测空白回答往往留下 1–3 个字符（换行/标点），严格等于空字符串时不会触发重试。
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const TARGETS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      path.join(homedir(), '.dsh', 'plugin-sources', 'dsh-deepseek-web-free', 'lib', 'index.js'),
      path.join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-deepseek-web-free', 'lib', 'index.js'),
    ];

const OLD = 'String(turn?.text ?? "").trim() === ""';
const NEW = 'String(turn?.text ?? "").replace(/\\s/g, "").length < 8';

for (const file of TARGETS) {
  if (!existsSync(file)) { console.log('缺文件: ' + file); continue; }
  const src = readFileSync(file, 'utf8');
  if (src.includes('length < 8')) { console.log('已打过: ' + file); continue; }
  if (!src.includes(OLD)) { console.log('锚点未找到: ' + file); continue; }
  const bak = file + '.bak-threshold';
  if (!existsSync(bak)) copyFileSync(file, bak);
  writeFileSync(file, src.replace(OLD, NEW), 'utf8');
  console.log('已放宽空白阈值: ' + file);
}
