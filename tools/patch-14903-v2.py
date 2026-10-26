"""patch-14903-v2.py — func[14903] 精确补丁：NULL 守卫
---------------------------------------------------------------
在 func[14903] 原始代码的
    local.get 2 ; i32.load offset=16 ; local.set 3   (local3 = [arg2+16])
之后插入 NULL 守卫：
    local.get 3 ; i32.eqz ; if ; i32.const -1 ; return ; end
链为 NULL（浏览器环境下字典内部数组未初始化）时返回 -1（未找到），
否则执行原始逻辑 —— 健康路径完全不受影响。

因为要往函数体里插入字节，必须重建整个 code section。
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


TARGET = 14903
GUARD = bytes([0x20, 0x03,          # local.get 3
               0x45,                # i32.eqz
               0x04, 0x40,          # if (void)
               0x41, 0x7F,          #   i32.const -1
               0x0F,                #   return
               0x0B])               # end
ANCHOR = bytes([0x20, 0x02,         # local.get 2
                0x28, 0x02, 0x10,   # i32.load align=2 offset=16
                0x21, 0x03])        # local.set 3


def main():
    path = sys.argv[1]
    bak = path + '.bak-14903-v2'
    d = open(path, 'rb').read()
    if not os.path.exists(bak):
        # 备份应当是“原始未补丁”的版本
        shutil_src = path + '.bak-14903'
        if os.path.exists(shutil_src):
            d = open(shutil_src, 'rb').read()
        open(bak, 'wb').write(d)
        print('已备份（原始版本）->', bak)
    else:
        d = open(bak, 'rb').read()  # 总是从原始版本出发
        print('从原始备份出发:', bak)

    data = bytearray(d)
    d2, sections = parse(bak)
    bodies = get_code_bodies(d2, sections)
    imp = count_imported_functions(d2, sections)
    body_idx = TARGET - imp
    bs, be, cs = bodies[body_idx]
    instr = bytes(d2[cs:be])
    pos = instr.find(ANCHOR)
    assert pos >= 0, '未找到锚点指令序列'
    # 锚点后应紧跟 local.get 3; i32.load offset=96（崩溃指令）
    print('func[%d]: body 0x%x-0x%x, code@0x%x, 锚点偏移 %d'
          % (TARGET, bs, be, cs, pos))
    assert instr[pos + len(ANCHOR):pos + len(ANCHOR) + 3] == bytes([0x20, 0x03, 0x28]), \
        '锚点后不是 local.get 3; i32.load'

    new_instr = instr[:pos + len(ANCHOR)] + GUARD + instr[pos + len(ANCHOR):]

    # ── 重建 code section ──
    # 找到 section 10 的起始（含 size LEB）
    p = 8
    sec_pos = {}
    while p < len(d2):
        sid = d2[p]; p += 1
        size, p2 = uleb(d2, p)
        sec_pos[sid] = (p, p2)          # (size LEB 位置, 内容起始)
        p = p2 + size
    size_pos, content_start = sec_pos[10]

    # 原 code section 内容
    _, old_end = sec_pos[10]
    old_end = old_end  # 内容起始
    # 重新计算 section 真实结束：sec_pos 存的是 (sizeLEB起点, 内容起点)
    p = 8
    while p < len(d2):
        sid = d2[p]; p += 1
        size, p2 = uleb(d2, p)
        if sid == 10:
            content_end = p2 + size
            break
        p = p2 + size

    old_content = bytes(d2[content_start:content_end])

    # 解析旧内容: count + bodies(uleb size + bytes)
    q = 0
    count, q = uleb(old_content, q)
    assert count == len(bodies), (count, len(bodies))
    out = bytearray()
    out += uleb_enc(count)
    for i in range(count):
        bsize, q2 = uleb(old_content, q)
        body = old_content[q2:q2 + bsize]
        q = q2 + bsize
        if i == body_idx:
            # 该 body = local decls + instructions
            # decls 长度 = cs - bs
            decls = body[:cs - bs]
            new_body = decls + new_instr
            out += uleb_enc(len(new_body)) + new_body
        else:
            out += uleb_enc(bsize) + body
    assert q == len(old_content)

    # 组装新文件
    new_sec = uleb_enc(len(out))
    delta = (len(new_sec) + len(out)) - ((size_pos and 0) or 0)  # placeholder
    # 旧 section 占用: [size_pos, content_end)
    old_total = content_end - size_pos
    new_total = len(new_sec) + len(out)
    new_file = bytearray(d2[:size_pos]) + new_sec + out + bytearray(d2[content_end:])
    open(path, 'wb').write(new_file)
    print('补丁完成: code section %d B -> %d B (delta %+d)'
          % (old_total, new_total, new_total - old_total))


if __name__ == '__main__':
    main()
