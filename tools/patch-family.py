"""patch-family.py — Dictionary 工具族通用 NULL 守卫补丁
---------------------------------------------------------------
背景：浏览器 GLES3 路径下，某字典内部数组指针 [v+0x60](=96) 为 NULL，
族内函数（14853/14860/14861/14884/14902/14903/14904/14913 ...）
在 [w+0x38](=56)/[w+0x3C](=60) 处越界。

模式（v2 修正）：
    i32.load offset=16      -- 28 02 10 21 <a>     -> local.set a ; 栈上是 obj
    local.get a
    i32.load offset=96      -- 20 <a> 28 02 60 21 <w>  -> local.set w
    local.get w ; i32.load offset=56/60   -- 20 <w> 28 ...

守卫（插入在 local.set w 之后）：
    local.get w ; i32.eqz ; if ; <miss> ; end
  <miss>：函数无返回值 → return
          函数有返回值   → i32.const -1 ; return
只在 w==0（本会崩溃的路径）时改变行为，健康路径零影响。
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wasm_dis_lib import parse, get_code_bodies, count_imported_functions, uleb


def uleb_enc(v):
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def parse_types(d2, sections):
    """返回 {type_idx: results_count} 和 {func_idx: type_idx}"""
    results = {}
    if 1 in sections:
        s, e = sections[1][0]
        p = s
        n, p = uleb(d2, p)
        for i in range(n):
            form = d2[p]; p += 1
            assert form == 0x60, 'type %d form 0x%02x' % (i, form)
            np, p = uleb(d2, p)
            p += np                     # 参数类型（i32/i64/f32/f64 均 1 字节）
            nr, p = uleb(d2, p)
            results[i] = nr
            p += nr
    func_types = {}
    if 3 in sections:
        s, e = sections[3][0]
        p = s
        n, p = uleb(d2, p)
        for i in range(n):
            t, p = uleb(d2, p)
            func_types[i] = t
    return results, func_types


# i32.load offset=16 ; local.set a
ANCHOR_HEAD = bytes([0x28, 0x02, 0x10, 0x21])


def find_patterns(instr):
    """找 [28 02 10 21 a 20 a 28 02 60 21 w 20 w 28 02 (38|3C)]
    返回 [(anchor_pos, a, w, set_pos)]，set_pos = 插守卫位置"""
    out = []
    i = 0
    n = len(instr)
    while True:
        i = instr.find(ANCHOR_HEAD, i)
        if i < 0:
            break
        # 28 02 10 21 a          (0..4)
        # 20 a                   (5..6)
        # 28 02 60               (7..9)    i32.load offset=96
        # 21 w                   (10..11)
        # 20 w                   (12..13)
        # 28 02 38/3C            (14..16)
        if i + 17 <= n:
            a = instr[i + 4]
            head_ok = (instr[i + 5] == 0x20 and instr[i + 6] == a and
                       instr[i + 7:i + 10] == bytes([0x28, 0x02, 0x60]) and
                       instr[i + 10] == 0x21)
            if head_ok:
                w = instr[i + 11]
                tail_ok = (instr[i + 12] == 0x20 and instr[i + 13] == w and
                           instr[i + 14] == 0x28 and instr[i + 15] == 0x02 and
                           instr[i + 16] in (0x38, 0x3C))
                if tail_ok:
                    out.append((i, a, w, i + 12))
        i += 1
    return out


def locate_code_section(d2):
    """返回 (size_leb_start, content_start, content_end)"""
    p = 8
    while p < len(d2):
        sid = d2[p]
        p += 1
        size_start = p
        size, p2 = uleb(d2, p)
        if sid == 10:
            return size_start, p2, p2 + size
        p = p2 + size
    raise RuntimeError('未找到 code section (id=10)')


def main():
    path = sys.argv[1]
    bak = path + '.bak-family'
    if not os.path.exists(bak):
        open(bak, 'wb').write(open(path, 'rb').read())
        print('已备份（当前工作版本）->', bak)
    else:
        print('使用现有工作版本（备份已存在）')

    d2, sections = parse(path)
    bodies = get_code_bodies(d2, sections)
    imp = count_imported_functions(d2, sections)
    results, func_types = parse_types(d2, sections)
    print('导入函数 %d  函数体 %d  type 数 %d' % (imp, len(bodies), len(results)))

    plan = []
    already = []
    for bi, (bs, be, cs) in enumerate(bodies):
        fi = bi + imp
        instr = bytes(d2[cs:be])
        pats = find_patterns(instr)
        if not pats:
            continue
        # 取最后一个匹配（通常是主路径），避免重复插守卫
        pos, a, w, ipos = pats[-1]
        # 已补丁：ipos 处是 20 w 45 04 40
        if instr[ipos:ipos + 5] == bytes([0x20, w, 0x45, 0x04, 0x40]):
            already.append(fi)
            continue
        nr = results.get(func_types.get(fi, -1), 0)
        if nr == 0:
            miss = bytes([0x0F])                    # void -> return
        else:
            miss = bytes([0x41, 0x7F, 0x0F])        # i32.const -1 ; return
        guard = bytes([0x20, w, 0x45, 0x04, 0x40]) + miss + bytes([0x0B])
        plan.append((bi, fi, ipos, guard, w, nr, len(pats)))

    print('已补丁函数 %d 个: %s' % (len(already), already))
    print('待补丁函数 %d 个:' % len(plan))
    for bi, fi, ipos, guard, w, nr, np_ in plan:
        print('   func[%d] body#%d w=local%d ret=%d 匹配%d处 插于 +%d 守卫=%s'
              % (fi, bi, w, nr, np_, ipos, guard.hex()))

    if not plan:
        print('无需补丁，退出')
        return

    size_start, content_start, content_end = locate_code_section(d2)
    old_content = bytes(d2[content_start:content_end])
    q = 0
    count, q = uleb(old_content, q)
    assert count == len(bodies), 'code 条目数 %d != 函数体数 %d' % (count, len(bodies))

    out = bytearray()
    out += uleb_enc(count)
    plan_by_bi = {p[0]: p for p in plan}
    for i in range(count):
        bsize, q2 = uleb(old_content, q)
        body = old_content[q2:q2 + bsize]
        q = q2 + bsize
        if i in plan_by_bi:
            bi, fi, ipos, guard, w, nr, np_ = plan_by_bi[i]
            bs, be, cs = bodies[i]
            decls = body[:cs - bs]
            instr = body[cs - bs:]
            assert ipos <= len(instr), 'func[%d] ipos %d > %d' % (fi, ipos, len(instr))
            new_instr = instr[:ipos] + guard + instr[ipos:]
            new_body = decls + new_instr
            out += uleb_enc(len(new_body)) + new_body
        else:
            out += uleb_enc(bsize) + body
    assert q == len(old_content), '解析未对齐: %d != %d' % (q, len(old_content))

    new_file = bytearray(d2[:size_start]) + uleb_enc(len(out)) + out + bytearray(d2[content_end:])
    open(path, 'wb').write(new_file)
    print('族补丁完成：补 %d 个函数，文件 %d -> %d 字节 (+%d)'
          % (len(plan), len(d2), len(new_file), len(new_file) - len(d2)))


if __name__ == '__main__':
    main()
