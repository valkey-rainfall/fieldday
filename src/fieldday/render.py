"""SVG renderer: presentation-style proportional bar diagrams.

Renders StructLayout models as themeable SVG. Labels that don't fit their
box are hoisted into a callout band above the bar, decluttered so they never
overlap, re-centered per run, and connected with right-angle leader lines
whose elbows are staggered per run so no two leaders cross or share a line.

Theming: every element carries a CSS class and colors come from CSS custom
properties with baked-in fallbacks -- standalone SVGs render with the theme
defaults; inlined into a page, the page's --fd-* variables win.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .probe import StructLayout, FieldLayout

CHAR_W = 0.62  # monospace width/em estimate
SEP_GAP_BITS = 16  # visual gap (2 'bytes') before a separate allocation bar

# Default: light scheme matching the valkey.io blog (white bg, #002a3a
# headings, brand blues #6983ff/#30176e, gray surface #e2e8f0, Open Sans
# for prose, Fira Mono for code-ish labels).
DEFAULT_THEME = {
    "background": "#ffffff",
    "text": "#002a3a",
    "muted": "#666666",
    "field-fill": "#6983ff",
    "field-text": "#ffffff",
    "padding-fill": "#f5f7f7",
    "padding-stroke": "#b9c2cc",
    "field-border": "#30176e",
    "highlight": "#1e8e3e",
    "font": "'Fira Mono', Consolas, Menlo, Monaco, 'Courier New', monospace",
}


@dataclass
class RenderOptions:
    px_per_byte: float = 15.0
    bar_height: int = 56
    font_size: int = 15          # inline labels
    callout_font_size: int = 12
    ruler: bool = True           # byte ruler below the bar
    ruler_step: int = 8
    cache_line: int = 64          # heavy tick every N bytes (0 disables)
    padding_callout: bool = False  # opt-in "N of M bytes are padding" line
    title: str | None = None      # None = struct name
    show_bit_widths: bool = True  # ":12" suffix on bitfield labels
    theme: dict = field(default_factory=dict)
    transparent: bool = False     # skip background rect
    responsive: bool = False      # fluid width (100% up to natural size)
    extra_css: str = ""           # user CSS appended inside the <style> block
    corner_radius: int = 4
    margin: int = 24


# ---------------------------------------------------------------- segments

@dataclass
class Segment:
    """A renderable box: a field, a padding hole, or a bitfield group span."""
    label: str
    start_bits: int
    width_bits: int
    is_padding: bool = False
    is_bitfield: bool = False
    is_flex: bool = False
    is_extra: bool = False       # hand-annotated companion allocation
    extra_kind: str = "embedded"  # embedded (same alloc) | separate (own alloc)
    dividers_bits: tuple = ()     # light internal boundaries, relative bits

    @property
    def bytes_str(self) -> str:
        if self.width_bits % 8 == 0:
            return f"{self.width_bits // 8}B"
        return f"{self.width_bits}b"


def segments_from_layout(sl: StructLayout, opts: RenderOptions) -> list[Segment]:
    relabel = sl.relabel or {}
    segs: list[Segment] = []
    for f in sl.fields:
        # manual relabel: custom label used verbatim; '' hides the label
        custom = relabel.get(f.name) if not f.is_padding else None
        if f.bit_offset is not None:
            label = f.name
            if opts.show_bit_widths and f.bit_width:
                label = f"{f.name}:{f.bit_width}"
            if custom is not None:
                label = custom
            segs.append(Segment(label, f.bit_offset, f.bit_width or 0,
                                is_bitfield=True))
        elif f.size == 0 and not f.is_padding:
            # flexible array member: nominal 1-byte box dangling past the end
            label = f.name + "[]" if custom is None else custom
            segs.append(Segment(label, f.offset * 8, 8, is_flex=True))
        else:
            name = ("*" + f.name) if f.is_pointer and not f.name.startswith("*") else f.name
            if custom is not None:
                name = custom
            segs.append(Segment("padding-fill" if f.is_padding else name,
                                f.offset * 8, f.size * 8,
                                is_padding=f.is_padding,
                                dividers_bits=tuple(d * 8 for d in (f.dividers or ()))))
    # fill sub-byte gaps (bitfield allocation-unit padding) with hatched
    # padding at bit precision -- the layout model's pad fields are byte-
    # granular, so leftover bits after the last bitfield in a unit would
    # otherwise render as blank canvas
    segs.sort(key=lambda g: g.start_bits)
    filled: list[Segment] = []
    cursor_bits = 0
    for g in segs:
        if g.start_bits > cursor_bits:
            filled.append(Segment("", cursor_bits, g.start_bits - cursor_bits,
                                  is_padding=True))
        filled.append(g)
        cursor_bits = max(cursor_bits, g.start_bits + g.width_bits)
    if sl.size * 8 > cursor_bits:
        filled.append(Segment("", cursor_bits, sl.size * 8 - cursor_bits,
                              is_padding=True))
    segs = filled

    # hand-annotated companion allocations (from layout JSON)
    cursor = max([sl.size * 8] + [g.start_bits + g.width_bits for g in segs])
    for extra in sl.extras:
        kind = extra.get("kind", "embedded")
        width_bits = int(extra["bytes"]) * 8
        if kind == "separate":
            cursor += SEP_GAP_BITS  # visual gap; '+' drawn in the gap
        segs.append(Segment(extra["label"], cursor, width_bits,
                            is_extra=True, extra_kind=kind))
        cursor += width_bits
    return segs


# ---------------------------------------------------------------- callouts

@dataclass
class Callout:
    seg: Segment
    label_x: float   # text anchor center
    width: float     # text width px
    target_x: float  # segment center px
    elbow_y: float = 0.0


def _text_w(s: str, size: float) -> float:
    return len(s) * size * CHAR_W


def plan_labels(segs: list[Segment], opts: RenderOptions, x0: float):
    """Split segments into inline-labeled and callouts; declutter callouts."""
    ppb = opts.px_per_byte
    inline: list[tuple[Segment, str]] = []
    callouts: list[Callout] = []
    for seg in segs:
        w = seg.width_bits / 8 * ppb
        if seg.is_padding:
            # padding is self-identifying by hatch; label only when roomy
            inline.append((seg, "padding-fill" if _text_w("padding-fill", opts.font_size) + 8 <= w else ""))
            continue
        if not seg.label or _text_w(seg.label, opts.font_size) + 8 <= w:
            inline.append((seg, seg.label))
        else:
            cx = x0 + (seg.start_bits + seg.width_bits / 2) / 8 * ppb
            callouts.append(Callout(seg, cx, _text_w(seg.label, opts.callout_font_size), cx))

    # declutter: greedy left-to-right shift, then re-center each run
    gap = 10
    runs: list[list[Callout]] = []
    for c in callouts:
        if runs and c.label_x - c.width / 2 < runs[-1][-1].label_x + runs[-1][-1].width / 2 + gap:
            c.label_x = runs[-1][-1].label_x + runs[-1][-1].width / 2 + gap + c.width / 2
            runs[-1].append(c)
        else:
            runs.append([c])
    for run in runs:
        if len(run) > 1:
            # shift the whole run left so labels straddle their targets
            drift = sum(c.label_x - c.target_x for c in run) / len(run)
            for c in run:
                c.label_x -= drift

    # clamp runs onto the canvas (re-centering can push edge runs off) and
    # restore inter-run ordering with a forward pass
    prev_end = x0
    for run in runs:
        left = run[0].label_x - run[0].width / 2
        need = max(x0, prev_end + (gap if prev_end > x0 else 0))
        if left < need:
            shift = need - left
            for c in run:
                c.label_x += shift
        prev_end = run[-1].label_x + run[-1].width / 2
    return inline, callouts, runs


def assign_elbows(runs: list[list[Callout]], bar_top: float, step: float = 8.0) -> float:
    """Stagger elbow heights per run; rightward labels get lower elbows so
    leaders never cross. Returns min elbow y (for band height calc)."""
    min_y = bar_top
    for run in runs:
        joggers = [c for c in run if abs(c.label_x - c.target_x) > 0.5]
        for level, c in enumerate(joggers):
            c.elbow_y = (bar_top - 8) - (len(joggers) - 1 - level) * step
            min_y = min(min_y, c.elbow_y)
    return min_y


# ---------------------------------------------------------------- svg emit

def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _style_block(theme: dict, extra_css: str = "") -> str:
    t = {**DEFAULT_THEME, **theme}
    tail = ("\n" + extra_css.strip()) if extra_css.strip() else ""
    return f"""<style>
  .fd-background      {{ fill: var(--fd-background, {t['background']}); }}
  .fd-title   {{ fill: var(--fd-text, {t['text']}); }}
  .fd-field-box   {{ fill: var(--fd-field-fill, {t['field-fill']}); stroke: var(--fd-field-border, {t['field-border']}); stroke-width: 1; }}
  .fd-padding-box     {{ fill: url(#fd-hatch); stroke: var(--fd-padding-stroke, {t['padding-stroke']}); stroke-width: 1; }}
  .fd-flexible-array    {{ fill: none; stroke: var(--fd-muted, {t['muted']}); stroke-width: 1; stroke-dasharray: 4 3; }}
  .fd-extra-box   {{ fill: var(--fd-field-fill, {t['field-fill']}); fill-opacity: 0.55; stroke: var(--fd-field-border, {t['field-border']}); stroke-width: 1; stroke-dasharray: 5 3; }}
  .fd-allocation-plus    {{ fill: var(--fd-muted, {t['muted']}); }}
  .fd-field-label   {{ fill: var(--fd-field-text, {t['field-text']}); }}
  .fd-padding-label  {{ fill: var(--fd-muted, {t['muted']}); }}
  .fd-callout-label {{ fill: var(--fd-text, {t['text']}); }}
  .fd-leader-line  {{ stroke: var(--fd-muted, {t['muted']}); stroke-width: 1; fill: none; }}
  .fd-ruler-line   {{ stroke: var(--fd-muted, {t['muted']}); stroke-width: 1; }}
  .fd-cache-line   {{ stroke: var(--fd-text, {t['text']}); stroke-width: 3; stroke-dasharray: 7 4; opacity: 0.8; }}
  .fd-cache-line-label    {{ fill: var(--fd-text, {t['text']}); }}
  .fd-pointer-arrow  {{ stroke: var(--fd-text, {t['text']}); stroke-width: 1.5; fill: none; }}
  .fd-pointer-head   {{ fill: var(--fd-text, {t['text']}); }}
  .fd-ruler-label    {{ fill: var(--fd-muted, {t['muted']}); }}
  .fd-note  {{ fill: var(--fd-highlight, {t['highlight']}); }}
  text        {{ font-family: var(--fd-font, {t['font']}); }}
  .fd-hatch-background {{ fill: var(--fd-padding-fill, {t['padding-fill']}); }}
  .fd-hatch-lines {{ stroke: var(--fd-padding-stroke, {t['padding-stroke']}); stroke-width: 1.5; }}
  .fd-subdivision-line  {{ stroke: var(--fd-field-text, {t['field-text']}); stroke-width: 1; stroke-dasharray: 2 3; opacity: 0.45; }}{tail}
</style>"""


HATCH = ('<defs><pattern id="fd-hatch" width="6" height="6" '
         'patternTransform="rotate(45)" patternUnits="userSpaceOnUse">'
         '<rect class="fd-hatch-background" width="6" height="6"/>'
         '<line class="fd-hatch-lines" x1="0" y1="0" x2="0" y2="6"/></pattern></defs>')


def _text(x, y, s, size, cls, anchor="middle", weight="600"):
    return (f'<text class="{cls}" x="{x:.1f}" y="{y:.1f}" font-size="{size}" '
            f'font-weight="{weight}" text-anchor="{anchor}">{_esc(s)}</text>')


def render_struct(sl: StructLayout, opts: RenderOptions | None = None) -> str:
    opts = opts or RenderOptions()
    ppb = opts.px_per_byte
    m = opts.margin
    x0 = m
    segs = segments_from_layout(sl, opts)
    end_bits = max([sl.size * 8] + [g.start_bits + g.width_bits for g in segs])
    total_px = end_bits / 8 * ppb

    inline, callouts, runs = plan_labels(segs, opts, x0)

    # vertical budget
    title = opts.title if opts.title is not None else \
        (sl.title or f"struct {sl.name}")
    cy = m + 4
    parts: list[str] = []
    if title:
        parts.append(_text(x0, cy + 10, title, 15, "fd-title", "start", "700"))
        cy += 30
    callout_y = 0.0
    if callouts:
        callout_y = cy + opts.callout_font_size
        cy = callout_y + 14 + 8 * max((len([c for c in run if abs(c.label_x - c.target_x) > 0.5])
                                       for run in runs), default=0)
    bar_top = cy
    assign_elbows(runs, bar_top)

    # group segments into allocations: the struct plus its embedded
    # extras form allocation 0; each separate extra starts a new
    # allocation that includes any embedded extras following it
    allocs = []
    _cur_start, _cur_end = 0, sl.size * 8
    for g in segs:
        if g.is_extra and g.extra_kind == "separate":
            allocs.append((_cur_start, _cur_end))
            _cur_start = g.start_bits
            _cur_end = g.start_bits + g.width_bits
        else:
            _cur_end = max(_cur_end, g.start_bits + g.width_bits)
    allocs.append((_cur_start, _cur_end))

    # bar segments
    for seg in segs:
        x = x0 + seg.start_bits / 8 * ppb
        w = seg.width_bits / 8 * ppb
        if seg.is_padding:
            cls = "fd-padding-box"
        elif seg.is_flex:
            cls = "fd-flexible-array"
        elif seg.is_extra:
            cls = "fd-extra-box"
            if seg.extra_kind == "separate":
                gap_px = SEP_GAP_BITS / 8 * ppb
                parts.append(_text(x - gap_px / 2, bar_top + opts.bar_height / 2 + 5,
                                   "+", 17, "fd-allocation-plus", weight="700"))
        else:
            cls = "fd-field-box"
        parts.append(f'<rect class="{cls}" x="{x:.1f}" y="{bar_top:.1f}" '
                     f'width="{w:.1f}" height="{opts.bar_height}" rx="{opts.corner_radius}"/>')
        for db in seg.dividers_bits:
            dx = x + db / 8 * ppb
            parts.append(f'<line class="fd-subdivision-line" x1="{dx:.1f}" y1="{bar_top + 3:.1f}" '
                         f'x2="{dx:.1f}" y2="{bar_top + opts.bar_height - 3:.1f}"/>')
    # cache-line boundaries: bold dashed rules cutting through the bar
    # (and down to the ruler when present), per allocation
    if opts.cache_line:
        rule_bottom = bar_top + opts.bar_height + (8 + 9 if opts.ruler else 0)
        for a_start, a_end in allocs:
            n_bytes = (a_end - a_start) // 8
            b = opts.cache_line
            while b <= n_bytes:
                x = x0 + a_start / 8 * ppb + b * ppb
                parts.append(f'<line class="fd-cache-line" x1="{x:.1f}" y1="{bar_top - 4:.1f}" '
                             f'x2="{x:.1f}" y2="{rule_bottom:.1f}"/>')
                b += opts.cache_line

    for seg, txt in inline:
        if not txt:
            continue
        x = x0 + (seg.start_bits + seg.width_bits / 2) / 8 * ppb
        cls = "fd-padding-label" if seg.is_padding else ("fd-callout-label" if seg.is_extra else "fd-field-label")
        parts.append(_text(x, bar_top + opts.bar_height / 2 + 5, txt,
                           opts.font_size, cls, weight="700"))

    # callouts + leaders
    for c in callouts:
        parts.append(_text(c.label_x, callout_y, c.seg.label,
                           opts.callout_font_size, "fd-callout-label"))
        top = callout_y + 4
        if c.elbow_y > 0:
            parts.append(f'<path class="fd-leader-line" d="M {c.label_x:.1f} {top:.1f} '
                         f'V {c.elbow_y:.1f} H {c.target_x:.1f} V {bar_top - 1:.1f}"/>')
        else:
            parts.append(f'<line class="fd-leader-line" x1="{c.label_x:.1f}" y1="{top:.1f}" '
                         f'x2="{c.label_x:.1f}" y2="{bar_top - 1:.1f}"/>')

    cy = bar_top + opts.bar_height

    # byte rulers: the main allocation ruler continues across embedded
    # extras (same allocation); each separate extra gets its own ruler
    # restarting at 0 (it is its own allocation).
    if opts.ruler:
        ry = cy + 8

        def draw_ruler(start_bits, end_bits, label_base):
            rx1 = x0 + start_bits / 8 * ppb
            rx2 = x0 + end_bits / 8 * ppb
            n_bytes = (end_bits - start_bits) // 8
            parts.append(f'<line class="fd-ruler-line" x1="{rx1:.1f}" y1="{ry}" x2="{rx2:.1f}" y2="{ry}"/>')

            def tick(b, cls, tlen, lblcls, weight):
                x = rx1 + b * ppb
                parts.append(f'<line class="{cls}" x1="{x:.1f}" y1="{ry}" x2="{x:.1f}" y2="{ry + tlen}"/>')
                parts.append(_text(x, ry + 20, str(label_base + b), 11, lblcls,
                                   weight=weight))

            cl = opts.cache_line
            b = 0
            while b <= n_bytes:
                if not (cl and b and b % cl == 0):
                    tick(b, "fd-ruler-line", 6, "fd-ruler-label", "600")
                b += opts.ruler_step
            if n_bytes % opts.ruler_step != 0 and not (cl and n_bytes % cl == 0):
                tick(n_bytes, "fd-ruler-line", 6, "fd-ruler-label", "600")
            # cache-line boundaries: bold label; the rule itself is the
            # full-height overlay drawn through the bar
            if cl:
                b = cl
                while b <= n_bytes:
                    x = rx1 + b * ppb
                    parts.append(_text(x, ry + 20, str(label_base + b), 12,
                                       "fd-cache-line-label", weight="700"))
                    b += cl

        for a_start, a_end in allocs:
            draw_ruler(a_start, a_end, 0)
        cy = ry + 26

    # pointer arrows: from a member's box down below the ruler, across,
    # and up into the start of the target member/extra (arrowhead up)
    if sl.arrows:
        centers = {}
        starts = {}
        for f in sl.fields:
            if not f.is_padding:
                centers[f.name] = x0 + (f.offset + max(f.size, 1) / 2) * ppb
        for g in segs:
            if g.is_extra:
                centers[g.label] = x0 + (g.start_bits + g.width_bits / 2) / 8 * ppb
                starts[g.label] = x0 + g.start_bits / 8 * ppb
            elif not g.is_padding:
                base = g.label.lstrip("*").split(":")[0].rstrip("[]")
                starts.setdefault(base, x0 + g.start_bits / 8 * ppb)
        bar_bottom = bar_top + opts.bar_height
        lane0 = cy + 10
        for i, arrow in enumerate(sl.arrows):
            src, dst = arrow.get("from"), arrow.get("to")
            fx = centers.get(src)
            tx = starts.get(dst, centers.get(dst))
            if fx is None or tx is None:
                raise ValueError(
                    f"arrow endpoint not found: {src!r} -> {dst!r} "
                    f"(use a member name or an extra's label)")
            if dst in starts:
                tx += 5  # point at the start of the target, slightly inset
            lane = lane0 + i * 13
            parts.append(
                f'<path class="fd-pointer-arrow" d="M {fx:.1f} {bar_bottom + 2:.1f} '
                f'V {lane:.1f} H {tx:.1f} V {bar_bottom + 8:.1f}"/>')
            parts.append(
                f'<polygon class="fd-pointer-head" points="'
                f'{tx - 4:.1f},{bar_bottom + 8:.1f} {tx + 4:.1f},{bar_bottom + 8:.1f} '
                f'{tx:.1f},{bar_bottom + 1:.1f}"/>')
        cy = lane0 + (len(sl.arrows) - 1) * 13 + 8

    # padding callout
    pad_b = sl.padding_bytes
    if opts.padding_callout and pad_b:
        cy += 18
        pct = round(pad_b * 100 / sl.size)
        parts.append(_text(x0, cy, f"\u25bc {pad_b} of {sl.size} bytes are padding ({pct}%)",
                           13, "fd-note", "start", "700"))

    # hand-annotated note (savings line etc.)
    if sl.note:
        cy += 18
        parts.append(_text(x0, cy, f"\u25bc {sl.note}", 13, "fd-note", "start", "700"))

    # canvas must fit callout labels and title, not just the bar
    content_right = x0 + total_px
    for c in callouts:
        content_right = max(content_right, c.label_x + c.width / 2)
    if title:
        content_right = max(content_right, x0 + _text_w(title, 15))
    width = int(content_right + m)
    height = int(cy + m / 2)
    bg = "" if opts.transparent else f'<rect class="fd-background" width="100%" height="100%" rx="8"/>\n'
    if opts.responsive:
        dims = f'style="width:100%;max-width:{width}px;height:auto"'
    else:
        dims = f'width="{width}" height="{height}"'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
            f'{dims}>\n{_style_block(opts.theme, opts.extra_css)}\n'
            f'{bg}{HATCH}\n' + "\n".join(parts) + "\n</svg>")


def render_to_file(sl: StructLayout, path: str | Path,
                   opts: RenderOptions | None = None) -> Path:
    p = Path(path)
    p.write_text(render_struct(sl, opts))
    return p
