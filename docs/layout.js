/* fieldday layout engine — C struct parsing + x86-64 SysV layout in JS.
 *
 * Browser port of the Python reference implementation (cparse.py/probe.py).
 * The Python tool uses the system C compiler as the layout oracle; this
 * engine reimplements the rules for the SUPPORTED SUBSET only (plain
 * fields, arrays, nested structs, bitfields, flexible array members,
 * stub types — no __attribute__, unions, or enums) and is cross-validated
 * against compiler-generated golden vectors (tests/vectors.json) in CI.
 * Any construct outside the subset throws, rather than guessing.
 *
 * ES module, zero dependencies; works in browsers and Node >= 14.
 */

// x86-64 SysV: [size, align] for base types (keyed by canonical name).
const BASE_TYPES = {
  "char": [1, 1], "signed char": [1, 1], "unsigned char": [1, 1],
  "short": [2, 2], "unsigned short": [2, 2],
  "int": [4, 4], "unsigned": [4, 4], "unsigned int": [4, 4], "signed": [4, 4],
  "long": [8, 8], "unsigned long": [8, 8],
  "long long": [8, 8], "unsigned long long": [8, 8],
  "float": [4, 4], "double": [8, 8], "long double": [16, 16],
  "_Bool": [1, 1], "bool": [1, 1],
};

// Mirrors BUILTIN_STUBS in cparse.py — keep in sync.
export const BUILTIN_STUBS = {
  sds: [8, 8], size_t: [8, 8], ssize_t: [8, 8], time_t: [8, 8],
  off_t: [8, 8], intptr_t: [8, 8], uintptr_t: [8, 8], ptrdiff_t: [8, 8],
  int8_t: [1, 1], uint8_t: [1, 1], int16_t: [2, 2], uint16_t: [2, 2],
  int32_t: [4, 4], uint32_t: [4, 4], int64_t: [8, 8], uint64_t: [8, 8],
  atomic_int: [4, 4], pthread_mutex_t: [40, 8],
  mstime_t: [8, 8], ustime_t: [8, 8],
};

const TYPE_KEYWORDS = new Set([
  "unsigned", "signed", "char", "short", "int", "long", "float", "double",
  "void", "_Bool", "bool",
]);
const QUALIFIERS = new Set(["const", "volatile", "static"]);

export class LayoutError extends Error {}

// ---------------------------------------------------------------- lexing

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
}

function collectStubDirectives(text) {
  const stubs = {};
  const re = /^\s*\/\/@\s*stub\s+(\w+)\s+(\d+)(?:\s+(\d+))?\s*$/gm;
  for (const m of text.matchAll(re)) {
    const size = parseInt(m[2], 10);
    stubs[m[1]] = [size, m[3] ? parseInt(m[3], 10) : Math.min(size, 8) || 1];
  }
  return stubs;
}

function tokenize(text) {
  const re = /[A-Za-z_]\w*|\d+|[{}\[\];:,*()]/g;
  const toks = [];
  for (const m of text.matchAll(re)) toks.push(m[0]);
  return toks;
}

// ---------------------------------------------------------------- parsing

class Parser {
  constructor(toks, stubs) {
    this.t = toks;
    this.i = 0;
    this.openTags = new Set();  // struct tags currently being defined
    this.stubs = stubs;                 // name -> [size, align]
    this.structs = new Map();           // tag/typedef -> {size, align, emitted}
    this.emitOrder = [];                // top-level struct names, in order
    this.layouts = new Map();           // name -> layout result
  }

  peek(k = 0) { return this.t[this.i + k]; }
  next() { return this.t[this.i++]; }
  expect(tok) {
    const got = this.next();
    if (got !== tok) throw new LayoutError(`expected '${tok}', got '${got ?? "<eof>"}'`);
    return got;
  }

  parseTranslationUnit() {
    while (this.i < this.t.length) {
      if (this.peek() === "typedef") this.parseTypedef();
      else if (this.peek() === "struct") this.parseTopStruct();
      else throw new LayoutError(`unsupported top-level token '${this.peek()}' (only struct definitions and typedefs are supported)`);
    }
    return this.emitOrder.map((n) => this.layouts.get(n));
  }

  parseTypedef() {
    this.expect("typedef");
    if (this.peek() !== "struct") throw new LayoutError("only 'typedef struct' is supported");
    this.next();
    let tag = null;
    if (this.peek() !== "{") tag = this.next();
    const fields = this.parseStructBody(tag);
    const name = this.next();
    this.expect(";");
    this.registerStruct(name, tag, fields, true);
  }

