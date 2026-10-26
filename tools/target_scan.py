#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
target_scan.py —— 从一张全分辨率截图里找出靶场敌人（含准星精确位置）

实测事实（全部来自截图测量，不是猜）：
  准星：纯白细十字，四段笔画（上/下/左/右）的对称中心 = (0.5000, 0.4994)。
        截图为 984x905，画布铺满视口，所以截图归一化坐标 == 画布归一化坐标。
  敌人：灰蓝色人形剪影，头顶有一个**纯红竖直小条**，RGB 恰为 (255, 15, 0)。
        全图纯红像素只有 20~30 个，混凝土隔离墩/灌木/沙地都不会产生这个颜色，
        所以红色标记是唯一不会被布景混淆的身份锚点。
        标记中心到靶身质心的竖直偏移约 0.016（实测 0.0144 与 0.0182）。

因此敌人定位流程：
  1) 找纯红小条 → 每个就是一个敌人
  2) 从红条往下在 (x±0.022, y+0.005 .. y+0.055) 窗口里取 lum<160 的像素质心 → 靶身中心
  3) 窗口里像素太少则退回「红条中心 + 0.016」

用法:
  python target_scan.py <png>            # 人类可读
  python target_scan.py <png> --json     # 机器可读
"""
import sys, json
import numpy as np
from PIL import Image
from scipy import ndimage

RET_X, RET_Y = 0.5000, 0.4994
MARK_DY = 0.016


def find_reticle(a, w, h):
    """准星 = 纯白细十字；用四段笔画的交点求中心，比整块质心稳。"""
    R, G, B = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    white = (R > 238) & (G > 238) & (B > 238)
    white[: int(0.42 * h)] = False
    white[int(0.58 * h):] = False
    white[:, : int(0.40 * w)] = False
    white[:, int(0.60 * w):] = False
    lbl, n = ndimage.label(white)
    hs, vs = [], []
    for i, sl in enumerate(ndimage.find_objects(lbl), start=1):
        ys, xs = sl
        bw, bh = xs.stop - xs.start, ys.stop - ys.start
        if (lbl[sl] == i).sum() < 8:
            continue
        cx, cy = (xs.start + xs.stop) / 2, (ys.start + ys.stop) / 2
        if bw >= 3 * max(1, bh):
            hs.append((cx, cy))          # 横笔画
        elif bh >= 3 * max(1, bw):
            vs.append((cx, cy))          # 竖笔画
    if len(hs) >= 2 and len(vs) >= 2:
        return (sum(p[0] for p in vs) / len(vs)) / w, (sum(p[1] for p in hs) / len(hs)) / h, 'strokes'
    if len(hs) >= 1 and len(vs) >= 1:
        return (sum(p[0] for p in vs) / len(vs)) / w, (sum(p[1] for p in hs) / len(hs)) / h, 'partial'
    return RET_X, RET_Y, 'default'


def scan(path, y0=0.30, y1=0.66, x0=0.03, x1=0.97):
    im = Image.open(path).convert('RGB')
    a = np.asarray(im, dtype=np.float32)
    h, w, _ = a.shape
    R, G, B = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    lum = R * 0.299 + G * 0.587 + B * 0.114

    ret_x, ret_y, ret_src = find_reticle(a, w, h)

    # ── 纯红标记（(255,15,0) 量级）──────────────────────────
    red = (R >= 180) & (G <= 90) & (B <= 90)
    red[: int(y0 * h)] = False
    red[int(y1 * h):] = False
    rl, _ = ndimage.label(red)
    marks = []
    for i, sl in enumerate(ndimage.find_objects(rl), start=1):
        ys, xs = sl
        area = int((rl[sl] == i).sum())
        bw, bh = xs.stop - xs.start, ys.stop - ys.start
        if area < 5 or bw > 14 or bh > 30:
            continue
        marks.append({
            'x': round(((xs.start + xs.stop) / 2) / w, 4),
            'y': round(((ys.start + ys.stop) / 2) / h, 4),
            'area': area, 'w': bw, 'h': bh,
        })

    # ── 从标记往下找靶身质心 ────────────────────────────────
    enemies = []
    for m in marks:
        mx, my = m['x'], m['y']
        wx0 = max(0, int((mx - 0.022) * w)); wx1 = min(w, int((mx + 0.022) * w))
        wy0 = max(0, int((my + 0.005) * h)); wy1 = min(h, int((my + 0.055) * h))
        win = lum[wy0:wy1, wx0:wx1] < 160
        cnt = int(win.sum())
        if cnt >= 20:
            ys2, xs2 = np.nonzero(win)
            bx = (xs2.mean() + wx0) / w
            by = (ys2.mean() + wy0) / h
            src = 'body-centroid'
        else:
            bx, by, src = mx, my + MARK_DY, 'marker-offset'
        enemies.append({
            'x': round(bx, 4), 'y': round(by, 4),
            'markerX': mx, 'markerY': my, 'bodyPx': cnt, 'source': src,
            'errX': round(bx - ret_x, 4), 'errY': round(by - ret_y, 4),
            'dist': round(((bx - ret_x) ** 2 + (by - ret_y) ** 2) ** 0.5, 4),
        })
    enemies.sort(key=lambda e: e['dist'])

    # ── 兜底：深色人形（红标没渲染出来时用）─────────────────
    dark = lum < 118
    dark[: int(0.36 * h)] = False
    dark[int(0.63 * h):] = False
    dark[:, : int(x0 * w)] = False
    dark[:, int(x1 * w):] = False
    lbl, n = ndimage.label(dark)
    darks = []
    for i, sl in enumerate(ndimage.find_objects(lbl), start=1):
        ys, xs = sl
        area = int((lbl[sl] == i).sum())
        bw, bh = xs.stop - xs.start, ys.stop - ys.start
        if area < 35 or area > 2000 or bw > 45 or bh > 80 or bh < bw * 1.05:
            continue
        cx = ((xs.start + xs.stop) / 2) / w
        cy = ((ys.start + ys.stop) / 2) / h
        darks.append({'x': round(cx, 4), 'y': round(cy, 4), 'w': bw, 'h': bh, 'area': area,
                      'dist': round(((cx - ret_x) ** 2 + (cy - ret_y) ** 2) ** 0.5, 4)})
    darks.sort(key=lambda t: t['dist'])

    return {
        'size': [w, h],
        'reticle': {'x': round(ret_x, 4), 'y': round(ret_y, 4), 'source': ret_src},
        'marks': marks,
        'enemies': enemies,
        'darks': darks,
    }


if __name__ == '__main__':
    res = scan(sys.argv[1])
    if '--json' in sys.argv:
        print(json.dumps(res))
    else:
        print('size', res['size'], 'reticle', res['reticle'])
        print('marks', res['marks'])
        print('enemies:')
        for e in res['enemies']:
            print('  (%0.4f,%0.4f) err=(%+.4f,%+.4f) dist=%0.4f %s bodyPx=%d'
                  % (e['x'], e['y'], e['errX'], e['errY'], e['dist'], e['source'], e['bodyPx']))
        print('darks (fallback, top 5):')
        for t in res['darks'][:5]:
            print('  (%0.4f,%0.4f) %dx%d a=%d dist=%0.4f' % (t['x'], t['y'], t['w'], t['h'], t['area'], t['dist']))
