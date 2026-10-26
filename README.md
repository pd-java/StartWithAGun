# 开局带把枪（SniperSiege）· 本地离线版

微信小游戏【开局带把枪】（Voodoo · SniperSiege，appid `wx97389648b73dfeca`）
的完整离线逆向版。**无需联网、无需微信**，本地启动后直接在浏览器里玩。

## 启动

```bash
cd web
node server.js          # 默认 http://127.0.0.1:8848
node server.js 9000     # 指定端口
node server.js 9000 --open   # 启动后自动打开浏览器
```

然后在浏览器打开 **http://127.0.0.1:8848/**，点「开始游戏」即可。

- 首次进入需加载约 60 秒（本地读取 69 个资源包 + 软解 ASTC 纹理），之后有浏览器缓存会快很多。
- 可选参数：`?verbose`（详细日志）、`?debug`（调试面板）。
- 鼠标 = 瞄准/射击，与手机触屏操作一致。

## 目录结构

```
MyGame/
├─ web/                     ← 玩的入口（server.js 也在这里）
│  ├─ index.html            启动页 + 遮罩 UI
│  ├─ server.js             零依赖本地静态服务器（支持 Range / wasm MIME / COOP+COEP）
│  ├─ wx-shim.js            微信 API 离线模拟层（登录/广告/云存档/埋点/Addressables 分流）
│  ├─ wx-loader.js          微信小游戏模块运行时（define/require/requirePlugin）
│  ├─ unity-shim.js         Unity WebGL 桥接层（canvas/主循环/RAF）
│  ├─ unity-data-hook.js    Unity 资源加载钩子（data/wasm 预取）
│  ├─ lib/                  原小游戏 game.js / Unity 插件（原样保留）
│  ├─ test-harness.js       无头浏览器自测脚本（node test-harness.js --wait 120）
│  └─ assets/
│     ├─ 3e69ea94….webgl.data.unityweb.bin       Unity 数据包（22MB）
│     ├─ wasmcode_decompressed.wasm              主 wasm（23MB，已应用 Dictionary 越界族补丁）
│     ├─ wasmcode1_decompressed.wasm             wasm 分包 2（38MB）
│     ├─ remote-config.real.json                 真实远端配置（离线返回）
│     └─ StreamingAssets/aa/
│        ├─ settings.json / catalog.json          Addressables 运行时数据（真实抓取）
│        └─ WebGL/*.bundle                        883 个资源包（589MB，全部本地化）
├─ decrypted/  unpacked/  extracted/          ← wxapkg 解密/解包/提取中间产物
├─ tools/                                     ← 逆向工具脚本（解密、补丁、下载器）
└─ README.md
```

## 逆向要点（技术备忘）

1. **wxapkg 解密**：PC 微信 `V1MMWX` 格式，AES-256-CBC（PBKDF2 派生 key）+ XOR 双段解密（`tools/decrypt-wxapkg.js`）。
2. **Unity WebGL 微信化**：Unity 2022.3.62f3 + minigame-unity-webgl-transform；主 wasm 23MB 超过 Chrome 8MB 同步编译限制，需 shim 绕过；wasm 双分包靠 `wasm_split.wait` + `call_indirect` 桩函数缝合。
3. **wasm 崩溃修复**：线上真实玩家也会触发的 Dictionary 越界崩溃，用族补丁修掉 10 个函数（`tools/patch-family.py`），见 `assets/wasmcode_decompressed.wasm`。
4. **Addressables 全量本地化**：catalog 列 878 个 bundle，已全部下载到本地；`wx-shim.js` 拦截层按 URL 分流——settings/catalog 返回本地 JSON，`aa/WebGL/*.bundle` 返回本地二进制，其余远端接口返回结构正确的空信封。
5. **广告移除**：广告位（rewarded/interstitial/banner）全部由 shim 模拟，`showRewardedVideoAd` 直接回调成功，无需看广告即可解锁武器/道具。


## 追加修复（第二轮反馈）

