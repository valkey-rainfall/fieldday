#!/usr/bin/env python3
"""Generate golden layout vectors for cross-validating the JS layout engine.

Runs the Python parse+probe pipeline (where the system C compiler is the
layout oracle) over a corpus of snippets and writes tests/vectors.json.
The web app's JS layout engine must reproduce every vector exactly --
tests/js/run_vectors.mjs (Stage 2) asserts this, and CI regenerates the
vectors to catch drift between the reference implementation and the web.

Usage: .venv/bin/python tools/gen_vectors.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from fieldday.cparse import parse_snippet  # noqa: E402
from fieldday.probe import compute_layouts  # noqa: E402

# name -> C snippet. Mirrors the pytest layout cases plus the Valkey blog
# structs. Every construct the web engine claims to support needs a vector.
CORPUS = {
    "simple_no_padding": "struct p { long a; long b; };",
    "interior_and_tail_padding": "struct p { char c; long l; short s; };",
    "pointer_fields": "struct p { void *ptr; int x; };",
    "char_array": "struct p { char buf[13]; long l; };",
    "multidim_sizes": "struct p { int a[4]; short b[3]; };",
    "builtin_stub_alignment": "struct p { char c; sds s; };",
    "user_stub": "//@ stub mytype 12 4\nstruct p { char c; mytype m; };",
    "bitfield_packing": "struct p { unsigned a : 12; unsigned b : 1; unsigned c : 19; };",
    "bitfield_overflow_unit": "struct p { unsigned a : 30; unsigned b : 10; };",
    "bitfield_after_bytes": "struct p { uint8_t t; unsigned f : 4; };",
    "bitfield_then_bytes": "struct p { unsigned f : 4; uint8_t t; };",
    "nested_struct": """
        struct inner { long a; long b; };
        struct outer { int x; struct inner in; };
    """,
    "typedef_struct": "typedef struct { int a; char b; } tiny;",
    "flexible_array_member": """
        typedef struct node {
            sds ele;
            double score;
            struct node *backward;
            struct level { struct node *fwd; unsigned long span; } lvl[];
        } node;
    """,
    "small_types_cluster": """
        struct s { uint64_t a; uint8_t resp; uint8_t argc; uint8_t vers;
                   uint8_t mode; void *p; };
    """,
    "valkey_robj_90": """
        struct robj_90 {
            unsigned type : 4;
            unsigned encoding : 4;
            unsigned lru : 24;
            int refcount;
            void *ptr;
        };
    """,
    "valkey_robj_91": """
        struct robj_91 {
            unsigned type : 4;
            unsigned encoding : 4;
            unsigned lru : 24;
            unsigned hasexpire : 1;
            unsigned hasembkey : 1;
            unsigned hasembval : 1;
            unsigned refcount : 29;
            void *val_ptr;
        };
    """,
    "valkey_zskiplistnode": """
        typedef struct zskiplistNode {
            sds ele;
            double score;
            struct zskiplistNode *backward;
            struct zskiplistLevel {
                struct zskiplistNode *forward;
                unsigned long span;
            } level[];
        } zskiplistNode;
    """,
}


def field_dict(f):
    d = {"name": f.name, "offset": f.offset, "size": f.size}
    if f.is_pointer:
        d["is_pointer"] = True
    if f.is_padding:
        d["is_padding"] = True
    if f.bit_offset is not None:
        d["bit_offset"] = f.bit_offset
        d["bit_width"] = f.bit_width
    if f.struct_ref:
        d["struct_ref"] = f.struct_ref
    return d


def main() -> int:
    vectors = []
    for name, snippet in CORPUS.items():
        layouts = compute_layouts(parse_snippet(snippet))
        vectors.append({
            "name": name,
            "snippet": snippet,
            "expected": [
                {"name": s.name, "size": s.size, "align": s.align,
                 "fields": [field_dict(f) for f in s.fields]}
                for s in layouts
            ],
        })
    out = ROOT / "tests" / "vectors.json"
    out.write_text(json.dumps({"abi": "x86_64-sysv",
                               "vectors": vectors}, indent=2) + "\n")
    n_structs = sum(len(v["expected"]) for v in vectors)
    print(f"wrote {out} ({len(vectors)} vectors, {n_structs} structs)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
