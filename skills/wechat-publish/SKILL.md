---
name: wechat-publish
description: 将 Markdown 文章转换为微信公众号排版并发布草稿 | Convert Markdown to styled WeChat article and publish as draft
---

## 用法

将 Markdown 文件转换为微信公众号格式（100% 内联 CSS），支持 3 种主题，自动处理微信限制（外链转脚注、中英文间距、代码高亮）。可选上传到公众号草稿箱。

## Step 1: 转换 Markdown 为微信 HTML

使用 `shell` 工具执行转换脚本：

```json
{"command": "python skills/wechat-publish/scripts/md2wx.py {INPUT_FILE} --theme {THEME} --out {OUTPUT_FILE}", "timeout": 30000}
```

参数说明：
- `{INPUT_FILE}` — Markdown 文件路径
- `{THEME}` — 主题名，可选：`tech-modern`（默认，蓝色科技风）、`minimal`（极简灰白）、`sage`（绿色，AgentClaw 品牌色）
- `{OUTPUT_FILE}` — 输出 HTML 文件路径

示例：
```bash
python skills/wechat-publish/scripts/md2wx.py docs/context-compression.md --theme sage --out data/tmp/article.html
```

如需 JSON 格式输出（含 title + digest + content），加 `--json` 参数：
```bash
python skills/wechat-publish/scripts/md2wx.py docs/article.md --theme tech-modern --json --out data/tmp/article.json
```

## Step 2: 预览（可选）

用 `file_read` 读取输出的 HTML，确认排版正确。也可以把 HTML 内容粘贴到微信公众号后台的编辑器中预览。

## Step 3: 发布到微信公众号草稿箱（可选）

需要用户提供 AppID 和 AppSecret。

### 3a. 获取 access_token

```bash
curl -s "https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid={APPID}&secret={APPSECRET}"
```

### 3b. 上传封面图

```bash
curl -s -X POST "https://api.weixin.qq.com/cgi-bin/material/add_material?access_token={TOKEN}&type=image" -F "media=@{COVER_IMAGE}"
```

### 3c. 创建草稿

用 `execute_code` 或 `shell` 发送 JSON 请求：

```bash
curl -s -X POST "https://api.weixin.qq.com/cgi-bin/draft/add?access_token={TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary "@{JSON_FILE}"
```

JSON 文件结构：
```json
{
  "articles": [{
    "title": "文章标题",
    "author": "作者名",
    "digest": "摘要（120字以内）",
    "content": "HTML内容（md2wx.py 的输出）",
    "thumb_media_id": "封面图的 media_id",
    "need_open_comment": 1,
    "only_fans_can_comment": 0
  }]
}
```

## 主题预览

### tech-modern（默认）
- 蓝色主色调（#2563eb）
- 深色代码块（#1e293b 背景）
- H2 左侧蓝色竖线
- H1 下方蓝色底线

### minimal
- 灰白极简风格
- 浅色代码块（#fafafa 背景）
- H2 下方浅灰底线
- 适合长文阅读

### sage（AgentClaw 品牌色）
- 绿色主色调（#6B7F5E）
- 深绿代码块（#1A1D17 背景）
- H2 左侧绿色竖线
- 与 AgentClaw Web UI 风格一致

## 微信限制自动处理

脚本自动处理以下微信平台限制：
1. **外链 → 脚注**：`[text](url)` 转为 `text[1]` + 文末参考链接列表
2. **列表 → flex 布局**：原生 `<ul>/<ol>` 不可靠，改用 `<section>` + flex
3. **中英文间距**：CJK 和 Latin 字符间自动插入空格
4. **代码块**：`white-space: pre-wrap` 防止溢出
5. **100% 内联 CSS**：微信会剥离 `<style>` 标签
