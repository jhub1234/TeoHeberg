const BASE_URL = 'https://manager.teoheberg.fr';
const ACCOUNTS_KEY = 'teoheberg_accounts';
const MAX_ADS_PER_RUN = 10;

// ========== 工具函数 ==========
function log(level, msg) {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const icon = { INFO: '✅', WARN: '⚠️', ERROR: '❌', DEBUG: '🔍' }[level] || 'ℹ️';
  console.log(`[${time}] ${icon} ${msg}`);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

function htmlResponse(html) {
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ========== KV 账号管理 ==========
async function getAccounts(env) {
  try {
    const data = await env.TEOHEBERG_KV.get(ACCOUNTS_KEY, 'json');
    return data || [];
  } catch (e) {
    log('ERROR', 'KV读取失败: ' + e.message);
    return [];
  }
}

async function saveAccounts(env, accounts) {
  await env.TEOHEBERG_KV.put(ACCOUNTS_KEY, JSON.stringify(accounts));
}

async function addAccount(env, email, cookie) {
  const accounts = await getAccounts(env);
  const existingIdx = accounts.findIndex(a => a.email === email);
  const now = new Date().toISOString();
  if (existingIdx >= 0) {
    accounts[existingIdx].cookie = cookie;
    accounts[existingIdx].updatedAt = now;
    accounts[existingIdx].cookieUpdatedAt = now;
  } else {
    accounts.push({
      email,
      cookie,
      addedAt: now,
      updatedAt: now,
      cookieUpdatedAt: now,
      lastAdCount: 0,
      totalAds: 0,
      lastPoints: '0,00'
    });
  }
  await saveAccounts(env, accounts);
  return accounts.length;
}

async function updateAccountStats(env, email, stats) {
  const accounts = await getAccounts(env);
  const account = accounts.find(a => a.email === email);
  if (account) {
    const { cookie, ...safeStats } = stats;
    Object.assign(account, safeStats, { updatedAt: new Date().toISOString() });
    await saveAccounts(env, accounts);
  }
}

// ========== 从响应头提取短期令牌 ==========
function extractSessionTokens(setCookieHeader) {
  if (!setCookieHeader) return { xsrf: null, session: null };
  const tokens = { xsrf: null, session: null };
  const parts = setCookieHeader.split(',');
  for (const part of parts) {
    const cookie = part.split(';')[0].trim();
    if (cookie.startsWith('XSRF-TOKEN=')) {
      tokens.xsrf = cookie;
    } else if (cookie.startsWith('teoheberg_session=')) {
      tokens.session = cookie;
    }
  }
  return tokens;
}

// ========== 用长期 Cookie 初始化会话 ==========
async function buildRuntimeCookie(email, storedCookie) {
  log('INFO', `[${email}] 使用长期Cookie获取短期令牌...`);
  const resp = await fetch(BASE_URL + '/home', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
      'Cookie': storedCookie,
      'Referer': BASE_URL + '/login',
      'Cache-Control': 'no-cache'
    },
    redirect: 'manual'
  });

  if (resp.status === 302 && resp.headers.get('location')?.includes('/login')) {
    log('ERROR', `[${email}] remember_web 已失效，需要手动更新`);
    return null;
  }

  const { xsrf, session } = extractSessionTokens(resp.headers.get('set-cookie'));
  if (!xsrf || !session) {
    log('ERROR', `[${email}] 未能获取短期令牌，请检查Cookie格式`);
    return null;
  }

  let rememberWeb = storedCookie;
  const match = storedCookie.match(/(remember_web_\w+=[^;]+)/);
  if (match) rememberWeb = match[1];

  const runtimeCookie = [rememberWeb, xsrf, session].join('; ');
  log('INFO', `[${email}] 会话初始化成功`);
  return runtimeCookie;
}

// ========== 积分提取 ==========
function extractPoints(html) {
  const match = html.match(/fa-coins"><\/i><\/small>\s*([\d,]+)\s*<\/span>/i);
  return match ? match[1].trim() : null;
}

// ========== 主页访问 ==========
async function fetchHomePage(email, cookie) {
  const response = await fetch(BASE_URL + '/home', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
      'Cookie': cookie,
      'Referer': BASE_URL + '/login',
      'Cache-Control': 'no-cache'
    },
    redirect: 'follow'
  });

  const html = await response.text();
  const points = extractPoints(html);
  log('INFO', `[${email}] 当前积分: ${points || '未找到'}`);
  return { points };
}