6. **音频空指针崩溃**（`wx-shim.js:1465 Cannot read properties of null (reading 'currentTime')`）：`InnerAudioContext.destroy()` 置空 `el` 后异步音频回调仍解引用它。修复：回调全部改为操作闭包持有的真实节点，永不解引用外层引用。
7. **画面横向压缩**：视口曾硬编码 iPhone X 比例（375/812），与真实微信 PC 窗口（约 0.576）不符。默认改为 `stretch` 铺满，`?fit=contain` 可切回留黑边模式。
8. **联赛引导卡死**（半透明遮罩浮在最上层）：通过自研 il2cpp 元数据解析器 + wasm 映射链（global-metadata v31 → CodeGenModules → methodPointers → elem 表还原），把 `BeginLeagueUnlockedTutorial` / `BeginLeagueUnlockedTutorialRoutine` 两个 wasm 函数体替换为立即返回，联赛引导不再触发（联赛功能本身保留）。工具：`tools/il2cpp_meta.py`、`tools/wasm_map.py`、`tools/wasm_patch_method.py`，备份 `assets/*.bak-method`。
9. **虚拟文件系统持久化**：wx FileSystemManager 写入现镜像到 localStorage（小文件），刷新页面不再丢存档/引导标记；资源缓存（bundle 等大文件）不落 localStorage。
10. **缓存策略**：`/assets/*`（bundle/wasm）长缓存，脚本 `no-cache` + Last-Modified——更新 shim 后普通刷新即可生效；改动 wasm 后需 Ctrl+Shift+R 强刷一次。


## 追加修复（第三轮反馈）

11. **结算框选【放弃】后永久卡死**：真实微信行为是插屏广告 `show()` 后用户关闭触发 `onClose`，游戏链路为 `SIADManager.ShowInterstitialAd → SkyIsland.IAA.Impl.Wx.InterstitialAd（注册 OnClose）→ IAA.OnInterstitialAdClose / ResetIsShowingInterstitialAd`。旧 mock 的 `onClose` 是空函数（注册即丢弃），广告永不关闭 → `IsShowingInterstitialAd` 状态无法复位 → 结算后卡死。修复：`createInterstitialAd` mock 补全 `load→onLoad`、`show→(350ms)→onClose` 完整生命周期。
12. **⚠️ 重大工具修正——wasm 补丁索引偏移**：elem 段函数索引是「模块索引空间」（前面有 890 个 import），此前 `wasm_patch_method.py` 把它直接当 code 段下标用，导致第二轮的联赛补丁实际打在了 +890 偏移的两个无辜函数上（真身未被补到）。已：①工具修正（自动减 import 数）；②从 `.bak-method` 还原 wasm；③改为补 `<BeginLeagueUnlockedTutorialRoutine>d__31::MoveNext`（返回 false = 协程立即完成，比把工厂补成 null 更安全，避免 `StartCoroutine(null)` 抛异常）。误伤的两个函数已还原。
13. **wasm 缓存戳**：`unity-data-hook.js` 给 wasm URL 加 `?v=WASM_VER` 查询参数，以后改 wasm 只需 bump `WASM_VER` 常量，普通刷新即可拿到新文件，不再需要 Ctrl+Shift+R。当前版本 `20261018a`。


## 追加：升级卡死排查（诊断增强）

14. **一键诊断日志（F9）**：不再需要 `?debug`。按 F9 即复制「错误/停顿 + 最近 400 行日志」到剪贴板（含时间戳、点击坐标、所有 wx API 调用）。日志环扩到 3000 行，并单独维护 200 行「错误环」（error/异常/主线程停顿），不会被 Unity 的普通 log 冲掉。
15. **主线程停顿探测**：rAF 间隔 > 1.2s 记录为 `[stall]`，用于区分「wasm/JS 死循环（整页无响应）」与「C# 逻辑等待（画面仍在动但无交互）」。
16. **存档写入加固**：`localStorage` 配额满时改为内存兜底并仍向游戏报告 200，避免升级/解锁等写档流程卡在「保存失败」分支。


## 追加：窗口自适应（第五轮）

