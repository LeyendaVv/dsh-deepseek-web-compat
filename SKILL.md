---
name: dsh-deepseek-web-compat
description: 让 DeepSeek 网页版（chat.deepseek.com）作为 DSH 的模型车道稳定可用。覆盖四类故障——启动即崩、回答空白、工具调用丢失、登录态反复失效——并给出协议诊断与产物验收方法。当用户说「网页版接入 DSH」「deepseek-web 崩了/空白/不调用工具」「token 老失效」时使用。
---

# DeepSeek 网页版接入 DSH 的兼容与修复

## 这套东西解决什么

`dsh-deepseek-web-free` 这类插件把 chat.deepseek.com 当成 LLM 车道，但它依赖**网页私有接口 + 文本工具协议**，所以有四类典型故障：

| 症状 | 根因 | 本 skill 的处理 |
|---|---|---|
| 应用启动即崩、整个 host 退出 | 提前发起的 Promise 没人 await，未处理拒绝杀掉 Node 进程 | 补丁 A3 / B1 |
| 回答区空白、显示"已完成 X 秒" | DeepThink 把内容全放进思考通道，正文为空 | 补丁 B6（自动关思考重试） |
| 模型说要干活但不调工具 | 它吐的是变形 DSML（全角竖线/双竖线/多余 name 参数），解析器认不出 | 补丁 B4（归一化） |
| 每隔一段时间要求重新登录 | 服务端在 `/users/current` 轮换 token，插件只取 id 丢掉了新 token | 补丁 A2 / B3 |

## 使用流程

### 1. 先诊断，别急着打补丁

```bash
node scripts/diag.mjs live            # 凭据是否有效、是否被限频
node scripts/diag.mjs offline cap.json  # 抓到的 challenge 响应喂给插件 WASM 解析器
```

判定表：

- `invalid-token`（40002/40003）→ 重新登录即可，**不是协议改版**
- `rate-limited`（429/42901）→ 等冷却，别重试
- `waf`（HTML 拦截页）→ 换浏览器 UA 或等冷却；curl 默认 UA 会被挡
- `non-json` / WASM 解析失败且正文是 JSON → 才考虑协议改版

### 2. 打补丁

```bash
node scripts/patch-all.mjs     # 幂等；每个文件先备份为 *.bak-compat
```

补丁作用于已安装的插件目录（默认 `~/.dsh/profiles/desktop/node_modules/dsh-deepseek-web-free/lib`，可用 `DSWEB_LIB` 覆盖）。

### 3. 验证

```bash
node scripts/diag.mjs health --interval 600   # 常驻体检，失效时弹通知
node scripts/check-artifact.mjs out.html --require 鹈鹕,车轮
```

### 4. 出问题回滚

```bash
node scripts/revert.mjs
```

## 关键约束（务必知道）

1. **补丁改的是 node_modules**，插件升级/重装会被覆盖 —— 重跑 `patch-all.mjs` 即可。
2. **网页版单次回复约 1 万字符封顶**，长产物会被截断。补丁 B5 注入质量前言，要求先出骨架、分块补写、未完时标 `<DSH_CONTINUE/>`。
3. **不要把它设成唯一模型**。接口是私有的，改版是迟早的事；DSH 里应保留一个正常模型（如官方 API 路由）作为默认。
4. **同一账号高频调用会触发风控**（HTML 拦截页 / 429）。批量任务请改用官方 API。

## 验收标准

- `diag.mjs live` 返回 `valid`
- 一次需要工具的任务能真实落盘（用 `check-artifact.mjs` 或直接看文件）
- 崩溃日志不再新增；`~/.dsh/deepseek-web/pow-error.log` 里能看到失败的真实服务端返回码

更多细节见 `docs/protocol.md`（协议链路）、`docs/diagnosis.md`（故障决策树）、`docs/pitfalls.md`（踩坑记录）。
