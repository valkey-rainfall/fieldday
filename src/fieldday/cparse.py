"""Parse C struct snippets into declaration models.

pycparser handles *declaration* parsing (names, types, bitfield widths,
array lengths, nesting). It does NOT compute layout -- offsets, sizes, and
padding come from the compiler probe (see probe.py), which is authoritative
for the target ABI.

Unknown types are resolved in order:
  1. builtin stub table (fixed-width ints, common libc/valkey types)
  2. structs/typedefs defined earlier in the same snippet
  3. user-supplied stubs: ``//@ stub NAME SIZE [ALIGN]`` comment lines
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from pycparser import CParser, c_ast

# Types we can stub without user input: name -> (size, align) on x86-64.
BUILTIN_STUBS = {
    "sds": (8, 8),  # char* behind a typedef
    "size_t": (8, 8),
    "ssize_t": (8, 8),
    "time_t": (8, 8),
    "off_t": (8, 8),
    "intptr_t": (8, 8),
    "uintptr_t": (8, 8),
    "ptrdiff_t": (8, 8),
    "int8_t": (1, 1), "uint8_t": (1, 1),
    "int16_t": (2, 2), "uint16_t": (2, 2),
    "int32_t": (4, 4), "uint32_t": (4, 4),
    "int64_t": (8, 8), "uint64_t": (8, 8),
    "bool": (1, 1), "_Bool": (1, 1),
    "atomic_int": (4, 4),
    "pthread_mutex_t": (40, 8),
    "mstime_t": (8, 8), "ustime_t": (8, 8),  # valkey
}

STUB_RE = re.compile(r"^\s*//@\s*stub\s+(\w+)\s+(\d+)(?:\s+(\d+))?\s*$", re.M)


@dataclass
class FieldDecl:
    name: str
    type_str: str        # human-readable declared type
    is_pointer: bool = False
    bit_width: int | None = None   # bitfield width, None = not a bitfield
    array_len: int | None = None   # None = not an array
    struct_ref: str | None = None  # name of snippet-defined struct type, if any


@dataclass
class StructDecl:
    name: str
    fields: list[FieldDecl] = field(default_factory=list)


@dataclass
class Snippet:
    structs: list[StructDecl]          # in definition order
    stubs: dict[str, tuple[int, int]]  # name -> (size, align) incl. builtins used
    source: str        # pycparser-friendly source (char[] stubs)
    probe_source: str  # compiler source (_Alignas-correct stubs)


class SnippetError(Exception):
    pass


def _collect_stub_directives(text: str) -> dict[str, tuple[int, int]]:
    stubs = {}
    for m in STUB_RE.finditer(text):
        name, size, align = m.group(1), int(m.group(2)), m.group(3)
        stubs[name] = (size, int(align) if align else min(int(size), 8) or 1)
    return stubs


def _strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    text = re.sub(r"//[^\n]*", "", text)
    return text


def _find_unknown_typedefs(text: str, known: set[str]) -> list[str]:
    """Best-effort scan for identifiers used in type position that pycparser
    won't know. We only need typedef names -- struct tags parse fine."""
    unknown = []
    keywords = ("struct", "union", "enum", "const", "volatile", "unsigned",
                "signed", "int", "char", "short", "long", "float", "double",
                "void", "typedef", "_Bool")
    # field decls look like: [quals] TYPE [*]name [: bits] [\[N\]] ;
    # anchored after '{', ';' or newline so one-line struct bodies work too
    for m in re.finditer(r"(?<=[{;\n])\s*((?:\w+\s+)*?)(\w+)\s*[\w*\s\[\]:]*;", text):
        prefix_toks = m.group(1).split()
        tok = m.group(2)
        if tok in keywords:
            continue
        # if any builtin type keyword already appeared, tok is the field name
        # (e.g. "unsigned paused : 1;") or a struct/union tag -- not a typedef
        if any(p in ("struct", "union", "enum", "unsigned", "signed", "int",
                     "char", "short", "long", "float", "double", "void", "_Bool")
               for p in prefix_toks):
            continue
        if tok not in known and tok not in unknown:
            unknown.append(tok)
    return unknown


def _type_to_str(node) -> str:
    if isinstance(node, c_ast.PtrDecl):
        return _type_to_str(node.type) + " *"
    if isinstance(node, c_ast.ArrayDecl):
        return _type_to_str(node.type)
    if isinstance(node, c_ast.TypeDecl):
        return _type_to_str(node.type)
    if isinstance(node, c_ast.IdentifierType):
        return " ".join(node.names)
    if isinstance(node, c_ast.Struct):
        return f"struct {node.name}" if node.name else "struct <anon>"
    if isinstance(node, c_ast.Union):
        return f"union {node.name}" if node.name else "union <anon>"
    if isinstance(node, c_ast.Enum):
        return f"enum {node.name}" if node.name else "enum <anon>"
    return "?"


