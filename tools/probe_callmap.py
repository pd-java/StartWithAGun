#!/usr/bin/env python3
"""快速「局部函数索引 → 方法名」反查 + 指定函数的 call 目标解析。

两段式：先建纯数值索引（不解字符串），命中后再惰性解名字。
用法：
  python tools/probe_callmap.py split:40153            # 列出该函数所有 call 目标及名字
  python tools/probe_callmap.py main:10883 --body      # 附带反汇编
  python tools/probe_callmap.py split:40153 --find out # 只显示名字含 out 的
"""
import os, sys, struct
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)))
                if '__file__' in dir() else 'tools')
sys.path.insert(0, os.getcwd())

import wasm_map as WM
import wasm_probe_marker as M
from il2cpp_meta import TD_COUNT, tmethods, mtoken, img_of_type, img_name, tname, mname

# ---------- 1) 纯数值索引 ----------
REV = {'main': {}, 'split': {}}


def build():
    n = 0
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
            # 顺序关键：主包 elem 先把全部槽填成桩，第二包 elem 再覆盖真实实现 → 先查 split
            loc = WM.table_map2.get(t)
            if loc is not None:
                REV['split'].setdefault(loc, []).append((ti, mi))
                n += 1
                continue
            loc = WM.table_map1.get(t)
            if loc is not None:
                REV['main'].setdefault(loc, []).append((ti, mi))
                n += 1
    return n


_tn_cache = {}


def names_of(module, local):
    hits = REV[module].get(local)
    if not hits:
        return []
    out = []
    for ti, mi in hits[:8]:
        if ti not in _tn_cache:
            _tn_cache[ti] = tname(ti)
        out.append(_tn_cache[ti] + '::' + mname(mi))
    if len(hits) > 8:
        out.append('…(+%d)' % (len(hits) - 8))
    return out


# ---------- 2) 反汇编 ----------
OPN = {0x00: 'unreachable', 0x01: 'nop', 0x02: 'block', 0x03: 'loop', 0x04: 'if',
       0x05: 'else', 0x0b: 'end', 0x0c: 'br', 0x0d: 'br_if', 0x0e: 'br_table',
       0x0f: 'return', 0x10: 'call', 0x11: 'call_indirect', 0x1a: 'drop',
       0x1b: 'select', 0x20: 'local.get', 0x21: 'local.set', 0x22: 'local.tee',
       0x23: 'global.get', 0x24: 'global.set', 0x28: 'i32.load', 0x29: 'i64.load',
       0x2a: 'f32.load', 0x2b: 'f64.load', 0x36: 'i32.store', 0x37: 'i64.store',
       0x38: 'f32.store', 0x39: 'f64.store', 0x3f: 'memory.size', 0x40: 'memory.grow',
       0x41: 'i32.const', 0x42: 'i64.const', 0x43: 'f32.const', 0x44: 'f64.const',
       0x45: 'i32.eqz', 0x46: 'i32.eq', 0x47: 'i32.ne', 0x48: 'i32.lt_s',
       0x49: 'i32.lt_u', 0x4a: 'i32.gt_s', 0x4b: 'i32.gt_u', 0x4c: 'i32.le_s',
       0x4d: 'i32.le_u', 0x4e: 'i32.ge_s', 0x4f: 'i32.ge_u', 0x6a: 'i32.add',
       0x6b: 'i32.sub', 0x6c: 'i32.mul'}


def main():
    spec = sys.argv[1]
    module, loc = spec.split(':')
    loc = int(loc, 0)
    want_body = '--body' in sys.argv
    find = None
    if '--find' in sys.argv:
        find = sys.argv[sys.argv.index('--find') + 1].lower()

    print('建立数值索引…', flush=True)
    n = build()
    print('索引条目', n, '| main:', len(REV['main']), 'split:', len(REV['split']))
    print('\n[本函数自我识别] %s:%d ->' % (module, loc),
          names_of(module, loc) or '(无名，可能是桩/ICF 合并目标)')

    src = M.SPLIT if module == 'split' else M.MAIN
    if os.path.exists(src + M.MARK):
        src = src + M.MARK          # 读打桩前快照，偏移才和静态分析一致
    m = M.Module(src)
    buf, ranges = m.body_ranges()
    n_imp, _ = m.import_counts()
    bi = loc - n_imp
    if not (0 <= bi < len(ranges)):
        print('函数体越界: bi=%d / %d' % (bi, len(ranges)))
        return
    s, ed = ranges[bi]
    body = buf[s:ed]
    le = m.locals_end(body)
    code = body[le:]
    ins = M.decode(code)
    print('body#%d  %dB  %d 指令' % (bi, len(body), len(ins)))

    # call 目标汇总
    calls = {}
    for off, op in ins:
        if op == 0x10:
            v, _ = M.uleb(code, off + 1)
            calls.setdefault(v, []).append(off)

    print('\n--- call 目标（本模块局部索引）---')
    for v, offs in sorted(calls.items(), key=lambda x: -len(x[1])):
        nm = names_of(module, v)
        label = ' | '.join(nm) if nm else '?'
        if find and find not in label.lower():
            continue
        print('  %3d× func[%d] %s' % (len(offs), v, label))
        print('       首次调用站点 @ %s' % ', '.join('0x%x' % o for o in offs[:6]))

    if want_body:
        print('\n--- 反汇编 ---')
        for off, op in ins:
            nm = OPN.get(op, 'op_%02x' % op)
            extra = ''
            if op in (0x02, 0x03, 0x04):
                extra = ' bt'
            elif op in (0x0c, 0x0d):
                v, _ = M.uleb(code, off + 1); extra = ' %d' % v
            elif op == 0x10:
                v, _ = M.uleb(code, off + 1)
                nmn = names_of(module, v)
                extra = ' %d  ; %s' % (v, ' | '.join(nmn) if nmn else '?')
            elif op == 0x11:
                v, p = M.uleb(code, off + 1); tb, _ = M.uleb(code, p)
                extra = ' type=%d table=%d' % (v, tb)
            elif op in (0x20, 0x21, 0x22, 0x23, 0x24):
                v, _ = M.uleb(code, off + 1); extra = ' %d' % v
            elif op in M.MEMARG_OPS:
                a, p = M.uleb(code, off + 1); o, _ = M.uleb(code, p)
                extra = ' off=%d' % o
            elif op in (0x41, 0x42):
                v, _ = M.uleb(code, off + 1); extra = ' %d' % v
            print('  %04x  %-14s%s' % (off, nm, extra))


if __name__ == '__main__':
    main()
