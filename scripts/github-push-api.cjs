'use strict';
/* 经 GitHub REST API（api.github.com，本网络可达）推送整个 git 树。
 * 空仓库自动引导（Contents API 首提交），随后 Git Data API 全量树。
 * 用法: node scripts/github-push-api.cjs <owner/repo> <branch> <commitMessage> [tag]
 * 凭据: gh auth token。文件清单: git ls-files（工作区已 git add）。
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const [,, REPO, BRANCH, MESSAGE, TAG] = process.argv;
if (!REPO || !BRANCH || !MESSAGE) {
  console.error('usage: node github-push-api.cjs <owner/repo> <branch> <message> [tag]');
  process.exit(1);
}
const TOKEN = execSync('gh auth token', { encoding: 'utf8' }).trim();
const API = 'https://api.github.com';

function apiOnce(method, url, body) {
  const res = execSync(
    `curl -s -X ${method} -H "authorization: Bearer ${TOKEN}" -H "accept: application/vnd.github+json" -H "content-type: application/json" --connect-timeout 20 --max-time 180 --retry 2 -d @- "${API}${url}"`,
    { input: JSON.stringify(body || {}), maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }
  );
  return res ? JSON.parse(res) : {};
}

function api(method, url, body) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const out = apiOnce(method, url, body);
      if (out && out.message && out.status >= 500) { lastErr = out; }
      else return out;
    } catch (e) { lastErr = e; }
    console.log(`  retry ${attempt} for ${method} ${url}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, true, 2000 * attempt);
  }
  throw new Error('api failed after retries: ' + method + ' ' + url + ' → ' + JSON.stringify(lastErr).slice(0, 200));
}

// 0) 使用仓库默认分支（gh 建仓默认 main）
const repoInfo = api('GET', `/repos/${REPO}`);
const BR = (repoInfo.default_branch || 'main').trim();
console.log('default branch:', BR);
const BRANCH_ = BR;

// 1) 引导：空仓库时用 Contents API 建首个提交
let parentSha = null;
const refRes = api('GET', `/repos/${REPO}/git/refs/heads/${BRANCH_}`);
if (refRes.object && refRes.object.sha) {
  parentSha = refRes.object.sha;
  console.log('existing branch head:', parentSha.slice(0, 10));
} else {
  const boot = api('PUT', `/repos/${REPO}/contents/README.md`, {
    message: 'init', content: Buffer.from('# Token Monitor Android\n').toString('base64')
  });
  if (!(boot.commit && boot.commit.sha)) throw new Error('bootstrap failed: ' + JSON.stringify(boot).slice(0, 200));
  parentSha = boot.commit.sha;
  console.log('bootstrapped empty repo, first commit:', parentSha.slice(0, 10));
}

// 2) 全量 blob
const files = execSync('git ls-files -z', { encoding: 'buffer' })
  .toString('utf8').split('\0').filter(Boolean);
console.log('files:', files.length);

const tree = [];
for (let i = 0; i < files.length; i++) {
  const rel = files[i];
  const abs = path.join(process.cwd(), rel);
  const data = fs.readFileSync(abs);
  const blob = api('POST', `/repos/${REPO}/git/blobs`, {
    content: data.toString('base64'), encoding: 'base64'
  });
  if (!blob.sha) throw new Error('blob failed: ' + rel + ' → ' + JSON.stringify(blob).slice(0, 200));
  const isExec = (fs.statSync(abs).mode & 0o111) !== 0;
  tree.push({ path: rel.replace(/\\/g, '/'), mode: isExec ? '100755' : '100644', type: 'blob', sha: blob.sha });
  if ((i + 1) % 100 === 0) console.log(`  blobs ${i + 1}/${files.length}`);
}

// 3) 树（以引导提交的树为基底，全量替换）+ 提交 + 移动分支
const parentCommit = api('GET', `/repos/${REPO}/git/commits/${parentSha}`);
const newTree = api('POST', `/repos/${REPO}/git/trees`, { base_tree: parentCommit.tree.sha, tree });
if (!newTree.sha) throw new Error('tree failed: ' + JSON.stringify(newTree).slice(0, 200));

const commit = api('POST', `/repos/${REPO}/git/commits`, {
  message: MESSAGE, tree: newTree.sha, parents: [parentSha]
});
if (!commit.sha) throw new Error('commit failed: ' + JSON.stringify(commit).slice(0, 200));

const patched = api('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH_}`, { sha: commit.sha, force: true });
console.log('branch:', (patched.object && patched.object.sha) ? BRANCH_ + ' → ' + patched.object.sha.slice(0, 10) : JSON.stringify(patched).slice(0, 200));

if (TAG) {
  const tagRef = api('POST', `/repos/${REPO}/git/refs`, { ref: `refs/tags/${TAG}`, sha: commit.sha });
  console.log('tag:', (tagRef.object && tagRef.object.sha) ? TAG + ' → ' + tagRef.object.sha.slice(0, 10) : JSON.stringify(tagRef).slice(0, 200));
}
console.log('DONE. commit ' + commit.sha);