  parseTopStruct() {
    this.expect("struct");
    const tag = this.next();
    if (this.peek() !== "{") throw new LayoutError(`expected '{' after 'struct ${tag}'`);
    const fields = this.parseStructBody(tag);
    this.expect(";");
    this.registerStruct(tag, tag, fields, true);
  }

  // Parses '{ decls }' and returns raw field descriptors. Tags of all
  // enclosing in-progress definitions stay visible (self/outer references
  // are usable via pointer before registration completes).
  parseStructBody(selfTag) {
    if (selfTag) this.openTags.add(selfTag);
    this.expect("{");
    const fields = [];
    while (this.peek() !== "}") {
      this.parseDeclaration(fields);
    }
    this.expect("}");
    if (selfTag) this.openTags.delete(selfTag);
    return fields;
  }

  parseDeclaration(fields) {
    while (QUALIFIERS.has(this.peek())) this.next();

    let base;                            // {size, align, structRef}
    if (this.peek() === "struct") {
      this.next();
      let tag = null;
      if (this.peek() !== "{") tag = this.next();
      if (this.peek() === "{") {
        // inline nested struct definition: struct level { ... } lvl[];
        const nested = this.parseStructBody(tag);
        const info = this.computeLayout(nested, tag ?? "<anon>");
        if (tag) this.structs.set(`struct ${tag}`, { size: info.size, align: info.align });
        base = { size: info.size, align: info.align, structRef: null, incomplete: false };
      } else if (this.openTags.has(tag) || this.structs.has(`struct ${tag}`)) {
        const known = this.structs.get(`struct ${tag}`);
        // self-reference is only usable via pointer; mark incomplete
        base = known
          ? { size: known.size, align: known.align, structRef: known.emitted ? tag : null, incomplete: false }
          : { size: 0, align: 0, structRef: null, incomplete: true };
      } else {
        throw new LayoutError(`unknown struct type 'struct ${tag}' — define it earlier in the snippet`);
      }
    } else if (TYPE_KEYWORDS.has(this.peek())) {
      const words = [];
      while (TYPE_KEYWORDS.has(this.peek())) words.push(this.next());
      const canon = words.filter((w) => w !== "int" || words.length === 1).join(" ")
        .replace(/^signed (char)$/, "signed $1").replace(/^signed$/, "signed");
      if (words.includes("void")) {
        base = { size: 0, align: 0, structRef: null, incomplete: true }; // void: pointer-only
      } else {
        const key = canon in BASE_TYPES ? canon : words.join(" ");
        if (!(key in BASE_TYPES)) throw new LayoutError(`unsupported type '${words.join(" ")}'`);
        base = { size: BASE_TYPES[key][0], align: BASE_TYPES[key][1], structRef: null, incomplete: false };
      }
    } else {
      const name = this.next();
      if (name in this.stubs) {
        base = { size: this.stubs[name][0], align: this.stubs[name][1], structRef: null, incomplete: false };
      } else if (this.structs.has(name)) {
        const s = this.structs.get(name);
        base = { size: s.size, align: s.align, structRef: s.emitted ? name : null, incomplete: false };
      } else if (name in BUILTIN_STUBS) {
        base = { size: BUILTIN_STUBS[name][0], align: BUILTIN_STUBS[name][1], structRef: null, incomplete: false };
      } else {
        throw new LayoutError(
          `Unknown type '${name}': add a stub directive, e.g. '//@ stub ${name} 8 8' (size [align] in bytes)`);
      }
    }

    // declarator list: [*]* name [\[N\]] [: bits] {, ...} ;
    for (;;) {
      let ptr = 0;
      while (this.peek() === "*") { this.next(); ptr++; }
      const fname = this.next();
      if (!/^[A-Za-z_]\w*$/.test(fname)) throw new LayoutError(`bad field name '${fname}'`);
      let arrayLen = null;
      if (this.peek() === "[") {
        this.next();
        arrayLen = this.peek() === "]" ? 0 : parseInt(this.next(), 10);
        this.expect("]");
      }
      let bits = null;
      if (this.peek() === ":") {
        this.next();
        bits = parseInt(this.next(), 10);
      }
      if (base.incomplete && ptr === 0) {
        throw new LayoutError(`field '${fname}' has incomplete type (did you mean a pointer?)`);
      }
      fields.push({
        name: fname,
        size: ptr > 0 ? 8 : base.size,
        align: ptr > 0 ? 8 : base.align,
        isPointer: ptr > 0,
        structRef: ptr > 0 ? base.structRef : base.structRef,
        arrayLen,
        bits,
      });
      if (this.peek() === ",") { this.next(); continue; }
      this.expect(";");
      break;
    }
  }

