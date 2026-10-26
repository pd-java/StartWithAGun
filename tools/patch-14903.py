"""patch-14903.py — 给 wasmcode_decompressed.wasm 的 func[14903] 打安全补丁
---------------------------------------------------------------
func[14903] 是一个泛型 Dictionary 查找（TryGetValue 语义）。
在浏览器 GLES3 路径下，它读到的字典内部数组指针为 NULL，
第一帧就触发 memory access out of bounds。

补丁：整个函数体替换为  return -1（"未找到"）。
函数内本来就有 -1 返回路径（arg0 为空时），所有 4 个调用者
（14853/14861/14902/14913）都能正确处理未命中。

用法:
    python patch-14903.py <wasm路径>          # 打补丁
    python patch-14903.py <wasm路径> --revert # 还原备份
"""
import sys, shutil, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wasm_dis_lib import parse, get_code_bodies, count_imported_functions

TARGET = 14903  # 全局函数索引（含 import 偏移）


def main():
    path = sys.argv[1]
    revert = '--revert' in sys.argv
    bak = path + '.bak-14903'

    if revert:
        if os.path.exists(bak):
            shutil.copyfile(bak, path)
            print('已还原:', bak, '->', path)
        else:
            print('没有备份文件', bak)
        return

    d = open(path, 'rb').read()
    if not os.path.exists(bak):
        shutil.copyfile(path, bak)
        print('已备份 ->', bak)

    d = bytearray(d)
    secs = parse(path)[1]
    bodies = get_code_bodies(d, secs)
    imp = count_imported_functions(d, secs)
    body_idx = TARGET - imp
    bs, be, cs = bodies[body_idx]
    print('func[%d]: body 0x%x-0x%x (%d B), code@0x%x'
          % (TARGET, bs, be, be - bs, cs))

    # 新指令序列: i32.const -1; return; nop*; end
    # 必须保持 body 总长度不变（body-size LEB 不改）
    instr_len = be - cs          # 原 code 长度（不含 local decls）
    new = bytearray()
    new += bytes([0x41, 0x7F])   # i32.const -1
    new += bytes([0x0F])         # return
    while len(new) < instr_len - 1:
        new += bytes([0x01])     # nop 填充
    new += bytes([0x0B])         # end
    assert len(new) == instr_len, (len(new), instr_len)

    d[cs:be] = new
    open(path, 'wb').write(d)
    print('补丁完成: func[%d] -> 恒返回 -1（未命中）' % TARGET)


if __name__ == '__main__':
    main()
