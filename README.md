# fieldday

Generate presentation-quality SVG diagrams of C struct memory layouts —
fields drawn proportionally to their size, padding holes made visible,
bitfields included, colors themeable for blog posts and slide decks.

```
fieldday struct.c -o diagram.svg
```

Layout data (offsets, sizes, padding, bitfield placement) is computed by
**compiling and running a probe program with your system C compiler** — not
by reimplementing ABI rules — so the diagram shows exactly what the compiler
does. Requires any C compiler (`cc`, `gcc`, or `clang`) on PATH. Layouts
reflect the host ABI (x86-64 SysV on a typical Linux box).

## Install

```
pip install -e .          # from a clone; installs the `fieldday` command
```

Python >= 3.9, `pycparser`, and a C compiler.

## Usage

Input is a C snippet containing one or more struct definitions:

```c
/* client.c */
struct client {
    uint64_t id;
    int fd;
    uint8_t resp;
    sds name;              /* unknown types: see stubs below */
    unsigned flags : 12;   /* bitfields supported */
    void *conn;
};
```

```
fieldday client.c                     # writes client.svg next to the input
fieldday client.c -o out.svg          # explicit output path
cat client.c | fieldday - -o out.svg  # read from stdin
fieldday client.c --struct client     # pick one struct when a snippet has several
```

Common presentation flags:

```
fieldday client.c --theme light --transparent --title "struct client (Valkey 9.1)"
fieldday client.c --no-ruler --no-padding-callout --px-per-byte 20
```

Run `fieldday --help` for the full flag list.

## Unknown types (stubs)

The snippet doesn't need headers. Unknown type names resolve in order:

1. **Builtin stubs** — fixed-width ints (`uint32_t`, ...), `size_t`, `sds`,
   `time_t`, `bool`, and other common names are known already.
2. **Same-snippet structs** — a struct defined earlier in the snippet can be
   used as a field type (embedded or via pointer).
3. **Stub directives** — declare anything else with a comment line:

```c
//@ stub robj 16 8        <- name, size in bytes, optional alignment
struct entry { robj *obj; robj embedded; };
```

If a type can't be resolved, fieldday exits with an error naming it and
showing the directive to add.

## Hand-tweak workflow (JSON)

For diagrams that need manual edits (renaming, merging fields, marking a
field as removed-in-next-version), export the layout, edit it, re-render:

```
fieldday client.c --emit-json > layout.json
$EDITOR layout.json
fieldday --from-json layout.json -o final.svg
```

The JSON schema mirrors what you see: per-struct `name`/`size`/`align` and a
`fields` array with `name`, `offset`, `size`, optional `bit_offset`/
`bit_width`, `is_padding`, `is_pointer`.

## Theming

Builtin themes: `dark` (default), `light`. Custom theme = JSON file with any
subset of these keys:

```json
{ "bg": "#ffffff", "text": "#1a1a2e", "muted": "#667788",
  "field": "#4a90c2", "field-text": "#ffffff",
  "pad": "#eceef2", "pad-stroke": "#b8bcc8",
  "border": "#99aabb", "accent": "#b8860b",
  "font": "ui-monospace, monospace" }
```

Every color in the SVG also resolves through a CSS custom property
(`--fd-bg`, `--fd-field`, `--fd-accent`, ...) with the theme value as
fallback. **Inline the SVG into a blog page and define `--fd-*` variables
in the page's CSS** — the diagram follows the page theme, including dark/
light mode switches, with no re-render. `--transparent` omits the background
rect so the page background shows through.

## What the diagram shows

- One box per field, width proportional to size; byte ruler underneath
- Padding holes as hatched boxes, plus a "N of M bytes are padding" callout
- Bitfields as sub-byte boxes labeled `name:width`
- Pointer fields prefixed `*`
- Labels that don't fit their box are hoisted above the bar with
  right-angle leader lines (collision-free, never crossing)

## Development

```
python3 -m venv .venv && .venv/bin/pip install -e .[dev]
.venv/bin/pytest
```

Tests assert layout correctness against the compiler and geometric
invariants of the SVG (bar tiling, label overlap, leader crossings).
