#!/usr/bin/env python3
"""列出射击链路候选方法的 wasm 归属（main / split）与局部函数索引。

用法：python tools/probe_resolve.py
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.getcwd())

import wasm_map as WM

TARGETS = [
    ('FPSPlayerController', 'Shoot'),
    ('FPSPlayerController', 'ShootAsync'),
    ('FPSPlayerController', 'ShootRoutine'),
    ('FPSPlayerController', 'AllowAimingCheck'),
    ('FPSPlayerController', 'TryAimAtInitialTutorialTarget'),
    ('FPSPlayerController', 'SetAimingDirection'),
    ('FPSPlayerController', 'SetZoomPercent'),
    ('FPSPlayerController', 'get_IsUsingZoomSlider'),
    ('FPSPlayerController', 'get_TimeSinceLastShot'),
    ('PlayerController', 'get_InputBlocked'),
    ('PlayerController', 'SetInputBlock'),
    ('SequenceEvent', 'get_HasInputBlock'),
    ('SequenceEvent', 'SetInputBlockOverride'),
]

for tn, mn in TARGETS:
    res = WM.resolve(tn, mn)
    if not res:
        print(f'-- {tn}::{mn}  (未解析)')
        continue
    for e in res:
        print(f"{tn}::{mn}  image={e.get('image')} token=0x{e['token']:08x} "
              f"table={e.get('table')} module={e.get('module')} local={e.get('local')}")
