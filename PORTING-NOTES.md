# Token Monitor — Android 移植平台改动对照文档

工程位置：`work/20261023_token_monitor_port/android-app/`（Capacitor 8.5.3）
原项目：Javis603/token-monitor v0.77.0（Electron 43.7.9）
UI 路线：① 复刻原版桌面布局（340×650 紧凑卡片容器化）
移植形态：**hub 同步客户端 + 完整仪表盘**（本地 AI 工具日志在 Android 上不存在，采集器按阶段1结论裁剪）

---

## 一、工程结构

```
android-app/
├── capacitor.config.json          # appId com.javis.tokenmonitor、allowMixedContent、http scheme
├── package.json                   # @capacitor/* 8.5.3 + filesystem/browser/status-bar/app 插件
├── www/
│   ├── index.html                 # 【新增】入口重定向页（见改动#1）
│   └── app/                       # 原仓库镜像（保持目录深度 → 88 个脚本相对路径零改动）
│       ├── package.json           # 原版 package.json（appVersion 模块读取版本号）
│       ├── assets/icons/          # 原版 65 个品牌 SVG（rowIconMasks 按原相对路径引用）
│       └── src/
│           ├── shared/            # 原版 shared 层（渲染层脚本 + 桥 CJS 模块闭包，逐字节同源）
│           └── electron/
│               ├── renderer/      # 原版 UI 106 文件（仅 index.html 注入 3 处，见改动#2）
│               │   ├── android-bridge.js    # 【新增】平台桥（preload.js + main.js 子集的 WebView 实现）
│               │   └── android-shell.css    # 【新增】手机容器化样式（见改动#3）
│               └── ...            # 原版其余文件未动（limits/ providers/ 等，仅作桥的模块库）
├── android/                       # npx cap add android 生成（Capacitor 8 模板）
│   └── app/src/main/
│       ├── AndroidManifest.xml    # 改动#4：权限 + cleartext + 禁云备份
│       └── java/com/javis/tokenmonitor/MainActivity.java  # 改动#5：通知运行时权限
└── scripts/test-bridge-modules.cjs  # 【新增】桥模块闭包执行测试（21 模块 + 18 导出断言）
```

## 二、逐项平台改动对照

### 改动 #1 — 应用入口重定向
- 【原桌面端代码】Electron `main.js` 以 `renderer/index.html` 为窗口直接加载页
- 【Android适配代码】`www/index.html`（Capacitor 固定加载 webDir 根）内 `location.replace('app/src/electron/renderer/index.html' + query)`
- 原因：渲染层 88 个 `<script>` 全部是相对路径（`../../shared/...`），保持原目录深度即可**零路径改动**复用；重定向页保留 query 参数（`windowHidden` 等语义不受损）。

### 改动 #2 — renderer/index.html 注入（仅 3 行）
- 【原桌面端代码】head 首脚本为 `floatingBubbleBoot.js`
- 【Android适配代码】其前插入 `<script src="android-bridge.js"></script>`；viewport 增加 `viewport-fit=cover`；样式表追加 `android-shell.css`
- 原因：桥必须在任何渲染层脚本之前定义 `window.tokenMonitor`（app.js 末尾同步调 `init()`）；安全区供 `env(safe-area-inset-*)` 使用。

### 改动 #3 — 手机容器化样式（UI 路线①）
- 【原桌面端代码】`main.js DEFAULT_WINDOW` 340×650 无边框悬浮窗；`.shell` 铺满窗口（styles.css:80）
- 【Android适配代码】`android-shell.css`：全屏 WebView 内居中 max-width 420px 全高卡片；≥480px 视口（平板/横屏）呈现 24px 圆角 + 留白 + 投影的悬浮卡片形态
- 原因：复刻原 widget 比例感；原版全部组件/视图/交互不变。

### 改动 #4 — AndroidManifest 权限
- 【原桌面端代码】Windows 安装器权限（无运行时权限概念）；数据在 `%APPDATA%\Token Monitor`
- 【Android适配代码】
  - `INTERNET` + `ACCESS_NETWORK_STATE`：hub 同步（REST+SSE）、服务状态、汇率、更新检查
  - `POST_NOTIFICATIONS`：限额提醒（Android 13+ 运行时申请）
  - `android:usesCleartextTraffic="true"`：**局域网 host 模式 hub 是明文 HTTP**（桌面端同Design），不开启则 LAN 同步被混合内容策略拦截；云中继（Cloudflare Worker）自动 HTTPS 不受影响
  - `android:allowBackup="false"`：`settings.json` 含 hub 共享密钥，禁止自动云备份
  - 存储零权限：应用数据全部写 `context.filesDir` 沙盒（`%APPDATA%` 的 Android 等价物）

