---
name: wechat-publish
description: Markdown 转微信公众号排版并发布草稿。不用于：写文章内容、其他平台发布
---

## 用法

将 Markdown 文件转换为微信公众号格式（100% 内联 CSS），支持 3 种主题，自动处理微信限制（外链转脚注、中英文间距、代码高亮）。可选上传到公众号草稿箱。

## 首选：一键发布草稿

发布到公众号时，优先只执行这一条命令；不要拆成封面、转换、上传多个步骤。

```bash
python skills/wechat-publish/scripts/publish_article.py {INPUT_MD} --title "封面标题" --subtitle "封面副标题" --scheme dark --theme tech-modern --author "爬爬虾" --out-dir {WORKDIR}
```

成功后脚本只输出 `draft_media_id=...`、`cover=...`、`article_json=...`、`draft_json=...`。到这里任务完成，直接回复草稿已创建；不要再读取 `article.json`，不要再查找脚本。

离线验证时加 `--dry-run`，不会创建真实草稿：
```bash
python skills/wechat-publish/scripts/publish_article.py {INPUT_MD} --title "封面标题" --subtitle "封面副标题" --out-dir {WORKDIR} --dry-run
```

禁止事项：
- 禁止使用不存在的 `upload.py` 或 `publish.py`
- 禁止手写访问令牌、上传封面或 `curl` 草稿接口
- 禁止绕过发布脚本访问微信接口
- 禁止读取 `data/tmp/**/skills/**` 里的历史脚本
- 禁止在发布成功后再读取 `article.json` 做无必要预览

## 拆分调试流程

只有一键脚本失败且用户要求排查时，才使用下面的拆分步骤。

### Step 0: 生成封面图

使用 `shell` 工具执行封面生成脚本：

```bash
python skills/wechat-publish/scripts/cover.py "标题" "副标题" --scheme {SCHEME} --out {OUTPUT_PNG}
```

参数说明：
- 第一个参数 — 主标题，用 `|` 分行（如 `"第一行|第二行"`）
- 第二个参数 — 副标题（可选，留空则不显示）
- `--scheme` — 配色方案：`dark`（默认，深蓝）、`warm`（暖橙）、`green`（绿色）、`purple`（紫色）、`blue`（蓝色）
- `--out` — 输出 PNG 路径，默认为脚本同目录下 `cover.png`

输出尺寸：900×383（微信公众号封面标准尺寸）。

**注意**：封面图不允许使用 emoji，保持干净高级感。

示例：
```bash
python skills/wechat-publish/scripts/cover.py "从零到开好|美国怀俄明州公司" "LLC注册 · EIN申请 · Mercury银行开户" --scheme dark --out data/tmp/cover.png
```

### Step 1: 转换 Markdown 为微信 HTML

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

### Step 2: 预览（可选）

用 `file_read` 读取输出的 HTML，确认排版正确。也可以把 HTML 内容粘贴到微信公众号后台的编辑器中预览。

### Step 3: 发布到微信公众号草稿箱

只使用发布脚本，不要手写访问令牌、上传封面或 `curl` 草稿接口。脚本会通过反代服务器完成获取访问令牌、上传封面、组装 `articles` JSON 和创建草稿。

```bash
python skills/wechat-publish/scripts/publish_draft.py {ARTICLE_JSON} --cover {COVER_IMAGE} --author "爬爬虾" --out {DRAFT_JSON}
```

参数说明：
- `{ARTICLE_JSON}` — Step 1 使用 `--json` 生成的文件，结构必须是 `title`、`digest`、`content`
- `{COVER_IMAGE}` — Step 0 生成的封面图
- `{DRAFT_JSON}` — 保存最终提交给微信的草稿 JSON，便于复查

成功后脚本只输出 `draft_media_id=...` 和 `draft_json=...`。不要输出访问令牌。

离线验证时使用 dry-run，不会访问网络、不会创建真实草稿：
```bash
python skills/wechat-publish/scripts/publish_draft.py {ARTICLE_JSON} --thumb-media-id test_thumb --dry-run --out {DRAFT_JSON}
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
