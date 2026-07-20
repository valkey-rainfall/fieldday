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

DEFAULT_THEME = {
    "bg": "#1a1a2e",
    "text": "#e0e0e0",
    "muted": "#8a8a9a",
    "field": "#7fb3e0",
    "field-text": "#16213e",
    "pad": "#2a2a3e",
    "pad-stroke": "#555568",
    "border": "#444444",
    "accent": "#e0b97f",
    "font": "ui-monospace, SFMono-Regular, 'Cascadia Code', monospace",
}


@dataclass
class RenderOptions:
    px_per_byte: float = 15.0
    bar_height: int = 56
    font_size: int = 15          # inline labels
    callout_font_size: int = 12
    ruler: bool = True           # byte ruler below the bar
    ruler_step: int = 8
    padding_callout: bool = True  # "N of M bytes are padding" line
    title: str | None = None      # None = struct name
    show_bit_widths: bool = True  # ":12" suffix on bitfield labels
    theme: dict = field(default_factory=dict)
    transparent: bool = False     # skip background rect
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

    @property
    def bytes_str(self) -> str:
        if self.width_bits % 8 == 0:
            return f"{self.width_bits // 8}B"
        return f"{self.width_bits}b"


def segments_from_layout(sl: StructLayout, opts: RenderOptions) -> list[Segment]:
    segs: list[Segment] = []
    for f in sl.fields:
        if f.bit_offset is not None:
            label = f.name
            if opts.show_bit_widths and f.bit_width:
                label = f"{f.name}:{f.bit_width}"
            segs.append(Segment(label, f.bit_offset, f.bit_width or 0,
                                is_bitfield=True))
        else:
            name = ("*" + f.name) if f.is_pointer and not f.name.startswith("*") else f.name
            segs.append(Segment("pad" if f.is_padding else name,
                                f.offset * 8, f.size * 8,
                                is_padding=f.is_padding))
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
            inline.append((seg, "pad" if _text_w("pad", opts.font_size) + 8 <= w else ""))
            continue
        if _text_w(seg.label, opts.font_size) + 8 <= w:
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


def _style_block(theme: dict) -> str:
    t = {**DEFAULT_THEME, **theme}
    return f"""<style>
  .fd-bg      {{ fill: var(--fd-bg, {t['bg']}); }}
  .fd-title   {{ fill: var(--fd-text, {t['text']}); }}
  .fd-field   {{ fill: var(--fd-field, {t['field']}); stroke: var(--fd-border, {t['border']}); stroke-width: 1; }}
  .fd-pad     {{ fill: url(#fd-hatch); stroke: var(--fd-pad-stroke, {t['pad-stroke']}); stroke-width: 1; }}
  .fd-label   {{ fill: var(--fd-field-text, {t['field-text']}); }}
  .fd-padlbl  {{ fill: var(--fd-muted, {t['muted']}); }}
  .fd-callout {{ fill: var(--fd-text, {t['text']}); }}
  .fd-leader  {{ stroke: var(--fd-muted, {t['muted']}); stroke-width: 1; fill: none; }}
  .fd-ruler   {{ stroke: var(--fd-muted, {t['muted']}); stroke-width: 1; }}
  .fd-rlbl    {{ fill: var(--fd-muted, {t['muted']}); }}
  .fd-accent  {{ fill: var(--fd-accent, {t['accent']}); }}
  text        {{ font-family: var(--fd-font, {t['font']}); }}
  .fd-hatchbg {{ fill: var(--fd-pad, {t['pad']}); }}
  .fd-hatchln {{ stroke: var(--fd-pad-stroke, {t['pad-stroke']}); stroke-width: 1.5; }}
</style>"""


HATCH = ('<defs><pattern id="fd-hatch" width="6" height="6" '
         'patternTransform="rotate(45)" patternUnits="userSpaceOnUse">'
         '<rect class="fd-hatchbg" width="6" height="6"/>'
         '<line class="fd-hatchln" x1="0" y1="0" x2="0" y2="6"/></pattern></defs>')