17. **画面自适应浏览器窗口大小（已用无头浏览器截图验证）**。排查发现三处拦路虎，全部修复：
    - **canvas.style 被适配层劫持**：game.js 的 weapp-adapter 改了主 canvas 的原型链（`__proto__.__proto__ = 适配层 Element 实例`），该实例自带一个假 `style` 对象 → 运行期 `canvas.style.width=...` 全写进假对象，真实布局纹丝不动。修复：shim 加载时（原型链被改之前）预存原生 `style` getter（`NATIVE_STYLE_GET`），所有布局写入走 `realStyle(canvas)`。
    - **引擎需要"官方入口"才知道要重排**：实测只改 `canvas.width` Unity 不认，必须调 `GameGlobal.unityNamespace.Browser.setCanvasSize(w*dpr, h*dpr)`（emscripten 官方入口，会更新 widthNative 并触发引擎侧 resizeListeners），随后 Unity 自动按新尺寸重排 UI 并渲染。注意它会清掉 canvas 的 style width/height，所以调完要把样式重新铺一遍。
    - **伪 window 视口尺寸是死值**：`GameGlobal/window` 的 innerWidth/innerHeight 原是启动瞬间的固定数字，lib/game.js 用它计算 `canvas.clientWidth`/`getBoundingClientRect()`。改为活值 getter（必须带 setter，因为适配层有一句 `for(var a in r) i[a]=r[a]` 会向 GameGlobal 拷贝属性，只读 getter 会抛异常导致整个 game.js 起不来）。
    - 现在效果：启动时按当前窗口尺寸铺满；运行中拖动窗口/最大化，画面实时重排跟随。`?fit=contain` 仍可锁定 431:748 比例。
    - 配套修复：触摸/鼠标坐标换算改用画布真实矩形（`canvasNativeRect`，绕过实例上的 getBoundingClientRect 覆盖）。
    - 排查工具：`tools/cdp-probe.mjs`（无头 Chrome CDP：加载游戏→截图→改窗口尺寸→再截图，自动对比）。
    - 顺带修了一个 shim 自身 bug：`applyCanvasLayout` 里残留的未定义变量 `st` 会在加载早期抛 `ReferenceError`，导致 game.js 偶发 `canvas is not defined` 启动失败（错误环日志定位）。另显式补挂 `window.canvas` 全局（game.js 引导代码裸引用它）。


## 追加：自适应深度修复（第六轮）

18. **自适应的三处深层 BUG（本轮全部修复，均可用无头探针复现验证）**：
    - **触摸坐标残留「启动宽/当前宽」缩放系数**：`mapToCanvas` 是 contain 等比缩放时代的逻辑，resize 后所有点击坐标按 `启动宽/当前宽` 整体偏移——窗口拉大后点 UI 全部打偏，表现正是「图层错乱、点不动」。修复：stretch 1:1 模式下直接用当前画布真实矩形换算（`clientX - rect.left`），不再有任何历史系数。
    - **后备缓冲修改绕过引擎入口**：旧代码先改 `canvas.width` 再调 `Browser.setCanvasSize`，尺寸相同会被 emscripten「相同值提前返回」跳过——引擎收不到 resize 通知，Screen 尺寸与实际缓冲脱节。重构为 `syncCanvas()` 单一入口：CSS 样式 → `Browser.setCanvasSize`（唯一缓冲修改点、必经引擎）→ 补回样式；引擎未就绪时才直接改缓冲。
    - **resize 事件丢失无兜底**：滚动条出现/消失、devtools 开合、部分 DPI 切换不派发 `window.resize`，一旦 innerWidth 与 canvas 脱节，UI 按一个尺寸布局、画面按另一个渲染——图层错乱的典型元凶。新增三重兜底：`visualViewport.resize` 监听、`matchMedia(resolution)` 监听 DPR 变化（Ctrl+/- 缩放、跨屏拖动）、600ms 巡检自动比对 innerWidth×dpr 与 canvas 缓冲，脱节即自动重同步并记 `[resize-watch]` 日志。
    - 验证（`tools/cdp-probe.mjs` / `tools/cdp-dpr.mjs`）：884x805→1280x620、DPR 1→1.5（缓冲 1920x930、样式 1280x620、Unity FOV/UI 正确重排、巡检无反复触发）均通过。
    - 已知边界：军械库武器 3D 展示用固定尺寸 RenderTexture，窗口变化后该层清晰度/比例不会重建（真机微信窗口尺寸固定，游戏本就没有 RT 重建逻辑）；个别界面若在打开状态下缓存了屏幕尺寸，重新打开该界面即恢复。


## 追加：图层错乱根因修复（第七轮，用户实测截图 + F9 日志定位）

