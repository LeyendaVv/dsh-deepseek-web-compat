# dsh-deepseek-web-compat

让 **DeepSeek 网页版（chat.deepseek.com）** 作为 [DeepSeek Harness](https://github.com/deepseek-ai) 的模型车道稳定可用。

不是新插件，而是一套**补丁 + 诊断 + 验收**工具：修掉第三方插件 `dsh-deepseek-web-free` 在真实使用中的四类故障。

> 非官方、非 DeepSeek 出品。网页版接口是私有的，随时可能失效；使用有账号风险，后果自负。

## 修什么

| 症状 | 根因 | 补丁 |
|---|---|---|
| 启动即崩，整个应用退出 | 提前发起的 Promise 没人 await，未处理拒绝杀掉 Node 进程 | A3 / B1 |
| 回答区空白、"已完成 35 秒" | DeepThink 只产出思考，正文为空 | B6 |
| 只说不动手，工具没执行 | 模型吐变形 DSML（全角/双竖线/多余参数），解析器认不出 | B4 |
| 隔一会儿就要重新登录 | 服务端轮换 token，插件只取 id 把新 token 丢了 | A2 / B3 |

另外补了两个"体验层"的：错误按业务码分类（不再一律当协议错误）、长产物不省略（B5 质量前言）。

## 快速开始

```bash
# 1. 先确认凭据状态
node scripts/diag.mjs live

# 2. 打补丁（幂等，自动备份 *.bak-compat）
node scripts/patch-all.mjs

# 3. 重启 DSH，在模型菜单选择 DeepSeek Web

# 4. 可选：常驻体检，失效会弹通知
node scripts/diag.mjs health --interval 600

# 出问题一键回滚
node scripts/revert.mjs
```

默认改动目录：`~/.dsh/profiles/desktop/node_modules/dsh-deepseek-web-free/lib`（用 `DSWEB_LIB` 可覆盖）。

## 实测数据（2026-11，DSH 0.2.1-rc.5）

一次多轮文件生成任务（10 轮）：

- 常规轮次 **2–25 秒**；工具调用 24 次，真实落盘（桌面 HTML 12 KB）
- 异常：单轮 130 秒 / 思考 3.5 万字；两轮正文空白（修复后由 B6 兜底）
- **单次回复约 1 万字符封顶**：8.6k / 12.1k 字符的两版都在 `</html>` 前被截断

协议侧：`create_pow_challenge` 返回 `{"code":0,...,"difficulty":144000}`；PoW 求解约 60–90 ms；`x-ds-pow-response` 头约 368 字符。

## 目录

```
SKILL.md               # 给 agent 用的操作手册
docs/protocol.md       # 协议链路与字段
docs/diagnosis.md      # 故障决策树
docs/pitfalls.md       # 踩坑记录
scripts/patch-all.mjs  # 全部补丁（幂等）
scripts/revert.mjs     # 回滚
scripts/diag.mjs       # live / offline / health
scripts/check-artifact.mjs  # 产物机械验收
```

## 注意

1. 补丁改的是 `node_modules`，插件升级/重装会被覆盖，重跑 `patch-all.mjs`。
2. **别把它设成唯一模型**：接口改版是迟早的事，保留一条正常模型车道做默认。
3. 高频调用会触发风控（HTML 拦截页 / 429），批量任务请用官方 API。
4. 快照里的 `pow-error.log`、凭据、日志一律不要提交到仓库。

## 致谢

- 插件本体：[loyalchiiina/dsh-deepseek-web-free](https://github.com/loyalchiiina/dsh-deepseek-web-free)（协议解析在其 WASM 核心里）
- 思路参考：[ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)（"让 agent 接手调试会话"）、[DSH-webtokens](https://github.com/xinyuquan985-coder/DSH-webtokens)（浏览器桥接方案）

## License

MIT（仅覆盖本仓库的脚本与文档，不含任何第三方插件代码）
