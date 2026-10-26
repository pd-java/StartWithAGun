"""patch-14861-v3.py — func[14861] 精确补丁：空字典守卫
---------------------------------------------------------------
14861 的逻辑：
    v = [arg2+16]          ; 字典对象
    w = [v+96]             ; 字典内部数组（浏览器 GLES3 路径下为 NULL）
    x = [w+56]             ; ← w=0 时读静态垃圾 → 一路传到 14903 崩溃
    ...
    r = 14903(...)         ; 字典查找
    return (r >= 0)        ; bool：是否命中

补丁：在 w 装入后插入
    local.get 2 ; i32.eqz ; if ; i32.const 0 ; return ; end
w == 0（字典空/未初始化）时返回 false（未命中）——
语义完全正确：空字典的 ContainsKey 就是 false。
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


TARGET = 14861
GUARD = bytes([0x20, 0x02,          # local.get 2   (w)
               0x45,                # i32.eqz
               0x04, 0x40,          # if (void)
               0x41, 0x00,          #   i32.const 0   (false = 未命中)
               0x0F,                #   return
               0x0B])               # end
ANCHOR = bytes([0x20, 0x08,         # local.get 8   (v)
                0x28, 0x02, 0x60,   # i32.load align=2 offset=96
                0x21, 0x02])        # local.set 2   (w = [v+96])


def main():
    path = sys.argv[1]
    bak = path + '.bak-14861'
    if not os.path.exists(bak):
        open(bak, 'wb').write(open(path, 'rb').read())
        print('已备份（当前版本，含 14903 补丁）->', bak)
    else:
        print('使用现有工作版本（保留 14903 补丁）')

    d2, sections = parse(path)
    bodies = get_code_bodies(d2, sections)
    imp = count_imported_functions(d2, sections)
    body_idx = TARGET - imp
    bs, be, cs = bodies[body_idx]
    instr = bytes(d2[cs:be])
    pos = instr.find(ANCHOR)
    assert pos >= 0, '未找到锚点'
    print('func[%d]: body 0x%x-0x%x, code@0x%x, 锚点偏移 %d'
          % (TARGET, bs, be, cs, pos))
    # 锚点可能出现两次（主路径 + 负长度分支），但主路径在前，
    # 在主路径处返回即可覆盖后续所有流程，只补丁第一处。

    new_instr = instr[:pos + len(ANCHOR)] + GUARD + instr[pos + len(ANCHOR):]

    # 找 code section
    p = 8
    sec_info = None
    while p < len(d2):
        sid = d2[p]; p += 1
        size, p2 = uleb(d2, p)
        if sid == 10:
            sec_info = (p, p2, p2 + size)
            break
        p = p2 + size
    size_pos, content_start, content_end = sec_info
    old_content = bytes(d2[content_start:content_end])

    q = 0
    count, q = uleb(old_content, q)
    out = bytearray()
    out += uleb_enc(count)
    for i in range(count):
        bsize, q2 = uleb(old_content, q)
        body = old_content[q2:q2 + bsize]
        q = q2 + bsize
        if i == body_idx:
            decls = body[:cs - bs]
            new_body = decls + new_instr
            out += uleb_enc(len(new_body)) + new_body
        else:
            out += uleb_enc(bsize) + body
    assert q == len(old_content)

    new_sec = uleb_enc(len(out))
    new_file = bytearray(d2[:size_pos]) + new_sec + out + bytearray(d2[content_end:])
    open(path, 'wb').write(new_file)
    print('补丁完成: func[%d] 增加空字典守卫 (+%d B)'
          % (TARGET, len(new_instr) - len(instr)))


if __name__ == '__main__':
    main()
