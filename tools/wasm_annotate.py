#!/usr/bin/env python3
"""wasm_annotate.py —— 反汇编指定 C# 方法，并把 call 目标标注成方法名。

用法：
  python tools/wasm_annotate.py "Type::Method" ["Type::Method" ...]
  python tools/wasm_annotate.py --fi 7180
"""
import sys, os, json, re, io, importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wasm_map as WM

spec = importlib.util.spec_from_file_location('wd', os.path.join(HERE, 'wasm-dis.py'))
wd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wd)

WASM = os.path.join(os.path.dirname(HERE), 'web', 'assets', 'wasmcode_decompressed.wasm')
NAMES = json.load(open(os.path.join(HERE, 'fi_names.json'), encoding='utf-8'))

_d = None
_bodies = None
_imp = None


def load():
    global _d, _bodies, _imp
    if _d is None:
        _d, secs = wd.parse(WASM)
        _bodies = wd.get_code_bodies(_d, secs)
        _imp = wd.count_imported_functions(_d, secs)
    return _d, _bodies, _imp


def name_of(fi):
    v = NAMES.get(str(fi))
    if not v:
        return None
    return v[0].split('::')[-1] if len(v) == 1 else v[0]


def annotate(fi, max_lines=400):
    d, bodies, imp = load()
    bi = fi - imp
    if bi < 0 or bi >= len(bodies):
        print('FI', fi, '超范围')
        return
    bs, be, cs = bodies[bi]
    print('===== FI %d  body %d  size %d' % (fi, bi, be - bs))
    buf = io.StringIO()
    old = sys.stdout
    sys.stdout = buf
    try:
        wd.disasm(d, cs, be, limit=1000000)
    finally:
        sys.stdout = old
    lines = buf.getvalue().splitlines()
    for i, l in enumerate(lines):
        m = re.match(r'(\s*[0-9a-f]+\s+)call\s+(\d+)', l)
        if m:
            nm = name_of(int(m.group(2)))
            if nm:
                l = l + '   ; ' + nm
        if i >= max_lines:
            print('   ... 省略剩余 %d 行' % (len(lines) - i))
            break
        print(l)


if __name__ == '__main__':
    args = sys.argv[1:]
    if args and args[0] == '--fi':
        for a in args[1:]:
            annotate(int(a))
    else:
        for a in args:
            tn, mn = a.split('::', 1)
            for e in WM.resolve(tn, mn):
                annotate(e['local'])