// ========== 广告请求 ==========
async function adApiRequest(url, cookie, referer = BASE_URL + '/home') {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'Cookie': cookie,
    'Referer': referer,
    'Cache-Control': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin'
  };
  return fetch(url, { headers, redirect: 'manual' });
}

// ========== 解析链接 ==========
function decodeRParam(urlStr) {
  try {
    const u = new URL(urlStr);
    const r = u.searchParams.get('r');
    if (!r) return null;
    return atob(r.replace(/-/g, '+').replace(/_/g, '/'));
  } catch { return null; }
}

function extractLinkToUrl(html) {
  const match = html.match(/(?:href|data-url)=["'](https:\/\/link-to\.net\/\d+\/\d+\/[^"'\s]+)["']/i) ??
                html.match(/(https:\/\/link-to\.net\/\d+\/\d+\/[^"'\s]+)/i);
  return match ? match[1] : null;
}

// ========== 验证流程 ==========
async function executeVerify(verifyPath, cookie, email) {
  if (!verifyPath.startsWith('http')) verifyPath = BASE_URL + verifyPath;
  log('INFO', `[${email}] 验证URL: ${verifyPath}`);

  const response = await fetch(verifyPath, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
      'Cookie': cookie,
      'Referer': BASE_URL + '/linkvertise/generate',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin'
    },
    redirect: 'follow'
  });

  const text = await response.text();

  if (/gagné|crédits? gagnés|earned credits/i.test(text)) {
    return { success: true };
  }
  if (/limite quotidienne atteinte|no.*credits/i.test(text)) {
    return { success: false, msg: '今日额度已用完' };
  }
  if (/login/i.test(text) && response.url.includes('/login')) {
    return { success: false, msg: 'Cookie已失效' };
  }

  const snippet = text.substring(0, 200).replace(/\n/g, ' ');
  log('WARN', `[${email}] 验证页面未知内容: ${snippet}`);
  return { success: false, msg: '验证后页面异常' };
}

async function followLinkvertiseFlow(linkToUrl, cookie, email) {
  const response = await adApiRequest(linkToUrl, cookie);

  if (response.status === 302 || response.status === 301) {
    const location = response.headers.get('location');
    if (!location) return { success: false, msg: '无 location' };
    log('INFO', `[${email}] link-to.net 跳转: ${location.substring(0, 60)}...`);
    const verifyPath = decodeRParam(location);
    if (!verifyPath) return { success: false, msg: '解码 r 失败' };
    return executeVerify(verifyPath, cookie, email);
  }

  if (response.status === 200) {
    const html = await response.text();
    if (/limite quotidienne atteinte|no.*credits/i.test(html)) {
      return { success: false, msg: '今日额度已用完' };
    }
    const redirect = extractLinkToUrl(html);
    if (redirect) {
      const verifyPath = decodeRParam(redirect);
      if (verifyPath) return executeVerify(verifyPath, cookie, email);
    }
    return { success: false, msg: 'link-to.net 200 未找到跳转' };
  }

  return { success: false, msg: `link-to.net 状态 ${response.status}` };
}

// ========== 广告任务主循环 ==========
async function performAdTask(env, email, storedCookie) {
  const runtimeCookie = await buildRuntimeCookie(email, storedCookie);
  if (!runtimeCookie) {
    return { completedAds: 0, beforePoints: null, afterPoints: null, error: '会话初始化失败，请更新长期Cookie' };
  }

  const homeStart = await fetchHomePage(email, runtimeCookie);
  const beforePoints = homeStart.points;
  log('INFO', `[${email}] 开始广告任务，初始积分: ${beforePoints || '未知'}`);

  let completedAds = 0;
  let error = null;

  try {
    for (let round = 1; round <= MAX_ADS_PER_RUN; round++) {
      log('INFO', `[${email}] 第 ${round} 轮广告`);

      const response = await adApiRequest(
        `${BASE_URL}/linkvertise/generate`,
        runtimeCookie,
        BASE_URL + '/home'
      );

      const status = response.status;
      log('DEBUG', `[${email}] generate 响应: ${status}`);

      if (status === 302 || status === 301) {
        const location = response.headers.get('location');
        if (!location) { error = '无 location'; break; }
        if (location.includes('/login')) {
          error = 'Cookie已失效';
          break;
        }
        if (location.includes('/linkvertise') && !location.includes('/linkvertise/generate')) {
          log('INFO', `[${email}] 重定向到 /linkvertise，额度已用完`);
          const check = await fetch(BASE_URL + location, {
            headers: { 'Cookie': runtimeCookie, 'User-Agent': 'Mozilla/5.0 ...' },
            redirect: 'follow'
          });
          const checkText = await check.text();
          if (/limite quotidienne atteinte/i.test(checkText)) {
            error = '今日额度已用完';
          } else {
            error = '跳转到未知页面';
          }
          break;
        }

        const flow = await followLinkvertiseFlow(location, runtimeCookie, email);
        if (flow.success) {
          completedAds++;
          log('INFO', `[${email}] ✅ 第 ${completedAds} 次广告完成`);
        } else {
          error = flow.msg;
          if (error && /额度已用完/i.test(error)) break;
          log('WARN', `[${email}] 广告失败: ${error}`);
        }
      } else if (status === 200) {
        const html = await response.text();
        if (/limite quotidienne atteinte|no.*credits/i.test(html)) {
          log('INFO', `[${email}] 额度已用完`);
          break;
        }
        const linkToUrl = extractLinkToUrl(html);
        if (!linkToUrl) { error = '未找到 link-to.net 链接'; break; }
        log('INFO', `[${email}] 提取链接: ${linkToUrl.substring(0, 60)}...`);

        const flow = await followLinkvertiseFlow(linkToUrl, runtimeCookie, email);
        if (flow.success) {
          completedAds++;
          log('INFO', `[${email}] ✅ 第 ${completedAds} 次广告完成`);
        } else {
          error = flow.msg;
          if (/额度已用完/i.test(error)) break;
          log('WARN', `[${email}] 广告失败: ${error}`);
        }
      } else if (status === 403) {
        error = '被 Cloudflare 拦截 (403)';
        break;
      } else {
        error = `generate 返回 HTTP ${status}`;
        break;
      }

      if (error && /额度已用完/i.test(error)) break;

      const delay = 5000 + Math.random() * 7000;
      log('INFO', `[${email}] 等待 ${Math.round(delay/1000)} 秒...`);
      await new Promise(r => setTimeout(r, delay));
    }
  } catch (e) {
    error = e.message;
    log('ERROR', `[${email}] 异常: ${error}`);
  }

  let afterPoints = null;
  try {
    const homeEnd = await fetchHomePage(email, runtimeCookie);
    afterPoints = homeEnd.points;
  } catch (e) {
    log('WARN', `[${email}] 结束后访问主页失败: ${e.message}`);
  }

  return { completedAds, beforePoints, afterPoints, error };
}

// ========== 通知发送（已修复 Cookie 失效不提示的问题） ==========
async function notifyAdResult(env, email, result) {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  let title, lines;

  // 优先检测 Cookie 失效等致命错误
  if (result.error && /会话初始化失败|remember_web.*失效/i.test(result.error)) {
    title = '🚨 Cookie 已失效';
    lines = [
      title,
      '',
      `账号：${email}`,
      `状态：${result.error}`,
      '⚠️ 请尽快手动更新长期 Cookie',
      '',
      'TeoHeberg Daily Points'
    ];
  } else if (result.adCount > 0) {
    title = '✅ 广告任务已完成';
    lines = [
      title,
      '',
      `账号：${email}`,
      `积分：${result.beforePoints || '?'} -> ${result.afterPoints || '?'}`,
      `广告：执行 ${result.adCount} 次`,
      '',
      'TeoHeberg Daily Points'
    ];
  } else {
    title = '⏳ 冷却中';
    lines = [
      title,
      '',
      `账号：${email}`,
      `积分：${result.afterPoints || result.beforePoints || '?'}`,
      `广告：今日额度已用完`,
      '',
      'TeoHeberg Daily Points'
    ];
  }

  await sendTelegram(env, lines.join('\n'));
}

async function sendTelegram(env, text) {
  try {
    const token = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
    });
  } catch (e) { log('DEBUG', 'TG 通知失败'); }
}

