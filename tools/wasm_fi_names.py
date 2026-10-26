#!/usr/bin/env python3
"""wasm_fi_names.py —— 建立「主模块函数索引(FI) → C# 方法名」反查表。

原理：methodPointers[rid-1] = 表索引 → elem 段 表索引→FI（模块索引空间）。
反向聚合后即可把反汇编里的 `call <FI>` 直接翻译成 C# 方法名。

用法：
  python tools/wasm_fi_names.py build   # 生成 tools/fi_names.json
  python tools/wasm_fi_names.py look 9453 5092
"""
import sys, os, json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wasm_map as WM

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fi_names.json')


def build():
    # table -> FI（主模块）
    table_to_fi = dict(WM.table_map1)
    # table -> [方法名]
    table_to_names = {}
    ptrcache = {}
    for ti in range(WM.TD_COUNT):
        ms, mc = WM.tmethods(ti)
        if mc == 0:
            continue
        ii = WM.img_of_type(ti)
        if ii < 0:
            continue
        if ii not in ptrcache:
            ptrcache[ii] = WM.module_ptrs(WM.img_name(ii))
        ptrs = ptrcache[ii]
        if not ptrs:
            continue
        tn = WM.tname(ti)
        for mi in range(ms, ms + mc):
            rid = WM.mtoken(mi) & 0xFFFFFF
            if 1 <= rid <= len(ptrs):
                t = ptrs[rid - 1]
                if t in table_to_fi:
                    table_to_names.setdefault(t, []).append(tn + '::' + WM.mname(mi))

    fi_to_names = {}
    for t, names in table_to_names.items():
        fi = table_to_fi[t]
        lst = fi_to_names.setdefault(str(fi), [])
        for n in names:
            if n not in lst:
                lst.append(n)

    json.dump(fi_to_names, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
    print('写出', OUT, '条目', len(fi_to_names))


def look(fis):
    m = json.load(open(OUT, encoding='utf-8'))
    for f in fis:
        print(f, '->', m.get(str(f), '(无)'))


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'look':
        look(sys.argv[2:])
    else:
        build()