def _text(x, y, s, size, cls, anchor="middle", weight="600"):
    return (f'<text class="{cls}" x="{x:.1f}" y="{y:.1f}" font-size="{size}" '
            f'font-weight="{weight}" text-anchor="{anchor}">{_esc(s)}</text>')


def render_struct(sl: StructLayout, opts: RenderOptions | None = None) -> str:
    opts = opts or RenderOptions()
    ppb = opts.px_per_byte
    m = opts.margin
    x0 = m
    total_px = sl.size * ppb
    segs = segments_from_layout(sl, opts)

    inline, callouts, runs = plan_labels(segs, opts, x0)

    # vertical budget
    title = opts.title if opts.title is not None else f"struct {sl.name}"
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

    # bar segments
    for seg in segs:
        x = x0 + seg.start_bits / 8 * ppb
        w = seg.width_bits / 8 * ppb
        cls = "fd-pad" if seg.is_padding else "fd-field"
        parts.append(f'<rect class="{cls}" x="{x:.1f}" y="{bar_top:.1f}" '
                     f'width="{w:.1f}" height="{opts.bar_height}" rx="{opts.corner_radius}"/>')
    for seg, txt in inline:
        if not txt:
            continue
        x = x0 + (seg.start_bits + seg.width_bits / 2) / 8 * ppb
        cls = "fd-padlbl" if seg.is_padding else "fd-label"
        parts.append(_text(x, bar_top + opts.bar_height / 2 + 5, txt,
                           opts.font_size, cls, weight="700"))

    # callouts + leaders
    for c in callouts:
        parts.append(_text(c.label_x, callout_y, c.seg.label,
                           opts.callout_font_size, "fd-callout"))
        top = callout_y + 4
        if c.elbow_y > 0:
            parts.append(f'<path class="fd-leader" d="M {c.label_x:.1f} {top:.1f} '
                         f'V {c.elbow_y:.1f} H {c.target_x:.1f} V {bar_top - 1:.1f}"/>')
        else:
            parts.append(f'<line class="fd-leader" x1="{c.label_x:.1f}" y1="{top:.1f}" '
                         f'x2="{c.label_x:.1f}" y2="{bar_top - 1:.1f}"/>')

    cy = bar_top + opts.bar_height

    # byte ruler
    if opts.ruler:
        ry = cy + 8
        parts.append(f'<line class="fd-ruler" x1="{x0}" y1="{ry}" x2="{x0 + total_px:.1f}" y2="{ry}"/>')
        b = 0
        while b <= sl.size:
            x = x0 + b * ppb
            parts.append(f'<line class="fd-ruler" x1="{x:.1f}" y1="{ry}" x2="{x:.1f}" y2="{ry + 6}"/>')
            parts.append(_text(x, ry + 20, str(b), 11, "fd-rlbl"))
            b += opts.ruler_step
        if (sl.size % opts.ruler_step) != 0:
            x = x0 + sl.size * ppb
            parts.append(f'<line class="fd-ruler" x1="{x:.1f}" y1="{ry}" x2="{x:.1f}" y2="{ry + 6}"/>')
            parts.append(_text(x, ry + 20, str(sl.size), 11, "fd-rlbl"))
        cy = ry + 26

    # padding callout
    pad_b = sl.padding_bytes
    if opts.padding_callout and pad_b:
        cy += 18
        pct = round(pad_b * 100 / sl.size)
        parts.append(_text(x0, cy, f"\u25bc {pad_b} of {sl.size} bytes are padding ({pct}%)",
                           13, "fd-accent", "start", "700"))

    width = int(2 * m + total_px)
    height = int(cy + m / 2)
    bg = "" if opts.transparent else f'<rect class="fd-bg" width="100%" height="100%" rx="8"/>\n'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
            f'width="{width}" height="{height}">\n{_style_block(opts.theme)}\n'
            f'{bg}{HATCH}\n' + "\n".join(parts) + "\n</svg>")


def render_to_file(sl: StructLayout, path: str | Path,
                   opts: RenderOptions | None = None) -> Path:
    p = Path(path)
    p.write_text(render_struct(sl, opts))
    return p
