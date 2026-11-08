# 故障决策树

从现象出发，每一步都是可执行的命令。

## 0. 先确定是哪一类

```bash
node scripts/diag.mjs live
```

| 结果 | 结论 | 下一步 |
|---|---|---|
| `valid code=0` | 凭据没问题 | 看 §2 / §3 / §4 |
| `invalid-token 40002/40003` | 登录态失效 | §1 |
| `rate-limited 429xx` | 限频 | 等几小时，别重试 |
| `waf`（HTML 页面） | 反爬拦截 | 换浏览器 UA；仍不行等冷却 |
| `network` | 网络不通 | 查代理/DNS（注意 `hosts` 可能把域名指向 127.0.0.1） |

## 1. 一直要求重新登录

- 先确认 `diag.mjs live` 是 `invalid-token` 还是 `valid`
- 若是 `valid` 但界面显示未登录 → 是**面板/设置页状态不同步**（webview 分区每次重启清空），不影响模型调用
- 若确实失效 → 重新登录；并把补丁 A2/B3 打上，让轮换后的新 token 能写回凭据库，减少失效频率

## 2. 应用启动即崩（host exited / fatal load failure）

看 crash log（`%APPDATA%\<app>\logs\crash-*.log`）：

- `code: 'DEEPSEEK_WEB_PROTOCOL'` + 栈里有 `solveCompletionPow` → 补丁 A1（分类）+ B1（promise 兜底）
- `code: 'DEEPSEEK_WEB_WAF'` 或消息里出现 `non-JSON` → 现在是可重试错误，不该再崩；若仍崩，说明还有第二处未处理拒绝
- 完全无法启动时，用宿主提供的"禁用第三方插件"入口先恢复，再逐个排查

## 3. 回答区空白（"已完成 X 秒"但没有内容）

会话日志里看 assistant 消息：`正文 0 字 / 思考 数千字` 就是本症状。

- 临时解法：把插件配置 `thinking` 设为 `disabled`
- 长期解法：补丁 B6 —— 检测到"思考非空、正文为空"时自动关思考续问一次
- 注意：空白也可能是**输出被截断**，见 §4

## 4. 产物不完整（缺标签、少了主体）

```bash
node scripts/check-artifact.mjs out.html --require <关键元素>
```

- 报"缺少收尾的 `</html>`" → 被截断，不是画错
- 单次回复约 1 万字符封顶 → 让模型先出骨架、分块补写（补丁 B5 的质量前言就是干这个）
- 看到 `<DSH_CONTINUE/>` → 说明它自己标了断点，回一句"继续，从断点接着写"即可

## 5. 说要干活但不调用工具

- 会话日志里该轮 `tool/call` 为 0，且正文里没有 `<dsh_tool_calls>`
- 抓一次它到底输出了什么：若是 `｜｜DSML｜｜` 这类变形 → 补丁 B4 归一化
- 若它压根没输出调用块 → 是模型不守协议，换更强模型或把任务拆小

## 6. 怎么自证修好了

1. `diag.mjs live` → `valid`
2. 发一个必须用工具的任务（写文件），确认文件真的落盘
3. `check-artifact.mjs` 通过
4. crash log 不再新增；`~/.dsh/deepseek-web/pow-error.log` 里能看到失败时的真实服务端返回
