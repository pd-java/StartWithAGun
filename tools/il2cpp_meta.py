#!/usr/bin/env python3
"""il2cpp global-metadata v31 解析器：类型/方法名 → token。"""
import struct, json, sys

D = open('extracted/global-metadata.dat', 'rb').read()
H = struct.unpack('<' + 'i' * 66, D[:264])
PAIRS = [(H[2 + i * 2], H[3 + i * 2]) for i in range(32)]
STR_OFF, STR_SIZE = PAIRS[2]
TD_OFF, TD_SIZE = PAIRS[19]
M_OFF, M_SIZE = PAIRS[5]
LIT_OFF, LIT_SIZE = PAIRS[0]
LITD_OFF, LITD_SIZE = PAIRS[1]

TD_STRIDE = 88
M_STRIDE = 36
TD_COUNT = TD_SIZE // TD_STRIDE
M_COUNT = M_SIZE // M_STRIDE


def cstr(off):
    end = D.index(b'\x00', STR_OFF + off)
    return D[STR_OFF + off:end].decode('utf-8', 'replace')


def mname(mi):
    ni = struct.unpack_from('<i', D, M_OFF + mi * M_STRIDE)[0]
    return cstr(ni)


def mtoken(mi):
    return struct.unpack_from('<I', D, M_OFF + mi * M_STRIDE + 24)[0]


def mdeclaring(mi):
    return struct.unpack_from('<i', D, M_OFF + mi * M_STRIDE + 4)[0]


def tname(ti):
    ni, ns = struct.unpack_from('<ii', D, TD_OFF + ti * TD_STRIDE)
    n, s = cstr(ni), cstr(ns)
    return (s + '.' + n) if s else n


def tmethods(ti):
    ms = struct.unpack_from('<i', D, TD_OFF + ti * TD_STRIDE + 36)[0]
    mc = struct.unpack_from('<H', D, TD_OFF + ti * TD_STRIDE + 64)[0]
    return ms, mc


def tfields(ti):
    fs = struct.unpack_from('<i', D, TD_OFF + ti * TD_STRIDE + 32)[0]
    fc = struct.unpack_from('<H', D, TD_OFF + ti * TD_STRIDE + 68)[0]
    return fs, fc


def literal(idx):
    ln, di = struct.unpack_from('<Ii', D, LIT_OFF + idx * 8)
    return D[LITD_OFF + di:LITD_OFF + di + ln].decode('utf-8', 'replace')


# ---- images（程序集）----
IMG_OFF, IMG_SIZE = PAIRS[20]
IMG_STRIDE = 40
IMG_COUNT = IMG_SIZE // IMG_STRIDE


def img_name(ii):
    ni = struct.unpack_from('<i', D, IMG_OFF + ii * IMG_STRIDE)[0]
    return cstr(ni)


def img_type_range(ii):
    ts, tc = struct.unpack_from('<ii', D, IMG_OFF + ii * IMG_STRIDE + 8)
    return ts, tc


def img_of_type(ti):
    for ii in range(IMG_COUNT):
        ts, tc = img_type_range(ii)
        if ts <= ti < ts + tc:
            return ii
    return -1


def find_literal(s):
    # 在 stringLiteralData 中找到字符串位置，再反查 literal 索引
    tgt = s.encode('utf-8')
    i = D.find(tgt, LITD_OFF, LITD_OFF + LITD_SIZE)
    if i < 0:
        return -1
    di = i - LITD_OFF
    for k in range(LIT_SIZE // 8):
        ln, d0 = struct.unpack_from('<Ii', D, LIT_OFF + k * 8)
        if d0 == di and ln == len(tgt):
            return k
    return -1


if __name__ == '__main__':
    print(f'types={TD_COUNT} methods={M_COUNT}')
    # 找关键类型
    targets = ['TutorialService', 'LeagueService', 'LeagueSaveData']
    for ti in range(TD_COUNT):
        n = tname(ti)
        base = n.split('.')[-1]
        if base in targets or n.startswith('SniperSeige') and 'League' in n:
            ms, mc = tmethods(ti)
            print(f'[{ti}] {n} methods={mc}')
            if base in targets:
                for mi in range(ms, ms + mc):
                    print(f'    token=0x{mtoken(mi):08x} rid={mtoken(mi) & 0xFFFFFF} {mname(mi)}')
