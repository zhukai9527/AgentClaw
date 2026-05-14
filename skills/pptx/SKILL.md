---
name: pptx
description: Use when the user asks to create, edit, improve, redesign, beautify, or inspect PowerPoint decks, PPT files, slide decks, keynotes, or .pptx deliverables. Prefer this skill for presentation work that must produce a real PPTX file, especially when visual quality, editable text, brand assets, charts, or export verification matter. Do not use for Word documents or PDFs.
---

# PPTX Deck Production

Create PowerPoint decks as designed presentation artifacts, not as `python-pptx` API demos. The default goal is a deck that looks intentionally designed, keeps important text editable, and has been rendered or inspected before delivery.

## Choose the production path

Use the highest-quality path the request allows:

| User need | Path | Result |
| --- | --- | --- |
| "Make it beautiful", "keynote", product launch, brand deck, pitch, public-facing slides | HTML-first | Design in HTML/CSS, render previews, then export or rebuild to PPTX |
| Editable PPTX is mandatory | Editable-constrained | Follow the editable PPTX constraints from the first slide; avoid effects that cannot become PowerPoint objects |
| Quick internal deck, simple edit, append slides, fix text/table/chart | Python-pptx fallback | Use native `python-pptx` objects with a restrained design system |
| Existing deck visual refresh | Inspect first | Read the deck, render/convert previews when available, then patch the source PPTX |

If the user did not specify editability, optimize for visual quality and provide a PPTX plus PNG/PDF previews when possible. If the deck must remain heavily editable, tell the user that some web-only visual effects will be simplified.

Do not vendor or copy third-party slide engines into this repo without checking their license. You may use public design ideas such as HTML-first workflow, asset intake, showcase-first iteration, and anti-slop gates.

## Design intake

Before generating a substantial deck, capture enough context to avoid generic slides:

1. Audience and use: live talk, investor pitch, report, class, social carousel, internal status, sales leave-behind.
2. Slide count and density: live decks should usually be lighter; leave-behinds can carry more tables and notes.
3. Brand/source assets: logo, product renders, UI screenshots, brand guidelines, colors, fonts, existing site, previous decks.
4. Required format: PPTX only, HTML plus PPTX, PDF, speaker notes, or all of the above.
5. Current facts: if product specs, market data, people, laws, prices, or recent events matter, verify them before using them.

For branded decks, create or update a short `brand-spec.md` in the deck workspace. Include logo paths, product/UI image paths, color tokens, font choices, and no-go rules. Logo, product images, and UI screenshots matter more than guessed colors.

## HTML-first deck workflow

Use this for design-heavy decks and for any deck where the user complained about ugly output.

1. Create a writable deck workspace with `slides/`, `assets/`, `previews/`, and optional `brand-spec.md`.
2. Build a two-slide showcase before the whole deck when the deck has 5+ slides. Pick the cover plus the most different content slide. The phrase "two-slide showcase" means these two slides establish typography, palette, spacing, imagery, and page grammar before bulk generation.
3. Author slides at 16:9 with a stable canvas. Prefer `960pt × 540pt`, `1280px × 720px`, or `13.333in × 7.5in`. Keep one clear job per slide.
4. Use real assets as first-class visuals. Do not replace a product, brand, person, interface, or chart with generic icons, CSS silhouettes, decorative SVGs, or stock-like filler.
5. Render PNG previews for the showcase, inspect them, then continue the full deck. After the full deck, render PNG previews for every slide.
6. Export or rebuild to PPTX only after the visual grammar is stable.

Visual grammar beats template repetition. Keep consistent margins, type scale, colors, and motif behavior, but vary composition: full-bleed image, open type, chart-first slide, comparison, quote, timeline, section divider, artifact screenshot, or closing CTA.

## Editable PPTX constraints

When users need editable text and shapes in PowerPoint, the design source must obey PowerPoint's object model from the start:

- Use `960pt × 540pt` or equivalent 16:9 dimensions.
- All visible text must be wrapped in semantic text elements in HTML (`p`, `h1`-`h6`, `li`) or native PowerPoint text boxes. The phrase "text must be wrapped" is a hard gate.
- Put fills, borders, and shadows on container shapes, not directly on text elements.
- Use real image elements or native picture shapes for images. Do not rely on CSS `background-image` if the converter cannot map it.
- Avoid CSS gradients, web components, canvas art, complex SVG decorations, blend modes, and layout tricks that cannot become editable PPTX objects.
- Leave extra text slack. PowerPoint font metrics differ from browser metrics; tight titles and chips will wrap or clip.
- Use native editable charts/tables when the relationship is chartable. Do not fake ordinary charts from boxes unless the visual relationship cannot be represented by native chart/table objects.

