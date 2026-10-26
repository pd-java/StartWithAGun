#!/usr/bin/env python3
"""校验 decode() 能完整解码两个模块的所有函数体（不改任何文件）。"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import wasm_probe_marker as M

for path in (M.MAIN, M.SPLIT):
    m = M.Module(path)
    buf, ranges = m.body_ranges()
    bad = 0
    errs = {}
    for k, (s, e) in enumerate(ranges):
        body = buf[s:e]
        try:
            le = m.locals_end(body)
            M.decode(body[le:])
        except Exception as ex:
            bad += 1
            key = str(ex)[:60]
            errs[key] = errs.get(key, 0) + 1
    print('%-34s 函数体 %d 个，解码失败 %d 个' % (os.path.basename(path), len(ranges), bad))
    for k, v in sorted(errs.items(), key=lambda x: -x[1])[:8]:
        print('    %5d × %s' % (v, k))
