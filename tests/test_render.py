"""Stage 2 tests: renderer geometry invariants.

Rather than pixel-matching, we parse the emitted SVG and assert invariants:
  - segments tile the bar exactly (no gaps/overlaps, full struct width)
  - callout labels never overlap horizontally
  - no two leader lines intersect or share a horizontal run
"""

import re

import pytest

from fieldday.cparse import parse_snippet
from fieldday.probe import compute_layouts
from fieldday.render import RenderOptions, render_struct


def render(snippet, **kw):
    sl = compute_layouts(parse_snippet(snippet))[0]
    return render_struct(sl, RenderOptions(**kw))


def rects(svg, cls):
    out = []
    for m in re.finditer(r'<rect class="(fd-field-box|fd-padding-box)" x="(-?[\d.]+)" y="(-?[\d.]+)" '
                         r'width="(-?[\d.]+)"', svg):
        if m.group(1) == cls or cls == "*":
            out.append((float(m.group(2)), float(m.group(4))))
    return out


def leader_segments(svg):
    """Extract leader polylines as lists of (x1,y1,x2,y2) segments."""
    segs = []
    for m in re.finditer(r'<path class="fd-leader-line" d="M (-?[\d.]+) (-?[\d.]+) '
                         r'V (-?[\d.]+) H (-?[\d.]+) V (-?[\d.]+)"', svg):
        x1, y1, ey, tx, by = map(float, m.groups())
        segs.append([(x1, y1, x1, ey), (x1, ey, tx, ey), (tx, ey, tx, by)])
    for m in re.finditer(r'<line class="fd-leader-line" x1="(-?[\d.]+)" y1="(-?[\d.]+)" '
                         r'x2="(-?[\d.]+)" y2="(-?[\d.]+)"', svg):
        x1, y1, x2, y2 = map(float, m.groups())
        segs.append([(x1, y1, x2, y2)])
    return segs


def callout_labels(svg):
    out = []
    for m in re.finditer(r'<text class="fd-callout-label" x="(-?[\d.]+)" y="(-?[\d.]+)" '
                         r'font-size="(\d+)"[^>]*>([^<]+)</text>', svg):
        x, y, size, text = float(m.group(1)), float(m.group(2)), int(m.group(3)), m.group(4)
        w = len(text) * size * 0.62
        out.append((x - w / 2, x + w / 2, text))
    return out