### 改动 #5 — MainActivity 通知运行时权限 + 本地插件注册
- 【原桌面端代码】`Notification.isSupported()` 直接可用（main.js:6316）
- 【Android适配代码】`MainActivity.onCreate` → API 33+ 检查并申请 `POST_NOTIFICATIONS`；拒绝不影响现有功能（当前版本仅带内提醒）。同文件 `registerPlugin(TokenMonitorSsePlugin.class)` 注册本地 SSE 插件（见改动 #7）

### 改动 #6 — IPC 桥整体替换（android-bridge.js，约 900 行）
- 【原桌面端代码】`preload.js` contextBridge（约 100 方法）+ `main.js` 113 个 ipcMain handler
- 【Android适配代码】单文件实现同名 API 面，分四类：
  1. **完整实现**（与桌面 client 模式逐语义对齐）：
     - `getStats`：≡ main.js:8377 client 分支——`fetch /api/stats` → `composeLocalSyncSummary(stats, null)`（无本地设备时原样透传，syncDisplayStats.js:115 已验证）→ `projectLimitStatsForDisplay` + `projectModelAliasStats` 呈现变换 → `rendererStats` 裁剪 allTime.sessions → snapshot stamp
     - SSE 实时流：≡ `startStatsStream`（main.js:5224）——fetch 流式 + `sseEventReader.js` 原模块解析 `snapshot`/`stats`/`freshness`，3s 断线重连，`x-token-monitor-stream: 2` 协商头
     - `getDashboardHistory`：hub `/api/history`（≡ hub `aggregateHistory`）+ `projectModelAliasHistory` + `fixedPeriods: {source:'hub'}`
     - `getAllTimeSessions`/快照：`createRendererSnapshots` 语义（statsPublisher.js 原模块）
     - `getSettings`/`updateSettings`/`settings:push`、`getStreamStatus`、`getHubInfo`、`getHubBuildStatus`（probeHubBuild 原模块）、`regenerateHubSecret`（crypto.getRandomValues 24B base64url）
     - `saveSubscriptions`（PUT + baseUpdatedAt CAS，409→'stale_write' 错误码对齐）、共享标记采纳（`subscriptionsUpdatedAt`/`syncSettingsRevisions` → 拉取 `/api/subscriptions` 与 `/api/sync/settings/{modelAliases,customPricing}`）
     - `getServiceStatus`（serviceStatus.js 原模块直用）、`deleteDevice`、`lookupModelPricing`（本地 customModelPricing 表）、`copyText`、`openExternal`（Capacitor Browser 插件）
  2. **合理替换**：
     - 设置存储：`settings.json` → Capacitor Filesystem 写 `context.filesDir`（浏览器调试回落 localStorage，格式与桌面同构可互迁）；离线种子：上次 hub 快照缓存至 `stats-cache.json`，重启先上屏再刷新
     - `openDashboard` → `onOpenView('trends')`（桌面独立热力图窗口 → 手机已有 trends 视图）
     - `getAppUpdateState/checkNow`：electron-updater → GitHub Releases API 版本比对，`installSupported: false`（APK 手动更新）
     - `getAppInfo`：`platform: 'android'`（UI 的 is-windows/is-mac 类不命中 → 中性样式分支）
     - `getNativeMaterialState`：恒 `transparent` → 原版 CSS 玻璃降级链生效（无 Liquid Glass/Acrylic）
     - `getSessionDetail`：恒 `{found:false}`（桌面读本地转录文件；Android 无转录，UI 以 stats 内聚合行降级渲染）
  3. **有意裁剪**（no-op，UI 对应区块自动隐藏或不出现）：托盘 `setTrayIcons`、悬浮球全家、`signalContentReady`、窗口 min/close、iCloud、WSL、`getTokscaleStatus:{supported:false}`（隐藏 tokscale 设置组）、`clearSessionUsageArchive`、`exportNow`（本地无归档可导出）
  4. **厂商账号面**（codex/cursor/mimo/antigravity 等 10 组登录 IPC）：返回 `{ok:false, error:'unsupported'}`——登录依赖桌面凭据文件/系统浏览器流；**配额数据不受影响**（经 hub 同步展示）。二期可做手机端手填 token。
- 关键机制：**微型 CJS 加载器**——23 个原版模块（hubProtocol/syncDisplayStats/statsPublisher/modelAliasPresentation/limits/statsPresentation/usage/history/serviceStatus/sseEventReader 等）以 `new Function('require','module','exports', 源码)` 执行，与桌面**逐字节同源**；require 解析支持 `.js`/`/index.js` 候选（Node 语义：文件优先于同名目录，如 `usage` 目录 vs `usage.js`）；UMD 依赖（sessionLive/sessionRows/modelAliases 等 10 个）回落到 index.html 已挂载的 `window.TokenMonitor*` 全局。**业务算法零复制、零改写。**

