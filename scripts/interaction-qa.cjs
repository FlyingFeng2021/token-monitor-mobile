'use strict';
/* 交互 QA：点开视图切换器菜单 → 截图 → 切到"工具"视图 → 截图 → 打开设置 → 截图。
 * 已确认：?breakdown=limits 被弹回是桌面同源行为（limitViewAvailable 门控），非缺陷。
 */
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8123/app/src/electron/renderer/__seed.html';
const HUB_URL = process.env.HUB_URL || '';
const HUB_SECRET = process.env.HUB_SECRET || '';
const SEED = (() => {
  const q = new URLSearchParams();
  if (HUB_URL) { q.set('hub', HUB_URL); q.set('secret', HUB_SECRET); }
  q.set('breakdown', 'home');
  const qs = q.toString();
  return BASE + '?' + qs;
})();
const OUT = path.join(__dirname, '..', '.smoke');

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 150)));

  await page.goto(BASE + '?breakdown=home&period=today', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 14000));
  const bootInfo = await page.evaluate(() => ({
    total: document.getElementById('totalTokens') ? document.getElementById('totalTokens').textContent : null,
    viewSwitcherHtml: (document.getElementById('viewSwitcher') || {}).innerHTML ? 'present' : 'missing',
    firstBtn: document.querySelector('#viewSwitcher button') ? document.querySelector('#viewSwitcher button').textContent.trim().slice(0, 6) : 'NONE'
  }));
  console.log('boot:', JSON.stringify(bootInfo));
  const net = await page.evaluate(async () => {
    const hubUrl = JSON.parse(localStorage.getItem('token-monitor:settings.json') || '{}').hubUrl;
    const secret = JSON.parse(localStorage.getItem('token-monitor:settings.json') || '{}').secret;
    try {
      const r = await fetch(hubUrl + '/api/stats', { headers: { authorization: 'Bearer ' + secret } });
      const j = await r.json();
      return { status: r.status, devices: (j.devices || []).length, today: j.periods && j.periods.today && j.periods.today.totalTokens };
    } catch (e) { return { fetchError: String(e).slice(0, 120) }; }
  });
  console.log('in-page fetch:', JSON.stringify(net));

  // 1) 点开视图切换器（左下角当前视图按钮）
  const toggled = await page.evaluate(() => {
    const container = document.getElementById('viewSwitcher');
    if (!container) return 'no-container';
    const btn = container.querySelector('button');
    if (!btn) return 'no-button';
    btn.click();
    return 'clicked:' + btn.id + ':' + btn.textContent.trim().slice(0, 8);
  });
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: path.join(OUT, 'ix-menu-open.png') });

  // 2) 点菜单里的"工具"项（data-breakdown / data-view 任一匹配，兜底按文本找）
  const switched = await page.evaluate(() => {
    const container = document.getElementById('viewSwitcher');
    const nodes = container.querySelectorAll('[data-breakdown],[data-view],button,li');
    for (const n of nodes) {
      const key = (n.dataset.breakdown || n.dataset.view || '').toLowerCase();
      const text = n.textContent.trim();
      if (key === 'limits' || text === '额度') { n.click(); return 'switched:' + text.slice(0, 8); }
    }
    return 'tool-item-not-found:' + nodes.length;
  });
  await new Promise((r) => setTimeout(r, 1500));
  const navLabel = await page.evaluate(() => {
    const c = document.getElementById('viewSwitcher');
    const b = c && c.querySelector('button');
    return b ? b.textContent.trim().slice(0, 10) : '';
  });
  console.log('toggle:', toggled, '| switch:', switched, '| nav now:', JSON.stringify(navLabel));
  await page.screenshot({ path: path.join(OUT, 'ix-tool-view.png') });

  // 3) 打开设置抽屉（右下角齿轮）
  await page.evaluate(() => {
    const b = document.getElementById('settingsButton');
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: path.join(OUT, 'ix-settings.png') });

  // 设置里填 hub 地址的面板存在性（同步节）
  const syncPanel = await page.evaluate(() => {
    const hub = document.getElementById('hubUrlInput');
    const secret = document.getElementById('secretInput');
    return { hubInput: Boolean(hub), secretInput: Boolean(secret) };
  });
  console.log('sync form:', JSON.stringify(syncPanel), '| JS errors:', errors.length ? errors : 'none');
  await browser.close();
})();
