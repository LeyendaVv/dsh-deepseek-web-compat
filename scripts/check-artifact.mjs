#!/usr/bin/env node
// 产物机械验收：不调模型、不花 token，先查"有没有明显残缺"
// 用法: node scripts/check-artifact.mjs <文件> [--require 关键词1,关键词2]
// 退出码: 0 通过 / 1 有问题 / 2 文件不存在
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
if (!file || !existsSync(file)) { console.error('文件不存在: ' + file); process.exit(2); }
const reqIdx = process.argv.indexOf('--require');
const required = reqIdx > 0 ? (process.argv[reqIdx + 1] || '').split(',').filter(Boolean) : [];

const text = readFileSync(file, 'utf8');
const ext = path.extname(file).toLowerCase();
const problems = [];

const TRUNC = [
  [/(^|\s)…(\s|$)/, '出现单独省略号 …'],
  [/\/\/\s*(省略|\.\.\.|其余|同上)/, '注释里有"省略/其余/同上"'],
  [/(其余|剩下|后续)(部分)?(同上|省略|类似)/, '正文说"其余同上/省略"'],
  [/<!--\s*(省略|\.\.\.)/, 'HTML 注释里有省略'],
  [/\bTODO\b|\bFIXME\b/, '残留 TODO/FIXME'],
];
for (const [re, msg] of TRUNC) if (re.test(text)) problems.push(msg);

const lower = text.toLowerCase();
if (ext === '.html' || lower.includes('<!doctype html')) {
  if (!/<!doctype html/i.test(text)) problems.push('缺少 <!DOCTYPE html>');
  if (!/<\/html>\s*$/i.test(text.trim())) problems.push('缺少收尾的 </html>（疑似被截断）');
  if (!/<\/body>/i.test(text)) problems.push('缺少 </body>');
  const open = (text.match(/<div\b/gi) || []).length;
  const close = (text.match(/<\/div>/gi) || []).length;
  if (open !== close) problems.push(`<div> 未闭合：开 ${open} / 闭 ${close}`);
  if (lower.includes('<svg') && !/<\/svg>/i.test(text)) problems.push('内联 <svg> 未闭合');
}
if (ext === '.svg' && !/<\/svg>\s*$/i.test(text.trim())) problems.push('SVG 缺少收尾 </svg>');

for (const k of required) if (!text.includes(k)) problems.push('缺少必需元素: ' + k);

const minByExt = { '.html': 1500, '.svg': 800, '.py': 300, '.js': 500, '.md': 200 };
const min = minByExt[ext];
if (min && text.length < min) problems.push(`内容过短（${text.length} 字符 < 预期 ${min}），疑似没写完`);

console.log(JSON.stringify({ file: path.basename(file), ok: problems.length === 0, problems, chars: text.length }, null, 2));
process.exit(problems.length === 0 ? 0 : 1);
