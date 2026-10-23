'use strict';
/* 手机视口（390×844 @2x，真设备仿真）逐视图截图 QA。
 * 用法: node scripts/mobile-qa.cjs [view ...]   (默认全部视图)
 * 前置: hub(:17331) + http.server(:8123) 已启动且已注入数据。
 */
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8123/app/src/electron/renderer/__seed.html';
const OUT = path.join(__dirname, '..', '.smoke');

// 真实 hub 注入：HUB_URL/HUB_SECRET 环境变量（不落仓库文件）
const HUB_URL = process.env.HUB_URL || '';
const HUB_SECRET = process.env.HUB_SECRET || '';
function seedUrl(view, period) {
  const q = new URLSearchParams();
  if (HUB_URL) { q.set('hub', HUB_URL); q.set('secret', HUB_SECRET); }
  if (view) q.set('breakdown', view);
  if (period) q.set('period', period);
  const qs = q.toString();
  return BASE + (qs ? '?' + qs : '');
}

const VIEWS = process.argv.slice(2).length ? process.argv.slice(2)
  : ['home', 'tool', 'model', 'project', 'session', 'device', 'status', 'limits', 'trends'];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-first-run', '--disable-gpu']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200));
  });

  for (const view of VIEWS) {
    const period = view === 'trends' ? 'month' : 'today';
    await page.goto(seedUrl(view, period), { waitUntil: 'domcontentloaded' });
    // 等 seed 重定向 + 数据流第一帧
    await new Promise((r) => setTimeout(r, 9000));
    const info = await page.evaluate(() => {
      const shell = document.querySelector('.shell');
      const mq = window.matchMedia('(min-width: 480px)').matches;
      const r = shell ? shell.getBoundingClientRect() : null;
      const total = document.body.innerText.match(/[\d.,]+[KM]?/) ? true : false;
      return {
        url: location.pathname.split('/').pop(),
        mq480: mq,
        shell: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
        innerWidth: window.innerWidth,
        hasAndroidClass: document.documentElement.classList.contains('android-shell'),
        text: document.body.innerText.slice(0, 80).replace(/\n/g, ' | ')
      };
    });
    await page.screenshot({ path: path.join(OUT, `m390-${view}.png`) });
    console.log(`[${view}]`, JSON.stringify(info));
  }
  console.log('JS errors:', errors.length ? errors.slice(0, 5) : 'none');
  await browser.close();
})();
