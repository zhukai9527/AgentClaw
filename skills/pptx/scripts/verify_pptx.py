#!/usr/bin/env python3
"""Verify a PPTX package and optionally render preview artifacts.

The script intentionally returns machine-readable JSON so an agent can make a
hard deliver / do-not-deliver decision instead of relying on subjective claims.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


def find_soffice() -> str | None:
    candidates = [
        shutil.which("soffice"),
        shutil.which("libreoffice"),
        r"C:\Program Files\LibreOffice\program\soffice.com",
        r"C:\Program Files\LibreOffice\program\soffice.exe",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    return None


def inspect_pptx(path: Path) -> dict:
    try:
        from pptx import Presentation
    except Exception as exc:  # pragma: no cover - depends on machine setup
        return {
            "ok": False,
            "errors": [f"python-pptx unavailable: {exc}"],
            "warnings": [],
        }

    prs = Presentation(path)
    slides = []
    text_count = 0
    image_count = 0
    table_count = 0
    chart_count = 0

    for index, slide in enumerate(prs.slides, start=1):
        texts: list[str] = []
        for shape in slide.shapes:
            if getattr(shape, "has_text_frame", False):
                for paragraph in shape.text_frame.paragraphs:
                    text = paragraph.text.strip()
                    if text:
                        texts.append(text)
            if getattr(shape, "shape_type", None) == 13:
                image_count += 1
            if getattr(shape, "has_table", False):
                table_count += 1
            if getattr(shape, "has_chart", False):
                chart_count += 1
        text_count += len(texts)
        slides.append({"index": index, "textCount": len(texts), "sampleText": texts[:5]})

    return {
        "ok": True,
        "errors": [],
        "warnings": [],
        "slideCount": len(prs.slides),
        "widthEmu": prs.slide_width,
        "heightEmu": prs.slide_height,
        "textCount": text_count,
        "imageCount": image_count,
        "tableCount": table_count,
        "chartCount": chart_count,
        "slides": slides,
    }


def render_pdf(pptx_path: Path, out_dir: Path) -> tuple[Path | None, list[str], list[str]]:
    warnings: list[str] = []
    errors: list[str] = []
    soffice = find_soffice()
    if not soffice:
        warnings.append("LibreOffice/soffice not found; preview render skipped")
        return None, warnings, errors

    command = [
        soffice,
        "--headless",
        "--convert-to",
        "pdf",
        "--outdir",
        str(out_dir),
        str(pptx_path),
    ]
    proc = subprocess.run(command, capture_output=True, text=True, timeout=90)
    if proc.returncode != 0:
        errors.append((proc.stderr or proc.stdout or "LibreOffice render failed").strip())
        return None, warnings, errors

    pdf_path = out_dir / f"{pptx_path.stem}.pdf"
    if not pdf_path.exists():
        errors.append("LibreOffice finished but PDF preview was not created")
        return None, warnings, errors
    return pdf_path, warnings, errors


def render_pngs(pdf_path: Path, out_dir: Path) -> tuple[list[str], list[str]]:
    warnings: list[str] = []
    try:
        import fitz  # type: ignore
    except Exception:
        warnings.append("PyMuPDF not found; PDF preview created but PNG pages skipped")
        return [], warnings

    png_paths: list[str] = []
    doc = fitz.open(pdf_path)
    try:
        for page_index in range(doc.page_count):
            page = doc.load_page(page_index)
            pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
            png_path = out_dir / f"{pdf_path.stem}_slide_{page_index + 1:02d}.png"
            pix.save(png_path)
            png_paths.append(str(png_path))
    finally:
        doc.close()
    return png_paths, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify a PPTX file before delivery.")
    parser.add_argument("pptx", type=Path)
    parser.add_argument("--out-dir", type=Path, default=None)
    parser.add_argument("--min-slides", type=int, default=1)
    parser.add_argument("--require-text", action="store_true")
    parser.add_argument("--require-preview", action="store_true")
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()

    pptx_path = args.pptx.resolve()
    out_dir = (args.out_dir or pptx_path.with_suffix("").with_name(f"{pptx_path.stem}_verification")).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    report: dict = {
        "ok": False,
        "pptx": str(pptx_path),
        "outDir": str(out_dir),
        "errors": [],
        "warnings": [],
        "pdfPreview": None,
        "pngPreviews": [],
    }

    if not pptx_path.exists():
        report["errors"].append("PPTX file does not exist")
    elif pptx_path.suffix.lower() != ".pptx":
        report["errors"].append("Input is not a .pptx file")
    else:
        inspection = inspect_pptx(pptx_path)
        report.update(inspection)
        report["errors"] = list(report.get("errors", []))
        report["warnings"] = list(report.get("warnings", []))

        if inspection.get("ok"):
            if inspection.get("slideCount", 0) < args.min_slides:
                report["errors"].append(f"Slide count below minimum {args.min_slides}")
            if args.require_text and inspection.get("textCount", 0) == 0:
                report["errors"].append("No readable text found in deck")

            pdf_path, warnings, errors = render_pdf(pptx_path, out_dir)
            report["warnings"].extend(warnings)
            report["errors"].extend(errors)
            if pdf_path:
                report["pdfPreview"] = str(pdf_path)
                png_paths, png_warnings = render_pngs(pdf_path, out_dir)
                report["pngPreviews"] = png_paths
                report["warnings"].extend(png_warnings)
            elif args.require_preview:
                report["errors"].append("Preview render is required but unavailable")

    report["ok"] = len(report["errors"]) == 0
    report_path = out_dir / "verify_report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    report["reportPath"] = str(report_path)

    output = json.dumps(report, ensure_ascii=False, indent=2)
    print(output if args.as_json else f"ok={report['ok']} report={report_path}")
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
