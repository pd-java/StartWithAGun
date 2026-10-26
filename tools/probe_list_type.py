#!/usr/bin/env python3
"""列出某类型的全部方法 → wasm 归属 + 函数体长度。

用法：python tools/probe_list_type.py FPSPlayerController [--bodies]
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.getcwd())

import wasm_map as WM
from wasm_patch_method import Wasm, WASM_PATH

want = sys.argv[1] if len(sys.argv) > 1 else 'FPSPlayerController'
show_bodies = '--bodies' in sys.argv

w = Wasm(open(WASM_PATH, 'rb').read())
w.load()

rows = WM.resolve(want, None)
for e in rows:
    loc = e.get('local')
    info = ''
    if loc is not None and e.get('module') == 'main':
        li = loc - w.n_imports
        if 0 <= li < len(w.bodies):
            blen = w.bodies[li][1]
            info = f'bodyLen={blen}'
    print(f"{e['method']:<34} tok=0x{e['token']:08x} table={e.get('table')} "
          f"mod={e.get('module')} local={loc} {info}")
