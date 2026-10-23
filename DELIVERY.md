# Token Monitor Android — 打包与交付手册

配套工程：Capacitor 8.5.3（`android/` 工程，AGP 8.13.0 / Gradle 8.14.3 / compileSdk 36 / minSdk 24）
适用设备：Android 7.0 ~ 16（覆盖任务要求的 Android 10~15）
应用包名：`com.javis.tokenmonitor` · 当前版本 0.77.0

---

## 1. 云端打包（主路径，推荐）

**本机零 Android 工具链**。仓库根 = `android-app/`，workflow 已就位：`.github/workflows/android.yml`。

```bash
# 首次发布
cd android-app
git init && git add -A && git commit -m "Token Monitor Android 0.77.0"
git remote add origin git@github.com:<你的用户名>/<仓库名>.git
git push -u origin master        # 或 main
```

**云端仓库（已建好）：https://github.com/FlyingFeng2021/token-monitor-mobile**

推送后自动流程：`npm ci` → JDK 21 → Android SDK（runner 预装）→ `assembleDebug` + `assembleRelease` →
**APK 出现在 Actions 运行页的 Artifacts**（`Token-Monitor-debug` / `Token-Monitor-release`）。
`v*` 标签会把两个 APK 直附到 **Releases 页**（公开、手机浏览器免登录直接下载）。

> 本机 git 直连 github.com 被墙时的推送通道：`node scripts/github-push-api.cjs
> FlyingFeng2021/token-monitor-mobile main "<commit message>" [tag]`
> （走 api.github.com 的 Git Data API，支持断点续传；首次前先 `git add -A`。）

- 手动触发：Actions 页 → Android APK → Run workflow
- 发版：`git tag v0.77.0 && git push origin v0.77.0` → APK 自动附到 GitHub Release
- **签名零配置可用**：首次构建自动生成密钥并跨构建缓存，签名稳定，可持续覆盖安装。
  进阶（可选）：把自己的 keystore 以 base64 存入仓库 Secrets `KEYSTORE_BASE64`
  （口令/别名 Secrets：`KEYSTORE_PASSWORD` / `KEY_ALIAS` / `KEY_PASSWORD`）。
  ⚠️ 更换签名后需先卸载旧版再安装。

## 2. 本地备用打包（2 个轻量工具）

仅需：**① JDK 21 ② Android cmdline-tools**（无 Android Studio、无 NDK）。
注意：Capacitor 8 的 Android 库强制 Java 21 工具链（JDK 17 不够）；工程已配置
foojay 工具链自动下载兜底，但建议直接装 JDK 21 一步到位。

```powershell
# ① JDK 21（scoop 一条命令；github 不通时用清华镜像手动装，见下方提示）
scoop install java/temurin21-jdk
#   镜像手动装（约 200MB）：
#   curl -L -o $env:TEMP\jdk21.zip https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/x64/windows/OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip
#   解压后设置 JAVA_HOME 指向解压目录即可（build-apk.cmd 会跟随 JAVA_HOME）

# ② Android cmdline-tools（约 150MB 下载 + SDK 组件约 600MB，一次性）
curl -L -o $env:TEMP\cmdtools.zip https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip
Expand-Archive $env:TEMP\cmdtools.zip -DestinationPath $env:LOCALAPPDATA\Android\cmdline-tools -Force
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\Android\cmdline-tools\latest" | Out-Null
Move-Item "$env:LOCALAPPDATA\Android\cmdline-tools\cmdline-tools\*" "$env:LOCALAPPDATA\Android\cmdline-tools\latest\"
& "$env:LOCALAPPDATA\Android\cmdline-tools\latest\bin\sdkmanager.bat" --licenses   # 全部 y
& "$env:LOCALAPPDATA\Android\cmdline-tools\latest\bin\sdkmanager.bat" "platforms;android-36" "build-tools;36.0.0" "platform-tools"
```

之后每次打包**一行命令**（工程根目录下）：

```cmd
build-apk.cmd
```

（等价于 `cd android && gradlew.bat assembleDebug --no-daemon`；产物：
`android\app\build\outputs\apk\debug\app-debug.apk`。要出 release 版：
`build-apk.cmd assembleRelease`。本地构建默认无 release 密钥 → 产物为未签名包，
日常安装请用 debug 版。）

## 3. 真机安装步骤

1. **取 APK**：GitHub 仓库 → Actions → 最新一次运行 → Artifacts → 下载 `Token-Monitor-debug`（zip 内含 apk）
2. **传手机**：USB / 网盘 / 微信文件传输助手均可
3. **安装**：点开 apk → 系统提示"未知来源"时选择允许（路径通常为：设置 → 应用 → 特殊权限 → 安装未知应用 → 对应文件管理器 → 允许）；Google Play Protect 弹窗 → "更多详情" → "仍然安装"
4. **首次启动**：弹出通知权限申请（Android 13+）——可允许也可拒绝，不影响现有功能
5. **连接数据源**（App 显示 0 是因为没有数据源）：
   - **方案 A · 局域网直连桌面端（同一 WiFi）**
     - 桌面端：打开 Token Monitor → 设置 → Multi-device Sync → 模式选 **Host**，记下页面显示的局域网地址（形如 `http://192.168.x.x:17321`）与 Secret
     - Windows 防火墙放行（管理员 PowerShell 执行一次）：
       `netsh advfirewall firewall add rule name="Token Monitor Hub" dir=in action=allow protocol=TCP localport=17321`
     - 手机端：App → 设置（右下齿轮）→ 同步 → 填入 Hub URL 与 Secret → 保存 → 状态指示变为已连接，数据开始流动
   - **方案 B · 云中继（不同网络可用，自动 HTTPS）**
     - 部署官方 Cloudflare Worker：原仓库 `worker/` 目录执行 `npx wrangler deploy`（需 Cloudflare 账号；`wrangler.toml` 里配置 secret）
     - 手机端填 `https://<你的worker>.workers.dev` + Secret
   - **方案 C · 纯 Node hub（桌面不开 GUI 时）**：桌面仓库目录执行
     `TOKEN_MONITOR_SECRET=你的密钥 npm run hub`，手机端填 `http://<PC-IP>:17321`
