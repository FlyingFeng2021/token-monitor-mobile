'use strict';
/*
 * 桥模块闭包执行测试 —— 在 Node 中以与 android-bridge.js 完全相同的
 * require 解析规则执行 www/app 内的原版模块，证明：
 *   1) CJS_MODULES 表内每个模块可在浏览器沙箱语义下执行（无 node: 内建依赖泄漏）
 *   2) 所有 require 相对路径可解析（CJS 表 或 UMD 文件本体）
 *   3) 桥依赖的关键导出面存在
 * UMD 依赖在 Node 下走 module.exports 分支（原仓库 node --test 同款语义）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'www', 'app');

const CJS_MODULES = {
  'package.json': 1,
  'src/shared/hubProtocol.js': 1,
  'src/shared/appVersion.js': 1,
  'src/shared/syncUploadInterval.js': 1,
  'src/shared/usage.js': 1,
  'src/shared/history.js': 1,
  'src/shared/clientHealth.js': 1,
  'src/shared/sessionActivityProjection.js': 1,
  'src/shared/providers/reasonix/paths.js': 1,
  'src/shared/providers/reasonix/sessionGuard.js': 1,
  'src/shared/projectKey.js': 1,
  'src/shared/providers/dsh/paths.js': 1,
  'src/shared/providers/devin/paths.js': 1,
  'src/shared/limits/core.js': 1,
  'src/electron/serviceStatus.js': 1,
  'src/electron/sseEventReader.js': 1,
  'src/electron/statsPublisher.js': 1,
  'src/electron/syncDisplayStats.js': 1,
  'src/electron/modelAliasPresentation.js': 1,
  'src/electron/limits/statsPresentation.js': 1,
  'src/electron/fixedPeriodHistory.js': 1,
  'src/electron/hubBuildStatus.js': 1,
  'src/shared/hubBuildComparison.js': 1,
  'src/shared/hubBuildIdentity.js': 1
};

const cache = Object.create(null);

function loadRel(repoPath) {
  if (cache[repoPath]) return cache[repoPath].exports;
  const abs = path.join(ROOT, repoPath);
  const src = fs.readFileSync(abs, 'utf8');
  if (repoPath.endsWith('.json')) {
    cache[repoPath] = { exports: JSON.parse(src) };
    return cache[repoPath].exports;
  }
  const mod = { exports: {} };
  cache[repoPath] = mod;
  const dir = path.posix.dirname(repoPath.split('\\').join('/'));
  const req = (spec) => {
    const base = path.posix.normalize(path.posix.join(dir, spec));
    const candidates = [base + '.js', base + '/index.js', base];
    const target = candidates.find((c) => fs.existsSync(path.join(ROOT, c)));
    if (!target) {
      throw new Error('unresolvable require: ' + spec + ' (from ' + repoPath + ' → ' + base + ')');
    }
    return loadRel(target);
  };
  new Function('require', 'module', 'exports', src)(req, mod, mod.exports);
  return mod.exports;
}

let failures = 0;
function check(name, cond) {
  if (cond) { console.log('  ok  ' + name); } else { failures++; console.log('  FAIL ' + name); }
}

console.log('[1] executing full module closure...');
for (const key of Object.keys(CJS_MODULES)) {
  try { loadRel(key); console.log('  ok  executed ' + key); }
  catch (e) { failures++; console.log('  FAIL ' + key + ': ' + e.message); }
}

console.log('[2] export surface assertions...');
const m = (k) => cache[k] ? cache[k].exports : null;

const hubProtocol = m('src/shared/hubProtocol.js');
check('hubProtocol.applyFreshnessEvent', typeof (hubProtocol && hubProtocol.applyFreshnessEvent) === 'function');
check('hubProtocol.HUB_STREAM_HEADER', hubProtocol && hubProtocol.HUB_STREAM_HEADER === 'x-token-monitor-stream');

const syncDisplay = m('src/electron/syncDisplayStats.js');
check('syncDisplayStats.composeLocalSyncSummary', typeof (syncDisplay && syncDisplay.composeLocalSyncSummary) === 'function');
check('syncDisplayStats.completeLocalSyncStats', typeof (syncDisplay && syncDisplay.completeLocalSyncStats) === 'function');
if (syncDisplay) {
  const hub = { devices: [{ deviceId: 'd1', today: { tokens: 5 }, periods: { today: { tokens: 5 } } }] };
  const out = syncDisplay.composeLocalSyncSummary(hub, null);
  check('composeLocalSyncSummary(null device) returns hubStats as-is', out === hub);
}

const statsPublisher = m('src/electron/statsPublisher.js');
check('statsPublisher.rendererStats', typeof (statsPublisher && statsPublisher.rendererStats) === 'function');
if (statsPublisher) {
  const trimmed = statsPublisher.rendererStats({ periods: { allTime: { tokens: 1, sessions: { a: 1 } } }, devices: [] });
  check('rendererStats strips allTime.sessions', trimmed.periods && !('sessions' in trimmed.periods.allTime));
}

const sse = m('src/electron/sseEventReader.js');
check('sseEventReader.createSseBlockReader', typeof (sse && sse.createSseBlockReader) === 'function');
if (sse) {
  const reader = sse.createSseBlockReader();
  const blocks = reader.push('event: stats\ndata: {"a":1}\n\n');
  const parsed = blocks.length === 1 ? sse.parseSseBlock(blocks[0]) : null;
  check('SSE parse roundtrip', parsed && parsed.event === 'stats' && parsed.data.a === 1);
}

const pres = m('src/electron/limits/statsPresentation.js');
check('statsPresentation.projectLimitStatsForDisplay', typeof (pres && pres.projectLimitStatsForDisplay) === 'function');

const alias = m('src/electron/modelAliasPresentation.js');
check('modelAliasPresentation.projectModelAliasStats', typeof (alias && alias.projectModelAliasStats) === 'function');
check('modelAliasPresentation.projectModelAliasHistory', typeof (alias && alias.projectModelAliasHistory) === 'function');
check('modelAliasPresentation.projectModelAliasSessions', typeof (alias && alias.projectModelAliasSessions) === 'function');

const usage = m('src/shared/usage.js');
check('usage.aggregateDevices', typeof (usage && usage.aggregateDevices) === 'function');
check('usage.aggregateHistory', typeof (usage && usage.aggregateHistory) === 'function');
if (usage) {
  const agg = usage.aggregateDevices([], 0);
  check('aggregateDevices([]) yields empty aggregate', agg && agg.periods && Array.isArray(agg.devices));
}

const serviceStatus = m('src/electron/serviceStatus.js');
check('serviceStatus.createServiceStatusClient', typeof (serviceStatus && serviceStatus.createServiceStatusClient) === 'function');

const fixedPeriods = m('src/electron/fixedPeriodHistory.js');
check('fixedPeriodHistory.fixedPeriodHistoryMeta', typeof (fixedPeriods && fixedPeriods.fixedPeriodHistoryMeta) === 'function');
if (fixedPeriods) {
  const meta = fixedPeriods.fixedPeriodHistoryMeta({ source: 'hub' });
  check('fixedPeriodHistoryMeta({source:hub})', meta && meta.historyTransportAvailable === true);
}

const appVersion = m('src/shared/appVersion.js');
check('appVersion.appVersion() = 0.77.0', appVersion && appVersion.appVersion() === '0.77.0');

const hubBuild = m('src/electron/hubBuildStatus.js');
check('hubBuildStatus.probeHubBuild', typeof (hubBuild && hubBuild.probeHubBuild) === 'function');

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures);
process.exit(failures === 0 ? 0 : 1);
