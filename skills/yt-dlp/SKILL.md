---
name: yt-dlp
description: 下载视频/音频（YouTube、B站、Twitter等）。不用于：网页抓取（用 web_fetch）、直播录制
---

All output files go to the working directory (工作目录). Always use `auto_send: true` on the shell call.
Filenames use video ID (ASCII-safe) to avoid encoding issues on Windows.

## Download video (default: best quality mp4)
```json
{"command": "yt-dlp --no-warnings -f 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b' --merge-output-format mp4 -o '{WORKDIR}/%(id)s.%(ext)s' 'URL'", "timeout": 300000, "auto_send": true}
```

## Download audio only (mp3)
```json
{"command": "yt-dlp --no-warnings -x --audio-format mp3 --audio-quality 0 -o '{WORKDIR}/%(id)s.%(ext)s' 'URL'", "timeout": 300000, "auto_send": true}
```

## Download with subtitles
```json
{"command": "yt-dlp --no-warnings -f 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b' --merge-output-format mp4 --write-auto-subs --write-subs --sub-langs 'zh.*,en' --embed-subs -o '{WORKDIR}/%(id)s.%(ext)s' 'URL'", "timeout": 300000, "auto_send": true}
```

## List available formats (when user asks for specific quality)
```json
{"command": "yt-dlp --no-warnings -F 'URL'", "timeout": 30000}
```
Then let user choose, download with `-f FORMAT_ID`.

## Download specific resolution (e.g. 720p)
```json
{"command": "yt-dlp --no-warnings -f 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/b' --merge-output-format mp4 -o '{WORKDIR}/%(id)s.%(ext)s' 'URL'", "timeout": 300000, "auto_send": true}
```

## Bilibili (needs cookies for high quality)
If download fails with 403 or low quality, try with cookies:
```json
{"command": "yt-dlp --no-warnings --cookies-from-browser chrome -f 'bv*+ba/b' --merge-output-format mp4 -o '{WORKDIR}/%(id)s.%(ext)s' 'URL'", "timeout": 300000, "auto_send": true}
```

## Playlist (download all)
```json
{"command": "yt-dlp --no-warnings -f 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b' --merge-output-format mp4 -o '{WORKDIR}/%(playlist_id)s/%(playlist_index)03d-%(id)s.%(ext)s' --yes-playlist 'URL'", "timeout": 600000}
```
Playlists can be large — do NOT auto_send. Tell user the folder path instead.

## YouTube cookies（必读）
YouTube 需要登录才能下载。**所有 YouTube URL 必须加 `--cookies 'D:/mycode/agentclaw/data/youtube-cookies.txt'`**。
- 先检查文件是否存在：`ls D:/mycode/agentclaw/data/youtube-cookies.txt`
- 存在 → 在 yt-dlp 命令中 `--no-warnings` 后面加 `--cookies 'D:/mycode/agentclaw/data/youtube-cookies.txt'`
- 不存在 → 告诉用户用浏览器扩展「Get Cookies.txt」导出 YouTube cookies，你保存到该路径后再下载
- 非 YouTube 网站（B站、Twitter 等）不需要加此参数

## Download time range (e.g. 4-5 minutes only)
在命令中加 `--download-sections "*00:04:00-00:05:00"`（替换为实际时间范围），直接下载指定片段，不要下载全视频再裁剪。

## Rules
- NEVER add `--proxy` flag. The network is already routed through a proxy at the router level. Adding a local proxy address will BREAK the connection.
- ALWAYS copy the JSON template above EXACTLY. Do not improvise commands.
- ALWAYS use bash shell (default), never PowerShell.
- ALWAYS quote the URL with single quotes (URLs contain special chars like & that bash interprets).
- timeout MUST be 300000 (5min) for single video, 600000 (10min) for playlists. NEVER use default timeout.
- Once download succeeds (exit code 0 and file exists), do NOT retry with different quality/format. Proceed to the user's next step if any.
- If download fails on non-YouTube sites, try `--cookies-from-browser chrome` (many sites need login for HD).
- For Twitter/X: URLs like `https://x.com/user/status/123` work directly.
- One command per video. Do NOT batch multiple URLs in one command.
