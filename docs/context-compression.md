# AgentClaw 七层上下文压缩体系

> 如何在有限的上下文窗口里，让 AI Agent 记住更多、丢失更少

## 为什么需要上下文压缩

AI Agent 和人类对话不同。一个简单的任务——"帮我搜索今天的新闻，写一篇日报，发到 Telegram"——可能涉及 5-10 次工具调用，每次工具调用都会产生大量输出（搜索结果、网页内容、命令输出）。这些输出全部堆在上下文里，几轮之后就会撑满模型的上下文窗口。

最朴素的做法是截断——超过上限就丢掉最早的消息。但这会丢失用户的原始意图和关键决策，导致 Agent 在后续轮次中"失忆"。

AgentClaw 的方案是**七层渐进式压缩管线**：从不调 API 的本地文本操作，到 LLM 驱动的结构化摘要，每一层解决不同粒度的问题，逐级升级。

## 七层架构总览

```
用户输入 → L1 基础压缩 → L2 参数截断 → L3 微压缩 → L4 溢出转文件 → L5 智能观测压缩 → L6 LLM 结构化压缩 → L7 系统提示词缓存
```

| 层级 | 名称 | 触发时机 | 是否调 API | 典型压缩率 |
|------|------|---------|-----------|----------|
| L1 | 基础压缩 | 每次构建 prompt | 否 | 3-12% |
| L2 | 工具参数截断 | 每轮迭代 | 否 | 因工具而异 |
| L3 | 微压缩 | 每轮迭代 | 否 | 30-70% |
| L4 | Overflow 溢出转文件 | 工具执行后 | 否 | 80%+ |
| L5 | 智能观测压缩 | 构建 prompt 时 | 否 | 80-95% |
| L6 | LLM 结构化压缩 | 消息数/token 超限 | 是 | 90%+ |
| L7 | Frozen Snapshot | session 级 | 否 | 不压缩，防重建 |

前五层全部是本地操作，零 API 调用。大部分场景下，L1-L5 就足以控制上下文大小，L6 很少触发。

## L1：基础压缩——空白归一化与 JSON 紧凑化

**位置**：`context-manager.ts` → `applyBasicCompression()` + `compressBasic()`

对所有消息始终生效的安全压缩，不改变语义：

- **空白归一化**：连续 3+ 换行折叠为 2 个，tab 转空格，行尾空白清除
- **JSON 紧凑化**：检测 JSON 格式的工具结果，用 `JSON.stringify()` 去除缩进

```
// Before (pretty-printed JSON, 847 chars)
{
  "status": "success",
  "data": {
    "id": 12345,
    "name": "test"
  }
}

// After (minified, 52 chars)
{"status":"success","data":{"id":12345,"name":"test"}}
```

典型节省 3-12%。看起来不多，但对每条消息都生效，积少成多。

## L2：工具参数截断——LLM 不需要重读自己写的代码

**位置**：`agent-loop.ts` → `microCompact()` 内的参数截断逻辑

核心洞察：当 LLM 调用 `file_write` 写了一个 500 行的文件，这 500 行代码会作为 `tool_use` 的 `input.content` 留在上下文里。但 LLM 已经"知道"自己写了什么——它不需要在后续轮次中重新阅读完整代码。

处理方式：对 `file_write`、`file_edit`、`execute_code`、`bash` 这四个工具，在 3 轮后将 `content`/`new_string`/`code`/`command` 参数截断为前 50 字符：

```
// Before
{ name: "file_write", input: { path: "index.ts", content: "import React from..." /* 2000+ chars */ } }

// After (3 轮后)
{ name: "file_write", input: { path: "index.ts", content: "import React from...(truncated)" } }
```

## L3：微压缩——静默回收旧工具输出

**位置**：`agent-loop.ts` → `microCompact()`

这是参考 Claude Code 的 MicroCompact 机制实现的。

规则很简单：距离当前迭代超过 3 轮的 `tool_result`，如果内容超过 800 字符，截断为前 200 字符 + 长度标记：

```
// Before (2500 chars)
<tool_result>
文件内容完整输出...（2500 字符的文件内容）
</tool_result>

// After
<tool_result>
文件内容完整输出...（前 200 字符）

[... truncated from 2500 chars]
</tool_result>
```