  registerStruct(name, tag, rawFields, emitted) {
    const info = this.computeLayout(rawFields, name);
    this.structs.set(name, { size: info.size, align: info.align, emitted });
    if (tag) this.structs.set(`struct ${tag}`, { size: info.size, align: info.align, emitted });
    if (emitted) {
      this.layouts.set(name, info);
      this.emitOrder.push(name);
    }
  }

  // x86-64 SysV layout for the supported subset.
  computeLayout(rawFields, name) {
    let bitCursor = 0;
    let maxAlign = 1;
    const out = [];

    for (const f of rawFields) {
      if (f.bits !== null) {
        // GCC/Clang bitfield rule: a bitfield may not cross an allocation-
        // unit boundary of its declared type; otherwise pack at next bit.
        const unitBits = f.size * 8;
        maxAlign = Math.max(maxAlign, f.align);
        let bo = bitCursor;
        if (Math.floor(bo / unitBits) !== Math.floor((bo + f.bits - 1) / unitBits)) {
          bo = Math.ceil(bo / unitBits) * unitBits;
        }
        out.push({ name: f.name, offset: Math.floor(bo / 8), size: 0,
                   bit_offset: bo, bit_width: f.bits,
                   isPointer: false, structRef: null });
        bitCursor = bo + f.bits;
      } else {
        const elemSize = f.size, elemAlign = f.align;
        const totalSize = f.arrayLen === null ? elemSize
          : f.arrayLen === 0 ? 0 : elemSize * f.arrayLen;
        maxAlign = Math.max(maxAlign, elemAlign);
        let byteCursor = Math.ceil(bitCursor / 8);
        byteCursor = Math.ceil(byteCursor / elemAlign) * elemAlign;
        out.push({ name: f.name, offset: byteCursor,
                   size: f.arrayLen === 0 ? 0 : totalSize,
                   bit_offset: null, bit_width: null,
                   isPointer: f.isPointer, structRef: f.structRef });
        bitCursor = (byteCursor + (f.arrayLen === 0 ? 0 : totalSize)) * 8;
      }
    }

    const size = Math.ceil(Math.ceil(bitCursor / 8) / maxAlign) * maxAlign;
    return { name, size, align: maxAlign, fields: insertPadding(out, size) };
  }
}

// Mirror of probe.py::_insert_padding — pad entries must match exactly.
function insertPadding(fields, total) {
  const out = [];
  let cursor = 0;
  for (const f of fields) {
    const start = f.bit_offset === null ? f.offset : Math.floor(f.bit_offset / 8);
    if (start > cursor) {
      out.push({ name: "pad", offset: cursor, size: start - cursor,
                 bit_offset: null, bit_width: null,
                 isPointer: false, structRef: null, isPadding: true });
    }
    out.push(f);
    cursor = f.bit_offset === null
      ? Math.max(cursor, f.offset + f.size)
      : Math.max(cursor, Math.floor((f.bit_offset + f.bit_width + 7) / 8));
  }
  if (total > cursor) {
    out.push({ name: "pad", offset: cursor, size: total - cursor,
               bit_offset: null, bit_width: null,
               isPointer: false, structRef: null, isPadding: true });
  }
  return out;
}

/** Parse a C snippet and compute layouts for all top-level structs.
 *  Returns [{name, size, align, fields: [{name, offset, size, is_pointer?,
 *  is_padding?, bit_offset?, bit_width?, struct_ref?}]}] — the same shape
 *  as the Python tool's --emit-json / golden vectors. Throws LayoutError. */
export function computeLayouts(snippetText) {
  const stubs = collectStubDirectives(snippetText);
  const clean = stripComments(snippetText);
  const parser = new Parser(tokenize(clean), stubs);
  const layouts = parser.parseTranslationUnit();
  if (!layouts.length) throw new LayoutError("No struct definitions found in snippet");
  return layouts.map((s) => ({
    name: s.name, size: s.size, align: s.align,
    fields: s.fields.map((f) => {
      const d = { name: f.name, offset: f.offset, size: f.size };
      if (f.isPointer) d.is_pointer = true;
      if (f.isPadding) d.is_padding = true;
      if (f.bit_offset !== null && f.bit_offset !== undefined) {
        d.bit_offset = f.bit_offset;
        d.bit_width = f.bit_width;
      }
      if (f.structRef) d.struct_ref = f.structRef;
      return d;
    }),
  }));
}
