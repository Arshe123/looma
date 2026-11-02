# /// script
# dependencies = ["fonttools==4.68.0"]
# ///
"""Build original zero-advance syntax glyphs; no third-party font is modified.

Run: uv run --script scripts/build-table-syntax-font.py
Only pipe/space/tab have glyphs. Actual IME text falls back to the body font,
so source-backed syntax can stay editable without hiding composed characters.
"""
from datetime import datetime
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

builder = FontBuilder(1000, isTTF=True)
names = [".notdef", "pipe", "space", "tab"]
builder.setupGlyphOrder(names)
builder.setupCharacterMap({0x7C: "pipe", 0x20: "space", 0x09: "tab"})
builder.setupGlyf({name: TTGlyphPen(None).glyph() for name in names})
builder.setupHorizontalMetrics({name: (0, 0) for name in names})
builder.setupHorizontalHeader(ascent=800, descent=-200)
builder.setupNameTable({
    "familyName": "Looma Table Syntax",
    "styleName": "Regular",
    "uniqueFontIdentifier": "LoomaTableSyntax-1.0",
    "fullName": "Looma Table Syntax",
    "psName": "LoomaTableSyntax",
    "version": "Version 1.0",
})
builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
builder.setupPost()
builder.setupMaxp()
stamp = int((datetime(2020, 1, 1) - datetime(1904, 1, 1)).total_seconds())
builder.font["head"].created = stamp
builder.font["head"].modified = stamp
builder.font.recalcTimestamp = False
output = Path(__file__).resolve().parents[1] / "src/renderer/assets/fonts/looma-table-syntax.ttf"
builder.save(output)
print(f"Generated original syntax font: {output} ({output.stat().st_size} bytes)")