## 三、数据流对照

| 环节 | 桌面端 | Android |
|---|---|---|
| 数据源 | tokscale 扫描本机 46+ AI 工具日志 | hub `/api/stats`（桌面 host 模式 `http://<LAN-IP>:17321` 或官方 Cloudflare Worker） |
| 实时通道 | SSE `/api/stats/stream`（主进程 fetch 流式） | 同协议（WebView fetch 流式 + 原版 sseEventReader） |
| 聚合/呈现 | composeLocalSyncSummary + 呈现变换 + rendererStats | 同一套原模块执行（本地设备恒 null → hub 快照透传） |
| 自有状态 | `%APPDATA%\Token Monitor\*.json` | `context.filesDir/{settings,stats-cache}.json`（同构格式） |
| 历史归档 | daily-history-archive.json（本地写） | hub 端聚合（手机只读；370 天窗口随 hub 数据下发） |

### 改动 #7 — 原生 SSE 插件（迭代修复：局域网实时推送）
- 【原桌面端代码】`startStatsStream`（main.js:5224）：Electron **主进程** fetch 流式读取 `/api/stats/stream`——Node fetch 无同源策略，天然无视 CORS
- 【Android适配代码】实测发现 Node 版 hub 的 SSE 响应**不带 CORS 头**（`src/hub/server.js` 只在 REST 的 sendJson/sendText 走 `corsHeaders()`；Worker 版带，worker/src/index.js:452）。WebView 内 fetch 受同源策略约束 → 局域网直连场景实时推送被拦，只剩轮询
  - 修复：`TokenMonitorSsePlugin.java`（约 130 行，HttpURLConnection 流式读取，Bearer + `accept: text/event-stream`，50ms 合批/512KB 分块把原始文本推回 JS），桥内原生路径把文本块喂给**同一个原版 sseEventReader**——协议行为与桌面端逐字节一致
  - 原生层连接不受 WebView 同源策略与混合内容策略约束 → 局域网/云中继都有真·实时
  - 浏览器 QA 环境自动回落 fetch-SSE 路径（逻辑同源，便于回归）

## 四、已知限制与二期路线

1. **后台保活**：切后台后 SSE 断开，回前台自动重连 + 立即拉取；渲染层自带 15s 轮询兜底。常驻前台服务 → 二期。
2. **限额账号登录**：手机端不可登录（见改动#6.4）；配额窗口数据经 hub 同步正常展示。
3. **会话全文明细**：hub 不上传会话文本（隐私设计），手机端会话行展示聚合数据（与桌面端"纯同步设备"信息量一致）。
4. **呈现变换差异**：`projectLimitStatsForDisplay` 的 local-provenance 细节在纯客户端设备上与桌面理论上等价（无本地 provider）；模型别名走 hub 共享设置自动采纳。
5. **AppWidget/通知提醒**：桌面悬浮窗/托盘的 Android 对应物（AppWidget 小组件、限额到达通知）→ 二期（local-notifications 插件已预装）。
6. **Termux 采集**：官方 tokscale 已有 android-arm64 构建（scripts/vendor/tokscale.json），理论可扫 Termux `$HOME` 下的 AI CLI 日志——未纳入主线。

## 五、验证记录（本机实测）

1. `node scripts/test-bridge-modules.cjs` → **ALL PASS**：21 个原版模块在浏览器沙箱语义下执行成功；18 项导出/行为断言通过（含 `composeLocalSyncSummary(hub,null)` 原样透传、rendererStats 裁剪、SSE 解析往返）。
2. 依赖闭包扫描 → **CLOSURE COMPLETE**（修复过程：无扩展名 require 候选解析 + `usage` 同名目录文件优先 + 补入 reasonix/sessionGuard、projectKey）。
3. **端到端**：原仓库 hub（node src/hub/server.js，:17331）+ `/api/ingest` 注入合成设备 → App 冷启动 → SSE 连接 → 原版 UI 渲染 **1,234,567 tokens / $12.34**、工具/模型/会话/设备分解、活动热力图、中文 i18n 自动生效（截图 `.smoke/e2e-final.png`）。
4. 控制台零桥错误；`npx cap sync` 通过；`MainActivity`/Manifest 就绪。
5. 真机 APK 编译由阶段4 GitHub Actions 完成（本机零 Android 工具链，符合约束）。
