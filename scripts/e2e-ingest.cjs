'use strict';
/* E2E: 向本地 hub 注入合成设备记录，供冷启动截图验证同步渲染。 */
const now = new Date();
const iso = now.toISOString();
const dayKey = now.toISOString().slice(0, 10);

function period(totalTokens, costUsd, scale) {
  const clients = { claude: Math.round(totalTokens * 0.6), codex: Math.round(totalTokens * 0.4) };
  const models = { 'claude-sonnet-4-5': clients.claude, 'gpt-5': clients.codex };
  return {
    capabilities: { tokenComponents: true, throughput: true },
    totalTokens,
    costUsd,
    cacheReadTokens: Math.round(totalTokens * 0.8),
    cacheWriteTokens: Math.round(totalTokens * 0.1),
    outputTokens: Math.round(totalTokens * 0.08),
    timedTokens: totalTokens,
    timedOutputTokens: Math.round(totalTokens * 0.08),
    timedDurationMs: 420000 * scale,
    clients,
    clientCosts: { claude: costUsd * 0.6, codex: costUsd * 0.4 },
    clientCacheReads: { claude: Math.round(totalTokens * 0.5), codex: Math.round(totalTokens * 0.3) },
    clientCacheWrites: { claude: Math.round(totalTokens * 0.06), codex: Math.round(totalTokens * 0.04) },
    clientOutputs: { claude: Math.round(totalTokens * 0.05), codex: Math.round(totalTokens * 0.03) },
    models,
    modelCosts: { 'claude-sonnet-4-5': costUsd * 0.6, 'gpt-5': costUsd * 0.4 },
    clientModels: { claude: { 'claude-sonnet-4-5': clients.claude }, codex: { 'gpt-5': clients.codex } },
    clientModelCosts: { claude: { 'claude-sonnet-4-5': costUsd * 0.6 }, codex: { 'gpt-5': costUsd * 0.4 } },
    sessions: {
      'claude:smoke-session-a': {
        client: 'claude', sessionId: 'smoke-session-a', totalTokens: Math.round(totalTokens * 0.3),
        costUsd: costUsd * 0.3, models: { 'claude-sonnet-4-5': Math.round(totalTokens * 0.3) },
        lastUsedAt: iso, firstUsedAt: iso
      },
      'codex:smoke-session-b': {
        client: 'codex', sessionId: 'smoke-session-b', totalTokens: Math.round(totalTokens * 0.2),
        costUsd: costUsd * 0.2, models: { 'gpt-5': Math.round(totalTokens * 0.2) },
        lastUsedAt: iso, firstUsedAt: iso
      }
    }
  };
}

const history = {
  daily: Array.from({ length: 10 }, (_, i) => {
    const d = new Date(now.getTime() - (9 - i) * 86400000);
    const tokens = 400000 + Math.round(Math.sin(i) * 150000) + i * 30000;
    return {
      date: d.toISOString().slice(0, 10),
      tokens,
      costUsd: tokens / 100000 * 0.8,
      messages: 40 + i,
      cacheReadTokens: Math.round(tokens * 0.7),
      cacheWriteTokens: Math.round(tokens * 0.1),
      outputTokens: Math.round(tokens * 0.1),
      perClient: { claude: tokens }, perModel: { 'claude-sonnet-4-5': tokens }
    };
  })
};

const record = {
  deviceId: 'smoke-desktop',
  hostname: 'smoke-pc',
  platform: 'win32-x64',
  osName: 'Windows',
  osVersion: '11',
  updatedAt: iso,
  agentVersion: '0.77.0',
  agentRuntime: 'headless-agent',
  projectsEnabled: true,
  historyAvailable: true,
  trackedClients: ['claude', 'codex'],
  today: period(1234567, 12.34, 1),
  month: period(9876543, 98.76, 8),
  allTime: period(54321098, 543.21, 40),
  history
};

fetch('http://127.0.0.1:17331/api/ingest', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer testsecret' },
  body: JSON.stringify(record)
}).then(async (res) => {
  console.log('ingest status:', res.status);
  const body = await res.text();
  console.log('ingest body:', body.slice(0, 300));
  const stats = await fetch('http://127.0.0.1:17331/api/stats', { headers: { authorization: 'Bearer testsecret' } });
  const doc = await stats.json();
  console.log('stats devices:', JSON.stringify((doc.devices || []).map((d) => d.deviceId)));
  console.log('stats today totalTokens:', doc.periods && doc.periods.today && doc.periods.today.totalTokens);
}).catch((e) => { console.error('E2E ingest failed:', e.message); process.exit(1); });
