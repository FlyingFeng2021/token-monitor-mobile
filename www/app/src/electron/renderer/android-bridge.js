'use strict';

/*
 * Token Monitor — Android bridge (Capacitor WebView).
 *
 * 【原桌面端代码】src/electron/preload.js（contextBridge 暴露 window.tokenMonitor）
 *                 + src/electron/main.js 中 renderer 依赖的 handler 子集
 * 【Android适配代码】本文件在 WebView 里直接实现同名 API 面。
 *   - 数据源：hub 同步客户端（GET /api/stats + SSE /api/stats/stream），
 *     与桌面端 client 模式的 fetchStats/startStatsStream 完全同构。
 *   - 存储：Capacitor Filesystem 插件写应用沙盒 JSON（Android 原生环境），
 *     浏览器/调试环境自动回落 localStorage。
 *   - 原生业务逻辑（复用原文件，运行时以微型 CJS 加载器执行）：
 *     hubProtocol / syncDisplayStats / statsPublisher / modelAliasPresentation /
 *     limits/statsPresentation / usage / history / serviceStatus / sseEventReader 等。
 *   - 裁剪面：托盘/悬浮球/notch/edgeDock/本地日志采集/账号登录 IPC → 有意 no-op。
 */
(function () {
  if (window.tokenMonitor) return; // 幂等：防止重复注入

  // ---------------------------------------------------------------------------
  // 0. 常量与模块表
  // ---------------------------------------------------------------------------

  var APP_VERSION = '0.77.0';
  var HUB_DEFAULT_PORT = 17321;
  var RELEASES_URL = 'https://github.com/Javis603/token-monitor/releases/latest';
  var SETTINGS_FILE = 'settings.json';
  var STATS_CACHE_FILE = 'stats-cache.json';

  // 与桌面端 hubProtocol.js 一致的流协商头
  var HUB_STREAM_HEADER = 'x-token-monitor-stream';
  var HUB_STREAM_VERSION = '2';

  // 微型 CJS 加载器的模块表：仓库相对路径 → 执行为 CommonJS 模块。
  // 全部为纯 JS（无 node: 内建依赖），与桌面端逐字节同源。
  var CJS_MODULES = {
    'package.json': '../../../package.json',
    'src/shared/hubProtocol.js': '../../../src/shared/hubProtocol.js',
    'src/shared/appVersion.js': '../../../src/shared/appVersion.js',
    'src/shared/syncUploadInterval.js': '../../../src/shared/syncUploadInterval.js',
    'src/shared/usage.js': '../../../src/shared/usage.js',
    'src/shared/history.js': '../../../src/shared/history.js',
    'src/shared/clientHealth.js': '../../../src/shared/clientHealth.js',
    'src/shared/sessionActivityProjection.js': '../../../src/shared/sessionActivityProjection.js',
    'src/shared/providers/reasonix/paths.js': '../../../src/shared/providers/reasonix/paths.js',
    'src/shared/providers/reasonix/sessionGuard.js': '../../../src/shared/providers/reasonix/sessionGuard.js',
    'src/shared/projectKey.js': '../../../src/shared/projectKey.js',
    'src/shared/providers/dsh/paths.js': '../../../src/shared/providers/dsh/paths.js',
    'src/shared/providers/devin/paths.js': '../../../src/shared/providers/devin/paths.js',
    'src/shared/limits/core.js': '../../../src/shared/limits/core.js',
    'src/electron/serviceStatus.js': '../../../src/electron/serviceStatus.js',
    'src/electron/sseEventReader.js': '../../../src/electron/sseEventReader.js',
    'src/electron/statsPublisher.js': '../../../src/electron/statsPublisher.js',
    'src/electron/syncDisplayStats.js': '../../../src/electron/syncDisplayStats.js',
    'src/electron/modelAliasPresentation.js': '../../../src/electron/modelAliasPresentation.js',
    'src/electron/limits/statsPresentation.js': '../../../src/electron/limits/statsPresentation.js',
    'src/electron/fixedPeriodHistory.js': '../../../src/electron/fixedPeriodHistory.js',
    'src/electron/hubBuildStatus.js': '../../../src/electron/hubBuildStatus.js',
    'src/shared/hubBuildComparison.js': '../../../src/shared/hubBuildComparison.js',
    'src/shared/hubBuildIdentity.js': '../../../src/shared/hubBuildIdentity.js',
    'src/shared/hubBuildRegistry.json': '../../../src/shared/hubBuildRegistry.json'
  };

  // require() 命中 UMD 依赖时回落到 index.html 已加载的全局
  // 【原桌面端代码】Node require('./sessionLive')
  // 【Android适配代码】window.TokenMonitorSessionLive（index.html 顺序加载产出）
  var UMD_GLOBALS = {
    'src/shared/sessionActivityProviders.js': 'TokenMonitorSessionActivityProviders',
    'src/shared/sessionLive.js': 'TokenMonitorSessionLive',
    'src/shared/trayText.js': 'TokenMonitorTrayText',
    'src/shared/currency.js': 'TokenMonitorCurrency',
    'src/shared/compactTokens.js': 'TokenMonitorCompactTokens',
    'src/shared/limits/providers.js': 'TokenMonitorLimitProviders',
    'src/shared/limits/balanceDisplay.js': 'TokenMonitorLimitBalanceDisplay',
    'src/shared/providers/workbuddy/identity.js': 'TokenMonitorWorkbuddyIdentity',
    'src/electron/renderer/sessionRows.js': 'TokenMonitorSessionRows',
    'src/electron/renderer/modelAliases.js': 'TokenMonitorModelAliases'
  };

  // ---------------------------------------------------------------------------
  // 1. 微型 CJS 加载器
  // ---------------------------------------------------------------------------

  var moduleCache = {};
  var moduleSources = {};
  var modulesPromise = null;

  function normPath(fromDir, spec) {
    var parts = (fromDir + '/' + spec).split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p === '' || p === '.') continue;
      if (p === '..') out.pop();
      else out.push(p);
    }
    return out.join('/');
  }

  function resolveRequire(fromKey, spec) {
    var dir = fromKey.split('/').slice(0, -1).join('/');
    var base = normPath(dir, spec);
    // 原仓库存在无扩展名 require（如 require('./sessionLive')），且存在
    // 同名目录+文件并存的情况（src/shared/usage 与 usage.js）——Node 语义
    // 文件优先，候选顺序 .js → /index.js → 原样。
    var candidates = [base + '.js', base + '/index.js', base];
    for (var i = 0; i < candidates.length; i++) {
      var target = candidates[i];
      if (CJS_MODULES[target]) return { kind: 'cjs', key: target };
      if (UMD_GLOBALS[target]) return { kind: 'umd', key: target };
    }
    throw new Error('[android-bridge] cannot resolve ' + spec + ' from ' + fromKey);
  }

  // 阶段2：源码已全部就绪后同步执行。require 命中 CJS 模块时递归执行
  // （深度优先 = 天然拓扑序），命中 UMD 依赖时取 index.html 已挂载的全局。
  function executeModule(key) {
    if (moduleCache[key]) return moduleCache[key].exports;
    var source = moduleSources[key];
    if (source == null) throw new Error('[android-bridge] source missing for ' + key);
    if (/\.json$/.test(key)) {
      moduleCache[key] = { exports: JSON.parse(source) };
      return moduleCache[key].exports;
    }
    var mod = { exports: {} };
    moduleCache[key] = mod;
    var syncRequire = function (spec) {
      var hit = resolveRequire(key, spec);
      if (hit.kind === 'umd') {
        var globalName = UMD_GLOBALS[hit.key];
        if (!window[globalName]) throw new Error('[android-bridge] UMD global missing: ' + globalName);
        return window[globalName];
      }
      return executeModule(hit.key);
    };
    new Function('require', 'module', 'exports', source)(syncRequire, mod, mod.exports);
    return mod.exports;
  }

  function loadSharedModules() {
    if (modulesPromise) return modulesPromise;
    var keys = Object.keys(CJS_MODULES);
    modulesPromise = Promise.all(keys.map(function (key) {
      var url = new URL(CJS_MODULES[key], document.baseURI).href;
      return fetch(url).then(function (res) {
        if (!res.ok) throw new Error('[android-bridge] load failed ' + key + ': ' + res.status);
        return res.text();
      }).then(function (source) { moduleSources[key] = source; });
    })).then(function () {
      keys.forEach(executeModule);
      return moduleCache;
    });
    return modulesPromise;
  }

  // ---------------------------------------------------------------------------
  // 2. 存储：Capacitor Filesystem 沙盒优先，浏览器回落 localStorage
  // ---------------------------------------------------------------------------

  var capPlugins = (window.Capacitor && window.Capacitor.Plugins) || null;
  var isNative = Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  var Fs = isNative && capPlugins && capPlugins.Filesystem ? capPlugins.Filesystem : null;
  // 原生 SSE 插件（TokenMonitorSsePlugin）：绕开 WebView CORS——Node 版 hub
  // 的流端点不带 CORS 头，浏览器 fetch 连不上；原生层连接则协议行为与桌面端一致。
  var ssePlugin = (isNative && capPlugins && capPlugins.TokenMonitorSse) ? capPlugins.TokenMonitorSse : null;

  function storageRead(file) {
    if (Fs) {
      return Fs.readFile({ path: file, directory: 'DATA', encoding: 'UTF8' }).then(function (r) { return r.data; });
    }
    try { return Promise.resolve(window.localStorage.getItem('token-monitor:' + file)); } catch (_) { return Promise.resolve(null); }
  }

  function storageWrite(file, data) {
    if (Fs) {
      return Fs.writeFile({ path: file, directory: 'DATA', data: data, encoding: 'UTF8', recursive: true });
    }
    try { window.localStorage.setItem('token-monitor:' + file, data); } catch (_) {}
    return Promise.resolve();
  }

  // ---------------------------------------------------------------------------
  // 3. 设置：默认值与桌面端 defaultSettings() 对齐（裁掉桌面窗口/托盘字段保留兼容）
  // ---------------------------------------------------------------------------

  var DEFAULT_SETTINGS = {
    hubMode: 'client',
    hubUrl: '',
    hubHostPort: HUB_DEFAULT_PORT,
    hubHostSecret: '',
    secret: '',
    refreshMs: 15000,
    glassOpacity: 68,
    glassBlur: 32,
    backgroundImageOpacity: 28,
    systemGlass: true,
    reduceMotion: 'system',
    tokenNumberAnimation: 'roll',
    showLiveDot: true,
    showToolIcons: true,
    titleIconOnly: true,
    showCompactTotalTokens: false,
    showLiveTokenRate: false,
    liveTokenRateScope: 'all',
    compactTokenUnits: 'western',
    tokenRateMode: 'speed',
    heatmapMetric: 'cost',
    modelRankingMetric: 'tokens',
    homeActiveDaysWindow: 'all',
    sessionContextMetric: 'used',
    sessionTitlesEnabled: true,
    periodMonthMode: 'month',
    themeColors: {},
    vendorColors: {},
    textSize: 'standard',
    interfaceFontFamily: '',
    displayFontFamily: '',
    lastViewState: { period: 'today', breakdown: 'home' },
    deviceId: null, // 启动时生成并持久化
    clients: '',
    customScanPaths: {},
    clientDisplayOrder: '',
    hiddenClients: '',
    pinnedClients: '',
    viewDisplayOrder: '',
    hiddenViews: '',
    projectsEnabled: true,
    projectBreakdownMode: 'tool',
    historyEnabled: true,
    historyIntervalMs: 15 * 60 * 1000,
    allTimeSince: '2024-01-01',
    customModelPricing: [],
    modelAliases: {},
    modelAliasGrouping: 'off',
    limitsEnabled: true,
    limitProviders: '',
    limitProviderOrder: '',
    homeLimitProviderOrder: '',
    hiddenHomeLimitProviders: '',
    limitProviderHiddenItems: {},
    showLimitSource: false,
    maskLimitAccountEmails: false,
    showLimitUsed: false,
    showCodexAdditionalLimits: true,
    codexResetForecastEnabled: false,
    opencodeLocalLimitsEnabled: false,
    serviceProviderDisplayOrder: '',
    hiddenServiceProviders: '',
    serviceStatusRefreshMs: 60000,
    subscriptions: [],
    subscriptionsOrphaned: { hubUrl: '', records: [] },
    subscriptionsCacheHub: '',
    currency: 'USD',
    currencyRates: {},
    language: 'auto',
    zoomFactor: 1,
    appUpdate: { lastCheckedAt: null, lastKnownLatest: null, dismissedVersion: null }
  };

  var settings = null;
  var settingsLoaded = null;
  var deviceId = null;

  function generateDeviceId() {
    var bytes = new Uint8Array(8);
    (window.crypto || {}).getRandomValues ? window.crypto.getRandomValues(bytes) : bytes.set([Date.now() & 255]);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return 'android-' + hex;
  }

  function generateHubSecret() {
    var bytes = new Uint8Array(24);
    window.crypto.getRandomValues(bytes);
    var bin = '';
    for (var j = 0; j < bytes.length; j++) bin += String.fromCharCode(bytes[j]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function loadSettings() {
    if (settingsLoaded) return settingsLoaded;
    settingsLoaded = storageRead(SETTINGS_FILE).then(function (raw) {
      var stored = {};
      if (raw) { try { stored = JSON.parse(raw); } catch (_) { stored = {}; } }
      settings = Object.assign({}, DEFAULT_SETTINGS, stored);
      deviceId = String(settings.deviceId || '').trim() || generateDeviceId();
      settings.deviceId = deviceId;
      if (!settings.secret) settings.secret = '';
      return settings;
    });
    return settingsLoaded;
  }

  function persistSettings() {
    return storageWrite(SETTINGS_FILE, JSON.stringify(settings, null, 2)).catch(function () {});
  }

  function normalizeCurrency(value, fallback) {
    var next = String(value || '').trim().toUpperCase();
    return /^[A-Z]{3}$/.test(next) ? next : (fallback || 'USD');
  }

  // 【原桌面端代码】settingsForRenderer()（main.js:5439）——凭据字段默认拒绝出域
  // 【Android适配代码】纯客户端无本地凭据库，仅回显 hub 客户端密钥两个例外字段
  function rendererSettings() {
    return Object.assign({}, settings, {
      locale: (navigator.languages && navigator.languages[0]) || navigator.language || 'en',
      syncContentStatus: getSyncContentStatus(false)
    });
  }

  var settingsListeners = [];
  function pushSettingsToRenderer() {
    if (!settings) return;
    var payload = rendererSettings();
    for (var i = 0; i < settingsListeners.length; i++) {
      try { settingsListeners[i](payload); } catch (_) {}
    }
  }

  // settings:update 同名键剔除（对齐桌面端 applySettingsPatch 的白名单外剥离）
  function applySettingsPatch(patch) {
    if (!patch || typeof patch !== 'object') return;
    var blocked = ['subscriptions', 'subscriptionsOrphaned', 'subscriptionsCacheHub',
      'windowMaximized', 'workbuddyEndpoint', 'workbuddyLocalAppEnabled',
      'syncContentState', 'syncContentStatus', 'syncContentBase', 'deviceId'];
    for (var key in patch) {
      if (blocked.indexOf(key) !== -1) continue;
      settings[key] = patch[key];
    }
    if (patch.currency !== undefined) settings.currency = normalizeCurrency(patch.currency, settings.currency);
  }

  // ---------------------------------------------------------------------------
  // 4. Hub 客户端（对齐桌面 client 模式）
  // ---------------------------------------------------------------------------

  function hubConfig() {
    var url = String((settings && settings.hubUrl) || '').trim().replace(/\/+$/, '');
    var secret = String((settings && settings.secret) || '');
    return { url: url, secret: secret };
  }

  function currentHubIdentity() {
    var c = hubConfig();
    return c.url ? (c.url + '|' + c.secret) : '';
  }

  function hubFetch(path, options) {
    var c = hubConfig();
    if (!c.url) return Promise.reject(new Error('hub_not_configured'));
    var headers = Object.assign({}, (options && options.headers) || {});
    if (c.secret) headers.authorization = 'Bearer ' + c.secret;
    return fetch(c.url + path, Object.assign({}, options, { headers: headers })).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (body) {
          var err = new Error('Hub ' + res.status + ': ' + String(body).slice(0, 200));
          err.status = res.status;
          throw err;
        });
      }
      return res.json();
    });
  }

  // 最新 hub 快照缓存（对齐 main.js 的 latestHubStats 语义）
  var latestHubStats = null;
  var latestHubStatsReceivedAt = null;
  var latestStats = null;
  var statsPushRevision = 0;

  function setLatestHubStatsCache(stats) {
    latestHubStats = stats;
    latestHubStatsReceivedAt = Date.now();
  }

  // statsPublisher 的呈现缓存（WeakMap + 键串，键变化即换新 WeakMap）
  var presentationCacheKey = null;
  var presentationCacheMap = null;
  function presentationCacheGet(stats, key, compose) {
    if (presentationCacheKey !== key) { presentationCacheKey = key; presentationCacheMap = new WeakMap(); }
    if (presentationCacheMap.has(stats)) return presentationCacheMap.get(stats);
    var value = compose();
    presentationCacheMap.set(stats, value);
    return value;
  }

  var snapshots = null; // statsPublisher.createRendererSnapshots 轻量版
  function ensureSnapshots() {
    if (snapshots) return snapshots;
    var byId = new Map();
    var tags = new WeakMap();
    var nextId = 1;
    snapshots = {
      register: function (stats) {
        var tag = tags.get(stats);
        if (!tag) { tag = { id: nextId++, source: currentHubIdentity() }; tags.set(stats, tag); }
        byId.delete(tag.id);
        byId.set(tag.id, stats);
        if (byId.size > 8) byId.delete(byId.keys().next().value);
        return tag;
      },
      stamp: function (stats, copy) {
        if (!stats || typeof stats !== 'object') return copy;
        return Object.assign({}, copy, { snapshot: Object.assign({}, this.register(stats)) });
      },
      get: function (id) { return byId.get(id) || null; }
    };
    return snapshots;
  }

  // electronPresentationStats 等价物（main.js:3138）
  function presentationStats(stats) {
    var M = moduleCache;
    if (!M['src/electron/limits/statsPresentation.js'] || !M['src/electron/modelAliasPresentation.js']) return stats;
    var limitOptions = {
      localDeviceId: deviceId,
      syncActive: Boolean(hubConfig().url),
      opencodeLocalLimitsEnabled: (settings && settings.opencodeLocalLimitsEnabled === true)
    };
    var aliases = settings ? settings.modelAliases : undefined;
    var grouping = settings ? settings.modelAliasGrouping : undefined;
    var key = JSON.stringify([limitOptions, aliases || null, grouping || null, (settings && settings.sessionTitlesEnabled !== false)]);
    return presentationCacheGet(stats, key, function () {
      return M['src/electron/modelAliasPresentation.js'].exports.projectModelAliasStats(
        M['src/electron/limits/statsPresentation.js'].exports.projectLimitStatsForDisplay(stats, limitOptions),
        aliases,
        { grouping: grouping }
      );
    });
  }

  // stats:get 等价（main.js:8377，client 模式）
  function fetchHubStats() {
    return hubFetch('/api/stats');
  }

  function getStats() {
    return loadSharedModules().then(function () {
      return loadSettings();
    }).then(function () {
      var revision = statsPushRevision;
      return fetchHubStats().then(function (fetched) {
        setLatestHubStatsCache(fetched);
        var current = (statsPushRevision !== revision && latestStats) ? latestStats : fetched;
        if (current !== latestStats) pushStats(current, 'read');
        var stats = latestStats || current;
        maybeAdoptSharedMarkers(stats);
        persistStatsCache(stats);
        var snap = ensureSnapshots();
        return snap.stamp(stats, rendererStats(presentationStats(stats)));
      });
    });
  }

  // statsPublisher.rendererStats 原模块复用
  function rendererStats(stats) {
    var M = moduleCache;
    var mod = M['src/electron/statsPublisher.js'];
    return mod ? mod.exports.rendererStats(stats) : stats;
  }

  function pushStats(stats, reason) {
    latestStats = stats;
    statsPushRevision += 1;
    var snap = ensureSnapshots();
    var payload = {
      event: 'stats',
      data: { type: 'stats', reason: reason || 'local', mode: 'sync', stats: snap.stamp(stats, rendererStats(presentationStats(stats))) }
    };
    for (var i = 0; i < statsListeners.length; i++) {
      try { statsListeners[i](payload); } catch (_) {}
    }
  }

  var statsListeners = [];
  var statusListeners = [];
  var streamState = { connected: false, mode: 'idle', reason: null, detail: null };

  function pushStatus(connected, extra) {
    streamState.connected = Boolean(connected);
    streamState.mode = connected || hubConfig().url ? 'sync' : 'idle';
    if (!connected && extra && extra.reason) {
      streamState.reason = extra.reason;
      streamState.detail = extra.detail != null ? extra.detail : null;
    } else if (connected) {
      streamState.reason = null;
      streamState.detail = null;
    }
    var payload = { event: 'status', data: { connected: streamState.connected, mode: streamState.mode, reason: streamState.reason, detail: streamState.detail } };
    for (var i = 0; i < statusListeners.length; i++) {
      try { statusListeners[i](payload); } catch (_) {}
    }
  }

  function getStreamStatus() {
    return Promise.resolve({
      connected: streamState.connected,
      mode: streamState.mode,
      reason: streamState.reason || undefined,
      detail: streamState.detail || undefined
    });
  }

  // ---------------------------------------------------------------------------
  // 5. SSE 实时流（对齐 main.js startStatsStream，fetch 流式 + sseEventReader 原模块）
  // ---------------------------------------------------------------------------

  var streamAbort = null;
  var streamRetryTimer = null;
  var streamGeneration = 0;

  function classifyStreamFailure(info) {
    if (info && typeof info.reason === 'string' && info.reason.indexOf('http-') === 0) {
      var nativeCode = Number(info.reason.slice(4));
      if (nativeCode === 401 || nativeCode === 403) return { reason: 'unauthorized' };
      return { reason: 'unreachable', detail: String(nativeCode) };
    }
    if (info && info.status === 401) return { reason: 'unauthorized' };
    if (info && info.status === 403) return { reason: 'unauthorized' };
    if (info && info.status) return { reason: 'http-' + info.status, detail: String(info.status) };
    if (info && info.errorName === 'AbortError') return { reason: 'timeout' };
    if (info && info.reason === 'timeout') return { reason: 'timeout' };
    if (info && info.reason === 'eof') return { reason: 'eof' };
    if (info && info.message && /network/i.test(info.message)) return { reason: 'unreachable' };
    return { reason: (info && info.reason) || 'unreachable', detail: (info && info.message) || null };
  }

  var nativeSseHandles = [];

  function stopNativeSse() {
    if (!ssePlugin) return;
    try { ssePlugin.disconnect(); } catch (_) {}
    for (var i = 0; i < nativeSseHandles.length; i++) {
      try { nativeSseHandles[i].remove(); } catch (_) {}
    }
    nativeSseHandles = [];
  }

  function stopStatsStream() {
    streamGeneration += 1;
    if (streamAbort) { try { streamAbort.abort(); } catch (_) {} streamAbort = null; }
    if (streamRetryTimer) { clearTimeout(streamRetryTimer); streamRetryTimer = null; }
    stopNativeSse();
  }

  function scheduleStreamRetry() {
    if (streamRetryTimer) return;
    streamRetryTimer = setTimeout(function () {
      streamRetryTimer = null;
      connectStream();
    }, 3000);
  }

  function connectStream() {
    var c = hubConfig();
    if (!c.url) { pushStatus(false, { reason: 'notConfigured' }); return; }
    stopStatsStream();
    var generation = streamGeneration;
    if (ssePlugin) { connectStreamNative(generation, c); return; }
    var controller = new AbortController();
    streamAbort = controller;
    var M = moduleCache;
    var sse = M['src/electron/sseEventReader.js'];
    if (!sse) { scheduleStreamRetry(); return; }

    fetch(c.url + '/api/stats/stream', {
      headers: {
        accept: 'text/event-stream',
        'x-token-monitor-stream': HUB_STREAM_VERSION,
        authorization: c.secret ? ('Bearer ' + c.secret) : undefined
      },
      signal: controller.signal
    }).then(function (response) {
      if (generation !== streamGeneration) return null;
      if (!response.ok || !response.body) {
        var f = classifyStreamFailure({ status: response.status });
        pushStatus(false, f);
        scheduleStreamRetry();
        return null;
      }
      pushStatus(true);
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var blocks = sse.exports.createSseBlockReader();
      function pump() {
        return reader.read().then(function (chunk) {
          if (generation !== streamGeneration) return;
          if (chunk.done) {
            pushStatus(false, classifyStreamFailure({ reason: 'eof' }));
            scheduleStreamRetry();
            return;
          }
          var text = decoder.decode(chunk.value, { stream: true });
          var parsedBlocks = blocks.push(text);
          for (var i = 0; i < parsedBlocks.length; i++) {
            var parsed = sse.exports.parseSseBlock(parsedBlocks[i]);
            if (!parsed) continue;
            handleStreamEvent(parsed);
          }
          return pump();
        });
      }
      return pump();
    }).catch(function (error) {
      if (generation !== streamGeneration) return;
      if (error && error.name === 'AbortError') return;
      pushStatus(false, classifyStreamFailure({ message: error && error.message, errorName: error && error.name }));
      scheduleStreamRetry();
    });
  }

  // 原生层 SSE（TokenMonitorSsePlugin）：文本块 → 原版 sseEventReader → 事件
  function connectStreamNative(generation, c) {
    var sse = moduleCache['src/electron/sseEventReader.js'];
    if (!sse) { scheduleStreamRetry(); return; }
    var blocks = sse.exports.createSseBlockReader();
    function addListener(evt, handler) {
      ssePlugin.addListener(evt, handler).then(function (handle) {
        if (generation !== streamGeneration) {
          try { handle.remove(); } catch (_) {}
          return;
        }
        nativeSseHandles.push(handle);
      }).catch(function () {});
    }
    addListener('chunk', function (chunk) {
      if (generation !== streamGeneration) return;
      var parsedBlocks = blocks.push((chunk && chunk.text) || '');
      for (var i = 0; i < parsedBlocks.length; i++) {
        var parsed = sse.exports.parseSseBlock(parsedBlocks[i]);
        if (parsed) handleStreamEvent(parsed);
      }
    });
    addListener('open', function () {
      if (generation === streamGeneration) pushStatus(true);
    });
    addListener('closed', function (payload) {
      if (generation !== streamGeneration) return;
      pushStatus(false, classifyStreamFailure({
        reason: (payload && payload.reason) || 'network',
        message: (payload && payload.detail) || null
      }));
      scheduleStreamRetry();
    });
    ssePlugin.connect({ url: c.url + '/api/stats/stream', secret: c.secret });
  }

  function handleStreamEvent(parsed) {
    var M = moduleCache;
    var hubProtocol = M['src/shared/hubProtocol.js'];
    if (parsed.event === 'stats' || parsed.event === 'snapshot') {
      if (parsed.data && parsed.data.stats) {
        setLatestHubStatsCache(parsed.data.stats);
        pushStats(composeDisplayStats(parsed.data.stats), parsed.data.reason || 'ingest');
        maybeAdoptSharedMarkers(parsed.data.stats);
        persistStatsCache(parsed.data.stats);
      }
    } else if (parsed.event === 'freshness' && hubProtocol) {
      var refreshed = hubProtocol.exports.applyFreshnessEvent(latestHubStats, parsed.data);
      if (!refreshed) return;
      setLatestHubStatsCache(refreshed);
      pushStats(composeDisplayStats(refreshed), (parsed.data && parsed.data.reason) || 'ingest');
      maybeAdoptSharedMarkers(refreshed);
    } else {
      // 其他事件原样转发（与桌面 sendPush(parsed) 一致）
      for (var i = 0; i < statsListeners.length; i++) {
        try { statsListeners[i](parsed); } catch (_) {}
      }
    }
  }

  // composeLocalSyncSummary(stats, null) —— 无本地设备时按桌面语义原样返回
  function composeDisplayStats(stats) {
    var M = moduleCache;
    var mod = M['src/electron/syncDisplayStats.js'];
    if (!mod) return stats;
    try {
      return mod.exports.composeLocalSyncSummary(stats, null);
    } catch (_) {
      return stats;
    }
  }

  // ---------------------------------------------------------------------------
  // 6. 共享标记采纳（subscriptionsUpdatedAt / syncSettingsRevisions）
  // ---------------------------------------------------------------------------

  var lastSubscriptionsUpdatedAt = null;
  var lastSyncRevisions = null;
  var adoptingMarkers = false;

  function maybeAdoptSharedMarkers(stats) {
    if (!stats || adoptingMarkers) return;
    var subsUpdated = String(stats.subscriptionsUpdatedAt || '');
    var revisions = stats.syncSettingsRevisions || null;
    if (subsUpdated && subsUpdated !== lastSubscriptionsUpdatedAt) {
      adoptingMarkers = true;
      hubFetch('/api/subscriptions').then(function (doc) {
        lastSubscriptionsUpdatedAt = subsUpdated;
        settings.subscriptions = Array.isArray(doc.subscriptions) ? doc.subscriptions : [];
        settings.subscriptionsCacheHub = hubConfig().url;
        pushSettingsToRenderer();
      }).catch(function () {}).then(function () { adoptingMarkers = false; });
    }
    if (revisions && JSON.stringify(revisions) !== JSON.stringify(lastSyncRevisions)) {
      var prev = lastSyncRevisions || {};
      lastSyncRevisions = revisions;
      ['modelAliases', 'customPricing'].forEach(function (kind) {
        if (prev[kind] === revisions[kind]) return;
        hubFetch('/api/sync/settings/' + kind).then(function (doc) {
          if (!doc || doc.value == null) return;
          if (kind === 'modelAliases') {
            settings.modelAliases = (doc.value && doc.value.modelAliases) || {};
            settings.modelAliasGrouping = (doc.value && doc.value.modelAliasGrouping) || 'off';
          } else {
            settings.customModelPricing = Array.isArray(doc.value) ? doc.value : [];
          }
          pushSettingsToRenderer();
        }).catch(function () {});
      });
    }
  }

  function persistStatsCache(stats) {
    try {
      storageWrite(STATS_CACHE_FILE, JSON.stringify({ savedAt: new Date().toISOString(), stats: stats }));
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // 7. 余额面：与服务状态 / hub 信息 / 构建状态 / 更新检查
  // ---------------------------------------------------------------------------

  var serviceStatusClient = null;
  function ensureServiceStatusClient() {
    if (serviceStatusClient) return serviceStatusClient;
    var mod = moduleCache['src/electron/serviceStatus.js'];
    if (mod) serviceStatusClient = mod.exports.createServiceStatusClient();
    return serviceStatusClient;
  }

  function getServiceStatus(options) {
    return loadSharedModules().then(function () {
      var client = ensureServiceStatusClient();
      if (!client) return { providers: [], checkedAt: new Date().toISOString() };
      return client.getServiceStatus({
        force: Boolean(options && options.force),
        providerIds: Array.isArray(options && options.providerIds) ? options.providerIds : null
      });
    });
  }

  function getHubInfo() {
    var c = hubConfig();
    var port = HUB_DEFAULT_PORT;
    try { port = new URL(c.url).port ? Number(new URL(c.url).port) : (new URL(c.url).protocol === 'https:' ? 443 : 80); } catch (_) {}
    return Promise.resolve({
      mode: 'client',
      port: port,
      secret: String((settings && settings.hubHostSecret) || ''),
      listening: false,
      listeningPort: null,
      error: null,
      lanAddresses: [],
      icloud: { state: 'unavailable', availability: 'unavailable', supported: false, root: '', deviceCount: 0, watcher: 'inactive', reconciliation: 'idle' }
    });
  }

  function getHubBuildStatus() {
    var c = hubConfig();
    if (!c.url) return Promise.resolve({ status: 'notConfigured', runtime: '', hubUrl: '' });
    return loadSharedModules().then(function () {
      var mod = moduleCache['src/electron/hubBuildStatus.js'];
      if (!mod) return { status: 'unknown', runtime: '', hubUrl: c.url };
      return mod.exports.probeHubBuild(c.url).catch(function () {
        return { status: 'unknown', runtime: '', hubUrl: c.url };
      });
    });
  }

  function regenerateHubSecret() {
    return loadSettings().then(function () {
      settings.hubHostSecret = generateHubSecret();
      return persistSettings();
    }).then(function () {
      fireHubPush();
      return getHubInfo();
    });
  }

  // 应用内更新检查（桌面 electron-updater 的 Android 替代：GitHub Releases 比对，
  // 不做下载安装——APK 由用户手动更新，installSupported 恒为 false）
  function fetchLatestReleaseVersion() {
    return fetch(RELEASES_URL.replace('/releases/latest', '/releases/latest'), {
      headers: { accept: 'application/vnd.github+json' }
    }).then(function (res) { return res.json(); }).then(function (doc) {
      return String((doc && doc.tag_name) || '').replace(/^v/, '');
    });
  }

  function versionCompare(a, b) {
    var pa = String(a || '').split('.').map(Number);
    var pb = String(b || '').split('.').map(Number);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var va = pa[i] || 0; var vb = pb[i] || 0;
      if (va !== vb) return va > vb ? 1 : -1;
    }
    return 0;
  }

  function appUpdateState(extra) {
    var block = (settings && settings.appUpdate) || {};
    var latest = block.lastKnownLatest || null;
    var dismissed = block.dismissedVersion || null;
    var hasUpdate = Boolean(latest && versionCompare(latest, APP_VERSION) > 0 && latest !== dismissed);
    return Object.assign({
      currentVersion: APP_VERSION,
      latest: latest,
      releasesUrl: RELEASES_URL,
      hasUpdate: hasUpdate,
      showUpdateNotice: hasUpdate,
      dismissedVersion: dismissed,
      lastCheckedAt: block.lastCheckedAt || null,
      lastAttemptAt: null,
      checking: false,
      lastError: null,
      lastErrorKind: null,
      installSupported: false,
      installSupportReason: 'android-manual',
      installPhase: 'idle',
      installProgress: null,
      installVersion: null,
      installError: null
    }, extra || {});
  }

  function checkAppUpdateNow() {
    return loadSettings().then(function () {
      return fetchLatestReleaseVersion().then(function (latest) {
        settings.appUpdate = Object.assign({}, settings.appUpdate, {
          lastCheckedAt: new Date().toISOString(),
          lastKnownLatest: latest || settings.appUpdate.lastKnownLatest
        });
        return persistSettings().then(function () { return appUpdateState(); });
      }).catch(function (error) {
        return appUpdateState({ lastError: (error && error.message) || 'check failed', lastErrorKind: 'check' });
      });
    });
  }

  function dismissAppUpdate(version) {
    return loadSettings().then(function () {
      settings.appUpdate = Object.assign({}, settings.appUpdate, { dismissedVersion: String(version || '') });
      return persistSettings();
    }).then(function () { return appUpdateState(); });
  }

  // ---------------------------------------------------------------------------
  // 8. 同步内容（标题/共享设置）— Android 为只读客户端，能力位恒为 unsupported
  // ---------------------------------------------------------------------------

  function getSyncContentStatus() {
    return {
      identity: currentHubIdentity(),
      destination: (settings && settings.hubUrl) || '',
      supported: false,
      serverTitlesEnabled: false,
      enabled: { sessionTitles: false, modelAliases: false, customPricing: false },
      revisions: { modelAliases: 0, customPricing: 0 },
      pendingTitleCleanup: false,
      error: 'unsupported'
    };
  }

  // ---------------------------------------------------------------------------
  // 9. 平台信息 / 诊断 / 杂项
  // ---------------------------------------------------------------------------

  function androidRelease() {
    var m = /Android (\d+)/.exec(navigator.userAgent || '');
    return m ? ('android-' + m[1]) : 'android';
  }

  function getAppInfo() {
    return Promise.resolve({
      notchCapabilities: null,
      version: APP_VERSION,
      platform: 'android',
      arch: 'arm64',
      osRelease: androidRelease(),
      isPackaged: true,
      userData: '(android sandbox)/files',
      homeDir: '(android sandbox)/files',
      sharedDataDir: '(android sandbox)/files',
      customScanClientIds: [],
      loginItemSupported: false,
      loginItemOpenAtLogin: false,
      systemDarkUi: window.matchMedia('(prefers-color-scheme: dark)').matches
    });
  }

  function generateDiagnosticReport() {
    var c = hubConfig();
    var lines = [
      'Token Monitor — Android (Capacitor WebView)',
      'version: ' + APP_VERSION,
      'platform: android (' + androidRelease() + ')',
      'userAgent: ' + navigator.userAgent,
      'deviceId: ' + String(deviceId || ''),
      'hub configured: ' + (c.url ? 'yes' : 'no'),
      'hub url: ' + (c.url ? c.url.replace(/\/\/[^/]*@/, '//***@') : '(not set)'),
      'stream connected: ' + streamState.connected,
      'stream failure: ' + (streamState.reason || 'none'),
      'last stats received: ' + (latestHubStatsReceivedAt ? new Date(latestHubStatsReceivedAt).toISOString() : 'never'),
      'native storage: ' + (Fs ? 'Filesystem plugin' : 'localStorage fallback')
    ];
    var text = lines.join('\n');
    return Promise.resolve({
      generatedAt: new Date().toISOString(),
      completeness: {},
      text: text,
      bytes: text.length,
      truncated: false,
      includedClientCount: 0,
      omittedClientCount: 0,
      includedLimitProviderCount: 0,
      omittedLimitProviderCount: 0,
      includedRemoteGroupCount: 0,
      omittedRemoteGroupCount: 0,
      includedJournalEventCount: 0,
      journalOmittedCount: 0
    });
  }

  function copyText(text) {
    return new Promise(function (resolve, reject) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(String(text)).then(function () { resolve({ ok: true }); }, function () { legacyCopy(text) ? resolve({ ok: true }) : reject(new Error('clipboard unavailable')); });
      } else {
        legacyCopy(text) ? resolve({ ok: true }) : reject(new Error('clipboard unavailable'));
      }
    });
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = String(text);
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) { return false; }
  }

  function openExternal(url) {
    var Browser = capPlugins && capPlugins.Browser;
    if (Browser && Browser.open) return Browser.open({ url: String(url) }).then(function () { return { ok: true }; });
    window.open(String(url), '_blank', 'noopener');
    return Promise.resolve({ ok: true });
  }

  // ---------------------------------------------------------------------------
  // 10. 历史与聚合（hub /api/history + 原模块投影）
  // ---------------------------------------------------------------------------

  function getDashboardHistory(options) {
    return loadSharedModules().then(function () {
      return hubFetch('/api/history').then(function (history) {
        var M = moduleCache;
        var aliasMod = M['src/electron/modelAliasPresentation.js'];
        var meta = { source: 'hub', historyTransportAvailable: true };
        var result = Object.assign({}, history, { fixedPeriods: meta });
        if (aliasMod) {
          result = aliasMod.exports.projectModelAliasHistory(result, settings.modelAliases, { grouping: settings.modelAliasGrouping });
        }
        return result;
      });
    });
  }

  function getAllTimeSessions(snapshotId) {
    var M = moduleCache;
    var snap = ensureSnapshots();
    var stats = snap.get(snapshotId);
    if (!stats) return Promise.resolve(null);
    var syncMod = M['src/electron/syncDisplayStats.js'];
    var aliasMod = M['src/electron/modelAliasPresentation.js'];
    var complete = syncMod ? syncMod.exports.completeLocalSyncStats(stats) : stats;
    var sessions = (complete && complete.periods && complete.periods.allTime && complete.periods.allTime.sessions) || {};
    if (aliasMod) {
      sessions = aliasMod.exports.projectModelAliasSessions(stats, sessions, settings.modelAliases, { grouping: settings.modelAliasGrouping });
    }
    return Promise.resolve(sessions);
  }

  // 会话明细：桌面端读本地转录文件（sessionDetailWorker），Android 无转录可读。
  // 【原桌面端代码】readSessionDetailForPlatform({...}) → 本地 JSONL/SQLite 解析
  // 【Android适配代码】恒 found:false，UI 以 stats 内聚合行降级渲染
  function getSessionDetail() {
    return Promise.resolve({ found: false });
  }

  function lookupModelPricing(modelId) {
    return loadSettings().then(function () {
      var list = (settings && settings.customModelPricing) || [];
      var wanted = String(modelId || '').trim().toLowerCase();
      for (var i = 0; i < list.length; i++) {
        var entry = list[i];
        if (String(entry.modelId || '').trim().toLowerCase() !== wanted) continue;
        var toPerToken = function (v) { return typeof v === 'number' ? v / 1e6 : null; };
        return {
          ok: true,
          result: {
            pricing: {
              input: toPerToken(entry.inputPerM),
              output: toPerToken(entry.outputPerM),
              cacheRead: toPerToken(entry.cacheReadPerM),
              cacheWrite: toPerToken(entry.cacheWritePerM)
            },
            matchedKey: entry.modelId,
            source: 'custom'
          }
        };
      }
      return { ok: false };
    });
  }

  // ---------------------------------------------------------------------------
  // 11. 订阅（hub 共享列表读写；CAS 冲突错误码对齐桌面）
  // ---------------------------------------------------------------------------

  function saveSubscriptions(list, base) {
    return loadSettings().then(function () {
      var body = { subscriptions: Array.isArray(list) ? list : [], baseUpdatedAt: String((base && base.updatedAt) || '') };
      var c = hubConfig();
      if (!c.url) {
        settings.subscriptions = Array.isArray(list) ? list : [];
        return persistSettings().then(rendererSettings);
      }
      return fetch(c.url + '/api/subscriptions', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: c.secret ? ('Bearer ' + c.secret) : undefined },
        body: JSON.stringify(body)
      }).then(function (res) {
        if (res.status === 409) throw new Error('stale_write');
        if (!res.ok) throw new Error('hub_rejected');
        return res.json();
      }).then(function (doc) {
        settings.subscriptions = Array.isArray(doc.subscriptions) ? doc.subscriptions : [];
        settings.subscriptionsCacheHub = c.url;
        lastSubscriptionsUpdatedAt = String(doc.updatedAt || '');
        pushSettingsToRenderer();
        return rendererSettings();
      }).catch(function (error) {
        if (error && error.status) throw new Error('hub_unreachable');
        throw error;
      });
    });
  }

  // Android 无本地-only 订阅来源 → 两个孤儿接口均为无操作（对齐桌面无孤儿时行为）
  function adoptOrphanedSubscriptions() { return Promise.resolve(rendererSettings()); }
  function discardOrphanedSubscriptions() { return Promise.resolve(rendererSettings()); }

  function deleteDevice(deviceIdToDelete) {
    var c = hubConfig();
    if (!c.url) return Promise.reject(new Error('hub_not_configured'));
    return fetch(c.url + '/api/devices/' + encodeURIComponent(String(deviceIdToDelete)), {
      method: 'DELETE',
      headers: { authorization: c.secret ? ('Bearer ' + c.secret) : undefined }
    }).then(function (res) {
      if (!res.ok) throw new Error('Hub ' + res.status);
      return { ok: true };
    }).then(function (result) {
      return fetchHubStats().then(function (stats) {
        setLatestHubStatsCache(stats);
        pushStats(stats, 'read');
        return result;
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 12. 桌面专属面：托盘 / 悬浮球 / 窗口 — Android 有意 no-op（裁剪说明见移植文档）
  // ---------------------------------------------------------------------------

  function noopResult(value) { return function () { return Promise.resolve(value === undefined ? null : value); }; }

  var openViewListeners = [];
  var openSettingsListeners = [];
  var hubListeners = [];
  var themeListeners = [];

  function fireOpenView(viewId) {
    for (var i = 0; i < openViewListeners.length; i++) {
      try { openViewListeners[i](viewId); } catch (_) {}
    }
  }

  function fireHubPush() {
    getHubInfo().then(function (payload) {
      for (var i = 0; i < hubListeners.length; i++) {
        try { hubListeners[i](payload); } catch (_) {}
      }
    }).catch(function () {});
  }

  // ---------------------------------------------------------------------------
  // 13. window.tokenMonitor 组装（与 preload.js 方法面一一对应）
  // ---------------------------------------------------------------------------

  var api = {
    // --- 设置 ---
    getSettings: function () { return loadSettings().then(rendererSettings); },
    updateSettings: function (patch) {
      return loadSettings().then(function () {
        var hubChanged = patch && (patch.hubUrl !== undefined || patch.secret !== undefined);
        applySettingsPatch(patch);
        return persistSettings().then(function () {
          pushSettingsToRenderer();
          var c = hubConfig();
          if (c.url) connectStream(); else stopStatsStream();
          if (hubChanged) fireHubPush();
          return rendererSettings();
        });
      });
    },

    // --- 统计/历史/会话 ---
    getStats: getStats,
    getAllTimeSessions: getAllTimeSessions,
    getSessionDetail: getSessionDetail,
    getStreamStatus: getStreamStatus,
    getServiceStatus: getServiceStatus,
    getCodexResetForecast: function () {
      return loadSettings().then(function () {
        if (!settings || settings.codexResetForecastEnabled !== true) {
          return { status: 'disabled', checkedAt: new Date().toISOString() };
        }
        return { status: 'unavailable', checkedAt: new Date().toISOString() };
      });
    },
    lookupModelPricing: lookupModelPricing,
    clearSessionUsageArchive: function () { return Promise.resolve({ ok: false, error: 'unsupported' }); },

    // --- 订阅 ---
    saveSubscriptions: saveSubscriptions,
    adoptOrphanedSubscriptions: adoptOrphanedSubscriptions,
    discardOrphanedSubscriptions: discardOrphanedSubscriptions,

    // --- 外观（Android：无原生材质，恒 transparent → CSS 玻璃降级链生效） ---
    previewAppearance: function (patch) {
      return loadSettings().then(function () {
        applySettingsPatch(patch);
        return persistSettings();
      }).then(function () {
        pushSettingsToRenderer();
        return rendererSettings();
      });
    },
    getBackgroundImage: function () { return Promise.resolve(null); },
    chooseBackgroundImage: function () { return Promise.resolve({ ok: false, canceled: true }); },
    clearBackgroundImage: function () { return Promise.resolve({ ok: true }); },
    getNativeMaterialState: function () {
      return Promise.resolve({ type: 'transparent', reducedTransparency: false, highContrast: false, fallbackReason: 'android-webview', liquidGlassSupported: false });
    },
    onNativeMaterialState: function () { return function () {}; },

    // --- 设备 ---
    deleteDevice: deleteDevice,
    clientSources: function () { return Promise.resolve({ ok: false, error: 'unsupported-platform' }); },
    pickCustomScanPath: function () { return Promise.resolve({ ok: false, error: 'unsupported-platform' }); },
    revealClientSource: noopResult(undefined),
    revealClientSyncLock: noopResult(undefined),
    rescanClient: function () { return Promise.resolve({ ok: false, error: 'unsupported-platform' }); },
    repairClientSyncLock: noopResult(undefined),

    // --- Hub/同步 ---
    getHubInfo: getHubInfo,
    getHubBuildStatus: getHubBuildStatus,
    regenerateHubSecret: regenerateHubSecret,
    onHubPush: function (callback) { hubListeners.push(callback); return function () { var i = hubListeners.indexOf(callback); if (i >= 0) hubListeners.splice(i, 1); }; },
    getSyncContentStatus: getSyncContentStatus,
    previewSyncContent: function () { return Promise.resolve({ ok: false, error: 'unsupported' }); },
    configureSyncContent: function () { return Promise.resolve(getSyncContentStatus()); },
    retrySyncContentCleanup: function () { return Promise.resolve(getSyncContentStatus()); },
    onSyncContentPush: function () { return function () {}; },

    // --- 推送订阅 ---
    onStatsPush: function (callback) { statsListeners.push(callback); return function () { var i = statsListeners.indexOf(callback); if (i >= 0) statsListeners.splice(i, 1); }; },
    onSettingsPush: function (callback) { settingsListeners.push(callback); return function () { var i = settingsListeners.indexOf(callback); if (i >= 0) settingsListeners.splice(i, 1); }; },
    onWindowVisibilityPush: function () { return function () {}; },
    onNotchCapabilitiesPush: function () { return function () {}; },
    onSystemUiThemePush: function (callback) { themeListeners.push(callback); return function () { var i = themeListeners.indexOf(callback); if (i >= 0) themeListeners.splice(i, 1); }; },
    onOpenSettings: function (callback) { openSettingsListeners.push(callback); return function () { var i = openSettingsListeners.indexOf(callback); if (i >= 0) openSettingsListeners.splice(i, 1); }; },
    onOpenView: function (callback) { openViewListeners.push(callback); return function () { var i = openViewListeners.indexOf(callback); if (i >= 0) openViewListeners.splice(i, 1); }; },

    // --- 应用信息/更新/导出/诊断 ---
    getAppInfo: getAppInfo,
    generateDiagnosticReport: generateDiagnosticReport,
    copyText: copyText,
    openExternal: openExternal,
    openUserData: noopResult(undefined),
    exportNow: function () { return Promise.resolve({ ok: false, reason: 'unsupported' }); },
    pickExportDir: function () { return Promise.resolve({ ok: false, canceled: true }); },
    getTokscaleStatus: function () { return Promise.resolve({ supported: false }); },
    getAppUpdateState: function () { return loadSettings().then(function () { return appUpdateState(); }); },
    checkAppUpdateNow: checkAppUpdateNow,
    downloadAppUpdate: function () { return loadSettings().then(function () { return appUpdateState(); }); },
    installAppUpdate: function () { return loadSettings().then(function () { return appUpdateState(); }); },
    dismissAppUpdate: dismissAppUpdate,
    onAppUpdatePush: function () { return function () {}; },
    setTrayIcons: noopResult(undefined),

    // --- 厂商账号面（Android v1 裁剪：配额经 hub 同步展示，登录在桌面端完成） ---
    antigravity: { accounts: function () { return Promise.resolve([]); }, addAccount: function () { return Promise.resolve({ ok: false, error: 'unsupported' }); }, cancelLogin: noopResult(undefined), removeAccount: noopResult(undefined), setAccountEnabled: noopResult(undefined), onAccounts: function () { return function () {}; } },
    workbuddy: { accounts: function () { return Promise.resolve([]); }, addAccount: function () { return Promise.resolve({ ok: false, error: 'unsupported' }); }, cancelLogin: noopResult(undefined), removeAccount: noopResult(undefined), setAccountEnabled: noopResult(undefined), onAccounts: function () { return function () {}; } },
    mimo: { accounts: function () { return Promise.resolve([]); }, addAccount: function () { return Promise.resolve({ ok: false, error: 'unsupported' }); }, openConsole: noopResult(undefined), removeAccount: noopResult(undefined), setAccountEnabled: noopResult(undefined), onAccounts: function () { return function () {}; } },
    cursor: { loginManual: function () { return Promise.resolve({ ok: false, error: 'unsupported' }); }, setAccountEnabled: noopResult(undefined), logout: noopResult(undefined), status: function () { return Promise.resolve({ status: 'unsupported' }); } },
    limits: { saveCredential: function () { return Promise.resolve({ ok: false, error: 'unsupported' }); }, listOrganizationChoices: function () { return Promise.resolve([]); }, clearCredential: noopResult({ ok: true }) },
    opencode: { saveCookie: function () { return Promise.resolve({ ok: false, error: 'unsupported' }); }, logout: noopResult(undefined), status: function () { return Promise.resolve({ status: 'unsupported' }); }, getProfiles: function () { return Promise.resolve([]); }, saveProfile: function () { return Promise.resolve({ ok: false, error: 'unsupported' }); }, deleteProfile: noopResult(undefined), renameProfile: noopResult(undefined), removeCredential: noopResult(undefined), moveCredential: noopResult(undefined), setProfileEnabled: noopResult(undefined), setAmbientEnabled: noopResult(undefined) },
    openrouter: { getProfiles: function () { return Promise.resolve([]); }, saveProfile: function () { return Promise.resolve({ ok: false, error: 'unsupported' }); }, deleteProfile: noopResult(undefined), renameProfile: noopResult(undefined), setProfileEnabled: noopResult(undefined) },
    thirdparty: { getProfiles: function () { return Promise.resolve([]); }, saveProfile: function () { return Promise.resolve({ ok: false, error: 'unsupported' }); }, deleteProfile: noopResult(undefined), renameProfile: noopResult(undefined), setProfileEnabled: noopResult(undefined) },
    codex: { accounts: function () { return Promise.resolve([]); }, addAccount: function () { return Promise.resolve({ ok: false, error: 'unsupported' }); }, selectWorkspace: noopResult(undefined), cancelLogin: noopResult(undefined), removeAccount: noopResult(undefined), setAccountEnabled: noopResult(undefined), switchSystemAccount: noopResult(undefined), refreshAccountLimits: noopResult(undefined), onActiveAccount: function () { return function () {}; }, onLoginStatus: function () { return function () {}; } },
    copilot: { signIn: function () { return Promise.resolve({ ok: false, error: 'unsupported' }); }, cancelSignIn: noopResult(undefined), onLoginStatus: function () { return function () {}; } },

    // --- 窗口/悬浮球（桌面形态面：Android 有意 no-op） ---
    openDashboard: function () { fireOpenView('trends'); return Promise.resolve({ ok: true }); },
    getDashboardHistory: getDashboardHistory,
    onDashboardHistoryChanged: function () { return function () {}; },
    dashboard: { ready: noopResult(undefined), minimize: noopResult(undefined), close: noopResult(undefined) },
    expandFloatingBubble: noopResult(undefined),
    moveFloatingBubble: noopResult(undefined),
    peekFloatingBubble: noopResult(undefined),
    collapseFloatingBubbleIfIdle: noopResult(undefined),
    setFloatingBubbleCollapsedSize: noopResult(undefined),
    onFloatingBubbleState: function () { return function () {}; },
    signalContentReady: function () { return undefined; },
    setViewState: function (patch) {
      return loadSettings().then(function () {
        if (patch && typeof patch === 'object') {
          settings.lastViewState = Object.assign({}, settings.lastViewState, patch);
          return persistSettings();
        }
      });
    },
    minimize: function () { return undefined; },
    close: function () { return undefined; }
  };

  window.tokenMonitor = api;
  window.__TOKEN_MONITOR_ANDROID_BRIDGE__ = { version: 1 };

  // ---------------------------------------------------------------------------
  // 14. 启动序列：加载设置 → 恢复缓存 → 连流 → 主题/生命周期
  // ---------------------------------------------------------------------------

  function boot() {
    document.documentElement.classList.add('android-shell');
    loadSettings().then(function () {
      return loadSharedModules();
    }).then(function () {
      // 离线种子：上次的 hub 快照先上屏，getStats 到达后自然覆盖
      return storageRead(STATS_CACHE_FILE).then(function (raw) {
        if (!raw) return;
        try {
          var doc = JSON.parse(raw);
          if (doc && doc.stats) {
            setLatestHubStatsCache(doc.stats);
            pushStats(composeDisplayStats(doc.stats), 'local');
          }
        } catch (_) {}
      });
    }).then(function () {
      if (hubConfig().url) {
        connectStream();
        getStats().catch(function () {});
      } else {
        pushStatus(false, { reason: 'notConfigured' });
      }
    }).catch(function () {});

    // 系统深色模式 → 渲染层 + 状态栏
    var darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
    function fireTheme() {
      for (var i = 0; i < themeListeners.length; i++) {
        try { themeListeners[i]({ dark: darkQuery.matches }); } catch (_) {}
      }
      var StatusBar = capPlugins && capPlugins.StatusBar;
      if (StatusBar && StatusBar.setStyle) {
        try {
          StatusBar.setStyle({ style: darkQuery.matches ? 'DARK' : 'LIGHT' });
          if (StatusBar.setOverlaysWebView) StatusBar.setOverlaysWebView({ overlay: false });
        } catch (_) {}
      }
    }
    if (darkQuery.addEventListener) darkQuery.addEventListener('change', fireTheme);

    // 回前台：流断了立即重连 + 拉一次快照
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (hubConfig().url && !streamState.connected) connectStream();
      if (hubConfig().url) getStats().catch(function () {});
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
