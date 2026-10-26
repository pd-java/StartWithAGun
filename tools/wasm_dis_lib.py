"""
wasm-dis.py — 精简 WASM 反汇编器（仅用于定位崩溃函数）
------------------------------------------------------------
只解析 section 结构 + code section 的函数体，输出指定索引函数的字节码。
足够回答「j92815 在做什么」这个问题。
"""
import sys, struct

def uleb(d, p):
    r = 0; s = 0
    while True:
        b = d[p]; p += 1
        r |= (b & 0x7f) << s
        if not (b & 0x80):
            return r, p
        s += 7

def sleb(d, p):
    r = 0; s = 0
    while True:
        b = d[p]; p += 1
        r |= (b & 0x7f) << s
        s += 7
        if not (b & 0x80):
            if b & 0x40:
                r -= 1 << s
            return r, p

def parse(path):
    d = open(path, 'rb').read()
    assert d[:4] == b'\0asm', 'not wasm'
    p = 8
    sections = {}
    while p < len(d):
        sid = d[p]; p += 1
        size, p = uleb(d, p)
        sections.setdefault(sid, []).append((p, p + size))
        p += size
    return d, sections

def get_code_bodies(d, sections):
    """返回 [(body_start, body_end, local_decls, code_start)]"""
    out = []
    if 10 not in sections:
        return out
    start, end = sections[10][0]
    p = start
    count, p = uleb(d, p)
    for _ in range(count):
        body_size, p = uleb(d, p)
        body_start = p
        body_end = p + body_size
        # local declarations
        p2 = body_start
        ndecl, p2 = uleb(d, p2)
        for _ in range(ndecl):
            _n, p2 = uleb(d, p2)
            p2 += 1  # valtype
        out.append((body_start, body_end, p2))
        p = body_end
    return out


def count_imported_functions(d, sections):
    """统计 import 段里 func 类型的条目数（它们占据索引 0..n-1）"""
    if 2 not in sections:
        return 0
    start, _ = sections[2][0]
    p = start
    ni, p = uleb(d, p)
    n_fn = 0
    for _ in range(ni):
        ln, p = uleb(d, p); p += ln          # module name
        ln, p = uleb(d, p); p += ln          # field name
        kind = d[p]; p += 1
        if kind == 0:                         # func
            _, p = uleb(d, p)
            n_fn += 1
        elif kind == 1:                       # table
            p += 1                            # reftype
            flags = d[p]; p += 1
            _, p = uleb(d, p)                 # initial
            if flags:
                _, p = uleb(d, p)             # maximum
        elif kind == 2:                       # memory
            flags = d[p]; p += 1
            _, p = uleb(d, p)
            if flags:
                _, p = uleb(d, p)
        elif kind == 3:                       # global
            p += 2                            # valtype + mutability
    return n_fn


# --- 常用 opcode 名称（0x00-0xFF 主要部分）---
OPS = {
    0x00: 'unreachable', 0x01: 'nop', 0x02: 'block', 0x03: 'loop', 0x04: 'if', 0x05: 'else',
    0x0b: 'end', 0x0c: 'br', 0x0d: 'br_if', 0x0e: 'br_table', 0x0f: 'return', 0x10: 'call',
    0x11: 'call_indirect', 0x1a: 'drop', 0x1b: 'select',
    0x20: 'local.get', 0x21: 'local.set', 0x22: 'local.tee',
    0x23: 'global.get', 0x24: 'global.set',
    0x28: 'i32.load', 0x29: 'i64.load', 0x2a: 'f32.load', 0x2b: 'f64.load',
    0x2c: 'i32.load8_s', 0x2d: 'i32.load8_u', 0x2e: 'i32.load16_s', 0x2f: 'i32.load16_u',
    0x36: 'i32.store', 0x37: 'i64.store', 0x38: 'f32.store', 0x39: 'f64.store',
    0x3a: 'i32.store8', 0x3b: 'i32.store16',
    0x3f: 'memory.size', 0x40: 'memory.grow',
    0x41: 'i32.const', 0x42: 'i64.const', 0x43: 'f32.const', 0x44: 'f64.const',
    0x45: 'i32.eqz', 0x46: 'i32.eq', 0x47: 'i32.ne', 0x48: 'i32.lt_s', 0x49: 'i32.lt_u',
    0x4a: 'i32.gt_s', 0x4b: 'i32.gt_u', 0x4c: 'i32.le_s', 0x4d: 'i32.le_u',
    0x4e: 'i32.ge_s', 0x4f: 'i32.ge_u',
    0x6a: 'i32.add', 0x6b: 'i32.sub', 0x6c: 'i32.mul', 0x6d: 'i32.div_s', 0x6e: 'i32.div_u',
    0x71: 'i32.and', 0x72: 'i32.or', 0x73: 'i32.xor', 0x74: 'i32.shl', 0x75: 'i32.shr_s',
    0x76: 'i32.shr_u',
    0xfc: 'misc',
}