200 字符的预览足够 LLM 回忆"这个工具做了什么"，而不需要完整内容。如果 LLM 真的需要完整内容，可以再次调用 `file_read`。

关键设计：**最近 3 轮永远保留完整内容**。LLM 需要完整的最新信息来做正确的下一步决策。

## L4：Overflow 溢出转文件——变截断为延迟访问

**位置**：`agent-loop.ts` → `applyOverflow()`

当单次工具输出超过 8000 字符时（比如 `file_read` 一个大文件、`bash` 输出几百行日志），直接截断会丢失关键信息。Overflow 的做法是：

1. 将完整输出保存到 `data/tmp/{conversationId}/overflow_{tool}_{timestamp}.txt`
2. 上下文中只保留前 1500 字符预览 + 文件路径引用

```
[Output saved to overflow_bash_1711865432.txt — 15,230 chars]

Preview (first 1500 chars):
...（预览内容）...

Use file_read to access the full output if needed.
```

这把"截断 → 数据丢失"变成了"延迟访问"——LLM 随时可以 `file_read` 读取完整内容。

**防无限循环保护**：如果 LLM 读取 overflow 文件的输出又超了 8K，不会再次 overflow（通过路径检测 `overflow_*.txt` 跳过），避免 overflow → read → overflow → read 的死循环。

## L5：智能观测压缩——提取要点而非暴力截断

**位置**：`context-manager.ts` → `compressObservation()`

这是压缩率最高的一层（80-95%），灵感来自 ClawRouter 的 L6 Observation Compression。

不同于简单截断，它通过**四遍扫描**提取关键信息：

1. **第一遍：错误行**（最高优先级）——匹配 `error`/`exception`/`fail`/`ENOENT`/`TypeError` 等模式
2. **第二遍：状态行**——匹配 `success`/`complete`/`created`/`found`/`passed` 等模式
3. **第三遍：JSON 关键字段**——提取 `status`/`error`/`message`/`result`/`count` 等字段
4. **第四遍：首尾行**——保留前 3 行和后 2 行作为上下文

每遍扫描都有预算控制（50%/70%/85% 的上限），最终输出控制在 400 字符以内。

```
// Before (3200 chars 的 npm install 输出)
added 157 packages, removed 12 packages...
npm warn deprecated xyz@1.0.0...
...（100+ 行依赖安装日志）...

// After (82 chars, 97% 压缩率)
[bash — 3200 chars → 82 chars, 97% compressed]
added 157 packages, removed 12 packages
npm warn deprecated xyz@1.0.0
```

还有**去重机制**：如果 LLM 对同一个文件连续调用 `file_read` 两次（内容相同），第二次只返回 `[Duplicate result — same as earlier message]`。

## L6：LLM 结构化压缩——最后的防线

**位置**：`context-manager.ts` → `compressTurns()`

当消息数量超过阈值或 token 估算超过上下文预算的 70% 时，触发 LLM 压缩。这是唯一需要调用 API 的层级。

压缩 prompt 使用七段结构化模板：

```
**User Request:** 用户最初要求做什么
**Current State:** 已完成的工作和当前状态
**Key Decisions:** 做过的重要决策和约束
**Files & Code:** 涉及的文件和代码改动
**Errors & Fixes:** 遇到的问题和解决方案
**Next Steps:** 还需要做什么
**User Messages:** 用户的关键原话（逐字保留）
```

为什么用结构化模板而不是"总结为 3-5 个要点"？因为无结构的摘要会丢失关键信息——尤其是用户的原始意图。**User Messages** 段确保压缩后 LLM 仍然知道用户说了什么，不会偏离方向。

三级 fallback 保证压缩一定成功：

1. **Tier 1**：正常 LLM 结构化摘要（800 字符，500 token）
2. **Tier 2**：激进压缩（低温度 0.05，200 字符上限）
3. **Tier 3**：确定性截断（纯字符串操作，不调 API，保留前 2048 字符）

**Fresh Tail Protection**：无论压缩多激进，最近 N 条消息永远保留完整内容，不参与压缩。

**压缩后修复**：`sanitizeToolPairs()` 确保压缩边界不会切在 tool_call 和 tool_result 中间，修复孤立的工具调用对。

