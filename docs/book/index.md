# 造一个真能用的 AI Agent

> 从循环、工具、记忆到上线，一本书讲透智能体工程。

这部分是独立中文书稿区，不是英文 Blog、Series、Field Guides 或 Systems Analysis 的翻译版。它面向产品型技术读者、创业者、独立开发者和半技术背景实践者，更像一本可以从头读到尾的工程书。

这本书来自同一片 agent engineering 现场：循环失控、工具误用、记忆污染、成本膨胀、浏览器感知、交付失败、安全边界和上线纪律。AgentClaw 可以作为案例来源出现，但主角不是某个产品，而是一条从概念到生产系统的学习路径。

英文文章区负责输出高密度工程观点；这本书负责把同一套现场经验讲成一条可以跟着走的中文学习路径。

## 读者承诺

读完这本书，读者不只是知道 Agent 是什么，而是能理解一个真实 Agent 框架从 0 到 1 的关键决策：循环怎么控制，工具怎么设计，记忆怎么保存，成本怎么压低，错误怎么处理，安全怎么兜住，最终怎么上线给真实用户使用。

## 全书目录

### 开篇

- [为什么现在可以从零造 Agent](./00-opening.md)

### 第一部分：Agent 到底是什么

- [AI 不只是聊天的对象](./01-ai-is-not-chat.md)
- [最简 Agent](./02-minimal-agent.md)

### 第二部分：给 Agent 装上手脚

- [工具 Agent 的手和脚](./03-tool-agent.md)
- [当工具出错的时候](./04-tool-failures.md)
- [并行让 Agent 同时做几件事](./05-parallelism.md)

### 第三部分：教 Agent 记住事情

- [上下文窗口](./06-context-window.md)
- [长期记忆](./07-long-term-memory.md)
- [Token 经济学](./08-token-economics.md)

### 第四部分：当事情出错

- [LLM 会犯错，而且经常犯](./09-llm-failures.md)

### 第五部分：安全

- [你的 Agent 有 root 权限，谁没有？](./10-security.md)

### 第六部分：让 Agent 看见世界

- [浏览器 Agent 的眼睛](./11-browser.md)

### 第七部分：让 Agent 走进用户的生活

- [多渠道：一个大脑，七张嘴](./12-multi-channel.md)

### 第八部分：上线给别人用

- [从能跑到能用](./13-production.md)

### 第九部分：复盘与未来

- [我们犯过的错，以及你不必再犯](./14-lessons.md)
- [Agent 的未来](./15-future.md)

### 附录

- [大纲](./outline.md)
- [附录](./appendix.md)

## 和英文文章区的关系

英文 Agent Engineering publication 面向全球 agent 工程师，要求每篇都是一个可传播、可复用、可验证的工程论点。

中文书稿面向系统学习者，允许更长的叙事、更生活化的类比和更完整的学习坡度。两者共享 AgentClaw 的真实工程经验，但服务不同读者。
