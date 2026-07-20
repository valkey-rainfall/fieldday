"""Stage 1 tests: parser + compiler-probe layout oracle (x86-64 SysV)."""

import pytest

from fieldday.cparse import parse_snippet, SnippetError
from fieldday.probe import compute_layouts


def layout_of(snippet, name=None):
    layouts = compute_layouts(parse_snippet(snippet))
    if name is None:
        return layouts[0]
    return next(s for s in layouts if s.name == name)


def field(sl, name):
    return next(f for f in sl.fields if f.name == name and not f.is_padding)


def pads(sl):
    return [(f.offset, f.size) for f in sl.fields if f.is_padding]


class TestBasicLayout:
    def test_simple_no_padding(self):
        sl = layout_of("struct p { long a; long b; };")
        assert sl.size == 16 and sl.padding_bytes == 0
        assert field(sl, "a").offset == 0
        assert field(sl, "b").offset == 8

    def test_interior_and_tail_padding(self):
        sl = layout_of("struct p { char c; long l; short s; };")
        assert sl.size == 24
        assert pads(sl) == [(1, 7), (18, 6)]

    def test_pointer_flag(self):
        sl = layout_of("struct p { void *ptr; int x; };")
        assert field(sl, "ptr").is_pointer
        assert not field(sl, "x").is_pointer

    def test_array_field(self):
        sl = layout_of("struct p { char buf[13]; long l; };")
        assert field(sl, "buf").size == 13
        assert pads(sl) == [(13, 3)]


class TestStubs:
    def test_builtin_stub_alignment(self):
        # sds is a pointer typedef: 8B size AND 8B alignment
        sl = layout_of("struct p { char c; sds s; };")
        assert field(sl, "s").offset == 8
        assert sl.size == 16

    def test_user_stub_directive(self):
        sl = layout_of("""
            //@ stub mytype 12 4
            struct p { char c; mytype m; };
        """)
        assert field(sl, "m").offset == 4
        assert field(sl, "m").size == 12

    def test_unknown_type_error(self):
        with pytest.raises(SnippetError, match="Unknown type 'wat'"):
            parse_snippet("struct p { wat w; };")


class TestBitfields:
    def test_bitfield_packing(self):
        sl = layout_of("struct p { unsigned a : 12; unsigned b : 1; unsigned c : 19; };")
        assert sl.size == 4
        a, b, c = field(sl, "a"), field(sl, "b"), field(sl, "c")
        assert (a.bit_offset, a.bit_width) == (0, 12)
        assert (b.bit_offset, b.bit_width) == (12, 1)
        assert (c.bit_offset, c.bit_width) == (13, 19)

    def test_bitfield_after_bytes(self):
        sl = layout_of("struct p { uint8_t t; unsigned f : 4; };")
        f = field(sl, "f")
        assert f.bit_offset is not None and f.bit_width == 4


class TestMultiStruct:
    def test_nested_struct_ref(self):
        sl = layout_of("""
            struct inner { long a; long b; };
            struct outer { int x; struct inner in; };
        """, "outer")
        assert sl.size == 24
        f = field(sl, "in")
        assert f.struct_ref == "inner" and f.offset == 8 and f.size == 16

    def test_typedef_struct(self):
        sl = layout_of("typedef struct { int a; char b; } tiny;", "tiny")
        assert sl.size == 8 and pads(sl) == [(5, 3)]

    def test_comments_stripped(self):
        sl = layout_of("""
            struct p {
                long a;   /* block comment */
                long b;   // line comment
            };
        """)
        assert sl.size == 16


class TestFlexibleArrayMember:
    def test_fam_offset_and_zero_size(self):
        sl = layout_of("""
            typedef struct node {
                sds ele;
                double score;
                struct node *backward;
                struct level { struct node *fwd; unsigned long span; } lvl[];
            } node;
        """, "node")
        assert sl.size == 24
        f = field(sl, "lvl")
        assert f.offset == 24 and f.size == 0