If a finished HTML visual cannot be exported as editable PPTX cleanly, prefer PDF/PNG for visual fidelity and create a simplified editable PPTX only if the user still needs it.

## Design quality gates

Apply these anti-slop checks before delivery:

- No generic purple-blue gradients, emoji icons, random blobs, fake device silhouettes, stock SVG humans, or repeated "title + three rounded cards" unless the user explicitly asked for that style.
- No text-dense slides pretending to be presentation slides. Split dense material or move detail into speaker notes/appendix.
- No important text below presentation-readable size: body usually 18-28 pt, callouts 24+ pt, chart labels 12-16 pt minimum depending on density.
- No large empty cards used as a substitute for composition. Use open typography, a real visual, chart, table, or diagram.
- No placeholder imagery in final output unless honestly labeled and approved.
- No default Office chart/table styling. Set fonts, fills, line weights, gridlines, legends, labels, and emphasis deliberately.
- No overlap, clipping, off-slide content, or low-contrast text over busy imagery.

## Python-pptx fallback

Use `python-pptx` for direct PPTX creation, existing deck edits, or constrained internal decks. Install only if missing:

```powershell
python -m pip install python-pptx
```

Prefer blank slides and named geometry helpers over built-in placeholder layouts. Use a small design system:

```python
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)

W, H = 13.333, 7.5
INK = RGBColor(0x18, 0x1A, 0x1F)
MUTED = RGBColor(0x5B, 0x61, 0x6B)
PAPER = RGBColor(0xF7, 0xF4, 0xEE)
ACCENT = RGBColor(0x2F, 0x7D, 0x6D)

def add_text(slide, text, x, y, w, h, size, color=INK, bold=False, align=PP_ALIGN.LEFT):
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = box.text_frame
    tf.clear()
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.word_wrap = True
    tf.vertical_anchor = MSO_ANCHOR.TOP
    p = tf.paragraphs[0]
    p.text = text
    p.alignment = align
    run = p.runs[0]
    run.font.name = "Aptos"
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color
    return box

slide = prs.slides.add_slide(prs.slide_layouts[6])
slide.background.fill.solid()
slide.background.fill.fore_color.rgb = PAPER

add_text(slide, "Quarterly Product Narrative", 0.75, 0.7, 8.6, 0.9, 34, bold=True)
add_text(slide, "One sharp claim per slide. Use real evidence, not filler.", 0.78, 1.55, 7.4, 0.45, 15, MUTED)
shape = slide.shapes.add_shape(1, Inches(0.78), Inches(2.25), Inches(3.2), Inches(0.05))
shape.fill.solid()
shape.fill.fore_color.rgb = ACCENT

prs.save("output.pptx")
```

For charts, use native `add_chart` and then style axes, labels, legend, and colors. For tables, increase row height, remove heavy borders, use quiet rules, and emphasize one comparison instead of filling every cell with equal visual weight.

## Editing existing decks

1. Read the deck with `python-pptx`; list slide count, size, layouts, shape names, text, tables, charts, and media.
2. Render or convert to previews if LibreOffice is available:
   ```powershell
   soffice --headless --convert-to pdf --outdir previews input.pptx
   ```
3. Patch only the requested slides or the minimum shared theme objects needed.
4. Preserve existing user content unless the request is a rewrite.
5. Save to a new file unless the user explicitly asked to overwrite.

## Verification

Before final response:

1. Confirm the PPTX file exists and can be opened by `python-pptx`.
2. Inspect slide count, dimensions, and non-empty text objects.
3. Render PNG previews or a PDF when tooling is available. Use LibreOffice headless for PPTX-to-PDF, then convert PDF pages to PNG if possible.
4. Inspect every preview at readable size. Check cover quality, hierarchy, text fit, asset rendering, chart/table styling, and footer/source fit.
5. Report what was verified: PPTX path, preview paths, commands run, and any unresolved limitations.

If preview rendering is unavailable, say so clearly and compensate with package inspection: slide dimensions, shape count, text extraction, image count, and chart/table presence.
