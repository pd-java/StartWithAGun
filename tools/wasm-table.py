"""
wasm-table.py — 解析 wasm 的 elem 段，把函数表建起来
------------------------------------------------------------
用于回答：call_indirect <tableIdx> 实际会调到哪个函数？
"""
import sys
from wasm_dis_lib import uleb, sleb, parse, get_code_bodies


def parse_elem(d, start, end):
    """返回 {table_index: (offset, [func_idx...])}"""
    p = start
    out = []
    count, p = uleb(d, p)
    for _ in range(count):
        flags, p = uleb(d, p)
        if flags == 0:
            # active, table 0, offset expr
            assert d[p] == 0x41, d[p]
            p += 1
            off, p = sleb(d, p)
            p += 1  # end
            n, p = uleb(d, p)
            funcs = []
            for _ in range(n):
                f, p = uleb(d, p)
                funcs.append(f)
            out.append((0, off, funcs))
        else:
            raise NotImplementedError('elem flags=%d' % flags)
    return out


if __name__ == '__main__':
    path = sys.argv[1]
    d, secs = parse(path)
    rows = []
    for (s, e) in secs.get(9, []):
        rows.extend(parse_elem(d, s, e))
    total = sum(len(r[2]) for r in rows)
    print('elem 段数 =', len(rows), '| 表项总数 =', total)
    for (ti, off, funcs) in rows:
        print('  table %d: offset=%d, count=%d, 前 5 项 = %s' % (ti, off, len(funcs), funcs[:5]))

    want = [int(x) for x in sys.argv[2:]] if len(sys.argv) > 2 else []
    for w in want:
        for (ti, off, funcs) in rows:
            if off <= w < off + len(funcs):
                print('\n表项[%d] -> func[%d]  (来自 table %d, off=%d)' % (w, funcs[w - off], ti, off))
                break
        else:
            print('\n表项[%d] 未在 elem 段中找到' % w)
