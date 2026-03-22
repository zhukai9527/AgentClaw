---
name: work-report
description: 自动生成日报/周报并发送邮件 | Auto-generate daily/weekly work report from git log and send via email
---

## 用法

用户说"写日报"、"写周报"、"发日报"、"发周报"时触发。

## 步骤（严格按顺序执行，不要问用户）

### 1. 确定报告类型和时间范围

- **日报**：今天的提交（`--since="今天日期" --until="明天日期"`）
- **周报**：本周一到今天（`--since="本周一日期" --until="明天日期"`）
- 如果用户指定了日期范围，以用户为准

### 2. 获取 git 提交记录

```bash
cd D:/mycode/agentclaw && git log --oneline --since="START" --until="END"
```

同时获取统计数据：
```bash
cd D:/mycode/agentclaw && git log --oneline --since="START" --until="END" | wc -l
cd D:/mycode/agentclaw && git diff --stat $(git log --reverse --since="START" --until="END" --format="%H" | head -1)^..$(git log --since="START" --until="END" --format="%H" | head -1) | tail -1
```

### 3. 整理报告

格式要求：
- **标题**：`AgentClaw [日报/周报] — 日期范围`
- **按功能模块分类**：如核心引擎、渠道集成、前端、安全、文档等
- **每个模块**列出关键改动，一句话精炼
- **末尾**加数据统计（提交数、文件变更、代码行数增减）
- 日报可加"明日计划"（根据未完成的 TODO 或进行中的工作推测）
- 周报可加"本周教训"（从 fix 类提交中提炼经验）

### 4. 发送邮件

使用 `gws-gmail` skill 发送：
- **收件人**：353249@qq.com
- **邮件标题**：与报告标题一致
- **正文**：报告全文（纯文本）

发送命令（先 use_skill("gws-gmail") 获取指令）：
```bash
gws gmail users messages send --json '{
  "userId": "me",
  "raw": "<base64 编码的邮件>"
}'
```

邮件 raw 格式：
```
From: vorojar@gmail.com
To: 353249@qq.com
Subject: =?UTF-8?B?<base64编码的标题>?=
Content-Type: text/plain; charset=UTF-8

<报告正文>
```

### 5. 确认完成

回复用户：邮件已发送到 353249@qq.com，附上报告摘要（核心数据 + 主要进展一句话）。
