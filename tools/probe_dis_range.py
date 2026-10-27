#!/usr/bin/env python3
"""把某函数的一段字节反汇编（带 import 名 + 方法名 + br_table 目标展开）。

用法：
  python tools/probe_dis_range.py split:40153 --from 0x0 --to 0x180
  python tools/probe_dis_range.py split:40153 --from 0x140 --to 0x160 --brtable
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.getcwd())

import wasm_probe_marker as M
import wasm_map as WM
from il2cpp_meta import TD_COUNT, tmethods, mtoken, img_of_type, img_name, tname, mname
from probe_imports import parse as parse_imports

OPN = {0x00: 'unreachable', 0x01: 'nop', 0x02: 'block', 0x03: 'loop', 0x04: 'if',
       0x05: 'else', 0x0b: 'end', 0x0c: 'br', 0x0d: 'br_if', 0x0e: 'br_table',
       0x0f: 'return', 0x10: 'call', 0x11: 'call_indirect', 0x1a: 'drop',
       0x1b: 'select', 0x20: 'local.get', 0x21: 'local.set', 0x22: 'local.tee',
       0x23: 'global.get', 0x24: 'global.set', 0x25: 'table.get', 0x26: 'table.set',
       0x28: 'i32.load', 0x29: 'i64.load', 0x2a: 'f32.load', 0x2b: 'f64.load',
       0x2c: 'i32.load8_s', 0x2d: 'i32.load8_u', 0x2e: 'i32.load16_s', 0x2f: 'i32.load16_u',
       0x36: 'i32.store', 0x37: 'i64.store', 0x38: 'f32.store', 0x39: 'f64.store',
       0x3a: 'i32.store8', 0x3b: 'i32.store16', 0x3f: 'memory.size', 0x40: 'memory.grow',
       0x41: 'i32.const', 0x42: 'i64.const', 0x43: 'f32.const', 0x44: 'f64.const',
       0x45: 'i32.eqz', 0x46: 'i32.eq', 0x47: 'i32.ne', 0x48: 'i32.lt_s', 0x49: 'i32.lt_u',
       0x4a: 'i32.gt_s', 0x4b: 'i32.gt_u', 0x4c: 'i32.le_s', 0x4d: 'i32.le_u',
       0x4e: 'i32.ge_s', 0x4f: 'i32.ge_u', 0x50: 'i64.eqz', 0x51: 'i64.eq',
       0x6a: 'i32.add', 0x6b: 'i32.sub', 0x6c: 'i32.mul', 0x71: 'i32.and',
       0x72: 'i32.or', 0x73: 'i32.xor', 0x74: 'i32.shl', 0x76: 'i32.shr_u',
       0x88: 'i64.extend_i32_s', 0xa7: 'i32.wrap_i64', 0xac: 'i64.add'}

REV = {'main': {}, 'split': {}}


def build_rev():
    for ti in range(TD_COUNT):
        ii = img_of_type(ti)
        if ii < 0:
            continue
        ptrs = WM.module_ptrs(img_name(ii))
        if not ptrs:
            continue
        ms, mc = tmethods(ti)
        lim = len(ptrs)
        for mi in range(ms, ms + mc):
            rid = mtoken(mi) & 0xFFFFFF
            if not (1 <= rid <= lim):
                continue
            t = ptrs[rid - 1]
            loc = WM.table_map2.get(t)
            if loc is not None:
                REV['split'].setdefault(loc, []).append((ti, mi))
                continue
            loc = WM.table_map1.get(t)
            if loc is not None:
                REV['main'].setdefault(loc, []).append((ti, mi))


def resolve_block_targets(code, ins):
    """把每条 block/loop/if 的 end 偏移算出来，便于把 br N 翻成目标地址。"""
    stack = []
    ends = {}
    for off, op in ins:
        if op in (0x02, 0x03, 0x04):
            stack.append([off, None])
        elif op == 0x05:      # else
            pass
        elif op == 0x0b:      # end
            if stack:
                start = stack.pop()[0]
                ends[start] = off
    return ends


def main():
    spec = sys.argv[1]
    module, loc = spec.split(':')
    loc = int(loc, 0)

    def arg(flag, default):
        if flag in sys.argv:
            return int(sys.argv[sys.argv.index(flag) + 1], 0)
        return default

    lo = arg('--from', 0)
    hi = arg('--to', 1 << 30)

    print('建立索引…', flush=True)
    build_rev()
    imps = {fi: '%s.%s' % (mo, fl) for fi, mo, fl in
            parse_imports(M.SPLIT if module == 'split' else M.MAIN)}

    def nm(fi):
        r = REV[module].get(fi)
        if r:
            return ' | '.join(tname(t) + '::' + mname(m) for t, m in r[:3])
        return imps.get(fi, '?')

    src = M.SPLIT if module == 'split' else M.MAIN
    # 分析时默认读「打桩前快照」，否则偏移被探针插入的字节移位
    if '--src' in sys.argv:
        src = sys.argv[sys.argv.index('--src') + 1]
    elif os.path.exists(src + M.MARK):
        src = src + M.MARK
    m = M.Module(src)
    buf, ranges = m.body_ranges()
    n_imp, _ = m.import_counts()
    bi = loc - n_imp
    s, ed = ranges[bi]
    body = buf[s:ed]
    le = m.locals_end(body)
    code = body[le:]
    ins = M.decode(code)

    # block 结构 → 偏移映射（用指令序号算 br 目标）
    depth_stack = []
    op_at_depth = {}
    targets = {}
    for idx, (off, op) in enumerate(ins):
        if op in (0x02, 0x03, 0x04):
            depth_stack.append(idx)
        elif op == 0x0b:
            if depth_stack:
                depth_stack.pop()
        elif op in (0x0c, 0x0d, 0x0e):
            pass
    # 简化：直接用「块栈」在遍历时记录每层的结束位置
    blocks = []          # [(start_idx, end_idx)]
    st = []
    for idx, (off, op) in enumerate(ins):
        if op in (0x02, 0x03, 0x04):
            st.append(idx)
        elif op == 0x0b:
            if st:
                si = st.pop()
                blocks.append((si, idx))
    end_of = {si: ei for si, ei in blocks}

    def br_label(d):
        """深度 d → 目标指令序号（近似：取当前还未结束的第 d+1 层）"""
        return d

    print('===== %s  body#%d  %dB  %d 指令  显示 %#x..%#x =====' %
          (spec, bi, len(body), len(ins), lo, hi))

    # 维护块栈以便把 br depth 翻成地址
    cur = []
    idx2off = {i: o for i, (o, _) in enumerate(ins)}
    for idx, (off, op) in enumerate(ins):
        is_show = lo <= off < hi
        extra = ''
        if op in (0x02, 0x03, 0x04):
            cur.append(idx)
            bt = M.read_blocktype(code, off + 1)
            extra = ' bt'
        elif op == 0x0b:
            if cur:
                cur.pop()
        elif op in (0x0c, 0x0d):
            v, _ = M.uleb(code, off + 1)
            tgt = cur[-(v + 1)] if len(cur) > v else None
            extra = ' %d  -> %s' % (v, ('@%#x' % idx2off[tgt]) if tgt is not None else '(func end)')
        elif op == 0x0e:
            n, p = M.uleb(code, off + 1)
            tgts = []
            for _ in range(n):
                v, p = M.uleb(code, p)
                tgt = cur[-(v + 1)] if len(cur) > v else None
                tgts.append('@%#x' % idx2off[tgt] if tgt is not None else 'end')
            dv, p = M.uleb(code, p)
            tgt = cur[-(dv + 1)] if len(cur) > dv else None
            extra = ' n=%d default->%s\n         %s' % (
                n, '@%#x' % idx2off[tgt] if tgt is not None else 'end',
                '  '.join('%d:%s' % (i, t) for i, t in enumerate(tgts)))
        elif op == 0x10:
            v, _ = M.uleb(code, off + 1)
            extra = ' %d  ; %s' % (v, nm(v))
        elif op == 0x11:
            v, p = M.uleb(code, off + 1)
            tb, _ = M.uleb(code, p)
            extra = ' type=%d table=%d' % (v, tb)
        elif op in (0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26):
            v, _ = M.uleb(code, off + 1)
            extra = ' %d' % v
        elif op in M.MEMARG_OPS:
            a, p = M.uleb(code, off + 1)
            o, _ = M.uleb(code, p)
            extra = ' off=%d' % o
        elif op in (0x41, 0x42):
            v, _ = M.uleb(code, off + 1)
            extra = ' %d' % v
        elif op == 0x43:
            import struct
            extra = ' %g' % struct.unpack('<f', code[off + 1:off + 5])[0]
        elif op == 0x44:
            import struct
            extra = ' %g' % struct.unpack('<d', code[off + 1:off + 9])[0]
        elif op == 0x22:
            pass
        if is_show:
            print('  %04x  %-16s%s' % (off, OPN.get(op, 'op_%02x' % op), extra))


if __name__ == '__main__':
    main()
