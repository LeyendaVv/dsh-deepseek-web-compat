#!/usr/bin/env node
// 补丁 B7：把 DSML 工具标记从"展示内容"里彻底剥掉
//
// 背景：模型会把 DSML 草稿写进思考/正文通道。解析层已经能把它转成工具调用（B4），
// 但展示层只处理了规范写法的 <||DSML||，漏掉了实际出现的 <｜｜DSML｜｜（全角+双竖线）。
// 结果就是：工具其实执行了，但思考区/正文里仍能看到一大段原始 DSML。
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const TARGETS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      path.join(homedir(), '.dsh', 'plugin-sources', 'dsh-deepseek-web-free', 'lib', 'index.js'),
      path.join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-deepseek-web-free', 'lib', 'index.js'),
    ];

const HELPER = `
/** 展示用：删掉 DSML 工具草稿和 dsh_tool_calls 块（解析时不能删，展示时必须删）。 */
function stripToolMarkupForDisplay(content) {
\tif (typeof content !== "string" || content.length === 0) return content;
\tlet s = content.replace(/[\\uFF5C]{1,}/g, "|");
\t// 由内向外逐层删除，避免只删掉最外层留下碎片
\ts = s.replace(/<\\|+DSML\\|+\\s*parameter\\b[^>]*>[\\s\\S]*?<\\/\\|+DSML\\|+\\s*parameter>/gi, "");
\ts = s.replace(/<\\|+DSML\\|+\\s*invoke\\b[^>]*>[\\s\\S]*?<\\/\\|+DSML\\|+\\s*invoke>/gi, "");
\ts = s.replace(/<\\|+DSML\\|+[^>]*>[\\s\\S]*?<\\/\\|+DSML\\|+[^>]*>/gi, "");
\ts = s.replace(/<\\/?\\|+DSML\\|+[^>]*>/gi, "");
\ts = s.replace(/<dsh_tool_calls>[\\s\\S]*?<\\/dsh_tool_calls>/gi, "");
\treturn s.replace(/\\n{3,}/g, "\\n\\n").trim();
}
`;

let applied = 0;
for (const file of TARGETS) {
  if (!existsSync(file)) { console.log('缺文件: ' + file); continue; }
  let src = readFileSync(file, 'utf8');
  if (src.includes('stripToolMarkupForDisplay')) { console.log('已打过: ' + file); continue; }

  const ANCHOR = 'function projectCanonicalMessage(message) {';
  if (!src.includes(ANCHOR)) { console.log('锚点未找到: ' + file); continue; }

  // 1) 插入 helper
  src = src.replace(ANCHOR, HELPER + '\n' + ANCHOR);

  // 2) reasoning 走清理
  src = src.replace(
    `\tif (message.role === "assistant" && message.reasoning !== void 0 && message.reasoning.length > 0) content.push({
\t\ttype: "reasoning",
\t\ttext: message.reasoning
\t});`,
    `\tif (message.role === "assistant" && message.reasoning !== void 0 && message.reasoning.length > 0) content.push({
\t\ttype: "reasoning",
\t\ttext: stripToolMarkupForDisplay(message.reasoning)
\t});`,
  );

  // 3) 正文走清理（在 push 之前包一层）
  src = src.replace(
    `\tcontent.push({
\t\ttype: "text",
\t\ttext
\t});
\treturn {
\t\trole: message.role,`,
    `\tcontent.push({
\t\ttype: "text",
\t\ttext: stripToolMarkupForDisplay(text)
\t});
\treturn {
\t\trole: message.role,`,
  );

  const bak = file + '.bak-display-strip';
  if (!existsSync(bak)) copyFileSync(file, bak);
  writeFileSync(file, src, 'utf8');
  applied++;
  console.log('已应用展示层剥离: ' + file);
}

if (!applied) console.log('没有变化（可能已打过或版本不匹配）');
