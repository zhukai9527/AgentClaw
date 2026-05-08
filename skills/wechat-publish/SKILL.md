---
name: wechat-publish
description: Markdown 转微信公众号排版并发布草稿。Use this whenever the user asks to convert Markdown to WeChat Official Account HTML, inspect publish readiness, preview local WeChat layout, or create a WeChat draft. 不用于：写文章内容、其他平台发布。
---

# wechat-publish

将 Markdown 转成微信公众号兼容 HTML，可预览或创建草稿箱草稿。所有常规操作只走统一入口：

```bash
python skills/wechat-publish/scripts/wechat_publish.py capabilities --json
python skills/wechat-publish/scripts/wechat_publish.py inspect {INPUT_MD} --draft --json
python skills/wechat-publish/scripts/wechat_publish.py preview {INPUT_MD} --out-dir {WORKDIR} --json
python skills/wechat-publish/scripts/wechat_publish.py publish {INPUT_MD} --title "封面标题" --subtitle "封面副标题" --scheme dark --theme tech-modern --author "爬爬虾" --out-dir {WORKDIR} --json
```

离线验收或调试时使用 `--dry-run`，不会创建真实草稿：

```bash
python skills/wechat-publish/scripts/wechat_publish.py publish {INPUT_MD} --title "封面标题" --subtitle "封面副标题" --out-dir {WORKDIR} --dry-run --json
```

## 执行规则

- 先用 `capabilities --json` 获取当前可用主题、封面配色和 JSON 契约，不要从文档猜。
- 发布前优先跑 `inspect {INPUT_MD} --draft --json`。如果 `readiness.draft_ready=false`，按 `checks[].code` 处理，不要继续发布。
- 用户只要求查看效果时用 `preview`，它只写本地 HTML，不上传图片、不创建草稿。
- 用户明确要求发布到公众号草稿箱时才用 `publish`。成功后只根据 JSON 中的 `data.draft_media_id` 和 `data.artifacts` 汇报结果。
- stdout 是唯一机器契约：`success/code/message/data`。不要解析旧脚本的行文本输出。
- 参数名必须写完整，尤其是 `--out-dir`；CLI 不接受 `--out` 这类缩写。

## 禁止事项

- 禁止使用不存在的 `upload.py`、`publish.py`。
- 禁止手写访问令牌、上传封面或 `curl` 微信草稿接口。
- 禁止绕过 `wechat_publish.py` 直接访问微信接口。
- 禁止读取 `data/tmp/**/skills/**` 里的历史脚本。
- 禁止在发布成功后再读取 `article.json` 做无必要预览。

## 常用参数

- `--theme`：文章主题，默认 `tech-modern`；可用值以 `capabilities --json` 为准。
- `--scheme`：封面配色，默认 `dark`；可用值以 `capabilities --json` 为准。
- `--article-title`：覆盖文章 metadata 标题；不传时取 Markdown 第一个 H1。
- `--digest`：覆盖摘要；不传时从正文生成，最长 120 字符。
- `--thumb-media-id`：使用已有微信永久封面素材 ID。
- `--dry-run`：只生成本地 `article.json` / `draft.json`，不创建真实草稿。

## 微信限制自动处理

脚本自动处理：

1. 外链转脚注，避免微信外链限制。
2. 列表改成 `<section>` flex 布局，避免原生列表在微信编辑器里失真。
3. CJK 和 Latin 字符间插入空格。
4. 代码块使用 `white-space: pre-wrap` 防止横向溢出。
5. 输出 100% 内联 CSS，避免微信剥离 `<style>`。