def _segs_intersect(a, b, eps=0.01):
    """Axis-aligned segment intersection (excluding shared endpoints)."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    a_vert, b_vert = abs(ax1 - ax2) < eps, abs(bx1 - bx2) < eps
    if a_vert == b_vert:  # parallel: check overlap on shared axis line
        if a_vert:
            if abs(ax1 - bx1) > eps:
                return False
            lo1, hi1 = sorted((ay1, ay2)); lo2, hi2 = sorted((by1, by2))
        else:
            if abs(ay1 - by1) > eps:
                return False
            lo1, hi1 = sorted((ax1, ax2)); lo2, hi2 = sorted((bx1, bx2))
        return hi1 - eps > lo2 and hi2 - eps > lo1
    if b_vert:
        a, b = b, a
        ax1, ay1, ax2, ay2 = a
        bx1, by1, bx2, by2 = b
    # a vertical, b horizontal
    lo, hi = sorted((ay1, ay2))
    xlo, xhi = sorted((bx1, bx2))
    return (xlo + eps < ax1 < xhi - eps) and (lo + eps < by1 < hi - eps)


NASTY_SNIPPETS = {
    "adjacent_bytes": """
        struct s { uint64_t a; uint8_t resp; uint8_t argc; uint8_t vers;
                   uint8_t mode; void *p; };
    """,
    "clustered_right": """
        struct s { uint64_t a; uint64_t b; uint64_t c;
                   uint8_t x; uint8_t y; uint8_t z; uint8_t w; };
    """,
    "clustered_left": """
        struct s { uint8_t x; uint8_t y; uint8_t z; uint8_t w;
                   uint64_t a; uint64_t b; uint64_t c; };
    """,
    "bitfield_swarm": """
        struct s { unsigned alpha : 3; unsigned beta : 2; unsigned gamma : 5;
                   unsigned delta : 6; uint64_t tail; };
    """,
    "two_runs": """
        struct s { uint8_t aa; uint8_t bb; uint64_t mid;
                   uint16_t cc; uint16_t dd; uint64_t end; };
    """,
}


class TestBarTiling:
    def test_segments_tile_bar(self):
        svg = render("struct s { char c; long l; short h; };", px_per_byte=10, margin=20)
        boxes = sorted(rects(svg, "*"))
        cursor = boxes[0][0]
        for x, w in boxes:
            assert abs(x - cursor) < 0.05, "gap or overlap in bar tiling"
            cursor = x + w
        assert abs(cursor - boxes[0][0] - 24 * 10) < 0.05  # struct is 24B


class TestCalloutGeometry:
    @pytest.mark.parametrize("name", list(NASTY_SNIPPETS))
    def test_labels_do_not_overlap(self, name):
        svg = render(NASTY_SNIPPETS[name])
        spans = sorted(callout_labels(svg))
        for (l1, r1, t1), (l2, r2, t2) in zip(spans, spans[1:]):
            assert r1 <= l2 + 0.05, f"labels '{t1}' and '{t2}' overlap"

    @pytest.mark.parametrize("name", list(NASTY_SNIPPETS))
    def test_labels_stay_on_canvas(self, name):
        # regression: re-centering once pushed edge runs to negative x
        svg = render(NASTY_SNIPPETS[name])
        for left, right, text in callout_labels(svg):
            assert left >= 0, f"label '{text}' pushed off-canvas (x={left})"

    @pytest.mark.parametrize("name", list(NASTY_SNIPPETS))
    def test_leaders_do_not_cross(self, name):
        svg = render(NASTY_SNIPPETS[name])
        leaders = leader_segments(svg)
        for i in range(len(leaders)):
            for j in range(i + 1, len(leaders)):
                for sa in leaders[i]:
                    for sb in leaders[j]:
                        assert not _segs_intersect(sa, sb), \
                            f"leader {i} crosses leader {j}: {sa} x {sb}"


class TestOptions:
    def test_transparent_skips_bg(self):
        svg = render("struct s { long a; };", transparent=True)
        assert 'class="fd-background"' not in svg

    def test_theme_override_baked(self):
        svg = render("struct s { long a; };", theme={"field-fill": "#123456"})
        assert "#123456" in svg

    def test_css_variables_present(self):
        svg = render("struct s { long a; };")
        assert "var(--fd-field-fill," in svg

    def test_padding_callout_opt_in(self):
        assert "bytes are padding" not in render("struct s { char c; long l; };")
        svg = render("struct s { char c; long l; };", padding_callout=True)
        assert "bytes are padding" in svg

    def test_no_padding_no_callout(self):
        svg = render("struct s { long a; long b; };", padding_callout=True)
        assert "padding" not in svg.split("</style>")[1]

    def test_cache_line_ticks(self):
        svg = render("struct s { char big[130]; };", px_per_byte=4)
        assert svg.count('class="fd-cache-line"') == 2  # ticks at 64 and 128
        assert 'class="fd-cache-line-label"' in svg
        svg0 = render("struct s { char big[130]; };", px_per_byte=4, cache_line=0)
        assert 'fd-cache-line' not in svg0.split("</style>")[1]


class TestAnnotations:
    def _layout(self, **kw):
        from fieldday.probe import StructLayout, FieldLayout
        sl = StructLayout(name="t", size=8, align=8, **kw)
        sl.fields.append(FieldLayout(name="a", type_str="long", offset=0, size=8))
        return sl

    def test_embedded_extra_renders_dashed(self):
        sl = self._layout(extras=[{"label": "elem (16B)", "bytes": 16, "kind": "embedded"}])
        svg = render_struct(sl, RenderOptions())
        assert 'class="fd-extra-box"' in svg and "elem (16B)" in svg

    def test_separate_extra_has_plus(self):
        sl = self._layout(extras=[{"label": "sds", "bytes": 16, "kind": "separate"}])
        svg = render_struct(sl, RenderOptions())
        assert 'class="fd-allocation-plus"' in svg

    def test_note_rendered_in_accent(self):
        sl = self._layout(note="51 bytes total")
        svg = render_struct(sl, RenderOptions())
        assert "51 bytes total" in svg

    def test_struct_title_used(self):
        sl = self._layout(title="My hand-written title")
        svg = render_struct(sl, RenderOptions())
        assert "My hand-written title" in svg

    def test_opts_title_overrides_struct_title(self):
        sl = self._layout(title="from json")
        svg = render_struct(sl, RenderOptions(title="from cli"))
        assert "from cli" in svg and "from json" not in svg

    def test_responsive_dims(self):
        sl = self._layout()
        svg = render_struct(sl, RenderOptions(responsive=True))
        assert "width:100%;max-width:" in svg and 'height="' not in svg.split(">")[0].replace("viewBox", "")

    def test_ruler_continues_over_embedded(self):
        # embedded extras are the same allocation: main ruler spans them
        sl = self._layout(extras=[{"label": "e", "bytes": 16, "kind": "embedded"}])
        svg = render_struct(sl, RenderOptions())
        rlbls = re.findall(r'class="fd-ruler-label"[^>]*>(\d+)<', svg)
        assert max(int(x) for x in rlbls) == 24  # 8B struct + 16B embedded

    def test_separate_extra_gets_own_ruler(self):
        # separate allocations restart their ruler at 0
        sl = self._layout(extras=[{"label": "s", "bytes": 16, "kind": "separate"}])
        svg = render_struct(sl, RenderOptions())
        rlbls = [int(x) for x in re.findall(r'class="fd-ruler-label"[^>]*>(\d+)<', svg)]
        assert max(rlbls) == 16          # separate ruler: 0..16
        assert rlbls.count(0) == 2       # two rulers, both starting at 0

    def test_extra_css_appended(self):
        sl = self._layout()
        svg = render_struct(sl, RenderOptions(extra_css=".fd-field-box { fill: pink; }"))
        assert ".fd-field-box { fill: pink; }" in svg

    def test_array_dividers_drawn(self):
        from fieldday.cparse import parse_snippet
        from fieldday.probe import compute_layouts
        sl = compute_layouts(parse_snippet("struct s { int x[5]; int tail; };"))[0]
        svg = render_struct(sl, RenderOptions())
        assert svg.count('class="fd-subdivision-line"') == 4  # 5 elements -> 4 dividers

    def test_relabel_and_hide(self):
        from fieldday.cparse import parse_snippet
        from fieldday.probe import compute_layouts
        sl = compute_layouts(parse_snippet(
            "struct s { long a; long b; unsigned f : 4; };"))[0]
        sl.relabel = {"a": "cool label", "b": "", "f": "flags!"}
        svg = render_struct(sl, RenderOptions())
        assert "cool label" in svg and "flags!" in svg
        assert ">b<" not in svg and ">f:4<" not in svg

    def test_embedded_after_separate_joins_that_allocation(self):
        # embedded | separate | embedded: the trailing embedded item belongs
        # to the separate allocation's ruler; rulers must not overlap
        sl = self._layout(extras=[
            {"label": "e1", "bytes": 5, "kind": "embedded"},
            {"label": "s1", "bytes": 5, "kind": "separate"},
            {"label": "e2", "bytes": 7, "kind": "embedded"},
        ])
        svg = render_struct(sl, RenderOptions())
        rlbls = [int(x) for x in re.findall(r'class="fd-ruler-label"[^>]*>(\d+)<', svg)]
        # alloc 0: struct 8B + e1 5B = 13; alloc 1: s1 5B + e2 7B = 12
        assert max(rlbls) == 13
        assert 12 in rlbls
        assert rlbls.count(0) == 2

    def test_pointer_arrow_rendered(self):
        sl = self._layout(extras=[{"label": "data", "bytes": 16, "kind": "embedded"}])
        sl.arrows = [{"from": "a", "to": "data"}]
        svg = render_struct(sl, RenderOptions())
        assert svg.count('class="fd-pointer-arrow"') == 1
        assert svg.count('class="fd-pointer-head"') == 1

    def test_pointer_arrow_bad_endpoint(self):
        sl = self._layout()
        sl.arrows = [{"from": "a", "to": "nope"}]
        import pytest as _pytest
        with _pytest.raises(ValueError, match="arrow endpoint"):
            render_struct(sl, RenderOptions())

    def test_note_plain_by_default(self):
        sl = self._layout(note="just an observation")
        svg = render_struct(sl, RenderOptions())
        assert 'class="fd-note-plain"' in svg
        assert "\u25bc just" not in svg

    def test_note_savings_style(self):
        sl = self._layout(note="8 bytes saved")
        sl.note_style = "savings"
        svg = render_struct(sl, RenderOptions())
        assert 'class="fd-note"' in svg and "\u25bc 8 bytes saved" in svg

    def test_extra_dividers_drawn(self):
        sl = self._layout(extras=[{"label": "sds", "bytes": 24, "kind": "embedded",
                                   "dividers": [3, 23]}])
        svg = render_struct(sl, RenderOptions())
        assert svg.count('class="fd-subdivision-line"') == 2

    def test_arrow_to_offset(self):
        sl = self._layout(extras=[{"label": "sds", "bytes": 24, "kind": "embedded"}])
        sl.arrows = [{"from": "a", "to": "sds", "to_offset": 3}]
        opts = RenderOptions()
        svg = render_struct(sl, opts)
        import re as _re
        head = _re.search(r'fd-pointer-head" points="[-\d.]+,[-\d.]+ [-\d.]+,[-\d.]+ ([-\d.]+),', svg)
        # extras start at struct end (8B); +3B offset at 15 px/byte, margin 24
        assert abs(float(head.group(1)) - (24 + (8 + 3) * 15)) < 0.11

    def test_jemalloc_size_class_table(self):
        # exhaustive against the authoritative table in valkey
        # deps/jemalloc/doc/jemalloc.xml (64-bit, quantum=16, 4KiB page)
        from fieldday.render import jemalloc_size_class
        classes = [8, 16, 32, 48, 64, 80, 96, 112, 128,
                   160, 192, 224, 256, 320, 384, 448, 512,
                   640, 768, 896, 1024, 1280, 1536, 1792, 2048,
                   2560, 3072, 3584, 4096]
        doc = lambda n: next(c for c in classes if n <= c)
        for n in range(1, 4097):
            assert jemalloc_size_class(n) == doc(n), n

    def test_jemalloc_slack_boxes(self):
        sl = self._layout()  # 8B struct: exact class, no slack
        svg = render_struct(sl, RenderOptions(jemalloc_slack=True))
        assert svg.split("</style>")[1].count("fd-slack-box") == 0
        sl = self._layout(extras=[{"label": "e", "bytes": 12, "kind": "embedded"}])
        svg = render_struct(sl, RenderOptions(jemalloc_slack=True))  # 20B -> 32B
        assert svg.split("</style>")[1].count("fd-slack-box") == 1
        assert "+12B (32B class)" in svg

    def test_jemalloc_slack_skips_fam(self):
        from fieldday.cparse import parse_snippet
        from fieldday.probe import compute_layouts
        sl = compute_layouts(parse_snippet(
            "struct s { long a; struct lv { long f; } lvl[]; };"))[0]
        svg = render_struct(sl, RenderOptions(jemalloc_slack=True))
        assert "fd-slack-box" not in svg.split("</style>")[1]

    def test_css_survives_var_unsupported_renderers(self):
        # macOS Preview / Inkscape drop var() declarations as invalid and
        # fall back to SVG's default black fill. Every var() declaration
        # must be immediately preceded by a baked declaration of the same
        # property so legacy renderers keep the theme color.
        import re as _re
        svg = render_struct(
            __import__("fieldday.probe", fromlist=["compute_layouts"]).compute_layouts(
                __import__("fieldday.cparse", fromlist=["parse_snippet"]).parse_snippet(
                    "struct s { long a; };"))[0], RenderOptions())
        style = svg.split("<style>")[1].split("</style>")[0]
        for m in _re.finditer(r"(fill|stroke|font-family): var\((--fd-[a-z-]+), ([^)]+)\)", style):
            prop, _, val = m.groups()
            assert f"{prop}: {val}; {prop}: var(" in style, \
                f"var() declaration for {prop} lacks a baked fallback: {m.group(0)}"
