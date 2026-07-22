"""Compiler-probe layout oracle.

Instead of reimplementing ABI layout rules (a bug farm: alignment, bitfield
packing, attributes), we generate a tiny C program that prints offsetof()/
sizeof() for every field of the parsed structs, compile it with the system
C compiler, and run it. The compiler is the authority.

Bitfields (no offsetof allowed): probed by zeroing the struct, setting the
bitfield to all-ones, and scanning which bits of the raw bytes changed.
This yields exact bit offset + bit width as laid out by this ABI.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from .cparse import Snippet, StructDecl


class ProbeError(Exception):
    pass


@dataclass
class FieldLayout:
    name: str
    type_str: str
    offset: int              # bytes (for bitfields: byte containing first bit)
    size: int                # bytes (bitfields: 0, see bit_*)
    is_pointer: bool = False
    is_padding: bool = False
    bit_offset: int | None = None  # absolute bit offset within struct
    bit_width: int | None = None
    struct_ref: str | None = None


@dataclass
class StructLayout:
    name: str
    size: int
    align: int
    fields: list[FieldLayout] = field(default_factory=list)
    # hand-annotation extensions (populated via layout JSON, not the probe):
    # extras: companion allocations [{label, bytes, kind: embedded|separate}]
    extras: list = field(default_factory=list)
    note: str | None = None   # savings/summary line rendered in accent color
    title: str | None = None  # hand-written diagram title

    @property
    def padding_bytes(self) -> int:
        return sum(f.size for f in self.fields if f.is_padding)


def _find_cc() -> str:
    for cc in ("cc", "gcc", "clang"):
        if shutil.which(cc):
            return cc
    raise ProbeError("No C compiler found (tried cc, gcc, clang)")


def _emit_probe_c(snippet: Snippet) -> str:
    lines = [
        "#include <stdio.h>",
        "#include <stddef.h>",
        "#include <string.h>",
        "",
        snippet.probe_source,
        "",
        "static void scan_bits(const unsigned char *buf, size_t n) {",
        "    long first = -1, last = -1;",
        "    for (size_t i = 0; i < n * 8; i++) {",
        "        if (buf[i / 8] & (1u << (i % 8))) {",
        "            if (first < 0) first = (long)i;",
        "            last = (long)i;",
        "        }",
        "    }",
        '    printf("%ld %ld", first, first < 0 ? 0 : last - first + 1);',
        "}",
        "",
        "int main(void) {",
    ]
    for s in snippet.structs:
        tag = f"struct {s.name}" if _needs_tag(snippet, s) else s.name
        lines.append(f'    printf("STRUCT {s.name} %zu %zu\\n", '
                     f"sizeof({tag}), _Alignof({tag}));")
        for f in s.fields:
            if f.bit_width is not None:
                lines += [
                    "    {",
                    f"        {tag} probe_v;",
                    "        memset(&probe_v, 0, sizeof(probe_v));",
                    f"        probe_v.{f.name} = -1;",
                    f'        printf("BITFIELD {f.name} ");',
                    "        scan_bits((const unsigned char *)&probe_v, sizeof(probe_v));",
                    '        printf("\\n");',
                    "    }",
                ]
            else:
                if f.array_len == 0:  # flexible array member: sizeof is invalid
                    lines.append(
                        f'    printf("FIELD {f.name} %zu 0\\n", '
                        f"offsetof({tag}, {f.name}));")
                else:
                    lines.append(
                        f'    printf("FIELD {f.name} %zu %zu\\n", '
                        f"offsetof({tag}, {f.name}), "
                        f"sizeof((({tag} *)0)->{f.name}));")
    lines += ["    return 0;", "}"]
    return "\n".join(lines)


def _needs_tag(snippet: Snippet, s: StructDecl) -> bool:
    """True if 's' is only usable as 'struct NAME' (no typedef alias)."""
    return f"typedef" not in snippet.source or \
        not _has_typedef_alias(snippet.source, s.name)


def _has_typedef_alias(source: str, name: str) -> bool:
    import re
    return re.search(rf"typedef\s+struct[^;{{]*\{{[^}}]*\}}\s*{name}\s*;", source, re.S) is not None or \
        re.search(rf"typedef\s+struct\s+\w+\s+{name}\s*;", source) is not None


def _run_probe(c_source: str) -> str:
    cc = _find_cc()
    with tempfile.TemporaryDirectory(prefix="fieldday-") as td:
        src = Path(td) / "probe.c"
        exe = Path(td) / "probe"
        src.write_text(c_source)
        r = subprocess.run([cc, "-std=c11", "-o", str(exe), str(src)],
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise ProbeError(f"probe compile failed:\n{r.stderr}")
        r = subprocess.run([str(exe)], capture_output=True, text=True)
        if r.returncode != 0:
            raise ProbeError(f"probe run failed: {r.stderr}")
        return r.stdout


def _insert_padding(fields: list[FieldLayout], total: int) -> list[FieldLayout]:
    """Insert explicit padding fields into a sorted field list."""
    out: list[FieldLayout] = []
    cursor = 0
    for f in fields:
        start = f.offset if f.bit_offset is None else f.bit_offset // 8
        if start > cursor:
            out.append(FieldLayout(name="pad", type_str="padding",
                                   offset=cursor, size=start - cursor,
                                   is_padding=True))
        out.append(f)
        if f.bit_offset is None:
            cursor = max(cursor, f.offset + f.size)
        else:
            cursor = max(cursor, (f.bit_offset + (f.bit_width or 0) + 7) // 8)
    if total > cursor:
        out.append(FieldLayout(name="pad", type_str="padding",
                               offset=cursor, size=total - cursor,
                               is_padding=True))
    return out


def compute_layouts(snippet: Snippet) -> list[StructLayout]:
    """Run the compiler probe and return per-struct layouts with padding."""
    output = _run_probe(_emit_probe_c(snippet))

    decl_by_struct = {s.name: {f.name: f for f in s.fields} for s in snippet.structs}
    layouts: list[StructLayout] = []
    current: StructLayout | None = None

    for line in output.splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "STRUCT":
            if current:
                layouts.append(_finalize(current))
            current = StructLayout(name=parts[1], size=int(parts[2]),
                                   align=int(parts[3]))
        elif parts[0] == "FIELD" and current:
            decl = decl_by_struct[current.name][parts[1]]
            current.fields.append(FieldLayout(
                name=parts[1], type_str=decl.type_str,
                offset=int(parts[2]), size=int(parts[3]),
                is_pointer=decl.is_pointer, struct_ref=decl.struct_ref))
        elif parts[0] == "BITFIELD" and current:
            decl = decl_by_struct[current.name][parts[1]]
            bit_off, bit_w = int(parts[2]), int(parts[3])
            current.fields.append(FieldLayout(
                name=parts[1], type_str=decl.type_str,
                offset=bit_off // 8, size=0,
                bit_offset=bit_off, bit_width=bit_w))
    if current:
        layouts.append(_finalize(current))
    return layouts


def _finalize(sl: StructLayout) -> StructLayout:
    sl.fields.sort(key=lambda f: (f.bit_offset if f.bit_offset is not None
                                  else f.offset * 8))
    sl.fields = _insert_padding(sl.fields, sl.size)
    return sl


def layouts_to_json(layouts: list[StructLayout]) -> str:
    def enc(o):
        return {k: v for k, v in o.__dict__.items() if v is not None}
    return json.dumps(
        {"structs": [
            {"name": s.name, "size": s.size, "align": s.align,
             "fields": [enc(f) for f in s.fields],
             **({"extras": s.extras} if s.extras else {}),
             **({"note": s.note} if s.note else {}),
             **({"title": s.title} if s.title else {})}
            for s in layouts]},
        indent=2)
