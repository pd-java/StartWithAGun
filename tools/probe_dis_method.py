#!/usr/bin/env python3
"""反汇编指定 IL2CPP 方法，并把 call / call_indirect 目标解析成方法名。

用法：
  python tools/probe_dis_method.py Type::Method [--limit N] [--src backup]
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.getcwd())

import wasm_probe_marker as M
import wasm_map as WM

OPN = {0x00: 'unreachable', 0x01: 'nop', 0x02: 'block', 0x03: 'loop', 0x04: 'if',
       0x05: 'else', 0x0b: 'end', 0x0c: 'br', 0x0d: 'br_if', 0x0e: 'br_table',
       0x0f: 'return', 0x10: 'call', 0x11: 'call_indirect', 0x1a: 'drop',
       0x1b: 'select', 0x20: 'local.get', 0x21: 'local.set', 0x22: 'local.tee',
       0x23: 'global.get', 0x24: 'global.set', 0x28: 'i32.load', 0x29: 'i64.load',
       0x2a: 'f32.load', 0x2b: 'f64.load', 0x36: 'i32.store', 0x37: 'i64.store',
       0x38: 'f32.store', 0x39: 'f64.store', 0x3f: 'memory.size',
       0x40: 'memory.grow', 0x41: 'i32.const', 0x42: 'i64.const',
       0x43: 'f32.const', 0x44: 'f64.const'}

# local(main) → 方法名集合
REV = {}
for slot, loc in WM.table_map1.items():
    REV.setdefault(('main', loc), set())
for ti in range(0):
    pass


def build_rev():
    """遍历 Assembly-CSharp + 全部镜像，建立 (module, local) → 方法名 的索引"""
    import struct
    from il2cpp_meta import TD_COUNT, tname, tmethods, mname, mtoken, img_of_type, img_name
    n = 0
    for ti in range(TD_COUNT):
        ii = img_of_type(ti)
        if ii < 0:
            continue
        image = img_name(ii)
        ptrs = WM.module_ptrs(image)
        if not ptrs:
            continue
        ms, mc = tmethods(ti)
        tn = tname(ti)
        for mi in range(ms, ms + mc):
            tok = mtoken(mi)
            rid = tok & 0xFFFFFF
            if not (1 <= rid <= len(ptrs)):
                continue
            t = ptrs[rid - 1]
            for mm, mp in (('main', WM.table_map1), ('split', WM.table_map2)):
                loc = mp.get(t)
                if loc is not None:
                    REV.setdefault((mm, loc), set()).add(tn + '::' + mname(mi))
                    n += 1
    return n


def name_of(module, funcidx, n_imp):
    loc = funcidx
    r = REV.get((module, loc))
    if r:
        return ' | '.join(sorted(r)[:4])
    return '?'


def main():
    target = sys.argv[1]
    limit = 4000
    if '--limit' in sys.argv:
        limit = int(sys.argv[sys.argv.index('--limit') + 1])
    want_split = '--split' in sys.argv
    src = M.SPLIT if want_split else M.MAIN
    if '--src' in sys.argv and sys.argv[sys.argv.index('--src') + 1] == 'backup':
        src = src + M.MARK
    elif '--src' in sys.argv:
        src = sys.argv[sys.argv.index('--src') + 1]

    if target.startswith('midx:'):
        e = {'module': 'split' if want_split else 'main', 'local': int(target.split(':')[1], 0)}
        res = [e]
    else:
        res = WM.resolve(*target.split('::', 1))
    tn = target
    mn = ''
    if not target.startswith('midx:'):
        pass
    if not res:
        print('未解析', target); return
    mod_want = 'split' if want_split else 'main'
    e = [x for x in res if x.get('module') == mod_want]
    if not e:
        print('不在 %s 模块：' % mod_want, res); return
    e = e[0]
    module, local = mod_want, e['local']

    print('建立方法名索引…')
    n = build_rev()
    print('索引条目', n)

    m = M.Module(src)
    buf, ranges = m.body_ranges()
    n_imp, _ = m.import_counts()
    bi = local - n_imp
    s, ed = ranges[bi]
    body = buf[s:ed]
    le = m.locals_end(body)
    code = body[le:]
    ins = M.decode(code)

    print('\n===== %s  body#%d  %dB  %d 指令 =====' % (target, bi, len(body), len(ins)))

    # 预扫：把 call 目标统计出来
    calls = {}
    for off, op in ins:
        if op == 0x10:
            v, _ = M.uleb(code, off + 1)
            calls[v] = calls.get(v, 0) + 1

    shown = 0
    for off, op in ins:
        if shown >= limit:
            print('  …（截断）'); break
        nm = OPN.get(op, 'op_%02x' % op)
        extra = ''
        if op in (0x02, 0x03, 0x04):
            p = M.read_blocktype(code, off + 1); extra = ' bt'
        elif op in (0x0c, 0x0d):
            v, _ = M.uleb(code, off + 1); extra = ' %d' % v
        elif op == 0x10:
            v, _ = M.uleb(code, off + 1)
            extra = ' %d  ; %s' % (v, name_of(module, v, n_imp))
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
        elif op == 0x43:
            extra = ' f32'
        elif op == 0x44:
            extra = ' f64'
        print('  %04x  %-14s%s' % (off, nm, extra))
        shown += 1

    print('\n--- call 目标汇总（次数 / 名称）---')
    for v, c in sorted(calls.items(), key=lambda x: -x[1]):
        print('  %5d × func[%d]  %s' % (c, v, name_of(module, v, n_imp)))


if __name__ == '__main__':
    main()
