#!/usr/bin/env python3
"""probe_slots.py —— 方法名 → 函数表槽位（用于在页面里用 __indirect_function_table 直接调用）

背景：页面实测 `window.__wasmMainExports.__indirect_function_table` 是导出的，
      于是 JS 侧可以 `table.get(slot)(...)` 直接调用任意 IL2CPP 方法。
      本工具把「方法名」翻译成「槽位 + 签名线索」。

用法：
  python tools/probe_slots.py Transform::get_position
  python tools/probe_slots.py Camera::get_main --limit 5
  python tools/probe_slots.py WorldToScreenPoint          # 子串匹配
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.getcwd())

import wasm_map as WM
import probe_callmap as PC
from il2cpp_meta import tname, mname


def main():
    pat = sys.argv[1].lower()
    limit = 8
    if '--limit' in sys.argv:
        limit = int(sys.argv[sys.argv.index('--limit') + 1])

    n = PC.build()
    print('索引条目', n, '| main:', len(PC.REV['main']), 'split:', len(PC.REV['split']), flush=True)

    # local → [名字]
    want = {}   # (module, local) -> names
    hits = 0
    for mod in ('main', 'split'):
        for loc, lst in PC.REV[mod].items():
            names = []
            for ti, mi in lst[:4]:
                try:
                    full = tname(ti) + '::' + mname(mi)
                except Exception:
                    continue
                if pat in full.lower():
                    names.append(full)
            if names:
                want[(mod, loc)] = names
                hits += 1
    print('匹配到 %d 个函数体' % hits, flush=True)

    if not want:
        return

    # 反查表槽
    out = []
    for mod, tmap, size in (('main', WM.table_map1, 183184), ('split', WM.table_map2, 126552)):
        for t in range(size):
            loc = tmap.get(t)
            if loc is None:
                continue
            k = (mod, loc)
            if k in want:
                out.append((mod, loc, t, want[k]))
    print('表槽命中 %d 个' % len(out))
    seen = set()
    for mod, loc, t, names in out[:limit]:
        key = (mod, loc)
        if key in seen:
            continue
        seen.add(key)
        print('  %-5s func[%-6d] slot %-7d  %s' % (mod, loc, t, ' | '.join(names)))
    if len(out) > limit:
        print('  …(还有 %d 个，用 --limit 加大)' % (len(out) - limit))


if __name__ == '__main__':
    main()
