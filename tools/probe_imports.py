#!/usr/bin/env python3
"""列出 wasm 导入（import）函数的名称与索引。

用法：python tools/probe_imports.py [main|split] [--grep il2cpp]
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.getcwd())
import wasm_probe_marker as M


def uleb_pos(b, p):
    r = 0; s = 0
    while True:
        x = b[p]; p += 1
        r |= (x & 0x7f) << s
        s += 7
        if not x & 0x80:
            return r, p


def name_at(b, p):
    n, p = uleb_pos(b, p)
    return b[p:p + n].decode('utf-8', 'replace'), p + n


def parse(path):
    b = open(path, 'rb').read()
    p = 8
    while p < len(b):
        sid = b[p]; p += 1
        size, p2 = uleb_pos(b, p)
        if sid == 2:
            q = p2
            cnt, q = uleb_pos(b, q)
            out = []
            fi = 0
            for _ in range(cnt):
                mod, q = name_at(b, q)
                fld, q = name_at(b, q)
                kind = b[q]; q += 1
                if kind == 0:          # func: typeidx
                    _, q = uleb_pos(b, q)
                    out.append((fi, mod, fld)); fi += 1
                elif kind == 1:        # table
                    q += 1
                    fl = b[q]; q += 1
                    _, q = uleb_pos(b, q)
                    if fl: _, q = uleb_pos(b, q)
                elif kind == 2:        # mem
                    fl = b[q]; q += 1
                    _, q = uleb_pos(b, q)
                    if fl: _, q = uleb_pos(b, q)
                elif kind == 3:        # global
                    q += 1
                    q += 1
                else:
                    raise SystemExit('unknown import kind %d' % kind)
            return out
        p = p2 + size
    return []


if __name__ == '__main__':
    which = 'main'
    for a in sys.argv[1:]:
        if a in ('main', 'split'):
            which = a
    path = M.SPLIT if which == 'split' else M.MAIN
    imps = parse(path)
    grep = None
    if '--grep' in sys.argv:
        grep = sys.argv[sys.argv.index('--grep') + 1]
    print('%s: %d 个函数导入' % (which, len(imps)))
    for fi, mod, fld in imps:
        line = '%4d  %s.%s' % (fi, mod, fld)
        if grep and grep not in line:
            continue
        print(line)
