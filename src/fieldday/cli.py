"""fieldday CLI: C struct snippet in, themeable layout SVG out.

Examples:
    fieldday struct.c                        # writes struct.svg next to input
    fieldday struct.c -o out.svg             # explicit output
    cat struct.c | fieldday -                # stdin
    fieldday struct.c --struct client        # pick one struct from snippet
    fieldday struct.c --emit-json            # layout JSON to stdout (no SVG)
    fieldday --from-json layout.json -o x.svg  # render hand-tweaked JSON
    fieldday struct.c --theme light          # builtin theme
    fieldday struct.c --theme mytheme.json   # custom theme file
    fieldday struct.c --transparent --no-ruler --title "struct client (9.1)"

Unknown types in snippets: add stub directives, e.g.
    //@ stub robj 16 8        (name, size bytes, optional align)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .cparse import parse_snippet, SnippetError
from .probe import (FieldLayout, ProbeError, StructLayout, compute_layouts,
                    layouts_to_json)
from .render import DEFAULT_THEME, RenderOptions, render_struct

BUILTIN_THEMES = {
    "dark": {},  # DEFAULT_THEME
    "light": {
        "bg": "#ffffff", "text": "#1a1a2e", "muted": "#667",
        "field": "#4a90c2", "field-text": "#ffffff",
        "pad": "#eceef2", "pad-stroke": "#b8bcc8",
        "border": "#9aa", "accent": "#b8860b",
    },
}


def load_theme(spec: str) -> dict:
    if spec in BUILTIN_THEMES:
        return BUILTIN_THEMES[spec]
    p = Path(spec)
    if not p.exists():
        sys.exit(f"fieldday: theme '{spec}' is not builtin "
                 f"({', '.join(BUILTIN_THEMES)}) and no such file exists")
    theme = json.loads(p.read_text())
    unknown = set(theme) - set(DEFAULT_THEME)
    if unknown:
        sys.exit(f"fieldday: unknown theme keys: {', '.join(sorted(unknown))} "
                 f"(valid: {', '.join(DEFAULT_THEME)})")
    return theme


def layouts_from_json(text: str) -> list[StructLayout]:
    data = json.loads(text)
    out = []
    for s in data["structs"]:
        sl = StructLayout(name=s["name"], size=s["size"], align=s.get("align", 8))
        for f in s["fields"]:
            sl.fields.append(FieldLayout(
                name=f["name"], type_str=f.get("type_str", ""),
                offset=f["offset"], size=f["size"],
                is_pointer=f.get("is_pointer", False),
                is_padding=f.get("is_padding", False),
                bit_offset=f.get("bit_offset"), bit_width=f.get("bit_width"),
                struct_ref=f.get("struct_ref")))
        out.append(sl)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="fieldday",
        description="Generate themeable SVG diagrams of C struct memory layouts.",
        epilog=__doc__.split("Examples:")[1],
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", nargs="?",
                    help="C snippet file, or '-' for stdin")
    ap.add_argument("--from-json", metavar="FILE",
                    help="render from layout JSON instead of C (hand-tweak workflow)")
    ap.add_argument("-o", "--output", metavar="FILE",
                    help="output SVG path (default: input name with .svg; '-' for stdout)")
    ap.add_argument("--struct", metavar="NAME",
                    help="render only this struct (default: all, suffixed files)")
    ap.add_argument("--emit-json", action="store_true",
                    help="print layout JSON to stdout instead of rendering")
    ap.add_argument("--theme", default="dark", metavar="NAME|FILE",
                    help="builtin theme (dark, light) or JSON theme file")
    ap.add_argument("--title", help="diagram title (default: struct NAME)")
    ap.add_argument("--transparent", action="store_true",
                    help="no background rect (inherit page background)")
    ap.add_argument("--no-ruler", action="store_true", help="omit byte ruler")
    ap.add_argument("--no-padding-callout", action="store_true",
                    help="omit the 'N of M bytes are padding' line")
    ap.add_argument("--px-per-byte", type=float, default=15.0,
                    help="horizontal scale (default 15)")
    args = ap.parse_args(argv)

    if not args.input and not args.from_json:
        ap.error("provide a C snippet file, '-', or --from-json FILE")

    try:
        if args.from_json:
            layouts = layouts_from_json(Path(args.from_json).read_text())
            in_name = Path(args.from_json).stem
        else:
            text = (sys.stdin.read() if args.input == "-"
                    else Path(args.input).read_text())
            layouts = compute_layouts(parse_snippet(text))
            in_name = "struct" if args.input == "-" else Path(args.input).stem
    except (SnippetError, ProbeError, FileNotFoundError, json.JSONDecodeError) as e:
        sys.exit(f"fieldday: {e}")

    if args.struct:
        layouts = [s for s in layouts if s.name == args.struct]
        if not layouts:
            sys.exit(f"fieldday: no struct named '{args.struct}' in input")

    if args.emit_json:
        print(layouts_to_json(layouts))
        return 0

    opts = RenderOptions(
        theme=load_theme(args.theme),
        title=args.title,
        transparent=args.transparent,
        ruler=not args.no_ruler,
        padding_callout=not args.no_padding_callout,
        px_per_byte=args.px_per_byte,
    )

    multi = len(layouts) > 1
    for sl in layouts:
        svg = render_struct(sl, opts)
        if args.output == "-":
            print(svg)
            continue
        if args.output and not multi:
            out = Path(args.output)
        else:
            base = Path(args.output).parent if args.output else \
                (Path(".") if args.input == "-" else Path(args.input).parent)
            out = base / (f"{in_name}_{sl.name}.svg" if multi else f"{in_name}.svg")
        out.write_text(svg)
        print(f"wrote {out} ({sl.name}: {sl.size}B, "
              f"{sl.padding_bytes}B padding)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
