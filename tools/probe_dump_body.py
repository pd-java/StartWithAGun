#!/usr/bin/env python3
"""dump: 查看若干 wasm 函数体头部字节，判断是否是 ICF 合并的共享桩。

用法：python tools/probe_dump_body.py <local> [<local> ...]
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

from wasm_patch_method import Wasm, WASM_PATH

w = Wasm(open(WASM_PATH, 'rb').read())
w.load()
print(f'函数体 {len(w.bodies)} 个，import func {w.n_imports} 个，类型 {len(w.types)} 个')

for a in sys.argv[1:]:
    loc = int(a, 0)
    li = loc - w.n_imports
    params, rets = w.types[w.func_types[li]]
    body = w.body(li)
    print(f'local={loc} body#{li} params={params.hex()} rets={rets.hex()} len={len(body)}')
    print('   ', body[:48].hex())