## L7：Frozen Snapshot——不重复构建系统提示词

**位置**：`context-manager.ts` → `dynamicContextCache`

严格来说这不是"压缩"，而是防止重复消耗。

系统提示词（包含 agent 身份、工具规范、记忆、技能目录等）在每个 session 中只构建一次，缓存在 `dynamicContextCache` 中。后续轮次直接复用，不重新组装。

这有两个好处：
- **节省构建时间**：不用每轮都查询记忆、扫描技能目录
- **提高 Prompt Cache 命中率**：对支持 prompt caching 的 API（如 Anthropic），固定不变的系统提示词可以走缓存价格（约为正常输入的 10%）

## 辅助机制

### 大内容提取（Large Content Extraction）

位于 L4 和 L5 之间的补充机制。Agent-loop 的 overflow 处理 >8K 的实时输出，但历史消息中可能存在更大的内容（>12K，比如多部分结果拼接后超标）。`extractLargeContent()` 扫描历史消息，将超大内容持久化到磁盘，替换为结构化摘要（支持 JSON/CSV/XML/代码/纯文本五种格式的智能摘要）。

### Conversation History Offload

L6 压缩后，被压缩掉的完整对话历史会保存到 `data/tmp/{conversationId}/conversation_history.md`。如果 Agent 需要回忆更早的对话细节，可以通过 `file_read` 读取这个文件。信息不是丢了，只是从"上下文内"转移到了"磁盘上"。

## 实际效果

以一个典型的 15 轮对话为例（搜索新闻 → 抓取网页 → 写文章 → 推送 Telegram）：

| 阶段 | 原始大小 | 压缩后 | 节省 |
|------|---------|--------|------|
| 搜索结果（3 次 web_search） | ~6K chars | ~1.2K（L5 观测压缩） | 80% |
| 网页抓取（web_fetch） | ~15K chars | 1.5K 预览 + 文件（L4 overflow） | 90% |
| 文件写入参数（file_write） | ~2K chars | 50 chars（L2 参数截断） | 97% |
| 5 轮前的工具结果 | ~4K chars | ~600 chars（L3 微压缩） | 85% |
| JSON 工具结果 | ~800 chars | ~400 chars（L1 JSON 紧凑化） | 50% |

整体上下文利用率提升 3-5 倍：同样的上下文窗口，能跑的对话轮次从 ~10 轮提升到 ~30 轮，而不丢失关键信息。

## 设计原则

1. **渐进升级**：能用本地操作解决的不调 API，能用截断解决的不丢弃。七层从低成本到高成本排列，绝大多数场景在前五层就解决了。

2. **延迟访问优于截断**：Overflow 和 History Offload 把"丢失"变成"转移"——信息从上下文移到磁盘，LLM 需要时随时可以 `file_read` 取回。

3. **保护最近信息**：Fresh Tail Protection 确保最近 N 条消息永远完整。LLM 需要完整的最新上下文来做正确决策。

4. **保护用户意图**：结构化压缩模板中的 "User Messages" 段逐字保留用户原话，确保压缩后不丢失用户的原始意图。

5. **永不失败**：L6 的三级 fallback 保证压缩一定成功。即使 LLM 调用失败两次，第三级确定性截断（纯字符串操作）也能兜底。

## 与 Claude Code 的对比

Claude Code 源码中的三层压缩：
- **MicroCompact**：不触发 API，本地编辑缓存内容
- **AutoCompact**：接近上限时触发，预留 13K 缓冲
- **Full Compact**：全量压缩为摘要 + 重新注入文件/plan/skill

AgentClaw 在同一思路上做了更细粒度的分层：Claude Code 的 MicroCompact 对应我们的 L2+L3，AutoCompact 对应 L6，Full Compact 对应 L6 + History Offload。额外的 L1（基础压缩）、L4（Overflow）、L5（智能观测压缩）、L7（Frozen Snapshot）是 AgentClaw 的补充设计，针对 Agent 工具调用产生大量输出的特点做了更精细的处理。

核心理念一致：**上下文是稀缺资源，压缩要分层递进、信息要延迟而非丢弃、用户意图永不丢失。**
