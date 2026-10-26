#!/usr/bin/env python3
"""找出「谁调用了 func[N]」—— 静态调用图。

用法：
  python tools/probe_find_callers.py 10883          # 主模块中直接 call 10883 的函数
  python tools/probe_find_callers.py 10883 --split  # 在 wasmcode1 里找
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.getcwd())

import wasm_probe_marker as M
import wasm_map as WM


def build_rev():
    from il2cpp_meta import TD_COUNT, tname, tmethods, mname, mtoken, img_of_type, img_name
    rev = {}
    for ti in range(TD_COUNT):
        ii = img_of_type(ti)
        if ii < 0:
            continue
        ptrs = WM.module_ptrs(img_name(ii))
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
                    rev.setdefault((mm, loc), set()).add(tn + '::' + mname(mi))
    return rev


def main():
    tgt = int(sys.argv[1], 0)
    mod = 'split' if '--split' in sys.argv else 'main'
    path = M.SPLIT if mod == 'split' else M.MAIN
    print('建索引…')
    rev = build_rev()
    m = M.Module(path)
    buf, ranges = m.body_ranges()
    n_imp, _ = m.import_counts()
    print(f'{os.path.basename(path)}：{len(ranges)} 个函数体，import {n_imp}')

    hits = []
    for bi, (s, e) in enumerate(ranges):
        body = buf[s:e]
        try:
            le = m.locals_end(body)
            ins = M.decode(body[le:])
        except Exception:
            continue
        cnt = 0
        for off, op in ins:
            if op == 0x10:
                v, _ = M.uleb(body, le + off + 1)
                if v == tgt:
                    cnt += 1
        if cnt:
            hits.append((bi + n_imp, cnt))

    print(f'找到 {len(hits)} 个调用点：')
    for idx, cnt in hits:
        names = rev.get((mod, idx))
        nm = ' | '.join(sorted(names)[:3]) if names else '?'
        print(f'  func[{idx}] ×{cnt}  {nm}')


if __name__ == '__main__':
    main()