19. **「各图层位置错乱」的真正根因**：游戏大量 UI 是「启动/进入界面那一刻」用**当时的窗口尺寸**代码定位的（并缓存 wx.getSystemInfoSync 的结果——lib/plugin.js 按引用存进 w.systemInfo，仅设备旋转时刷新）。窗口变化后 UGUI 锚点会重排，但代码定位的图层、缓存的尺寸不会 → 一半图层按旧尺寸、一半按新尺寸 = 混合错乱。用户截图实测：部分层按启动视口（≈500px）排布、部分按当前视口（706px）排布。三项修复：
    - **系统信息活值对象**：`getSystemInfoSync` / `getWindowInfo` 现在返回属性为 getter 的对象（windowWidth/screenWidth/safeArea.* 实时反映当前窗口，带忽略型 setter 防外部写入抛错）。按引用缓存它的代码（plugin.js 的 w.systemInfo、game.js 的 A）从此永远读到当前尺寸；`JSON.stringify`（C# 桥接）也自动取当前值。
    - **大幅尺寸变化自动重启**：窗口宽或高变化 >25%（关 devtools、最大化、拖拽大改）且稳定 2 秒后，自动以新尺寸重新启动游戏——这是唯一能保证**所有图层都用同一尺寸布局**的方案（真机微信窗口尺寸永不变化，游戏没写运行期重布局逻辑，任何 in-place 适配都做不到 100%）。进度在本地存档，无损；重启后有「已按新窗口尺寸重新启动」提示。会话内最多 3 次；`?noreload=1` 可禁用；启动完成前变窗口 = 直接按新尺寸启动（不算重启）。
    - **巡检定时器 bug**（白盒调试发现）：重启判定原先每 600ms 都 clearTimeout+重排 2s 定时器——定时器永远到不了期。改为排定后不重排、尺寸变回则撤销。
    - 验证（tools/cdp-verify-resize.mjs）：884x805 → 1280x620 自动重启成功，重启后 canvas 直接按 1280x620 初始化；活值 sysInfo 在 resize 后 1.5s 内即为新值。

## 已知限制


- 无云存档：进度保存在浏览器内存/localStorage，刷新后按游戏内置存档逻辑恢复。
- 排行榜、好友分享等社交功能为模拟实现。
- 埋点/上报全部离线吞掉，不发出任何网络请求。


## 仓库内容说明（供代码阅读/AI 分析）

本仓库为「代码 + 游戏资源」全量留档，但**补丁备份与逆向中间产物不入库**（见 `.gitignore`）。
分析本项目时应只关注下列源码，`web/assets/**/*.bundle`、`*.wasm`、`*.bin` 为 Unity 序列化资源与编译产物，**不可读、不构成逻辑**：

| 优先级 | 文件 | 作用 |
|---|---|---|
| ★★★ | `web/wx-shim.js` | 微信 API 离线模拟层，所有「假实现」的核心：登录/广告/云存档/文件系统/Addressables 分流 |
| ★★★ | `web/unity-data-hook.js` | Unity 资源加载钩子：data/wasm 预取、wasm 双分包缝合、`Module.wasmBinary` 注入 |
| ★★★ | `web/unity-shim.js` | Unity WebGL 桥接：canvas 获取、主循环、RAF、窗口自适应 `syncCanvas()` |
| ★★ | `web/wx-loader.js` | 微信小游戏模块运行时（define/require/requirePlugin） |
| ★★ | `web/server.js` | 零依赖静态服务器（Range / wasm MIME / COOP+COEP / 缓存策略） |
| ★★ | `web/lib/game.js`、`web/lib/plugin.js` | 原小游戏入口与微信插件（**原样保留，不要改**） |
| ★ | `web/test-harness.js` | 无头浏览器自测（`node test-harness.js --wait 120`） |
| ★ | `tools/*.py`、`tools/*.mjs` | 逆向工具链：wxapkg 解密、wasm 反汇编与补丁、il2cpp 元数据解析、CDP 无头探针 |

不入库但本地运行必需（如需完整复现请从原游戏提取）：
`decrypted/`、`unpacked/`、`extracted/`（wxapkg 中间产物）、`web/assets/*.bak-*`（wasm 补丁备份）。