// ========== 账号处理 ==========
async function processAccount(env, account) {
  const result = { email: account.email, adCount: 0, beforePoints: null, afterPoints: null };
  try {
    const ad = await performAdTask(env, account.email, account.cookie);
    result.adCount = ad.completedAds;
    result.beforePoints = ad.beforePoints;
    result.afterPoints = ad.afterPoints;
    result.error = ad.error;

    await updateAccountStats(env, account.email, {
      lastAdCount: ad.completedAds,
      totalAds: (account.totalAds || 0) + ad.completedAds,
      lastPoints: ad.afterPoints || ad.beforePoints || '0,00'
    });

    await notifyAdResult(env, account.email, result);
  } catch (e) {
    result.error = e.message;
  }
  return result;
}

async function processAllAccounts(env) {
  log('INFO', '========== 开始批量处理广告任务 ==========');
  const accounts = await getAccounts(env);
  if (!accounts.length) return { success: false, message: '无账号' };
  const results = [];
  for (const acc of accounts) {
    results.push(await processAccount(env, acc));
    await new Promise(r => setTimeout(r, 10000));
  }
  log('INFO', '========== 批量处理完成 ==========');
  return { success: true, totalAds: results.reduce((s, r) => s + r.adCount, 0), results };
}

// ========== 前端页面 ==========
function getHtmlPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TeoHeberg 广告任务管理</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { 
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  min-height: 100vh;
  color: #fff;
  padding: 20px;
}
.container { max-width: 1100px; margin: 0 auto; }
.header { text-align: center; padding: 40px 0; }
.header h1 { 
  font-size: 2.5rem;
  background: linear-gradient(90deg, #fff, #f0f0f0);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  margin-bottom: 10px;
}
.header p { color: rgba(255,255,255,0.8); font-size: 14px; }
.card {
  background: rgba(255,255,255,0.1);
  border-radius: 20px;
  padding: 30px;
  margin-bottom: 20px;
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255,255,255,0.2);
}
.form-group { margin-bottom: 20px; }
.form-group label { display: block; margin-bottom: 8px; font-weight: 500; }
.form-group input, .form-group textarea {
  width: 100%;
  padding: 12px 16px;
  border: 1px solid rgba(255,255,255,0.3);
  border-radius: 10px;
  background: rgba(0,0,0,0.2);
  color: #fff;
  font-size: 14px;
}
.form-group input::placeholder, .form-group textarea::placeholder {
  color: rgba(255,255,255,0.5);
}
textarea { min-height: 120px; font-family: Monaco, monospace; resize: vertical; }
.btn {
  padding: 12px 30px;
  border: none;
  border-radius: 10px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s;
  display: inline-block;
  margin-right: 10px;
  margin-bottom: 10px;
}
.btn-primary { background: #fff; color: #667eea; }
.btn-primary:hover { transform: translateY(-2px); box-shadow: 0 5px 20px rgba(255,255,255,0.3); }
.btn-success { background: #27ae60; color: #fff; }
.btn-danger { background: #e74c3c; color: #fff; }
.btn-warning { background: #f39c12; color: #fff; }
.btn-cancel { background: #555; color: #fff; }
.btn-sm { padding: 8px 14px; font-size: 13px; }
.account-list { margin-top: 20px; }
.account-item {
  background: rgba(0,0,0,0.2);
  padding: 20px;
  border-radius: 12px;
  margin-bottom: 15px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 15px;
}
.account-info { flex: 1; min-width: 200px; }
.account-email { font-weight: 600; font-size: 16px; margin-bottom: 8px; }
.account-meta { 
  font-size: 13px; 
  color: rgba(255,255,255,0.7); 
  line-height: 1.6;
}
.account-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.status { 
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  padding: 15px 30px;
  border-radius: 10px;
  font-size: 14px;
  display: none;
  z-index: 1000;
  box-shadow: 0 5px 25px rgba(0,0,0,0.3);
  max-width: 90%;
  text-align: center;
}
.status.success { background: #27ae60; display: block; }
.status.error { background: #e74c3c; display: block; }
.status.loading { background: #3498db; display: block; }
.hint {
  background: rgba(255,255,255,0.05);
  padding: 12px 16px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.6;
  color: rgba(255,255,255,0.8);
  border-left: 3px solid rgba(255,255,255,0.3);
}
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 15px;
  margin-bottom: 20px;
}
.stat-card {
  background: rgba(0,0,0,0.2);
  padding: 20px;
  border-radius: 12px;
  text-align: center;
}
.stat-value {
  font-size: 2rem;
  font-weight: bold;
  margin-bottom: 5px;
}
.stat-label {
  font-size: 13px;
  color: rgba(255,255,255,0.7);
}

/* 更新Cookie弹窗 */
.modal-overlay {
  display: none;
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.7);
  z-index: 2000;
  justify-content: center;
  align-items: center;
}
.modal-overlay.active { display: flex; }
.modal {
  background: #1a1a2e;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 16px;
  padding: 24px;
  width: 90%;
  max-width: 500px;
  color: #fff;
}
.modal h3 { margin-bottom: 16px; }
.modal textarea {
  width: 100%;
  min-height: 80px;
  margin-bottom: 12px;
  background: rgba(0,0,0,0.3);
  border: 1px solid rgba(255,255,255,0.2);
  border-radius: 8px;
  color: #fff;
  padding: 10px;
  font-family: monospace;
}
.modal-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>🚀 TeoHeberg 广告任务</h1>
    <p>自动完成广告 · 长期 remember_web Cookie</p>
  </div>

  <div class="card">
    <div class="form-group">
      <label>🔐 API密钥</label>
      <input type="password" id="authKey" placeholder="输入AUTH_KEY..." onkeydown="if(event.key==='Enter')loadAccounts()">
    </div>
    <button class="btn btn-primary" onclick="loadAccounts()">连接</button>
  </div>

  <div id="statsSection" style="display:none;">
    <div class="stats">
      <div class="stat-card">
        <div class="stat-value" id="statAccounts">0</div>
        <div class="stat-label">账号数量</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="statTotalAds">0</div>
        <div class="stat-label">总广告次数</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="statLastRun">-</div>
        <div class="stat-label">上次执行</div>
      </div>
    </div>
  </div>

  <div class="card" id="addSection" style="display:none;">
    <h3 style="margin-bottom: 20px;">➕ 添加账号</h3>
    <div class="form-group">
      <label>账号信息（格式：邮箱-----Cookie）</label>
      <textarea id="accountInput" placeholder="admin@example.com-----remember_web_xxx=...&#10;&#10;每行一个，可批量添加"></textarea>
    </div>
    <div class="hint">
      💡 <strong>Cookie获取方法：</strong><br>
      1. 登录 manager.teoheberg.fr<br>
      2. 获取长期有效的 remember_web Cookie<br>
      3. 格式：邮箱-----Cookie（五个减号分隔）
    </div>
    <div style="margin-top: 20px;">
      <button class="btn btn-primary" onclick="addAccounts()">添加账号</button>
      <button class="btn btn-success" onclick="runAll()">▶️ 执行所有账号</button>
    </div>
  </div>

  <div class="card" id="listSection" style="display:none;">
    <h3 style="margin-bottom: 20px;">📋 账号列表</h3>
    <div id="accountList"></div>
  </div>
</div>

<div class="status" id="status"></div>

<!-- 更新Cookie弹窗 -->
<div class="modal-overlay" id="cookieModal">
  <div class="modal">
    <h3>🍪 手动更新 Cookie</h3>
    <p style="color:#888;font-size:13px;margin-bottom:10px;" id="modalAccountLabel">账号：</p>
    <input type="hidden" id="modalAccountEmail">
    <textarea id="modalCookieInput" placeholder="粘贴新的 Cookie..."></textarea>
    <div class="modal-actions">
      <button class="btn btn-cancel btn-sm" onclick="closeCookieModal()">取消</button>
      <button class="btn btn-primary btn-sm" onclick="submitCookieUpdate()">更新</button>
    </div>
  </div>
</div>

<script>
let authKey = '';

function showStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status ' + (type || 'loading');
  if (type !== 'loading') setTimeout(() => el.className = 'status', 4000);
}

function api(path, options = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const url = window.location.origin + path + sep + 'key=' + encodeURIComponent(authKey);
  return fetch(url, options).then(r => r.json());
}

async function loadAccounts() {
  authKey = document.getElementById('authKey').value;
  if (!authKey) { showStatus('请输入密钥', 'error'); return; }
  
  localStorage.setItem('teoheberg_auth_key', authKey);
  showStatus('加载中...');
  
  const data = await api('/accounts');
  if (!data.success) { showStatus(data.message, 'error'); return; }
  
  document.getElementById('statsSection').style.display = 'block';
  document.getElementById('addSection').style.display = 'block';
  document.getElementById('listSection').style.display = 'block';
  
  document.getElementById('statAccounts').textContent = data.accounts.length;
  const totalAds = data.accounts.reduce((sum, a) => sum + (a.totalAds || 0), 0);
  document.getElementById('statTotalAds').textContent = totalAds;
  
  const lastUpdate = data.accounts.reduce((latest, a) => {
    const t = new Date(a.updatedAt).getTime();
    return t > latest ? t : latest;
  }, 0);
  if (lastUpdate > 0) {
    const diff = Date.now() - lastUpdate;
    const hours = Math.floor(diff / 3600000);
    document.getElementById('statLastRun').textContent = hours < 1 ? '刚刚' : \`\${hours}小时前\`;
  }
  
  renderAccounts(data.accounts);
  showStatus('加载成功', 'success');
}

function renderAccounts(accounts) {
  const list = document.getElementById('accountList');
  if (accounts.length === 0) {
    list.innerHTML = '<p style="text-align:center;color:rgba(255,255,255,0.5);">暂无账号</p>';
    return;
  }
  
  list.innerHTML = accounts.map(a => {
    const cookieAge = a.cookieUpdatedAt ? 
      Math.floor((Date.now() - new Date(a.cookieUpdatedAt).getTime()) / 3600000) : null;
    const cookieStatus = cookieAge === null ? '未知' :
      cookieAge < 1 ? '🟢 刚更新' :
      cookieAge < 24 ? \`🟡 \${cookieAge}小时前\` :
      \`🔴 \${Math.floor(cookieAge/24)}天前\`;
    
    return \`
    <div class="account-item">
      <div class="account-info">
        <div class="account-email">📧 \${a.email}</div>
        <div class="account-meta">
          Cookie: \${a.cookieLength} 字符 · \${cookieStatus}<br>
          上次广告: \${a.lastAdCount || 0} 次 · 总计: \${a.totalAds || 0} 次<br>
          添加时间: \${new Date(a.addedAt).toLocaleString('zh-CN')}
        </div>
      </div>
      <div class="account-actions">
        <button class="btn btn-success btn-sm" onclick="runAccount('\${a.email}')">▶️ 执行</button>
        <button class="btn btn-warning btn-sm" onclick="openCookieModal('\${a.email}')">🍪 更新</button>
        <button class="btn btn-danger btn-sm" onclick="removeAccount('\${a.email}')">🗑️</button>
      </div>
    </div>
  \`;
  }).join('');
}

async function addAccounts() {
  const input = document.getElementById('accountInput').value.trim();
  if (!input) { showStatus('请输入账号信息', 'error'); return; }
  
  const lines = input.split('\\n').filter(l => l.trim());
  const accounts = [];
  
  for (const line of lines) {
    const idx = line.indexOf('-----');
    if (idx > 0) {
      accounts.push({
        email: line.substring(0, idx).trim(),
        cookie: line.substring(idx + 5).trim()
      });
    }
  }
  
  if (accounts.length === 0) { showStatus('格式错误，用-----分隔', 'error'); return; }
  
  showStatus('添加中...');
  const data = await api('/accounts/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accounts })
  });
  
  if (data.success) {
    showStatus(\`添加成功: \${data.imported} 个\`, 'success');
    document.getElementById('accountInput').value = '';
    loadAccounts();
  } else {
    showStatus(data.message, 'error');
  }
}

async function removeAccount(email) {
  if (!confirm(\`确定删除 \${email} ?\`)) return;
  
  const data = await api('/accounts/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });
  
  if (data.success) {
    showStatus('已删除', 'success');
    loadAccounts();
  } else {
    showStatus(data.message, 'error');
  }
}

async function runAccount(email) {
  showStatus(\`执行中: \${email}\`, 'loading');
  const data = await api(\`/run?email=\${encodeURIComponent(email)}\`);
  
  if (data.success) {
    showStatus(\`完成: 广告 \${data.result.adCount} 次\`, 'success');
    loadAccounts();
  } else {
    showStatus(data.message || '执行失败', 'error');
  }
}

async function runAll() {
  if (!confirm('确定对所有账号执行广告任务？')) return;
  showStatus('批量执行中...', 'loading');
  
  const data = await api('/run-all');
  if (data.success) {
    showStatus(\`完成: 共 \${data.totalAds} 次广告\`, 'success');
    loadAccounts();
  } else {
    showStatus(data.message, 'error');
  }
}

function openCookieModal(email) {
  document.getElementById('modalAccountEmail').value = email;
  document.getElementById('modalAccountLabel').textContent = '账号：' + email;
  document.getElementById('modalCookieInput').value = '';
  document.getElementById('cookieModal').classList.add('active');
}

function closeCookieModal() {
  document.getElementById('cookieModal').classList.remove('active');
}

async function submitCookieUpdate() {
  const email = document.getElementById('modalAccountEmail').value;
  const cookie = document.getElementById('modalCookieInput').value.trim();
  if (!cookie) { showStatus('请输入Cookie', 'error'); return; }
  showStatus('更新中...');
  const data = await api('/accounts/update-cookie', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, cookie })
  });
  if (data.success) {
    showStatus('Cookie已更新', 'success');
    closeCookieModal();
    loadAccounts();
  } else {
    showStatus(data.message || '更新失败', 'error');
  }
}

const saved = localStorage.getItem('teoheberg_auth_key');
if (saved) document.getElementById('authKey').value = saved;
</script>
</body>
</html>`;
}

// ========== Worker 主入口 ==========
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/' && !url.searchParams.has('key')) return htmlResponse(getHtmlPage());
    if (request.method === 'OPTIONS') return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });

    const authKey = url.searchParams.get('key');
    if (env.AUTH_KEY && authKey !== env.AUTH_KEY) return jsonResponse({ success: false, message: 'Unauthorized' }, 401);

    try {
      if (url.pathname === '/accounts' && request.method === 'GET') {
        const accounts = await getAccounts(env);
        return jsonResponse({ success: true, accounts: accounts.map(a => ({
          email: a.email, cookieLength: (a.cookie || '').length,
          addedAt: a.addedAt, updatedAt: a.updatedAt,
          cookieUpdatedAt: a.cookieUpdatedAt,
          lastAdCount: a.lastAdCount || 0, totalAds: a.totalAds || 0,
          lastPoints: a.lastPoints || '0,00'
        }))});
      }
      if (url.pathname === '/accounts/import' && request.method === 'POST') {
        const body = await request.json();
        let imported = 0;
        for (const item of body.accounts) {
          if (item.email && item.cookie) { await addAccount(env, item.email, item.cookie); imported++; }
        }
        return jsonResponse({ success: true, imported });
      }
      if (url.pathname === '/accounts/remove' && request.method === 'POST') {
        const body = await request.json();
        const accounts = await getAccounts(env);
        await saveAccounts(env, accounts.filter(a => a.email !== body.email));
        return jsonResponse({ success: true });
      }
      if (url.pathname === '/accounts/update-cookie' && request.method === 'POST') {
        const body = await request.json();
        if (!body.email || !body.cookie) {
          return jsonResponse({ success: false, message: '缺少参数' }, 400);
        }
        const accounts = await getAccounts(env);
        const account = accounts.find(a => a.email === body.email);
        if (!account) {
          return jsonResponse({ success: false, message: '账号不存在' }, 404);
        }
        account.cookie = body.cookie;
        account.cookieUpdatedAt = new Date().toISOString();
        account.updatedAt = new Date().toISOString();
        await saveAccounts(env, accounts);
        return jsonResponse({ success: true, message: 'Cookie已更新' });
      }
      if (url.pathname === '/run') {
        const email = url.searchParams.get('email');
        const accounts = await getAccounts(env);
        const account = accounts.find(a => a.email === email);
        if (!account) return jsonResponse({ success: false, message: '账号不存在' }, 404);
        const result = await processAccount(env, account);
        return jsonResponse({ success: true, result });
      }
      if (url.pathname === '/run-all') {
        const result = await processAllAccounts(env);
        return jsonResponse(result);
      }
      return htmlResponse(getHtmlPage());
    } catch (e) {
      log('ERROR', '请求处理失败: ' + e.message);
      return jsonResponse({ success: false, message: e.message }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    log('INFO', '⏰ 定时任务触发');
    await processAllAccounts(env);
  }
};