def _eval_const(node) -> int | None:
    if isinstance(node, c_ast.Constant):
        try:
            return int(node.value, 0)
        except ValueError:
            return None
    if isinstance(node, c_ast.BinaryOp):
        lhs, rhs = _eval_const(node.left), _eval_const(node.right)
        if lhs is None or rhs is None:
            return None
        ops = {"+": lambda a, b: a + b, "-": lambda a, b: a - b,
               "*": lambda a, b: a * b, "/": lambda a, b: a // b,
               "<<": lambda a, b: a << b, ">>": lambda a, b: a >> b}
        fn = ops.get(node.op)
        return fn(lhs, rhs) if fn else None
    return None


def _field_from_decl(decl, snippet_struct_names: set[str]) -> FieldDecl:
    name = decl.name or "<anon>"
    is_ptr = isinstance(decl.type, c_ast.PtrDecl)
    array_len = None
    node = decl.type
    if isinstance(node, c_ast.ArrayDecl):
        array_len = _eval_const(node.dim) if node.dim is not None else 0
    bit_width = None
    if decl.bitsize is not None:
        bit_width = _eval_const(decl.bitsize)
    type_str = _type_to_str(decl.type)
    struct_ref = None
    base = type_str.replace(" *", "").strip()
    if base.startswith("struct "):
        tag = base[len("struct "):]
        if tag in snippet_struct_names:
            struct_ref = tag
    elif base in snippet_struct_names:
        struct_ref = base
    return FieldDecl(name=name, type_str=type_str, is_pointer=is_ptr,
                     bit_width=bit_width, array_len=array_len,
                     struct_ref=struct_ref)


def parse_snippet(text: str) -> Snippet:
    """Parse a C snippet containing one or more struct definitions."""
    user_stubs = _collect_stub_directives(text)
    clean = _strip_comments(text)

    # Names already known: builtin stubs, user stubs, snippet typedefs
    snippet_typedefs = set(re.findall(r"typedef\s+[^;]+?(\w+)\s*;", clean))
    known = set(BUILTIN_STUBS) | set(user_stubs) | snippet_typedefs

    unknown = _find_unknown_typedefs(clean, known)

    # Synthesize typedef stubs so pycparser accepts the snippet. Layout-wise
    # the probe uses the real stub struct, so parse-time char[] is fine.
    # Only stub names actually referenced, and never C keywords.
    referenced = set(re.findall(r"\b\w+\b", clean))
    keywords = {"_Bool", "bool"}
    prelude_lines = []
    probe_prelude_lines = []
    used_stubs: dict[str, tuple[int, int]] = {}
    for name in sorted(known | set(unknown)):
        if name in snippet_typedefs or name in keywords or name not in referenced:
            continue
        if name in user_stubs:
            size, align = user_stubs[name]
        elif name in BUILTIN_STUBS:
            size, align = BUILTIN_STUBS[name]
        else:
            raise SnippetError(
                f"Unknown type '{name}': add a stub directive, e.g. "
                f"'//@ stub {name} 8 8' (size [align] in bytes)")
        used_stubs[name] = (size, align)
        # pycparser can't handle _Alignas; the probe compiler can.
        prelude_lines.append(f"typedef char {name}[{size}];")
        probe_prelude_lines.append(
            f"typedef struct {{ _Alignas({align}) unsigned char _b[{size}]; }} {name};")

    source = "\n".join(prelude_lines) + "\n" + clean
    probe_source = "\n".join(probe_prelude_lines) + "\n" + clean
    try:
        ast = CParser().parse(source, filename="<snippet>")
    except Exception as e:  # pycparser raises plain Exception subclasses
        raise SnippetError(f"C parse error: {e}") from e

    structs: list[StructDecl] = []
    struct_names: set[str] = set()

    def visit_struct(node, name_hint=None):
        name = node.name or name_hint
        if not name or node.decls is None:
            return
        sd = StructDecl(name=name)
        for d in node.decls:
            if isinstance(d, c_ast.Decl):
                sd.fields.append(_field_from_decl(d, struct_names))
        structs.append(sd)
        struct_names.add(name)

    for ext in ast.ext:
        if isinstance(ext, c_ast.Decl) and isinstance(ext.type, c_ast.Struct):
            visit_struct(ext.type)
        elif isinstance(ext, c_ast.Typedef):
            inner = ext.type
            if isinstance(inner, c_ast.TypeDecl) and isinstance(inner.type, c_ast.Struct):
                visit_struct(inner.type, name_hint=ext.name)
                struct_names.add(ext.name)

    if not structs:
        raise SnippetError("No struct definitions found in snippet")
    return Snippet(structs=structs, stubs=used_stubs, source=source,
                   probe_source=probe_source)