6. 数据到达后即可左右切换视图（主页/工具/模型/会话/设备/趋势/额度/状态）

## 4. 常见报错排查清单

### CI 打包
| 现象 | 原因与处置 |
|---|---|
| `gradlew: Permission denied` | 从 Windows 推送丢失可执行位——workflow 已内置 `chmod +x`，自改 workflow 时勿删 |
| `Unsupported class file major version` / JDK 报错 | AGP 8.13 需 JDK 17+；workflow 固定 temurin 21，勿降 |
| `npm ci` 失败 | `package-lock.json` 必须随仓库提交 |
| SDK 许可报错 | `android-actions/setup-android@v3` 已自动接受；自建 runner 需手动 `sdkmanager --licenses` |
| Gradle 下载超时 | 重跑即可（setup-java 的 gradle 缓存第二次起生效）；自建 runner 可配国内镜像 |
| Artifact 里没有 APK | 看 build 步骤日志；产物路径固定 `android/app/build/outputs/apk/{debug,release}/` |

### 安装
| 现象 | 原因与处置 |
|---|---|
| "应用未安装" | 签名冲突（换过 keystore/secrets）→ 卸载旧版重装 |
| 解析包错误 | 传输损坏 → 重新传输；或下载的是 zip 未解压 |
| Play Protect 拦截 | "更多详情" → "仍然安装"（自签名 APK 的正常提示） |
| 装完闪退 | Android < 7.0 不支持（minSdk 24）；确认系统版本 |

### 连接与数据
| 现象 | 原因与处置 |
|---|---|
| 一直"未连接/连接失败" | ① 手机与 PC 不在同一网段（公司/校园 WiFi 常有 AP 隔离，可试手机热点）② 防火墙未放行 17321（见第 3 节命令）③ IP 填错（PC 上 `ipconfig` 核对）④ Secret 不一致 ⑤ URL 末尾不要带 `/api` 或路径 |
| **Secret 填了就是 401** | **等宽字体里 `l`（小写 L）与 `1`（数字 1）几乎不可分辨**——实测踩坑：截图抄写极易抄错。务必用桌面端密钥框右侧的**复制按钮**，手机上粘贴，绝不手敲 |
| 云中继返回 503 `secret_required` | Worker 端未配置 secret 或手机端 secret 填错 |
| 连上但数据为 0 | 桌面端采集未运行（打开桌面 App 或 `npm run agent`）；或刚连接，等一个刷新周期（默认 15s 轮询兜底） |
| 额度（Limits）面板空 | 配额需在**桌面端**登录对应账号，手机端经 hub 只读同步展示 |
| 通知不弹 | Android 13+ 通知权限被拒 → 系统设置 → 应用 → Token Monitor → 通知 → 允许 |
| 时间/额度窗口不准 | 手机系统时区异常；设为自动时区 |
| 想确认连接状态 | 设置 → 诊断 → 生成诊断报告（含 stream connected、hub url、最后数据到达时间） |

## 5. 数据迁移说明

**核心原则：手机端是 hub 的聚合视图，数据迁移 = 加入同一个 hub，无需手动搬文件。**

| 场景 | 操作 |
|---|---|
| 桌面 → 手机（首次） | 手机端填 Hub URL + Secret（第 3 节）。聚合历史（每日/每月/全时间统计、订阅、模型别名、自定义定价）自动到达。**历史完整性取决于桌面端/agent 持续作为数据源**——桌面采集的历史经 hub 聚合下发，删源转录不影响已聚合数据 |
| 手机换机 | 新机安装后重填 Hub URL + Secret 即恢复全部视图。手机本地仅存 `settings.json` + `stats-cache.json`（离线兜底缓存），工程已设 `allowBackup=false`（hub 密钥不上云盘备份），因此不做系统级换机迁移 |
| Node hub ↔ Cloudflare Worker 切换 | 两者存储独立：切换 = 该服务端从零开始聚合。把桌面端指向新 hub 后，桌面重新 ingest 即可回填 |
| hub Secret 轮换 | 桌面端（host 模式）重新生成 → 手机端设置里更新 Secret，其余不动 |
| 桌面端导出文件（exportDir 的 CSV/JSON） | 与手机端无关，不互导 |

## 6. 升级原版上游

渲染层与业务模块与原仓库逐字节同源。原版升级时：

```bash
# 用新版本 src/ + assets/ 覆盖 www/app/ 下对应内容，然后：
npm run sync        # cap sync android：刷新 android/ 内嵌资产
npm run test:bridge # 确认桥的模块闭包仍然全部通过
```

若上游改动 preload API 面，仅需在 `www/app/src/electron/renderer/android-bridge.js` 补齐对应方法。