def disasm(d, start, end, limit=220):
    p = start
    n = 0
    while p < end and n < limit:
        op = d[p]; p += 1
        name = OPS.get(op, 'op_0x%02x' % op)
        extra = ''
        try:
            if op in (0x02, 0x03, 0x04, 0x0c, 0x0d, 0x10, 0x20, 0x21, 0x22, 0x23, 0x24):
                v, p = uleb(d, p); extra = ' ' + str(v)
            elif op == 0x0e:  # br_table
                c, p = uleb(d, p)
                vs = []
                for _ in range(c + 1):
                    v, p = uleb(d, p); vs.append(v)
                extra = ' [' + ','.join(map(str, vs)) + ']'
            elif op == 0x11:
                v, p = uleb(d, p); b = d[p]; p += 1
                extra = ' %d (type %d)' % (v, b)
            elif op in (0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f,
                        0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b):
                a, p = uleb(d, p); off, p = uleb(d, p)
                extra = ' align=%d offset=%d' % (a, off)
            elif op == 0x41:
                v, p = sleb(d, p); extra = ' ' + str(v)
            elif op == 0x42:
                v, p = sleb(d, p); extra = ' ' + str(v)
            elif op == 0x43:
                extra = ' ' + str(struct.unpack('<f', d[p:p+4])[0]); p += 4
            elif op == 0x44:
                extra = ' ' + str(struct.unpack('<d', d[p:p+8])[0]); p += 8
            elif op == 0xfc:
                sub, p = uleb(d, p); extra = ' sub=%d' % sub
        except Exception as e:
            extra = ' <err %s>' % e
            break
        print('  %06x  %s%s' % (p - 1, name, extra))
        n += 1
    if p < end:
        print('  ... (还剩 %d 字节未反汇编)' % (end - p))


if __name__ == '__main__':
    path = sys.argv[1]
    want = [int(x) for x in sys.argv[2:]] if len(sys.argv) > 2 else []
    d, secs = parse(path)
    bodies = get_code_bodies(d, secs)

    # ── 关键：函数索引空间 = imported functions + defined functions ──
    # wasm 的函数索引从 0 开始先排 import 进来的函数，
    # code 段里的函数体从 import 数开始编号。
    # 浏览器报错用的（如 wasm-function[14903]）是【全局索引】，
    # 直接拿它当 code 段下标会整体偏移，必须减掉 import 数。
    fn_imports = count_imported_functions(d, secs)
    print('函数体总数 = %d，导入函数数 = %d，全局索引上界 = %d'
          % (len(bodies), fn_imports, fn_imports + len(bodies)))

    for idx in want:
        body_idx = idx - fn_imports
        if body_idx < 0:
            print('\nfunc[%d] 是导入函数（无函数体），请在 import 段查表' % idx)
            continue
        if body_idx >= len(bodies):
            print('func[%d] 超出范围（上界 %d）' % (idx, fn_imports + len(bodies) - 1))
            continue
        bs, be, cs = bodies[body_idx]
        print('\n===== func[%d]  (code 段第 %d 个)  体积=%d 字节  code@0x%x ====='
              % (idx, body_idx, be - bs, cs))
        disasm(d, cs, be)
