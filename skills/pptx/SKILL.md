---
name: pptx
description: Use when the user asks to create, edit, improve, redesign, beautify, inspect, or export PowerPoint decks, PPT files, slide decks, keynotes, or .pptx deliverables. Prefer this skill for presentation work that must produce a real PPTX file, especially when visual quality, editable text, brand assets, charts, or export verification matter. Do not use for Word documents or PDFs.
---

# PPTX Deck Production

Build the deck, verify the saved `.pptx`, then deliver it. Keep the interaction minimal; put deterministic checks in scripts instead of long explanations.

## Default fast path

1. Resolve source material.
2. Generate the deck in `{WORKDIR}`. Substantial decks should use `claude_code` with cwd `{WORKDIR}` instead of a long inline `bash`/XML-style tool call.
3. Run:
   ```powershell
   python "{VERIFY_PPTX}" "{WORKDIR}/output.pptx" --out-dir "{WORKDIR}/output_previews" --require-text --json
   ```
4. Send the PPTX only if verification exits 0. Do not send the PPTX when verification fails.

For substantial decks, also save `brand-spec.md` beside the output with logo/image paths, color tokens, fonts, and no-go style rules.

## Dependency discipline

- Do not run `pip install`, `python -m pip install`, `npm install`, or other package installation during a deck task.
- Use the existing environment. Do not run standalone dependency preflight checks such as `python -c "import pptx"`.
- Write and run the deck generation script directly. If that script fails with `ModuleNotFoundError` for a required package, stop and report the missing dependency instead of installing it inside the user task.

## Short prompt in an existing session

When the user says only `生成 ppt`, `做成PPT`, `导出pptx`, or similar in an existing session:

- Treat the latest substantial visible conversation content as the source.
- If that content is only a task summary, not the actual facts/outline, regenerate or ask for the missing source; do not invent facts.
- If the inherited topic is current news, prices, laws, product specs, or recent events and no current tool result contains the facts, search again before generating.
- Do not ask for style choices unless blocked. Choose a tasteful default and continue.

## Production paths

| Need | Path |
| --- | --- |
| Best visual quality | HTML-first: design two-slide showcase, then complete deck, then export/rebuild PPTX |
| Strict editable PPTX | Native editable objects: text boxes, shapes, images, charts, tables |
| Quick internal deck | `python-pptx` with a restrained design system |
| Existing deck edit | Inspect existing PPTX, patch only requested slides, verify |

Use a two-slide showcase for decks with 5+ slides when the user asked for beauty, redesign, pitch, keynote, public presentation, brand deck, or complained that output was ugly. The showcase is cover + the most different content slide.

## Editable PPTX constraints

- Use `960pt × 540pt`, `13.333in × 7.5in`, or equivalent 16:9.
- All visible text must be wrapped in semantic HTML text (`p`, `h1`-`h6`, `li`) or native PowerPoint text boxes. The phrase "text must be wrapped" is a hard gate.
- Use real image files or native picture shapes; do not fake subject imagery.
- Use native editable charts/tables for normal data relationships.
- Keep extra text slack because PowerPoint metrics differ from browser metrics.
- Avoid complex SVG, canvas art, blend modes, CSS-only backgrounds, and effects that cannot become PPTX objects when editability matters.

## Design gates

Apply these anti-slop checks before verification:

- No generic purple-blue gradient deck, emoji-as-icon system, random blobs, fake SVG people, or repeated "title + three rounded cards".
- No placeholder imagery unless explicitly approved.
- No default Office chart/table styling.
- No dense paragraph slides; split or move detail to speaker notes/appendix.
- No overlap, clipping, off-slide objects, or low-contrast text.
- Use real assets first: logo, product screenshots, UI, charts, photos, diagrams.

## Hard stop rules

- Do not write generated scripts or final files into `C:/Users/voroj` unless that is the explicit workspace.
- Do not call nonexistent preview scripts. The verifier in this skill is the preview/inspection entry.
- Do not treat one LibreOffice PNG as full-deck preview; PPTX preview must be PDF render or per-slide/page output.
- Do not deliver if `verify_pptx.py` reports `ok: false`.
- Do not run `verify_pptx.py` without `--json`; non-JSON `ok=True report=...` output is not enough for delivery.
- Do not send a `.pptx` from outside `{WORKDIR}`; copy it into `{WORKDIR}` and re-run verification first.

## Verification

Run the bundled verifier on every generated or edited deck:

```powershell
python "{VERIFY_PPTX}" "{WORKDIR}/deck.pptx" --out-dir "{WORKDIR}/previews" --require-text --json
```

Use `--require-preview` when visual quality was the point of the task. If preview tooling is unavailable, the verifier reports that limitation; only deliver without preview when the user asked for a quick/internal deck.

Final response should state the PPTX path, verifier result, preview/report path, and any limitation. Keep it short.
