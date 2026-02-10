addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

const CONFIG = { KV_TTL: 3600 }
const SESSION_TTL_SECONDS = 1800;
const SESSION_VIEW_TTL_SECONDS = 600;

function isTruthyEnv(val) {
  if (val === undefined || val === null) return false;
  const v = String(val).trim().toLowerCase();
  return v !== '' && v !== 'false' && v !== '0' && v !== 'no';
}

function getPassword() {
  return (typeof PASSWORD !== 'undefined' && PASSWORD) ? PASSWORD : '';
}

function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const parts = cookie.split(';');
  for (const part of parts) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function getSessionIdFromRequest(request) {
  const url = new URL(request.url);
  return url.searchParams.get('session') || getCookie(request, 'mc_session');
}

function generateSessionId() {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function formatOwnerToken(sessionId, createdAt) {
  const d = new Date(createdAt);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${sessionId}-${mm}${dd}-${hh}-${min}-owner`;
}

function formatHomeTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${mm}/${dd}—${hh}:${min}:${ss}`;
}

function formatHomeStatus(status) {
  if (status === 'arriving') return '车主正在赶来';
  if (status === 'active') return '进行中';
  if (status === 'closed') return '已结束';
  return status || '';
}

async function resolveSessionFromRequest(request) {
  if (typeof MOVE_CAR_STATUS === 'undefined') return null;
  const currentSession = await MOVE_CAR_STATUS.get('session_id');
  const ownerToken = await MOVE_CAR_STATUS.get('session_owner_token');
  const param = new URL(request.url).searchParams.get('session');
  const cookieSession = getCookie(request, 'mc_session');
  if (param && (param === currentSession || param === ownerToken)) return currentSession;
  if (cookieSession && currentSession && cookieSession === currentSession) return currentSession;
  return null;
}

async function appendSessionHistory(entry) {
  if (typeof MOVE_CAR_STATUS === 'undefined') return;
  const raw = await MOVE_CAR_STATUS.get('session_history');
  let list = [];
  if (raw) {
    try { list = JSON.parse(raw) || []; } catch (e) { list = []; }
  }
  list.unshift(entry);
  list = list.slice(0, 5);
  await MOVE_CAR_STATUS.put('session_history', JSON.stringify(list), { expirationTtl: 2592000 });
}

async function markSessionClosed() {
  if (typeof MOVE_CAR_STATUS === 'undefined') return;
  const sessionId = await MOVE_CAR_STATUS.get('session_id');
  if (!sessionId) return;
  const ownerToken = await MOVE_CAR_STATUS.get('session_owner_token');
  const createdAt = await MOVE_CAR_STATUS.get('session_created_at');
  const closedAt = Date.now();
  await MOVE_CAR_STATUS.put('session_id', sessionId, { expirationTtl: SESSION_VIEW_TTL_SECONDS });
  await MOVE_CAR_STATUS.put('session_status', 'closed', { expirationTtl: SESSION_VIEW_TTL_SECONDS });
  await MOVE_CAR_STATUS.put('session_completed_at', String(closedAt), { expirationTtl: SESSION_VIEW_TTL_SECONDS });
  await MOVE_CAR_STATUS.put('notify_status', 'closed', { expirationTtl: SESSION_VIEW_TTL_SECONDS });
  await MOVE_CAR_STATUS.delete('session_expires_at');
  await MOVE_CAR_STATUS.delete('owner_location');
  await MOVE_CAR_STATUS.delete('owner_message');
  await appendSessionHistory({
    sessionId,
    ownerToken,
    createdAt: createdAt ? Number(createdAt) : null,
    closedAt
  });
}

async function autoCloseIfExpired() {
  if (typeof MOVE_CAR_STATUS === 'undefined') return;
  const sessionStatus = await MOVE_CAR_STATUS.get('session_status');
  const expiresAt = await MOVE_CAR_STATUS.get('session_expires_at');
  if (sessionStatus !== 'closed' && expiresAt && Date.now() > Number(expiresAt)) {
    await markSessionClosed();
  }
}

async function purgeIfViewExpired() {
  if (typeof MOVE_CAR_STATUS === 'undefined') return false;
  const sessionStatus = await MOVE_CAR_STATUS.get('session_status');
  const completedAt = await MOVE_CAR_STATUS.get('session_completed_at');
  if (sessionStatus === 'closed' && completedAt && Date.now() - Number(completedAt) > SESSION_VIEW_TTL_SECONDS * 1000) {
    await MOVE_CAR_STATUS.delete('session_id');
    await MOVE_CAR_STATUS.delete('session_status');
    await MOVE_CAR_STATUS.delete('session_completed_at');
    await MOVE_CAR_STATUS.delete('session_owner_token');
    await MOVE_CAR_STATUS.delete('session_created_at');
    await MOVE_CAR_STATUS.delete('owner_location');
    await MOVE_CAR_STATUS.delete('owner_message');
    await MOVE_CAR_STATUS.delete('notify_status');
    return true;
  }
  return false;
}

async function handleRequest(request) {
  const url = new URL(request.url)
  const path = url.pathname
  const segments = path.split('/').filter(Boolean);
  const password = getPassword();
  const apiBase = '/api';

  if (segments[0] === 'api') {
    let apiName = '';
    if (password) {
      if (segments[1] === password) {
        apiName = segments[2] || '';
      } else {
        apiName = segments[1] || '';
      }
    } else {
      apiName = segments[1] || '';
    }

    if (apiName === 'notify' && request.method === 'POST') {
      return handleNotify(request, url);
    }
    if (apiName === 'get-location') {
      return handleGetLocation(request);
    }
    if (apiName === 'owner-confirm' && request.method === 'POST') {
      return handleOwnerConfirmAction(request);
    }
    if (apiName === 'get-phone' && request.method === 'POST') {
      return handleGetPhone();
    }
    if (apiName === 'get-session') {
      return handleGetSession(request);
    }
    if (apiName === 'terminate-session' && request.method === 'POST') {
      return handleTerminateSession(request);
    }
    if (apiName === 'clear-owner-location' && request.method === 'POST') {
      return handleClearOwnerLocation(request);
    }
    if (apiName === 'check-status') {
      return handleCheckStatus(request);
    }
    return new Response('Not Found', { status: 404 });
  }

  if (password && segments[0] === password && segments[1] === 'owner-home' && segments.length === 2) {
    return renderOwnerHomePage(url.origin, apiBase);
  }
  if (!password && segments[0] === 'owner-home') {
    return renderOwnerHomePage(url.origin, apiBase);
  }

  if (segments.length === 1 && segments[0]) {
    return renderOwnerSessionPage(segments[0], url.origin, apiBase);
  }

  return renderMainPage(url.origin, apiBase);
}

// WGS-84 转 GCJ-02 (中国国测局坐标系)
function wgs84ToGcj02(lat, lng) {
  const a = 6378245.0;
  const ee = 0.00669342162296594323;

  if (outOfChina(lat, lng)) return { lat, lng };

  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
}

function generateMapUrls(lat, lng) {
  const gcj = wgs84ToGcj02(lat, lng);
  return {
    amapUrl: `https://uri.amap.com/marker?position=${gcj.lng},${gcj.lat}&name=位置`,
    appleUrl: `https://maps.apple.com/?ll=${gcj.lat},${gcj.lng}&q=位置`
  };
}

// --- 核心修改：支持 PushPlus 和 Bark ---
async function handleNotify(request, url) {
  try {
    // 1. 检查 KV 是否绑定
    if (typeof MOVE_CAR_STATUS === 'undefined') {
      throw new Error('KV 数据库未绑定！请在 Cloudflare 后台 Settings -> Bindings 中绑定 MOVE_CAR_STATUS');
    }
    await autoCloseIfExpired();
    const body = await request.json();
    const message = body.message || '车旁有人等待';
    const location = body.location || null;
    const delayed = body.delayed || false;
    const incomingSessionId = body.sessionId || null;

    const currentSession = await MOVE_CAR_STATUS.get('session_id');
    const currentStatus = await MOVE_CAR_STATUS.get('session_status');
    let sessionId = null;
    const reuseSession = incomingSessionId && currentSession && incomingSessionId === currentSession && currentStatus !== 'closed';
    const nextSessionStatus = reuseSession && currentStatus === 'arriving' ? 'arriving' : 'active';

    if (reuseSession) {
      sessionId = currentSession;
      await MOVE_CAR_STATUS.put('session_id', sessionId, { expirationTtl: SESSION_VIEW_TTL_SECONDS });
      await MOVE_CAR_STATUS.put('session_status', nextSessionStatus, { expirationTtl: SESSION_VIEW_TTL_SECONDS });
      await MOVE_CAR_STATUS.delete('session_completed_at');
    } else {
      // 新请求时清理上次车主位置，避免旧位置泄露
      await MOVE_CAR_STATUS.delete('owner_location');
      await MOVE_CAR_STATUS.delete('owner_message');
      sessionId = generateSessionId();
      const createdAt = Date.now();
      const ownerToken = formatOwnerToken(sessionId, createdAt);
      await MOVE_CAR_STATUS.put('session_id', sessionId, { expirationTtl: SESSION_VIEW_TTL_SECONDS });
      await MOVE_CAR_STATUS.put('session_status', 'active', { expirationTtl: SESSION_VIEW_TTL_SECONDS });
      await MOVE_CAR_STATUS.put('session_created_at', String(createdAt), { expirationTtl: SESSION_VIEW_TTL_SECONDS });
      await MOVE_CAR_STATUS.put('session_owner_token', ownerToken, { expirationTtl: SESSION_VIEW_TTL_SECONDS });
      await MOVE_CAR_STATUS.delete('session_completed_at');
    }
    await MOVE_CAR_STATUS.put('session_expires_at', String(Date.now() + SESSION_VIEW_TTL_SECONDS * 1000), { expirationTtl: SESSION_VIEW_TTL_SECONDS });

    // --- 修改前 ---
    //  const confirmUrl = url.origin + '/owner-confirm';

    // --- 修改后：优先读取环境变量中的域名，如果没有配置则回退到原始域名 ---
    const baseDomain = (typeof EXTERNAL_URL !== 'undefined' && EXTERNAL_URL)
      ? EXTERNAL_URL.replace(/\/$/, "") // 去掉末尾斜杠
      : url.origin;

    let ownerToken = await MOVE_CAR_STATUS.get('session_owner_token');
    if (!ownerToken) {
      const createdAt = await MOVE_CAR_STATUS.get('session_created_at');
      const createdAtNum = createdAt ? Number(createdAt) : Date.now();
      ownerToken = formatOwnerToken(sessionId, createdAtNum);
      await MOVE_CAR_STATUS.put('session_owner_token', ownerToken, { expirationTtl: SESSION_VIEW_TTL_SECONDS });
      await MOVE_CAR_STATUS.put('session_created_at', String(createdAtNum), { expirationTtl: SESSION_VIEW_TTL_SECONDS });
    }
    const confirmUrl = baseDomain + '/' + ownerToken;

    const confirmUrlEncoded = encodeURIComponent(confirmUrl);

    const dateStr = new Date().toLocaleDateString('sv-SE');
    let notifyBody = `💬 留言: ${message}\\n⌛️日期：${dateStr}`;

    if (location && location.lat && location.lng) {
      const urls = generateMapUrls(location.lat, location.lng);
      notifyBody += '\\n📍 已附带位置信息，点击查看';

      await MOVE_CAR_STATUS.put('requester_location', JSON.stringify({
        lat: location.lat,
        lng: location.lng,
        ...urls
      }), { expirationTtl: CONFIG.KV_TTL });
    } else {
      notifyBody += '\\n⚠️ 未提供位置信息';
    }

    const notifyStatus = reuseSession && currentStatus === 'arriving' ? 'arriving' : 'waiting';
    await MOVE_CAR_STATUS.put('notify_status', notifyStatus, { expirationTtl: SESSION_VIEW_TTL_SECONDS });

    if (delayed) {
      await new Promise(resolve => setTimeout(resolve, 30000));
    }

    const notificationTasks = [];
    let localMeowRequest = null;
    const ensureNotifyOk = async (responsePromise, serviceName) => {
      try {
        const response = await responsePromise;
        const text = await response.text(); // Always read response
        if (!response.ok) {
          throw new Error(`${serviceName} failed (${response.status}): ${text}`);
        }
        return { service: serviceName, status: response.status, body: text };
      } catch (e) {
        throw new Error(`${serviceName} error: ${e.message}`);
      }
    };

    // 检测 Bark 变量
    if (typeof BARK_URL !== 'undefined' && BARK_URL) {
      const barkApiUrl = `${BARK_URL}/挪车请求/${encodeURIComponent(notifyBody)}?group=MoveCar&level=critical&call=1&sound=minuet&icon=https://cdn-icons-png.flaticon.com/512/741/741407.png&url=${confirmUrlEncoded}`;
      notificationTasks.push(ensureNotifyOk(fetch(barkApiUrl), 'Bark'));
    }

    // 检测 PushPlus 变量
    if (typeof PUSHPLUS_TOKEN !== 'undefined' && PUSHPLUS_TOKEN) {
      const pushPlusContent = notifyBody.replace(/\\n/g, '<br>') + `<br><br><a href="${confirmUrl}">👉 点击此处处理挪车请求</a>`;
      notificationTasks.push(
        ensureNotifyOk(fetch('http://www.pushplus.plus/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: PUSHPLUS_TOKEN,
            title: '🚗 挪车请求',
            content: pushPlusContent,
            template: 'html',
            channel: 'wechat'
          })
        }), 'PushPlus')
      );
    }

    // 检测 MeoW 变量
    if (typeof MEOW_NICKNAME !== 'undefined' && MEOW_NICKNAME) {
      let meowBaseUrl = (typeof MEOW_BASE_URL !== 'undefined' && MEOW_BASE_URL)
        ? MEOW_BASE_URL.replace(/\/$/, '')
        : 'https://api.chuckfang.com';
      if (!/^https?:\/\//i.test(meowBaseUrl)) {
        meowBaseUrl = `https://${meowBaseUrl}`;
      }
      const meowLocalSend = isTruthyEnv(typeof MEOW_LOCAL_SEND !== 'undefined' ? MEOW_LOCAL_SEND : null);
      const rawMsgType = (typeof MEOW_MSG_TYPE !== 'undefined' && MEOW_MSG_TYPE)
        ? String(MEOW_MSG_TYPE).trim().toLowerCase()
        : 'text';
      const meowMsgType = rawMsgType === 'html' ? 'html' : 'text'; // 只允许 text / html
      const parsedHeight = (typeof MEOW_HTML_HEIGHT !== 'undefined' && MEOW_HTML_HEIGHT !== null && MEOW_HTML_HEIGHT !== '')
        ? Number(MEOW_HTML_HEIGHT)
        : NaN;
      const meowHtmlHeight = Number.isFinite(parsedHeight) ? parsedHeight : 260;
      const meowUrl = new URL(`${meowBaseUrl}/${encodeURIComponent(MEOW_NICKNAME)}`);
      meowUrl.searchParams.set('msgType', meowMsgType);

      const buildMeowContent = (includeLink) => {
        if (meowMsgType === 'html') {
          meowUrl.searchParams.set('htmlHeight', String(meowHtmlHeight));
          const htmlBody = notifyBody.replace(/\\n/g, '<br>');
          const linkHtml = includeLink
            ? `<br><br><a href="${confirmUrl}">👉 点击此处处理挪车请求</a>`
            : '';
          return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: -apple-system, sans-serif; padding: 16px; margin: 0; line-height: 1.5; color: #333; }
  a { color: #007bff; text-decoration: none; display: inline-block; margin-top: 10px; font-weight: bold; }
</style>
</head>
<body>
  ${htmlBody}
  ${linkHtml}
</body>
</html>`;
        }
        const textBody = notifyBody.replace(/\\n/g, '\n');
        return includeLink
          ? `${textBody}\n\n👉 点击此处处理挪车请求: ${confirmUrl}`
          : textBody;
      };

      const includeLink = true;
      const meowContent = buildMeowContent(includeLink);
      if (meowMsgType === 'html') {
        meowUrl.searchParams.set('htmlHeight', String(meowHtmlHeight));
      }

      const meowRequest = {
        url: meowUrl.toString(),
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: {
          title: '🚗 挪车请求',
          msg: meowContent
        }
      };
      if (includeLink) {
        meowRequest.body.url = confirmUrl; // 某些客户端可能优先读取 body 中的 url
      }

      if (meowLocalSend) {
        localMeowRequest = meowRequest;
      } else {
        notificationTasks.push(
          ensureNotifyOk(fetch(meowRequest.url, {
            method: 'POST',
            headers: meowRequest.headers,
            body: JSON.stringify(meowRequest.body)
          }), 'MeoW')
        );
      }
    }

    // 如果两个都没配置，抛出错误
    if (notificationTasks.length === 0 && !localMeowRequest) {
      throw new Error('未配置通知方式！请在后台设置 BARK_URL、PUSHPLUS_TOKEN 或 MEOW_NICKNAME 变量');
    }

    const results = notificationTasks.length ? await Promise.all(notificationTasks) : [];

    const responsePayload = {
      success: true,
      sessionId: sessionId
    };
    if (localMeowRequest) responsePayload.localMeowRequest = localMeowRequest;
    return new Response(JSON.stringify(responsePayload), {
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': `mc_session=${sessionId}; Max-Age=${SESSION_VIEW_TTL_SECONDS}; Path=/; SameSite=Lax`
      }
    });

  } catch (error) {
    // 返回具体错误信息给前端，方便调试
    console.error('Notify Error:', error);
    const publicErrors = [
      'KV 数据库未绑定！请在 Cloudflare 后台 Settings -> Bindings 中绑定 MOVE_CAR_STATUS',
      '未配置通知方式！请在后台设置 BARK_URL、PUSHPLUS_TOKEN 或 MEOW_NICKNAME 变量'
    ];
    const publicMessage = publicErrors.includes(error.message) ? error.message : 'NOTIFY_FAILED';
    return new Response(JSON.stringify({ success: false, error: publicMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleGetLocation(request) {
  if (typeof MOVE_CAR_STATUS === 'undefined') return new Response(JSON.stringify({ error: 'KV_NOT_BOUND' }), { status: 500 });
  const sessionId = await resolveSessionFromRequest(request);
  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'SESSION_INVALID' }), { status: 404 });
  }
  const data = await MOVE_CAR_STATUS.get('requester_location');
  if (data) {
    return new Response(data, { headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: 'No location' }), { status: 404 });
}

function handleGetPhone() {
  const phone = typeof PHONE_NUMBER !== 'undefined' ? PHONE_NUMBER : '';
  if (!phone) {
    return new Response(JSON.stringify({ success: false, error: 'NO_PHONE' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return new Response(JSON.stringify({ success: true, phone: phone }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleGetSession(request) {
  if (typeof MOVE_CAR_STATUS === 'undefined') {
    return new Response(JSON.stringify({ sessionId: null }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  const url = new URL(request.url);
  const role = url.searchParams.get('role');
  const requestedSession = url.searchParams.get('session');
  await autoCloseIfExpired();
  if (await purgeIfViewExpired()) {
    return new Response(JSON.stringify({ sessionId: null, sessionStatus: null, sessionCompletedAt: null }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  const sessionId = await MOVE_CAR_STATUS.get('session_id');
  const sessionStatus = await MOVE_CAR_STATUS.get('session_status');
  const sessionCompletedAt = await MOVE_CAR_STATUS.get('session_completed_at');
  const completedAtNum = sessionCompletedAt ? Number(sessionCompletedAt) : null;
  if (role === 'owner') {
    const ownerToken = await MOVE_CAR_STATUS.get('session_owner_token');
    if (!ownerToken || (requestedSession && ownerToken !== requestedSession)) {
      return new Response(JSON.stringify({ sessionId: null, sessionStatus: null, sessionCompletedAt: null }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } else {
    const cookieSession = getCookie(request, 'mc_session');
    if (!sessionId || !cookieSession || cookieSession !== sessionId) {
      return new Response(JSON.stringify({ sessionId: null, sessionStatus: null, sessionCompletedAt: null }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  const safeCompletedAt = sessionStatus === 'closed' ? (completedAtNum || null) : null;
  return new Response(JSON.stringify({ sessionId: sessionId || null, sessionStatus: sessionStatus || null, sessionCompletedAt: safeCompletedAt }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleCheckStatus(request) {
  if (typeof MOVE_CAR_STATUS === 'undefined') {
    return new Response(JSON.stringify({ status: 'error', error: 'KV_NOT_BOUND' }), { headers: { 'Content-Type': 'application/json' } });
  }
  await autoCloseIfExpired();
  if (await purgeIfViewExpired()) {
    return new Response(JSON.stringify({
      status: 'waiting',
      ownerLocation: null,
      sessionId: null,
      sessionStatus: null,
      sessionCompletedAt: null
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  const sessionId = await MOVE_CAR_STATUS.get('session_id');
  const sessionStatus = await MOVE_CAR_STATUS.get('session_status');
  const sessionCompletedAt = await MOVE_CAR_STATUS.get('session_completed_at');
  const completedAtNum = sessionCompletedAt ? Number(sessionCompletedAt) : null;
  const cookieSession = getCookie(request, 'mc_session');
  if (!sessionId || !cookieSession || cookieSession !== sessionId) {
    return new Response(JSON.stringify({
      status: 'waiting',
      ownerLocation: null,
      sessionId: null,
      sessionStatus: null,
      sessionCompletedAt: null
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  let status = await MOVE_CAR_STATUS.get('notify_status');
  if (sessionStatus === 'closed') status = 'closed';
  const ownerLocation = await MOVE_CAR_STATUS.get('owner_location');
  const ownerMessage = await MOVE_CAR_STATUS.get('owner_message');
  return new Response(JSON.stringify({
    status: status || 'waiting',
    ownerLocation: ownerLocation ? JSON.parse(ownerLocation) : null,
    ownerMessage: ownerMessage || null,
    sessionId: sessionId || null,
    sessionStatus: sessionStatus || null,
    sessionCompletedAt: sessionStatus === 'closed' ? (completedAtNum || null) : null
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleTerminateSession(request) {
  try {
    if (typeof MOVE_CAR_STATUS === 'undefined') return new Response(JSON.stringify({ error: 'KV_NOT_BOUND' }), { status: 500 });
    const sessionId = await resolveSessionFromRequest(request);
    if (!sessionId) {
      return new Response(JSON.stringify({ error: 'SESSION_INVALID' }), { status: 404 });
    }
    await markSessionClosed();
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ success: false }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleOwnerConfirmAction(request) {
  try {
    if (typeof MOVE_CAR_STATUS === 'undefined') return new Response(JSON.stringify({ error: 'KV_NOT_BOUND' }), { status: 500 });
    const sessionId = await resolveSessionFromRequest(request);
    if (!sessionId) {
      return new Response(JSON.stringify({ error: 'SESSION_INVALID' }), { status: 404 });
    }
    const body = await request.json();
    const ownerLocation = body.location || null;
    const ownerMessage = typeof body.message === 'string' ? body.message.trim().slice(0, 120) : '';

    if (ownerLocation) {
      const urls = generateMapUrls(ownerLocation.lat, ownerLocation.lng);
      await MOVE_CAR_STATUS.put('owner_location', JSON.stringify({
        lat: ownerLocation.lat,
        lng: ownerLocation.lng,
        ...urls,
        timestamp: Date.now()
      }), { expirationTtl: CONFIG.KV_TTL });
    } else {
      await MOVE_CAR_STATUS.delete('owner_location');
    }
    if (ownerMessage) {
      await MOVE_CAR_STATUS.put('owner_message', ownerMessage, { expirationTtl: CONFIG.KV_TTL });
    } else {
      await MOVE_CAR_STATUS.delete('owner_message');
    }

    await MOVE_CAR_STATUS.put('session_id', sessionId, { expirationTtl: SESSION_VIEW_TTL_SECONDS });
    await MOVE_CAR_STATUS.put('session_status', 'arriving', { expirationTtl: SESSION_VIEW_TTL_SECONDS });
    await MOVE_CAR_STATUS.put('notify_status', 'arriving', { expirationTtl: SESSION_VIEW_TTL_SECONDS });
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    // 即使出错也尝试设为确认，避免卡死
    if (typeof MOVE_CAR_STATUS !== 'undefined') {
      await MOVE_CAR_STATUS.put('notify_status', 'arriving', { expirationTtl: SESSION_VIEW_TTL_SECONDS });
    }
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleClearOwnerLocation(request) {
  try {
    if (typeof MOVE_CAR_STATUS === 'undefined') return new Response(JSON.stringify({ error: 'KV_NOT_BOUND' }), { status: 500 });
    const sessionId = await resolveSessionFromRequest(request);
    if (!sessionId) {
      return new Response(JSON.stringify({ error: 'SESSION_INVALID' }), { status: 404 });
    }
    await MOVE_CAR_STATUS.delete('owner_location');
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ success: false }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function renderOwnerSessionPage(sessionSlug, origin, apiBase) {
  if (!sessionSlug || typeof MOVE_CAR_STATUS === 'undefined') {
    return renderSessionNotFoundPage();
  }
  await autoCloseIfExpired();
  if (await purgeIfViewExpired()) {
    return renderSessionNotFoundPage();
  }
  const currentSession = await MOVE_CAR_STATUS.get('session_id');
  if (!currentSession) return renderSessionNotFoundPage();
  const ownerToken = await MOVE_CAR_STATUS.get('session_owner_token');
  if (ownerToken && sessionSlug === ownerToken) {
    return renderOwnerPage(ownerToken, currentSession, apiBase);
  }
  if (sessionSlug === currentSession) {
    return renderMainPage(origin, apiBase, currentSession);
  }
  return renderSessionNotFoundPage();
}

async function renderOwnerHomePage(origin, apiBase) {
  if (typeof MOVE_CAR_STATUS === 'undefined') {
    return renderSessionNotFoundPage();
  }
  await autoCloseIfExpired();
  await purgeIfViewExpired();
  const sessionId = await MOVE_CAR_STATUS.get('session_id');
  const sessionStatus = await MOVE_CAR_STATUS.get('session_status');
  const createdAt = await MOVE_CAR_STATUS.get('session_created_at');
  let ownerToken = await MOVE_CAR_STATUS.get('session_owner_token');
  if (!ownerToken && sessionId && createdAt) {
    ownerToken = formatOwnerToken(sessionId, Number(createdAt));
  }
  let content = '<p>无</p>';
  if (sessionId && sessionStatus && sessionStatus !== 'closed' && ownerToken) {
    const link = `${origin}/${ownerToken}`;
    const timeText = createdAt ? formatHomeTimestamp(Number(createdAt)) : '';
    const statusText = formatHomeStatus(sessionStatus);
    content = `<ul><li><a href="${link}">#${sessionId}</a> <span style="opacity:.75;">${statusText}</span>${timeText ? ` <span style="opacity:.65;">(${timeText})</span>` : ''}</li></ul>`;
  }
  const historyRaw = await MOVE_CAR_STATUS.get('session_history');
  let history = [];
  if (historyRaw) {
    try { history = JSON.parse(historyRaw) || []; } catch (e) { history = []; }
  }
  const historyHtml = history.length
    ? `<ul>${history.map((item) => {
      const time = formatHomeTimestamp(item.closedAt || item.createdAt);
      return `<li>#${item.sessionId || '------'} ${time ? `<span style="opacity:.65;">${time}</span>` : ''}</li>`;
    }).join('')}</ul>`
    : '<p>无</p>';
  const html = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>活跃会话</title>
    <style>
      body { font-family: -apple-system, system-ui, sans-serif; padding: 24px; background: #0f0f12; color: #fff; }
      a { color: #7dd3fc; text-decoration: none; }
      ul { padding-left: 18px; }
    </style>
  </head>
  <body>
    <h2>活跃会话</h2>
    ${content}
    <h2 style="margin-top:24px;">历史会话</h2>
    ${historyHtml}
  </body>
  </html>
  `;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

function renderSessionNotFoundPage() {
  const html = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>会话不存在</title>
    <style>
      body { font-family: -apple-system, system-ui, sans-serif; padding: 24px; background: #0f0f12; color: #fff; }
      a { color: #7dd3fc; text-decoration: none; }
    </style>
  </head>
  <body>
    <h2>挪车会话不存在或已过期</h2>
    <p><a href="/">返回首页</a></p>
  </body>
  </html>
  `;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

function renderMainPage(origin, apiBase, sessionPathId) {
  const phone = typeof PHONE_NUMBER !== 'undefined' ? PHONE_NUMBER : '';

  const html = `
<!DOCTYPE html>
<html lang="zh-CN">

<head>
  <meta charset="UTF-8">
  <meta name="viewport"
    content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, viewport-fit=cover">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#050505">
  <title>通知车主挪车</title>
  <style>
    :root {
      --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
      --ease-elastic: cubic-bezier(0.34, 1.56, 0.64, 1);

      --card-max-width: 560px;
      --card-padding: 1.8rem;
      --card-radius: 28px;

      --text-glow: 0 1px 3px rgba(0, 0, 0, 0.35);

      --bg-base: #0a0a0c;
      --glass-surface: rgba(20, 20, 24, 0.65);
      --glass-border: rgba(255, 255, 255, 0.06);
      --glass-glow: rgba(255, 255, 255, 0.08);
      --glass-blur: 12px;
      --glass-edge-size: 1.5px;
      --card-shadow: 0 20px 50px -15px rgba(0, 0, 0, 0.35);

      --card-spotlight-size: 200px;
      --card-spotlight-color: rgba(255, 255, 255, 0.06);

      --btn-spotlight-size: 120px;
      --btn-source-size: 280px;
      --btn-source-rgb: 255, 255, 255;
      --btn-border-rgb: 255, 255, 255;
      --btn-hover-glow: rgba(255, 255, 255, 0.12);

      --text-primary: #ffffff;
      --text-secondary: rgba(255, 255, 255, 0.65);
      --accent: #ffffff;

      --btn-bg: rgba(255, 255, 255, 0.06);
      --btn-base-border: rgba(255, 255, 255, 0.08);
      --btn-hover-bg: #ffffff;
      --btn-hover-text: #000000;
      --btn-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);

      --toggle-bg: rgba(255, 255, 255, 0.12);
      --toggle-border: rgba(255, 255, 255, 0.18);
      --toggle-checked-bg: #22c55e;
      --toggle-checked-border: #16a34a;
      --toggle-knob: #ffffff;

      --fluid-1: rgba(139, 92, 246, 0.35);
      --fluid-2: rgba(236, 72, 153, 0.32);
      --fluid-3: rgba(59, 130, 246, 0.30);
      --fluid-4: rgba(251, 146, 60, 0.28);
      --fluid-5: rgba(168, 85, 247, 0.26);
      --fluid-6: rgba(14, 165, 233, 0.24);
      --fluid-base-1: #0a0a14;
      --fluid-base-2: #1a0a28;
      --fluid-base-3: #0a1428;
    }

    @media (prefers-color-scheme: light) {
      :root {
        --bg-base: #f0f4ff;
        --glass-surface: rgba(255, 255, 255, 0.45);
        --glass-border: rgba(0, 0, 0, 0.08);
        --glass-glow: rgba(255, 255, 255, 0.5);
        --glass-blur: 10px;
        --card-shadow: 0 12px 30px -10px rgba(0, 0, 0, 0.12);

        --card-spotlight-color: rgba(255, 255, 255, 0.5);

        --btn-source-rgb: 60, 60, 70;
        --btn-border-rgb: 80, 90, 110;
        --btn-hover-glow: rgba(0, 0, 0, 0.04);

        --text-primary: #0f172a;
        --text-secondary: #475569;
        --text-glow: 0 1px 2px rgba(0, 0, 0, 0.15);

        --btn-bg: rgba(255, 255, 255, 0.65);
        --btn-base-border: rgba(0, 0, 0, 0.1);
        --btn-hover-bg: #18181b;
        --btn-hover-text: #ffffff;
        --btn-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);

        --toggle-bg: rgba(15, 23, 42, 0.1);
        --toggle-border: rgba(15, 23, 42, 0.2);

        --fluid-1: rgba(217, 70, 239, 0.45);
        --fluid-2: rgba(59, 130, 246, 0.40);
        --fluid-3: rgba(251, 191, 36, 0.48);
        --fluid-4: rgba(236, 72, 153, 0.42);
        --fluid-5: rgba(139, 92, 246, 0.38);
        --fluid-6: rgba(34, 197, 94, 0.35);
        --fluid-base-1: #f8f0ff;
        --fluid-base-2: #fff0f8;
        --fluid-base-3: #fff7ed;
      }
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
      -webkit-font-smoothing: antialiased;
      -webkit-tap-highlight-color: transparent;
      -webkit-user-select: none;
      user-select: none;
    }

    body {
      font-family: -apple-system, system-ui, "Segoe UI", sans-serif;
      min-height: 100vh;
      background: linear-gradient(160deg, var(--bg-base) 0%, #0f0f12 100%);
      color: var(--text-primary);
      text-shadow: var(--text-glow);
      overflow-x: hidden;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding: clamp(16px, 4vw, 24px);
      padding-top: calc(clamp(16px, 4vw, 24px) + env(safe-area-inset-top, 0px));
      padding-bottom: calc(clamp(16px, 4vw, 24px) + env(safe-area-inset-bottom, 0px));
    }

    @media (prefers-color-scheme: light) {
      body {
        background: linear-gradient(160deg, var(--bg-base) 0%, #d4dae6 100%);
      }
    }

    /* Fluid Background */
    .bg-fluid {
      position: fixed;
      inset: -25%;
      z-index: -10;
      background:
        radial-gradient(40% 50% at 15% 20%, var(--fluid-1), transparent 70%),
        radial-gradient(45% 55% at 85% 15%, var(--fluid-2), transparent 70%),
        radial-gradient(50% 60% at 35% 85%, var(--fluid-3), transparent 70%),
        radial-gradient(40% 50% at 80% 80%, var(--fluid-4), transparent 70%),
        linear-gradient(120deg, var(--fluid-base-1) 0%, var(--fluid-base-2) 50%, var(--fluid-base-3) 100%);
      opacity: 1;
      animation: fluid-drift 28s ease-in-out infinite alternate;
      pointer-events: none;
      filter: saturate(1.15) brightness(1.05);
    }

    .bg-fluid::before,
    .bg-fluid::after {
      content: "";
      position: absolute;
      inset: -30%;
      pointer-events: none;
      mix-blend-mode: screen;
    }

    .bg-fluid::before {
      background:
        radial-gradient(55% 60% at 20% 30%, var(--fluid-5), transparent 70%),
        radial-gradient(60% 65% at 75% 65%, var(--fluid-6), transparent 72%),
        radial-gradient(45% 55% at 60% 15%, rgba(255, 255, 255, 0.08), transparent 70%);
      opacity: 0.85;
      filter: blur(2px);
      animation: fluid-float 30s ease-in-out infinite;
    }

    .bg-fluid::after {
      background:
        radial-gradient(60% 70% at 30% 75%, rgba(139, 92, 246, 0.20), transparent 70%),
        radial-gradient(50% 60% at 70% 35%, rgba(236, 72, 153, 0.18), transparent 70%),
        radial-gradient(55% 65% at 50% 50%, rgba(255, 255, 255, 0.06), transparent 75%);
      opacity: 0.7;
      filter: blur(6px);
      animation: fluid-sway 36s ease-in-out infinite alternate;
    }

    .bg-noise {
      position: fixed;
      inset: 0;
      z-index: -5;
      background:
        repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.03) 0, rgba(255, 255, 255, 0.03) 1px, transparent 1px, transparent 2px),
        repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.02) 0, rgba(255, 255, 255, 0.02) 1px, transparent 1px, transparent 3px);
      opacity: 0.12;
      pointer-events: none;
      mix-blend-mode: soft-light;
    }

    @keyframes fluid-drift {
      0% {
        transform: translate3d(0, 0, 0) scale(1);
      }

      50% {
        transform: translate3d(-3%, 2.5%, 0) scale(1.08);
      }

      100% {
        transform: translate3d(3%, -2%, 0) scale(1.05);
      }
    }

    @keyframes fluid-float {
      0% {
        transform: translate3d(0, 0, 0) scale(1);
      }

      50% {
        transform: translate3d(4%, -3%, 0) scale(1.10);
      }

      100% {
        transform: translate3d(-3%, 2%, 0) scale(1.06);
      }
    }

    @keyframes fluid-sway {
      0% {
        transform: translate3d(0, 0, 0) scale(1);
      }

      50% {
        transform: translate3d(-4%, 3.5%, 0) scale(1.09);
      }

      100% {
        transform: translate3d(3%, -2.5%, 0) scale(1.05);
      }
    }

    @keyframes fluid-shift {
      0% {
        background-position: 0% 0%, 100% 0%, 30% 100%, 80% 80%, 50% 50%;
      }

      50% {
        background-position: 10% 5%, 90% 10%, 20% 90%, 75% 70%, 45% 55%;
      }

      100% {
        background-position: 0% 0%, 100% 0%, 30% 100%, 80% 80%, 50% 50%;
      }
    }

    .anim-paused .bg-fluid,
    .anim-paused .bg-fluid::before,
    .anim-paused .bg-fluid::after {
      animation-play-state: paused;
    }

    @media (prefers-reduced-motion: reduce), (hover: none), (pointer: coarse) {
      .bg-fluid,
      .bg-fluid::before,
      .bg-fluid::after {
        animation: none !important;
        filter: none !important;
      }

      .bg-noise {
        opacity: 0.05;
      }
    }

    .low-power .bg-fluid,
    .low-power .bg-fluid::before,
    .low-power .bg-fluid::after {
      animation: none !important;
      filter: none !important;
    }

    .low-power .bg-fluid::before,
    .low-power .bg-fluid::after {
      display: none;
    }

    .low-power .bg-noise {
      opacity: 0.04;
    }

    .low-power .card,
    .low-power .spot-btn {
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }

    .low-power .card,
    .low-power .spot-btn {
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }

    .main-container {
      width: 100%;
      display: flex;
      justify-content: center;
      position: relative;
      z-index: 1;
    }

    .container {
      width: 100%;
      max-width: var(--card-max-width);
      display: flex;
      flex-direction: column;
      gap: clamp(12px, 3vw, 18px);
    }

    /* Glass Card */
    .card {
      --gx: -1000px;
      --gy: -1000px;
      background:
        radial-gradient(var(--card-spotlight-size) circle at var(--gx) var(--gy), var(--card-spotlight-color), transparent 100%),
        var(--glass-surface);
      backdrop-filter: blur(var(--glass-blur)) saturate(1.25) brightness(1.03);
      -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(1.25) brightness(1.03);
      border: 1px solid var(--glass-border);
      border-radius: var(--card-radius);
      padding: var(--card-padding);
      width: 100%;
      box-shadow:
        var(--card-shadow),
        inset 0 0 0 0.5px var(--glass-glow);
      position: relative;
      overflow: hidden;
      isolation: isolate;
    }

    /* Card edge highlight */
    .card::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      padding: var(--glass-edge-size);
      background: linear-gradient(180deg,
          rgba(255, 255, 255, 0.12) 0%,
          rgba(255, 255, 255, 0) 50%,
          rgba(255, 255, 255, 0.04) 100%);
      mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      mask-composite: exclude;
      -webkit-mask-composite: xor;
      pointer-events: none;
      z-index: 0;
    }

    .header {
      display: flex;
      align-items: center;
      gap: clamp(12px, 3vw, 20px);
    }

    .icon-wrap {
      width: clamp(56px, 14vw, 78px);
      height: clamp(56px, 14vw, 78px);
      border-radius: clamp(16px, 4vw, 22px);
      background: rgba(255, 255, 255, 0.08);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: clamp(28px, 7vw, 38px);
      flex-shrink: 0;
    }

    .header-content h1 {
      font-size: clamp(22px, 5.5vw, 28px);
      font-weight: 700;
      letter-spacing: -0.5px;
      color: var(--text-primary);
      margin-bottom: 4px;
    }

    .header-content p {
      font-size: clamp(13px, 3.5vw, 15px);
      color: var(--text-secondary);
      font-weight: 500;
      letter-spacing: 0.5px;
    }

    .input-card {
      padding: 0;
    }

    .input-card textarea {
      width: 100%;
      min-height: 90px;
      padding: clamp(14px, 3.5vw, 20px);
      border: none;
      background: transparent;
      color: var(--text-primary);
      font-size: 16px;
      font-family: inherit;
      resize: none;
      outline: none;
    }

    .input-card textarea::placeholder {
      color: var(--text-secondary);
      opacity: 0.7;
    }

    .tags {
      display: flex;
      gap: clamp(6px, 2vw, 10px);
      padding: 0 clamp(12px, 3vw, 20px) clamp(14px, 3vw, 20px);
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
    }

    .tags::-webkit-scrollbar {
      display: none;
    }

    .tag {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-primary);
      padding: 10px 16px;
      border-radius: 20px;
      font-size: 14px;
      font-weight: 600;
      white-space: nowrap;
      cursor: pointer;
      border: 1px solid rgba(255, 255, 255, 0.06);
      min-height: 42px;
      display: flex;
      align-items: center;
      transition: transform 0.2s ease, background 0.2s ease;
    }

    .tag:active {
      transform: scale(0.96);
      background: rgba(255, 255, 255, 0.14);
    }

    .loc-card {
      display: flex;
      align-items: center;
      gap: clamp(10px, 3vw, 16px);
      cursor: pointer;
      min-height: 64px;
    }

    .loc-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .loc-icon {
      width: clamp(44px, 11vw, 56px);
      height: clamp(44px, 11vw, 56px);
      border-radius: clamp(14px, 3.5vw, 18px);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: clamp(22px, 5.5vw, 28px);
      flex-shrink: 0;
      background: rgba(255, 255, 255, 0.1);
      transition: background 0.3s ease;
    }

    .loc-icon.loading {
      animation: pulse 1.5s ease-in-out infinite;
    }

    @keyframes pulse {

      0%,
      100% {
        opacity: 1;
      }

      50% {
        opacity: 0.5;
      }
    }

    .loc-icon.ready {
      background: rgba(34, 197, 94, 0.2);
    }

    .loc-icon.error {
      background: rgba(239, 68, 68, 0.2);
    }

    .loc-content {
      flex: 1;
      min-width: 0;
    }

    .loc-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .loc-status {
      font-size: 13px;
      color: var(--text-secondary);
      margin-top: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Toggle */
    .toggle {
      position: relative;
      display: inline-flex;
      align-items: center;
      width: 52px;
      height: 30px;
      flex-shrink: 0;
    }

    .toggle input {
      opacity: 0;
      width: 0;
      height: 0;
    }

    .toggle-slider {
      position: absolute;
      cursor: pointer;
      inset: 0;
      background: var(--toggle-bg);
      border: 1px solid var(--toggle-border);
      border-radius: 999px;
      transition: background 0.25s, border 0.25s;
    }

    .toggle-slider::before {
      content: "";
      position: absolute;
      height: 24px;
      width: 24px;
      left: 2px;
      top: 2px;
      background: var(--toggle-knob);
      border-radius: 50%;
      transition: transform 0.25s var(--ease-elastic);
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
    }

    .toggle input:checked+.toggle-slider {
      background: var(--toggle-checked-bg);
      border-color: var(--toggle-checked-border);
    }

    .toggle input:checked+.toggle-slider::before {
      transform: translateX(22px);
    }

    /* Spot Button - with spotlight border effect */
    .spot-btn {
      --bx: -1000px;
      --by: -1000px;
      --sx: -1000px;
      --sy: -1000px;
      --si: 0;
      --border-alpha: 0.06;
      --rx: 50%;
      --ry: 50%;
      position: relative;
      overflow: hidden;
      isolation: isolate;
      background:
        radial-gradient(var(--btn-spotlight-size) circle at var(--bx) var(--by), var(--btn-hover-glow), transparent 100%),
        var(--glass-surface);
      backdrop-filter: blur(var(--glass-blur)) saturate(1.25) brightness(1.03);
      -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(1.25) brightness(1.03);
      border: 1px solid var(--glass-border);
      box-shadow:
        var(--btn-shadow),
        inset 0 0 0 0.5px var(--glass-glow);
      transition: transform 0.3s var(--ease-out-expo);
    }

    .spot-btn>span {
      position: relative;
      z-index: 5;
    }

    /* Spotlight border - using mask technique */
    .spot-btn::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      padding: 1px;
      background:
        radial-gradient(var(--btn-spotlight-size) circle at var(--bx) var(--by), rgba(var(--btn-border-rgb), 0.85), transparent 100%),
        radial-gradient(var(--btn-source-size) circle at var(--sx) var(--sy), rgba(var(--btn-source-rgb), calc(0.9 * var(--si))), transparent 80%),
        linear-gradient(rgba(var(--btn-border-rgb), var(--border-alpha)), rgba(var(--btn-border-rgb), var(--border-alpha)));
      mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      mask-composite: exclude;
      -webkit-mask-composite: xor;
      pointer-events: none;
      z-index: 2;
    }

    /* Ripple effect */
    .spot-btn::after {
      content: "";
      position: absolute;
      width: var(--rsize, 320px);
      height: var(--rsize, 320px);
      border-radius: 50%;
      left: var(--rx);
      top: var(--ry);
      transform: translate(-50%, -50%) scale(0);
      opacity: 0;
      pointer-events: none;
      z-index: 1;
      background: var(--btn-hover-bg);
      transition: transform var(--ripple-ms, 280ms) var(--ease-out-expo), opacity var(--ripple-ms, 280ms) ease;
    }

    .spot-btn.ripple-on::after {
      transform: translate(-50%, -50%) scale(1);
      opacity: 1;
    }

    .spot-btn.ripple-on>span {
      color: var(--btn-hover-text);
    }

    /* Main button */
    .btn-main {
      width: 100%;
      padding: clamp(16px, 4vw, 20px);
      border: none;
      border-radius: var(--card-radius);
      font-size: clamp(16px, 4vw, 18px);
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      color: var(--text-primary);
      min-height: 56px;
    }

    .btn-main:active {
      transform: scale(0.98);
    }

    .btn-main:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Action buttons */
    .action-card {
      text-align: center;
    }

    .action-hint {
      font-size: 14px;
      color: var(--text-secondary);
      margin-bottom: 16px;
    }

    .btn-retry,
    .btn-phone {
      width: 100%;
      padding: 14px 20px;
      border: none;
      border-radius: 16px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      color: var(--text-primary);
      margin-bottom: 10px;
      text-decoration: none;
    }

    .btn-retry:disabled,
    .btn-phone:disabled,
    .btn-phone.disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    /* Map links */
    .map-links {
      display: flex;
      gap: 10px;
      margin-top: 16px;
    }

    .map-btn {
      flex: 1;
      padding: 12px 16px;
      border-radius: 12px;
      text-decoration: none;
      font-weight: 600;
      font-size: 14px;
      text-align: center;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }

    .map-btn.amap {
      background: rgba(24, 144, 255, 0.2);
      color: #60a5fa;
    }

    .map-btn.apple {
      background: rgba(255, 255, 255, 0.1);
      color: var(--text-primary);
    }

    .owner-card {
      text-align: center;
    }

    .owner-card h3 {
      font-size: 20px;
      color: var(--text-primary);
      margin-bottom: 8px;
    }

      .owner-card p {
        font-size: 14px;
        color: var(--text-secondary);
      }

      .owner-msg {
        margin-top: 10px;
        font-size: 14px;
        color: var(--text-secondary);
      }

      .owner-card.hidden {
        display: none;
      }

    .session-card {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 12px 16px;
      font-size: 13px;
      color: var(--text-secondary);
      cursor: pointer;
    }

    .session-row {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .session-expire {
      font-size: 12px;
      color: var(--text-secondary);
    }

    .session-card strong {
      color: var(--text-primary);
      font-weight: 700;
      letter-spacing: 0.5px;
    }

    /* Toast */
    .toast {
      position: fixed;
      top: calc(20px + env(safe-area-inset-top, 0px));
      left: 50%;
      transform: translateX(-50%) translateY(-100px);
      background: rgba(0, 0, 0, 0.85);
      color: white;
      padding: 14px 24px;
      border-radius: 16px;
      font-size: 15px;
      font-weight: 500;
      z-index: 1000;
      opacity: 0;
      transition: transform 0.4s var(--ease-out-expo), opacity 0.3s ease;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      max-width: 90%;
      text-align: center;
    }

    .toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }

    /* Modal */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 200;
      padding: 20px;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.3s ease, visibility 0.3s ease;
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }

    .modal-overlay.show {
      opacity: 1;
      visibility: visible;
    }

    .modal-box {
      background: var(--glass-surface);
      backdrop-filter: blur(20px) saturate(1.3);
      -webkit-backdrop-filter: blur(20px) saturate(1.3);
      border: 1px solid var(--glass-border);
      border-radius: 24px;
      padding: clamp(24px, 6vw, 32px);
      max-width: 340px;
      width: 100%;
      text-align: center;
      transform: scale(0.9);
      transition: transform 0.3s var(--ease-out-expo);
      box-shadow: 0 30px 60px -20px rgba(0, 0, 0, 0.5);
    }

    .modal-overlay.show .modal-box {
      transform: scale(1);
    }

    .modal-icon {
      font-size: 48px;
      margin-bottom: 16px;
    }

    .modal-title {
      font-size: 18px;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 8px;
    }

    .modal-desc {
      font-size: 14px;
      color: var(--text-secondary);
      margin-bottom: 24px;
      line-height: 1.6;
    }

    .modal-buttons {
      display: flex;
      gap: 12px;
    }

    .modal-btn {
      flex: 1;
      padding: 14px 16px;
      border-radius: 14px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      color: var(--text-primary);
      transition: transform 0.2s ease;
    }

    .modal-btn:active {
      transform: scale(0.96);
    }

    .modal-btn-danger {
      background: rgba(239, 68, 68, 0.2);
      color: #fca5a5;
    }

    /* Countdown */
    .countdown-container {
      display: flex;
      justify-content: center;
      margin: 20px 0;
    }

    .flip-card {
      --flip-bg: rgba(10, 10, 14, 0.9);
      position: relative;
      width: clamp(120px, 30vw, 150px);
      height: clamp(90px, 22vw, 120px);
      border-radius: 14px;
      background: var(--flip-bg);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
      perspective: 800px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
      font-size: clamp(56px, 14vw, 80px);
      font-weight: 700;
      letter-spacing: 2px;
      color: #fff;
    }

    .flip-half {
      position: absolute;
      left: 0;
      right: 0;
      height: 50%;
      overflow: hidden;
      background: var(--flip-bg);
      backface-visibility: hidden;
    }

    .flip-top {
      top: 0;
      border-top-left-radius: 14px;
      border-top-right-radius: 14px;
    }

    .flip-bottom {
      bottom: 0;
      border-bottom-left-radius: 14px;
      border-bottom-right-radius: 14px;
    }

    .flip-text {
      position: absolute;
      left: 0;
      right: 0;
      height: 200%;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
      text-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
    }

    .flip-top .flip-text {
      top: 0;
    }

    .flip-bottom .flip-text {
      bottom: 0;
    }

    .flip-static {
      z-index: 1;
    }

    .flip-anim {
      z-index: 3;
      transform-style: preserve-3d;
    }

    .flip-top.flip-anim {
      transform-origin: bottom;
    }

    .flip-bottom.flip-anim {
      transform-origin: top;
      transform: rotateX(90deg);
    }

    .flip-card::after {
      content: '';
      position: absolute;
      top: 50%;
      left: 0;
      right: 0;
      height: 2px;
      background: rgba(0, 0, 0, 0.5);
      transform: translateY(-50%);
      z-index: 2;
      pointer-events: none;
    }

    .flip-card.flip .flip-top.flip-anim {
      animation: flipTop 0.32s var(--ease-out-expo) forwards;
    }

    .flip-card.flip .flip-bottom.flip-anim {
      animation: flipBottom 0.32s var(--ease-out-expo) forwards;
      animation-delay: 0.18s;
    }

    @keyframes flipTop {
      from {
        transform: rotateX(0deg);
      }

      to {
        transform: rotateX(-90deg);
      }
    }

    @keyframes flipBottom {
      from {
        transform: rotateX(90deg);
      }

      to {
        transform: rotateX(0deg);
      }
    }

    @media (max-width: 768px) {
      :root {
        --card-padding: 1.4rem;
        --card-radius: 24px;
        --glass-edge-size: 1px;
      }

      .container {
        max-width: 94vw;
      }
    }
  </style>
</head>

<body>
  <div class="bg-fluid" aria-hidden="true"></div>
  <div class="bg-noise" aria-hidden="true"></div>

  <div id="toast" class="toast"></div>

  <div class="main-container">
    <div id="locationTipModal" class="modal-overlay">
      <div class="modal-box">
        <div class="modal-icon">📍</div>
        <div class="modal-title">位置信息说明</div>
        <div class="modal-desc">分享位置可让车主确认您在车旁<br>不分享将 <span style="font-weight:bold; font-size:1.2em;"> 延迟 </span> 发送通知
        </div>
        <div class="modal-buttons">
          <button class="modal-btn spot-btn" onclick="hideModal('locationTipModal');"><span>我知道了</span></button>
        </div>
      </div>
    </div>
    <div id="delayModal" class="modal-overlay">
      <div class="modal-box">
        <div class="modal-icon">⏳</div>
        <div class="modal-title">正在延迟发送</div>
        <div class="modal-desc">未提供位置信息，<br>将在倒计时结束后发送通知</div>
        <div class="countdown-container">
          <div id="countdownNum" class="flip-card">
            <span class="flip-half flip-top flip-static"><span class="flip-text">30</span></span>
            <span class="flip-half flip-bottom flip-static"><span class="flip-text">30</span></span>
            <span class="flip-half flip-top flip-anim"><span class="flip-text">30</span></span>
            <span class="flip-half flip-bottom flip-anim"><span class="flip-text">30</span></span>
          </div>
        </div>
        <div class="modal-buttons">
          <button class="modal-btn modal-btn-danger spot-btn" onclick="cancelDelay()"><span>取消发送</span></button>
        </div>
      </div>
    </div>

    <div class="container" id="mainView">
      <div class="card header">
        <div class="icon-wrap"><span>🚗</span></div>
        <div class="header-content">
          <h1>呼叫车主挪车</h1>
          <p>Notify Car Owner</p>
        </div>
      </div>
      <div class="card input-card">
        <textarea id="msgInput" placeholder="输入留言给车主...（可选）"></textarea>
        <div class="tags">
          <div class="tag spot-btn" onclick="addTag('您的车挡住我了')"><span>🚧 挡路</span></div>
          <div class="tag spot-btn" onclick="addTag('临时停靠一下')"><span>⏱️ 临停</span></div>
          <div class="tag spot-btn" onclick="addTag('电话打不通')"><span>📞 没接</span></div>
          <div class="tag spot-btn" onclick="addTag('麻烦尽快')"><span>🙏 加急</span></div>
        </div>
      </div>
      <div
        style="position: fixed; bottom: 10px; right: 10px; opacity: 0.35; font-size: 12px; color: rgba(255,255,255,0.5); pointer-events: none;">
        v2.4.0</div>
      <div class="card loc-card">
        <div id="locIcon" class="loc-icon loading">📍</div>
        <div class="loc-content">
          <div class="loc-row">
            <div class="loc-title">是否发送位置</div>
            <label class="toggle">
              <input id="shareLocationToggle" type="checkbox" checked>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div id="locStatus" class="loc-status">等待获取...</div>
        </div>
      </div>
      <div id="mapContainer" class="card"
        style="display:none; height: 200px; padding: 0; overflow: hidden; margin-top: -10px;"></div>
      <div id="sessionInfoUser" class="card session-card" style="display:none;">
        <div class="session-row">
          <span>会话 <strong id="sessionCodeUser">#------</strong></span>
          <span id="sessionStatusUser">进行中</span>
        </div>
        <div id="sessionExpire" class="session-expire" style="display:none;"></div>
      </div>
      <button id="notifyBtn" class="btn-main spot-btn" onclick="sendNotify()">
        <span>🔔</span>
        <span>一键通知车主</span>
      </button>
    </div>

    <div class="container" id="successView"
      style="display: none; flex-direction: column; align-items: center; justify-content: start; padding-top: 40px;">
      <div id="ownerFeedback" class="card owner-card hidden">
        <span style="font-size:56px; display:block; margin-bottom:16px">🎉</span>
        <h3>车主已收到通知</h3>
        <p>正在赶来，点击查看车主位置</p>
        <p id="ownerMessage" class="owner-msg" style="display:none;"></p>
        <div id="ownerMapLinks" class="map-links" style="display:none">
          <a id="ownerAmapLink" href="#" class="map-btn amap spot-btn"><span>🗺️ 高德地图</span></a>
          <a id="ownerAppleLink" href="#" class="map-btn apple spot-btn"><span>🍎 Apple Maps</span></a>
        </div>
      </div>

      <div id="waitingCard" class="card" style="text-align: center; margin-bottom: 15px;">
        <span style="font-size: 60px; display: block; margin-bottom: 20px;">✅</span>
        <h1 style="color: var(--text-primary); margin-bottom: 10px;">已通知车主</h1>
        <p id="waitingText" style="color: var(--text-secondary); font-size: 16px;">正在等待车主回应...请不要离开此页面</p>
      </div>

      <div class="card action-card">
        <p id="actionHint" class="action-hint">车主没反应？试试其他方式</p>
        <button id="retryBtn" class="btn-retry spot-btn" onclick="retryNotify()">
          <span>🔔</span>
          <span>再次通知</span>
        </button>
        ${phone ? `
        <button id="phoneBtn" type="button" class="btn-phone spot-btn">
          <span>📞</span>
          <span>直接打电话</span>
        </button>
        ` : ''}
<div style="margin-top: 15px; text-align: center;">
          <a href="javascript:location.reload()"
            style="color: rgba(255,255,255,0.55); text-decoration: none; font-size: 14px;">返回首页</a>
        </div>
      </div>
    </div>
  </div>

  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
    integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
    integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
  <script>
const API_BASE = '${apiBase}';
const SESSION_PATH_ID = '${sessionPathId || ''}';
const SESSION_VIEW_TTL_MS = ${SESSION_VIEW_TTL_SECONDS * 1000};
let userLocation = null;
      let checkTimer = null;
      let delayTimer = null;
      let retryCooldownTimer = null;
      let phoneCooldownTimer = null;
      let retryReadyAt = 0;
      let phoneReadyAt = null;
      let phoneDefaultHtml = '';
      let retryCooldownSeconds = 30;
      let callCooldownSeconds = 30;
      let ownerConfirmed = false;
      let currentSessionId = null;
      let currentSessionStatus = null;
      let currentSessionCompletedAt = null;
      let countdownVal = 30;
      let lastCountdownVal = null;
      let map = null;
      let marker = null;

      // WGS-84 to GCJ-02 function used in client side for map display
      function wgs84ToGcj02Client(lat, lng) {
        const a = 6378245.0;
        const ee = 0.00669342162296594323;
        if (outOfChina(lat, lng)) return { lat, lng };
        let dLat = transformLat(lng - 105.0, lat - 35.0);
        let dLng = transformLng(lng - 105.0, lat - 35.0);
        const radLat = lat / 180.0 * Math.PI;
        let magic = Math.sin(radLat);
        magic = 1 - ee * magic * magic;
        const sqrtMagic = Math.sqrt(magic);
        dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
        dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
        return { lat: lat + dLat, lng: lng + dLng };
      }
      function outOfChina(lat, lng) {
        return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
      }
      function transformLat(x, y) {
        let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
        ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
        ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
        ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
        return ret;
      }
      function transformLng(x, y) {
        let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
        ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
        ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
        ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
        return ret;
      }

      window.onload = () => {
        const toggle = document.getElementById('shareLocationToggle');
        toggle.addEventListener('change', handleLocationToggle);
        initActionControls();
        refreshSessionInfo();
        if (SESSION_PATH_ID) {
          currentSessionId = SESSION_PATH_ID;
        }
        if (toggle.checked) {
          requestLocation();
        } else {
          disableLocationSharing();
        }
        const sessionCard = document.getElementById('sessionInfoUser');
        if (sessionCard) {
          sessionCard.addEventListener('click', () => resumeSession());
        }
      };
      let idleKick = null;
      function setupPowerMode() {
        const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const saveData = navigator.connection && navigator.connection.saveData;
        const lowMem = navigator.deviceMemory && navigator.deviceMemory <= 4;
        const lowPower = !!(prefersReduced || saveData || lowMem);
        document.body.classList.toggle('low-power', lowPower);
      }
      function setupIdlePause() {
        const IDLE_MS = 4500;
        let timer = 0;
        const kick = () => {
          if (!document.hidden) {
            document.body.classList.remove('anim-paused');
          }
          if (timer) clearTimeout(timer);
          if (!document.hidden) {
            timer = setTimeout(() => {
              if (!document.hidden) document.body.classList.add('anim-paused');
            }, IDLE_MS);
          }
        };
        idleKick = kick;
        ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach((evt) => {
          window.addEventListener(evt, kick, { passive: true });
        });
        kick();
      }
      setupPowerMode();
      setupIdlePause();
      if (window.matchMedia) {
        const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        if (motionQuery.addEventListener) motionQuery.addEventListener('change', setupPowerMode);
        else if (motionQuery.addListener) motionQuery.addListener(setupPowerMode);
      }
      if (navigator.connection && navigator.connection.addEventListener) {
        navigator.connection.addEventListener('change', setupPowerMode);
      }
      document.addEventListener('visibilitychange', () => {
        document.body.classList.toggle('anim-paused', document.hidden);
        if (!document.hidden && idleKick) idleKick();
      });
      function initActionControls() {
        const phoneBtn = document.getElementById('phoneBtn');
        if (phoneBtn) {
          phoneDefaultHtml = phoneBtn.innerHTML;
          disablePhoneUntilRetry();
          phoneBtn.addEventListener('click', (e) => {
            if (!isPhoneReady()) {
              e.preventDefault();
              if (phoneReadyAt === null) {
                showToast('⏳ 请先再次提醒后再拨打电话');
              } else {
                const remaining = Math.max(0, Math.ceil((phoneReadyAt - Date.now()) / 1000));
                showToast('⏳ 还需等待 ' + remaining + 's 再拨打电话');
              }
              return;
            }
            requestPhoneAndCall();
          });
        }
      }
      function setActionHint(text) {
        const el = document.getElementById('actionHint');
        if (el && text) el.innerText = text;
      }
      function formatSessionStatus(raw) {
        if (raw === 'arriving') return '车主正在赶来';
        if (raw === 'closed' || raw === 'confirmed') return '已结束挪车会话';
        return '进行中';
      }
      function formatExpireText(ts) {
        const date = new Date(ts);
        const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        return '销毁时间 ' + time;
      }
      function applySessionInfo(data) {
        const info = document.getElementById('sessionInfoUser');
        const code = document.getElementById('sessionCodeUser');
        const status = document.getElementById('sessionStatusUser');
        const expire = document.getElementById('sessionExpire');
        currentSessionId = data && data.sessionId ? data.sessionId : null;
        currentSessionStatus = data && data.sessionStatus ? data.sessionStatus : null;
        currentSessionCompletedAt = data && data.sessionCompletedAt ? Number(data.sessionCompletedAt) : null;
        if (currentSessionId) {
          if (code) code.innerText = '#' + currentSessionId;
          if (status) status.innerText = formatSessionStatus(currentSessionStatus);
        if (currentSessionCompletedAt && (currentSessionStatus === 'closed' || currentSessionStatus === 'confirmed')) {
          if (expire) {
            expire.innerText = formatExpireText(currentSessionCompletedAt + SESSION_VIEW_TTL_MS);
            expire.style.display = 'block';
          }
        } else if (expire) {
          expire.style.display = 'none';
        }
          if (info) info.style.display = 'flex';
        } else if (info) {
          info.style.display = 'none';
        }
      }
      function resumeSession() {
        if (!currentSessionId) return;
        const mainView = document.getElementById('mainView');
        const successView = document.getElementById('successView');
        if (mainView) mainView.style.display = 'none';
        if (successView) successView.style.display = 'flex';
        history.replaceState(null, '', '/' + currentSessionId);
        startPolling();
        syncStatusOnce();
      }
      async function syncStatusOnce() {
        try {
          const res = await fetch(API_BASE + '/check-status');
          const data = await res.json();
          handleStatusResponse(data);
        } catch (e) {}
      }
      function handleStatusResponse(data) {
        if (data && (data.sessionId || data.sessionStatus || data.sessionCompletedAt)) {
          applySessionInfo(data);
        }
        const retryBtn = document.getElementById('retryBtn');
        const phoneBtn = document.getElementById('phoneBtn');
        const ownerCard = document.getElementById('ownerFeedback');
        const ownerMsg = document.getElementById('ownerMessage');
        if (data.status === 'arriving') {
          if (ownerCard) ownerCard.classList.remove('hidden');
          if (ownerMsg) {
            if (data.ownerMessage) {
              ownerMsg.innerText = '车主留言：' + data.ownerMessage;
              ownerMsg.style.display = 'block';
            } else {
              ownerMsg.style.display = 'none';
            }
          }
          const waitingCard = document.getElementById('waitingCard');
          if (waitingCard) waitingCard.style.display = 'none';
          if (data.ownerLocation && data.ownerLocation.amapUrl) {
            const mapLinks = document.getElementById('ownerMapLinks');
            if (mapLinks) mapLinks.style.display = 'flex';
            const amapLink = document.getElementById('ownerAmapLink');
            if (amapLink) amapLink.href = data.ownerLocation.amapUrl;
            const appleLink = document.getElementById('ownerAppleLink');
            if (appleLink) appleLink.href = data.ownerLocation.appleUrl;
          }
          setActionHint('车主正在赶来，可继续提醒');
          if (retryBtn && retryBtn.disabled && retryBtn.innerText.includes('会话已')) {
            retryBtn.disabled = false;
            retryBtn.innerHTML = '<span>🔔</span><span>再次通知</span>';
          }
          if (phoneBtn && phoneBtn.disabled && phoneBtn.innerText.includes('会话已')) {
            disablePhoneUntilRetry();
          }
        } else if (data.status === 'confirmed') {
          const fb = document.getElementById('ownerFeedback');
          if (fb) fb.classList.remove('hidden');
          if (ownerMsg) {
            if (data.ownerMessage) {
              ownerMsg.innerText = '车主留言：' + data.ownerMessage;
              ownerMsg.style.display = 'block';
            } else {
              ownerMsg.style.display = 'none';
            }
          }
          const waitingCard = document.getElementById('waitingCard');
          if (waitingCard) waitingCard.style.display = 'none';
          const sessionStatus = document.getElementById('sessionStatusUser');
          if (sessionStatus) sessionStatus.innerText = '已结束挪车会话';
          if (data.ownerLocation && data.ownerLocation.amapUrl) {
            const mapLinks = document.getElementById('ownerMapLinks');
            if (mapLinks) mapLinks.style.display = 'flex';
            const amapLink = document.getElementById('ownerAmapLink');
            if (amapLink) amapLink.href = data.ownerLocation.amapUrl;
            const appleLink = document.getElementById('ownerAppleLink');
            if (appleLink) appleLink.href = data.ownerLocation.appleUrl;
          }
          if (retryBtn) {
            retryBtn.disabled = true;
            retryBtn.innerHTML = '<span>✅</span><span>会话已完成</span>';
          }
          if (phoneBtn) {
            phoneBtn.disabled = true;
            phoneBtn.classList.add('disabled');
            phoneBtn.innerHTML = '<span>📞</span><span>会话已完成</span>';
          }
          setActionHint('会话已完成，需重新发起通知');
        } else if (data.status === 'closed') {
          if (ownerCard) ownerCard.classList.add('hidden');
          if (ownerMsg) ownerMsg.style.display = 'none';
          const waitingCard = document.getElementById('waitingCard');
          if (waitingCard) waitingCard.style.display = 'none';
          const sessionStatus = document.getElementById('sessionStatusUser');
          if (sessionStatus) sessionStatus.innerText = '已结束挪车会话';
          if (retryBtn) {
            retryBtn.disabled = true;
            retryBtn.innerHTML = '<span>✅</span><span>会话已结束</span>';
          }
          if (phoneBtn) {
            phoneBtn.disabled = true;
            phoneBtn.classList.add('disabled');
            phoneBtn.innerHTML = '<span>📞</span><span>会话已结束</span>';
          }
          setActionHint('会话已结束，需重新发起通知');
        } else {
          if (ownerCard) ownerCard.classList.add('hidden');
          if (ownerMsg) ownerMsg.style.display = 'none';
          const waitingCard = document.getElementById('waitingCard');
          if (waitingCard) waitingCard.style.display = '';
          if (retryBtn && retryBtn.disabled && retryBtn.innerText.includes('会话已')) {
            retryBtn.disabled = false;
            retryBtn.innerHTML = '<span>🔔</span><span>再次通知</span>';
          }
          if (phoneBtn && phoneBtn.disabled && phoneBtn.innerText.includes('会话已')) {
            disablePhoneUntilRetry();
          }
        }
      }
      async function refreshSessionInfo() {
        try {
          const res = await fetch(API_BASE + '/get-session');
          const data = await res.json();
          applySessionInfo(data);
        } catch (e) {}
      }
      function updateActionHint() {
        const now = Date.now();
        if (phoneReadyAt !== null && now < phoneReadyAt) {
          const remaining = Math.max(0, Math.ceil((phoneReadyAt - now) / 1000));
          setActionHint('再次提醒已发送，' + remaining + 's 后可拨打电话');
          return;
        }
        if (now < retryReadyAt) {
          const remaining = Math.max(0, Math.ceil((retryReadyAt - now) / 1000));
          setActionHint('距离下次提醒还有 ' + remaining + 's');
          return;
        }
        setActionHint('车主没反应？试试其他方式');
      }
      function startRetryCooldown(seconds) {
        const btn = document.getElementById('retryBtn');
        if (!btn) return;
        if (retryCooldownTimer) clearInterval(retryCooldownTimer);
        retryReadyAt = Date.now() + seconds * 1000;
        btn.disabled = true;
        updateRetryCountdown();
        retryCooldownTimer = setInterval(updateRetryCountdown, 1000);
      }
      function updateRetryCountdown() {
        const btn = document.getElementById('retryBtn');
        if (!btn) return;
        const remaining = Math.max(0, Math.ceil((retryReadyAt - Date.now()) / 1000));
        if (remaining <= 0) {
          clearInterval(retryCooldownTimer);
          retryCooldownTimer = null;
          btn.disabled = false;
          btn.innerHTML = '<span>🔔</span><span>再次通知</span>';
          updateActionHint();
          return;
        }
        btn.innerHTML = '<span>⏳</span><span>' + remaining + 's 后可再次提醒</span>';
        updateActionHint();
      }
      function disablePhoneUntilRetry() {
        const phoneBtn = document.getElementById('phoneBtn');
        if (!phoneBtn) return;
        phoneReadyAt = null;
        phoneBtn.disabled = true;
        phoneBtn.classList.add('disabled');
        phoneBtn.innerHTML = '<span>📞</span><span>再次提醒后可拨打</span>';
      }
      function startPhoneCooldown(seconds) {
        const phoneBtn = document.getElementById('phoneBtn');
        if (!phoneBtn) return;
        if (phoneCooldownTimer) clearInterval(phoneCooldownTimer);
        phoneReadyAt = Date.now() + seconds * 1000;
        phoneBtn.disabled = true;
        phoneBtn.classList.add('disabled');
        updatePhoneCountdown();
        phoneCooldownTimer = setInterval(updatePhoneCountdown, 1000);
      }
      function updatePhoneCountdown() {
        const phoneBtn = document.getElementById('phoneBtn');
        if (!phoneBtn || phoneReadyAt === null) return;
        const remaining = Math.max(0, Math.ceil((phoneReadyAt - Date.now()) / 1000));
        if (remaining <= 0) {
          clearInterval(phoneCooldownTimer);
          phoneCooldownTimer = null;
          phoneBtn.classList.remove('disabled');
          phoneBtn.disabled = false;
          phoneBtn.innerHTML = phoneDefaultHtml || '<span>📞</span><span>直接打电话</span>';
          phoneReadyAt = Date.now();
          updateActionHint();
          return;
        }
        phoneBtn.innerHTML = '<span>⏳</span><span>' + remaining + 's 后可拨打</span>';
        updateActionHint();
      }
      function isPhoneReady() {
        if (phoneReadyAt === null) return false;
        return Date.now() >= phoneReadyAt;
      }
      async function requestPhoneAndCall() {
        try {
          const res = await fetch(API_BASE + '/get-phone', { method: 'POST' });
          const data = await res.json();
          if (!res.ok || !data.phone) {
            throw new Error(data.error || 'NO_PHONE');
          }
          window.location.href = 'tel:' + data.phone;
        } catch (e) {
          console.error(e);
          showToast('❌ 获取电话失败');
        }
      }
      function showModal(id) { document.getElementById(id).classList.add('show'); }
      function hideModal(id) { document.getElementById(id).classList.remove('show'); }
      function requestLocation() {
        const toggle = document.getElementById('shareLocationToggle');
        if (!toggle.checked) return;
        const icon = document.getElementById('locIcon');
        const txt = document.getElementById('locStatus');
        icon.className = 'loc-icon loading';
        txt.className = 'loc-status';
        txt.innerText = '正在获取定位...';
        if ('geolocation' in navigator) {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
              icon.className = 'loc-icon success';
              txt.className = 'loc-status success';
              txt.innerText = '已获取位置 ✓';
              showMap(userLocation.lat, userLocation.lng);
            },
            (err) => {
              icon.className = 'loc-icon error';
              txt.className = 'loc-status error';
              txt.innerText = '位置获取失败，刷新页面可重试';
              hideMap();
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
          );
        } else {
          icon.className = 'loc-icon error';
          txt.className = 'loc-status error';
          txt.innerText = '浏览器不支持定位';
          hideMap();
        }
      }
      
      function showMap(lat, lng) {
        const container = document.getElementById('mapContainer');
        if (!container) return; // Prevention
        container.style.display = 'block';
        
        // Convert WGS84 (GPS) to GCJ02 (Amap/Chinese standard)
        const gcj = wgs84ToGcj02Client(lat, lng);
        const center = [gcj.lat, gcj.lng];

        if (!map) {
          map = L.map('mapContainer', {
            zoomControl: false,
            attributionControl: false,
            dragging: false,
            touchZoom: false,
            scrollWheelZoom: false,
            doubleClickZoom: false,
            boxZoom: false
          }).setView(center, 16);
          
          L.tileLayer('http://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
            subdomains: ['1', '2', '3', '4'],
            minZoom: 1,
            maxZoom: 19
          }).addTo(map);
          
          const icon = L.divIcon({
            className: 'custom-marker',
            html: '<div style="font-size: 30px;">📍</div>',
            iconSize: [30, 30],
            iconAnchor: [15, 30]
          });
          marker = L.marker(center, {icon: icon}).addTo(map);
        } else {
          map.setView(center, 16);
          marker.setLatLng(center);
        }
        if (map) {
          map.invalidateSize();
        }
      }

      function hideMap() {
        const container = document.getElementById('mapContainer');
        if (container) container.style.display = 'none';
      }

      function addTag(text) { document.getElementById('msgInput').value = text; }
      function handleLocationToggle(event) {
        if (event.target.checked) {
          requestLocation();
        } else {
          disableLocationSharing();
          showModal('locationTipModal');
        }
      }
      function disableLocationSharing() {
        userLocation = null;
        const icon = document.getElementById('locIcon');
        const txt = document.getElementById('locStatus');
        icon.className = 'loc-icon disabled';
        txt.className = 'loc-status disabled';
        txt.innerText = '已关闭位置共享，将在延迟后发送挪车信息';
        hideMap();
      }
      async function sendMeowLocal(request) {
        if (!request || !request.url) {
          throw new Error('MeoW 本地请求缺少目标地址');
        }
        const res = await fetch(request.url, {
          method: 'POST',
          headers: request.headers || { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(request.body || {})
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error('MeoW 本地发送失败 (' + res.status + '): ' + text + ' ');
        }
        return res;
      }
      function startDelayCountdown() {
        showModal('delayModal');
        countdownVal = 30;
        lastCountdownVal = null;
        updateDelayMsg();
        delayTimer = setInterval(() => {
          countdownVal--;
          updateDelayMsg();
          if (countdownVal <= 0) {
             clearInterval(delayTimer);
             hideModal('delayModal');
             doSendNotify(null);
          }
        }, 1000);
      }

      function updateDelayMsg() {
         const el = document.getElementById('countdownNum');
         if (!el) return;
         const current = countdownVal.toString().padStart(2, '0');
         if (lastCountdownVal === null) {
           lastCountdownVal = countdownVal;
         }
         const prev = lastCountdownVal.toString().padStart(2, '0');

         const topStatic = el.querySelector('.flip-top.flip-static .flip-text');
         const bottomStatic = el.querySelector('.flip-bottom.flip-static .flip-text');
         const topAnim = el.querySelector('.flip-top.flip-anim .flip-text');
         const bottomAnim = el.querySelector('.flip-bottom.flip-anim .flip-text');

         if (!topStatic || !bottomStatic || !topAnim || !bottomAnim) {
           el.innerText = current;
           return;
         }

         topStatic.textContent = current;
         bottomStatic.textContent = current;
         topAnim.textContent = prev;
         bottomAnim.textContent = current;

         el.classList.remove('flip');
         void el.offsetWidth;
         el.classList.add('flip');
         lastCountdownVal = countdownVal;
      }

      function cancelDelay() {
        clearInterval(delayTimer);
        hideModal('delayModal');
      }

      function sendNotify() {
        if (currentSessionId && (currentSessionStatus === 'active' || currentSessionStatus === 'arriving')) {
          showToast('已有进行中的会话，已为你打开');
          resumeSession();
          return;
        }
        const shareLocation = document.getElementById('shareLocationToggle').checked;
        const locationToSend = shareLocation ? userLocation : null;
        
        if (locationToSend) {
          doSendNotify(locationToSend);
        } else {
          startDelayCountdown();
        }
      }

      async function doSendNotify(locationToSend) {
        const btn = document.getElementById('notifyBtn');
        const msg = document.getElementById('msgInput').value;
        const delayed = false; // Client side delay already handled
        
        btn.disabled = true;
        btn.innerHTML = '<span>🚀</span><span>发送中...</span>';
        try {
          const res = await fetch(API_BASE + '/notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg, location: locationToSend, delayed: delayed })
          });
          const data = await res.json();
          if (res.ok && data.success) {
            if (delayed) showToast('⏳ 通知将延迟30秒发送'); // Should basically never happen with forced false
            else showToast('✅ 发送成功！');
            if (data.localMeowRequest) {
              sendMeowLocal(data.localMeowRequest).catch((err) => {
                console.error(err);
                showToast('⚠️ MeoW 本地发送失败，请重试');
              });
            }
            const mainView = document.getElementById('mainView');
            if (mainView) mainView.style.display = 'none';
            const successView = document.getElementById('successView');
            if (successView) successView.style.display = 'flex';
            if (data.sessionId) {
              applySessionInfo({ sessionId: data.sessionId, sessionStatus: 'active', sessionCompletedAt: null });
              history.replaceState(null, '', '/' + data.sessionId);
            }
            ownerConfirmed = false;
            retryCooldownSeconds = 30;
            callCooldownSeconds = 30;
            startRetryCooldown(retryCooldownSeconds);
            disablePhoneUntilRetry();
            updateActionHint();
            startPolling();
          } else {
            // 显示后端返回的具体错误信息
            throw new Error(data.error || 'API Error');
          }
        } catch (e) {
          console.error(e);
          showToast('❌ 错误: ' + e.message);
          btn.disabled = false;
          btn.innerHTML = '<span>🔔</span><span>一键通知车主</span>';
        }
      }
      document.addEventListener('contextmenu', (e) => e.preventDefault());

      function startPolling() {
        let count = 0;
        checkTimer = setInterval(async () => {
          count++;
          if (count > 120) { clearInterval(checkTimer); return; }
          try {
            const res = await fetch(API_BASE + '/check-status');
            const data = await res.json();
            handleStatusResponse(data);
            if (data.status === 'arriving') {
              if (!ownerConfirmed) {
                ownerConfirmed = true;
                retryCooldownSeconds = 60;
                callCooldownSeconds = 180;
                updateActionHint();
              }
              if(navigator.vibrate) navigator.vibrate([200, 100, 200]);
            } else if (data.status === 'closed') {
              clearInterval(checkTimer);
            }
          } catch(e) {}
        }, 3000);
      }
      function showToast(text) {
        const t = document.getElementById('toast');
        t.innerText = text;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 3000);
      }
      async function retryNotify() {
        const btn = document.getElementById('retryBtn');
        if (Date.now() < retryReadyAt) {
          showToast('⏳ 请等待倒计时结束再提醒');
          return;
        }
        let success = false;
        btn.disabled = true;
        btn.innerHTML = '<span>🚀</span><span>发送中...</span>';
        try {
          const res = await fetch(API_BASE + '/notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: '再次通知：请尽快挪车', location: userLocation, sessionId: currentSessionId })
          });
          const data = await res.json();
          if (res.ok && data.success) {
            if (data.localMeowRequest) {
              sendMeowLocal(data.localMeowRequest).catch((err) => {
                console.error(err);
                showToast('⚠️ MeoW 本地发送失败，请重试');
              });
            }
            showToast('✅ 再次通知已发送！');
            document.getElementById('waitingText').innerText = '已再次通知，等待车主回应...';
            startRetryCooldown(retryCooldownSeconds);
            startPhoneCooldown(callCooldownSeconds);
            success = true;
          } else { throw new Error('API Error'); }
        } catch (e) { showToast('❌ 发送失败，请重试'); }
        if (!success) {
          btn.disabled = false;
          btn.innerHTML = '<span>🔔</span><span>再次通知</span>';
        }
      }

// Spotlight tracking effect
    (function () {
      const buttons = Array.from(document.querySelectorAll('.spot-btn'));
      if (!buttons.length) return;
      const isCoarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      const isFine = window.matchMedia && window.matchMedia('(pointer: fine)').matches;
      const MAX_DIST = 110;
      const SOURCE_RADIUS = 300;
      let lastX = -10000;
      let lastY = -10000;
      let sourceX = -10000;
      let sourceY = -10000;
      let sourceIntensity = 0;
      let targetSourceIntensity = 0;
      let rafId = 0;
      let pointerRaf = 0;
      let pointerActive = false;

      const shouldUpdate = () => {
        if (document.hidden) return false;
        if (document.body.classList.contains('anim-paused')) return false;
        if (isCoarse && !pointerActive && sourceIntensity === 0 && targetSourceIntensity === 0) return false;
        return true;
      };

      const resetSpot = (btn) => {
        btn.style.setProperty('--bx', '-1000px');
        btn.style.setProperty('--by', '-1000px');
        btn.style.setProperty('--sx', '-1000px');
        btn.style.setProperty('--sy', '-1000px');
        btn.style.setProperty('--si', '0');
        btn.style.setProperty('--border-alpha', '0');
      };

      const setSpot = (btn, x, y, strength) => {
        const rect = btn.getBoundingClientRect();
        const bx = x - rect.left;
        const by = y - rect.top;
        const si = Math.max(0, Math.min(1, strength));
        btn.style.setProperty('--bx', bx + 'px');
        btn.style.setProperty('--by', by + 'px');
        btn.style.setProperty('--border-alpha', (0.04 + 0.22 * si).toFixed(3));
      };

      const updateAll = (x, y) => {
        const currentSource = sourceIntensity;
        buttons.forEach((btn) => {
          const rect = btn.getBoundingClientRect();
          const dx = Math.max(rect.left - x, 0, x - rect.right);
          const dy = Math.max(rect.top - y, 0, y - rect.bottom);
          const dist = Math.hypot(dx, dy);
          let borderAlpha = 0;

          if (dist <= MAX_DIST) {
            const strength = 1 - dist / MAX_DIST;
            setSpot(btn, x, y, strength);
            borderAlpha = Math.max(borderAlpha, 0.04 + 0.22 * strength);
          } else {
            resetSpot(btn);
          }

          if (currentSource > 0) {
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const sdist = Math.hypot(cx - sourceX, cy - sourceY);
            const sStrength = Math.max(0, 1 - sdist / SOURCE_RADIUS) * currentSource;
            const sBoost = Math.min(1, sStrength * 1.25);
            if (sBoost > 0) {
              btn.style.setProperty('--sx', (sourceX - rect.left) + 'px');
              btn.style.setProperty('--sy', (sourceY - rect.top) + 'px');
              btn.style.setProperty('--si', sBoost.toFixed(3));
              borderAlpha = Math.max(borderAlpha, 0.08 + 0.28 * sBoost);
            } else {
              btn.style.setProperty('--sx', '-1000px');
              btn.style.setProperty('--sy', '-1000px');
              btn.style.setProperty('--si', '0');
            }
          } else {
            btn.style.setProperty('--sx', '-1000px');
            btn.style.setProperty('--sy', '-1000px');
            btn.style.setProperty('--si', '0');
          }
          btn.style.setProperty('--border-alpha', borderAlpha.toFixed(3));
        });
      };

      const scheduleUpdate = () => {
        if (!shouldUpdate()) {
          resetAll();
          return;
        }
        if (pointerRaf) return;
        pointerRaf = requestAnimationFrame(() => {
          pointerRaf = 0;
          if (lastX > -9999) {
            updateAll(lastX, lastY);
          }
        });
      };

      const tick = () => {
        if (!shouldUpdate()) {
          resetAll();
          return;
        }
        sourceIntensity += (targetSourceIntensity - sourceIntensity) * 0.12;
        if (Math.abs(targetSourceIntensity - sourceIntensity) < 0.01) {
          sourceIntensity = targetSourceIntensity;
        }
        if (lastX > -9999) {
          updateAll(lastX, lastY);
        }
        if (Math.abs(targetSourceIntensity - sourceIntensity) >= 0.01) {
          rafId = requestAnimationFrame(tick);
        } else {
          rafId = 0;
        }
      };

      const resetAll = () => {
        buttons.forEach(resetSpot);
        if (pointerRaf) {
          cancelAnimationFrame(pointerRaf);
          pointerRaf = 0;
        }
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
        sourceIntensity = 0;
        targetSourceIntensity = 0;
        sourceX = -10000;
        sourceY = -10000;
        lastX = -10000;
        lastY = -10000;
        pointerActive = false;
      };

      document.addEventListener('pointermove', (e) => {
        lastX = e.clientX;
        lastY = e.clientY;
        if (isCoarse && !pointerActive) return;
        if (isCoarse) {
          sourceX = lastX;
          sourceY = lastY;
          targetSourceIntensity = 1;
          if (!rafId) rafId = requestAnimationFrame(tick);
        }
        scheduleUpdate();
      });

      document.addEventListener('pointerup', () => {
        if (!isCoarse) return;
        pointerActive = false;
        targetSourceIntensity = 0;
        if (!rafId) rafId = requestAnimationFrame(tick);
      });

      document.addEventListener('pointercancel', () => {
        if (!isCoarse) return;
        pointerActive = false;
        targetSourceIntensity = 0;
        if (!rafId) rafId = requestAnimationFrame(tick);
      });

      document.addEventListener('pointerout', (e) => {
        if (!e.relatedTarget) resetAll();
      });

      document.addEventListener('pointerleave', resetAll);
      document.addEventListener('mouseleave', resetAll);

      window.addEventListener('blur', resetAll);
      window.addEventListener('resize', () => {
        if (lastX > -9999) scheduleUpdate();
      });

      buttons.forEach((btn) => {
        resetSpot(btn);
        btn.addEventListener('pointerenter', (e) => {
          if (!isFine) return;
          sourceX = e.clientX;
          sourceY = e.clientY;
          targetSourceIntensity = 1;
          if (!rafId) rafId = requestAnimationFrame(tick);
        });
        btn.addEventListener('pointerleave', () => {
          if (!isFine) return;
          targetSourceIntensity = 0;
          if (!rafId) rafId = requestAnimationFrame(tick);
        });
        btn.addEventListener('pointerdown', (e) => {
          pointerActive = true;
          sourceX = e.clientX;
          sourceY = e.clientY;
          targetSourceIntensity = 1;
          if (!rafId) rafId = requestAnimationFrame(tick);
          btn.dataset.pressStart = String(performance.now());
          const rect = btn.getBoundingClientRect();
          const rx = e.clientX - rect.left;
          const ry = e.clientY - rect.top;
          const size = Math.max(rect.width, rect.height) * 2.2;
          btn.style.setProperty('--rx', rx + 'px');
          btn.style.setProperty('--ry', ry + 'px');
          btn.style.setProperty('--rsize', size + 'px');
          btn.style.setProperty('--ripple-ms', '180ms');
          btn.classList.remove('ripple-on');
          void btn.offsetWidth;
          btn.classList.add('ripple-on');
          if (btn._rippleTimer) clearTimeout(btn._rippleTimer);
        });
        const endRipple = () => {
          const start = Number(btn.dataset.pressStart || 0);
          const elapsed = Math.max(0, performance.now() - start);
          const outMs = Math.min(520, Math.max(160, Math.round(160 + elapsed * 0.45)));
          btn.style.setProperty('--ripple-ms', outMs + 'ms');
          if (btn._rippleTimer) clearTimeout(btn._rippleTimer);
          btn._rippleTimer = setTimeout(() => btn.classList.remove('ripple-on'), outMs);
          if (isCoarse) {
            pointerActive = false;
            targetSourceIntensity = 0;
            if (!rafId) rafId = requestAnimationFrame(tick);
          }
        };
        btn.addEventListener('pointerup', endRipple);
        btn.addEventListener('pointercancel', endRipple);
      });
    })();
  </script>
</body>

</html>
  `;
  const headers = { 'Content-Type': 'text/html;charset=UTF-8' };
  if (sessionPathId) {
    headers['Set-Cookie'] = `mc_session=${sessionPathId}; Max-Age=${SESSION_VIEW_TTL_SECONDS}; Path=/; SameSite=Lax`;
  }
  return new Response(html, { headers });
}

function renderOwnerPage(sessionToken, sessionId, apiBase) {
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">

<head>
  <meta charset="UTF-8">
  <meta name="viewport"
    content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, viewport-fit=cover">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#050505">
  <title>确认挪车</title>
  <style>
    :root {
      --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
      --ease-elastic: cubic-bezier(0.34, 1.56, 0.64, 1);

      --card-max-width: 560px;
      --card-padding: 1.8rem;
      --card-radius: 28px;

      --text-glow: 0 1px 3px rgba(0, 0, 0, 0.35);

      --bg-base: #0a0a0c;
      --glass-surface: rgba(20, 20, 24, 0.65);
      --glass-border: rgba(255, 255, 255, 0.06);
      --glass-glow: rgba(255, 255, 255, 0.08);
      --glass-blur: 12px;
      --glass-edge-size: 1.5px;
      --card-shadow: 0 20px 50px -15px rgba(0, 0, 0, 0.35);

      --btn-spotlight-size: 120px;
      --btn-source-size: 280px;
      --btn-source-rgb: 255, 255, 255;
      --btn-border-rgb: 255, 255, 255;
      --btn-hover-glow: rgba(255, 255, 255, 0.12);

      --text-primary: #ffffff;
      --text-secondary: rgba(255, 255, 255, 0.65);

      --btn-bg: rgba(255, 255, 255, 0.06);
      --btn-base-border: rgba(255, 255, 255, 0.08);
      --btn-hover-bg: #ffffff;
      --btn-hover-text: #000000;
      --btn-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);

      --toggle-bg: rgba(255, 255, 255, 0.12);
      --toggle-border: rgba(255, 255, 255, 0.18);
      --toggle-checked-bg: #22c55e;
      --toggle-checked-border: #16a34a;
      --toggle-knob: #ffffff;

      --fluid-1: rgba(139, 92, 246, 0.35);
      --fluid-2: rgba(236, 72, 153, 0.32);
      --fluid-3: rgba(59, 130, 246, 0.30);
      --fluid-4: rgba(251, 146, 60, 0.28);
      --fluid-5: rgba(168, 85, 247, 0.26);
      --fluid-6: rgba(14, 165, 233, 0.24);
      --fluid-base-1: #0a0a14;
      --fluid-base-2: #1a0a28;
      --fluid-base-3: #0a1428;
    }

    @media (prefers-color-scheme: light) {
      :root {
        --bg-base: #f0f4ff;
        --glass-surface: rgba(255, 255, 255, 0.45);
        --glass-border: rgba(0, 0, 0, 0.08);
        --glass-glow: rgba(255, 255, 255, 0.5);
        --glass-blur: 10px;
        --card-shadow: 0 12px 30px -10px rgba(0, 0, 0, 0.12);

        --btn-source-rgb: 60, 60, 70;
        --btn-border-rgb: 80, 90, 110;
        --btn-hover-glow: rgba(0, 0, 0, 0.04);

        --text-primary: #0f172a;
        --text-secondary: #475569;
        --text-glow: 0 1px 2px rgba(0, 0, 0, 0.15);

        --btn-bg: rgba(255, 255, 255, 0.65);
        --btn-base-border: rgba(0, 0, 0, 0.1);
        --btn-hover-bg: #18181b;
        --btn-hover-text: #ffffff;
        --btn-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);

        --toggle-bg: rgba(15, 23, 42, 0.1);
        --toggle-border: rgba(15, 23, 42, 0.2);

        --fluid-1: rgba(217, 70, 239, 0.45);
        --fluid-2: rgba(59, 130, 246, 0.40);
        --fluid-3: rgba(251, 191, 36, 0.48);
        --fluid-4: rgba(236, 72, 153, 0.42);
        --fluid-5: rgba(139, 92, 246, 0.38);
        --fluid-6: rgba(34, 197, 94, 0.35);
        --fluid-base-1: #f8f0ff;
        --fluid-base-2: #fff0f8;
        --fluid-base-3: #fff7ed;
      }
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
      -webkit-font-smoothing: antialiased;
      -webkit-tap-highlight-color: transparent;
      -webkit-user-select: none;
      user-select: none;
    }

    body {
      font-family: -apple-system, system-ui, "Segoe UI", sans-serif;
      min-height: 100vh;
      background: linear-gradient(160deg, var(--bg-base) 0%, #0f0f12 100%);
      color: var(--text-primary);
      text-shadow: var(--text-glow);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: clamp(16px, 4vw, 24px);
      padding-top: calc(clamp(16px, 4vw, 24px) + env(safe-area-inset-top, 0px));
      padding-bottom: calc(clamp(16px, 4vw, 24px) + env(safe-area-inset-bottom, 0px));
      overflow-x: hidden;
    }

    @media (prefers-color-scheme: light) {
      body {
        background: linear-gradient(160deg, var(--bg-base) 0%, #d4dae6 100%);
      }
    }

    /* Fluid Background */
    .bg-fluid {
      position: fixed;
      inset: -25%;
      z-index: -10;
      background:
        radial-gradient(40% 50% at 15% 20%, var(--fluid-1), transparent 70%),
        radial-gradient(45% 55% at 85% 15%, var(--fluid-2), transparent 70%),
        radial-gradient(50% 60% at 35% 85%, var(--fluid-3), transparent 70%),
        radial-gradient(40% 50% at 80% 80%, var(--fluid-4), transparent 70%),
        linear-gradient(120deg, var(--fluid-base-1) 0%, var(--fluid-base-2) 50%, var(--fluid-base-3) 100%);
      opacity: 1;
      animation: fluid-drift 28s ease-in-out infinite alternate;
      pointer-events: none;
      filter: saturate(1.15) brightness(1.05);
    }

    .bg-fluid::before,
    .bg-fluid::after {
      content: "";
      position: absolute;
      inset: -30%;
      pointer-events: none;
      mix-blend-mode: screen;
    }

    .bg-fluid::before {
      background:
        radial-gradient(55% 60% at 20% 30%, var(--fluid-5), transparent 70%),
        radial-gradient(60% 65% at 75% 65%, var(--fluid-6), transparent 72%),
        radial-gradient(45% 55% at 60% 15%, rgba(255, 255, 255, 0.08), transparent 70%);
      opacity: 0.85;
      filter: blur(2px);
      animation: fluid-float 30s ease-in-out infinite;
    }

    .bg-fluid::after {
      background:
        radial-gradient(60% 70% at 30% 75%, rgba(139, 92, 246, 0.20), transparent 70%),
        radial-gradient(50% 60% at 70% 35%, rgba(236, 72, 153, 0.18), transparent 70%),
        radial-gradient(55% 65% at 50% 50%, rgba(255, 255, 255, 0.06), transparent 75%);
      opacity: 0.7;
      filter: blur(6px);
      animation: fluid-sway 36s ease-in-out infinite alternate;
    }

    .bg-noise {
      position: fixed;
      inset: 0;
      z-index: -5;
      background:
        repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.03) 0, rgba(255, 255, 255, 0.03) 1px, transparent 1px, transparent 2px),
        repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.02) 0, rgba(255, 255, 255, 0.02) 1px, transparent 1px, transparent 3px);
      opacity: 0.12;
      pointer-events: none;
      mix-blend-mode: soft-light;
    }

    @keyframes fluid-drift {
      0% {
        transform: translate3d(0, 0, 0) scale(1);
      }

      50% {
        transform: translate3d(-3%, 2.5%, 0) scale(1.08);
      }

      100% {
        transform: translate3d(3%, -2%, 0) scale(1.05);
      }
    }

    @keyframes fluid-float {
      0% {
        transform: translate3d(0, 0, 0) scale(1);
      }

      50% {
        transform: translate3d(4%, -3%, 0) scale(1.10);
      }

      100% {
        transform: translate3d(-3%, 2%, 0) scale(1.06);
      }
    }

    @keyframes fluid-sway {
      0% {
        transform: translate3d(0, 0, 0) scale(1);
      }

      50% {
        transform: translate3d(-4%, 3.5%, 0) scale(1.09);
      }

      100% {
        transform: translate3d(3%, -2.5%, 0) scale(1.05);
      }
    }

    @keyframes fluid-shift {
      0% {
        background-position: 0% 0%, 100% 0%, 30% 100%, 80% 80%, 50% 50%;
      }

      50% {
        background-position: 10% 5%, 90% 10%, 20% 90%, 75% 70%, 45% 55%;
      }

      100% {
        background-position: 0% 0%, 100% 0%, 30% 100%, 80% 80%, 50% 50%;
      }
    }

    .anim-paused .bg-fluid,
    .anim-paused .bg-fluid::before,
    .anim-paused .bg-fluid::after {
      animation-play-state: paused;
    }

    @media (prefers-reduced-motion: reduce), (hover: none), (pointer: coarse) {
      .bg-fluid,
      .bg-fluid::before,
      .bg-fluid::after {
        animation: none !important;
        filter: none !important;
      }

      .bg-noise {
        opacity: 0.05;
      }
    }

    .low-power .bg-fluid,
    .low-power .bg-fluid::before,
    .low-power .bg-fluid::after {
      animation: none !important;
      filter: none !important;
    }

    .low-power .bg-fluid::before,
    .low-power .bg-fluid::after {
      display: none;
    }

    .low-power .bg-noise {
      opacity: 0.04;
    }

    .low-power .card,
    .low-power .spot-btn {
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }

    /* Glass Card */
    .card {
      background: var(--glass-surface);
      backdrop-filter: blur(var(--glass-blur)) saturate(1.25) brightness(1.03);
      -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(1.25) brightness(1.03);
      border: 1px solid var(--glass-border);
      border-radius: var(--card-radius);
      padding: clamp(24px, 6vw, 36px);
      text-align: center;
      width: 100%;
      max-width: var(--card-max-width);
      box-shadow:
        var(--card-shadow),
        inset 0 0 0 0.5px var(--glass-glow);
      position: relative;
      overflow: hidden;
      isolation: isolate;
    }

    /* Card edge highlight */
    .card::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      padding: var(--glass-edge-size);
      background: linear-gradient(180deg,
          rgba(255, 255, 255, 0.12) 0%,
          rgba(255, 255, 255, 0) 50%,
          rgba(255, 255, 255, 0.04) 100%);
      mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      mask-composite: exclude;
      -webkit-mask-composite: xor;
      pointer-events: none;
      z-index: 0;
    }

    .emoji {
      font-size: clamp(52px, 13vw, 72px);
      margin-bottom: clamp(16px, 4vw, 24px);
      display: block;
    }

    h1 {
      font-size: clamp(22px, 5.5vw, 28px);
      color: var(--text-primary);
      margin-bottom: 8px;
      font-weight: 700;
    }

    .subtitle {
      color: var(--text-secondary);
      font-size: clamp(14px, 3.5vw, 16px);
      margin-bottom: clamp(20px, 5vw, 28px);
      line-height: 1.5;
    }

    .owner-input {
      margin-bottom: 18px;
    }

    .input-card {
      padding: 0;
    }

    .input-card textarea {
      width: 100%;
      min-height: 90px;
      padding: 14px 16px;
      border: none;
      background: transparent;
      color: var(--text-primary);
      font-size: 14px;
      font-family: inherit;
      resize: none;
      outline: none;
    }

    .input-card textarea::placeholder {
      color: var(--text-secondary);
      opacity: 0.7;
    }

    .tags {
      display: flex;
      gap: 8px;
      padding: 0 12px 14px 12px;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
    }

    .tags::-webkit-scrollbar {
      display: none;
    }

    .tag {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-primary);
      padding: 8px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      cursor: pointer;
      border: 1px solid rgba(255, 255, 255, 0.08);
      min-height: 36px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .owner-input .tags {
      flex-wrap: wrap;
      overflow-x: hidden;
      gap: 8px 8px;
    }

    /* Map section */
    .map-section {
      background: rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 16px;
      margin-bottom: 20px;
      display: none;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }

    .map-section.show {
      display: block;
    }

    .map-section p {
      font-size: 12px;
      color: var(--text-secondary);
      margin-bottom: 12px;
      font-weight: 600;
    }

    .map-links {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }

    .map-btn {
      flex: 1;
      min-width: 110px;
      padding: 12px 16px;
      border-radius: 14px;
      text-decoration: none;
      font-weight: 600;
      font-size: 13px;
      text-align: center;
      color: var(--text-primary);
      border: 1px solid rgba(255, 255, 255, 0.1);
      transition: transform 0.2s ease;
    }

    .map-btn:active {
      transform: scale(0.96);
    }

    /* Toggle */
    .loc-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 20px;
      padding: 0 10px;
    }

    .loc-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      line-height: 1.2;
    }

    .toggle {
      position: relative;
      display: inline-flex;
      align-items: center;
      width: 54px;
      height: 32px;
      flex-shrink: 0;
    }

    .toggle input {
      opacity: 0;
      width: 0;
      height: 0;
    }

    .toggle-slider {
      position: absolute;
      cursor: pointer;
      inset: 0;
      background: var(--toggle-bg);
      border-radius: 999px;
      transition: background 0.25s, border 0.25s;
      border: 1px solid var(--toggle-border);
    }

    .toggle-slider::before {
      content: "";
      position: absolute;
      height: 24px;
      width: 24px;
      left: 4px;
      top: 50%;
      background: var(--toggle-knob);
      border-radius: 50%;
      transform: translateY(-50%);
      transition: transform 0.25s var(--ease-elastic);
      box-shadow: 0 4px 10px rgba(0, 0, 0, 0.2);
    }

    .toggle input:checked+.toggle-slider {
      background: var(--toggle-checked-bg);
      border-color: var(--toggle-checked-border);
    }

    .toggle input:checked+.toggle-slider::before {
      transform: translate(22px, -50%);
    }

    /* Buttons */
    .btn {
      position: relative;
      color: var(--text-primary);
      width: 100%;
      padding: 16px 0;
      border-radius: var(--card-radius);
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: transform 0.3s var(--ease-out-expo);
    }

    .btn:active {
      transform: scale(0.98);
    }

    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .btn-ghost {
      width: 100%;
      padding: 12px 0;
      border-radius: 14px;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 14px;
      color: var(--text-secondary);
    }

    .clear-msg {
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 8px;
      min-height: 16px;
    }

    .session-info {
      font-size: 13px;
      color: var(--text-secondary);
      margin-bottom: 10px;
      display: none;
    }

    .session-info strong {
      color: var(--text-primary);
      font-weight: 700;
      letter-spacing: 0.5px;
    }

    /* Spot Button - with spotlight border effect */
    .spot-btn {
      --bx: -1000px;
      --by: -1000px;
      --sx: -1000px;
      --sy: -1000px;
      --si: 0;
      --border-alpha: 0.06;
      --rx: 50%;
      --ry: 50%;
      position: relative;
      overflow: hidden;
      isolation: isolate;
      background:
        radial-gradient(var(--btn-spotlight-size) circle at var(--bx) var(--by), var(--btn-hover-glow), transparent 100%),
        var(--glass-surface);
      backdrop-filter: blur(var(--glass-blur)) saturate(1.25) brightness(1.03);
      -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(1.25) brightness(1.03);
      border: 1px solid var(--glass-border);
      box-shadow:
        var(--btn-shadow),
        inset 0 0 0 0.5px var(--glass-glow);
      transition: transform 0.3s var(--ease-out-expo);
    }

    .spot-btn>span {
      position: relative;
      z-index: 5;
    }

    /* Spotlight border - using mask technique */
    .spot-btn::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      padding: 1px;
      background:
        radial-gradient(var(--btn-spotlight-size) circle at var(--bx) var(--by), rgba(var(--btn-border-rgb), 0.85), transparent 100%),
        radial-gradient(var(--btn-source-size) circle at var(--sx) var(--sy), rgba(var(--btn-source-rgb), calc(0.9 * var(--si))), transparent 80%),
        linear-gradient(rgba(var(--btn-border-rgb), var(--border-alpha)), rgba(var(--btn-border-rgb), var(--border-alpha)));
      mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      mask-composite: exclude;
      -webkit-mask-composite: xor;
      pointer-events: none;
      z-index: 2;
    }

    /* Ripple effect */
    .spot-btn::after {
      content: "";
      position: absolute;
      width: var(--rsize, 320px);
      height: var(--rsize, 320px);
      border-radius: 50%;
      left: var(--rx);
      top: var(--ry);
      transform: translate(-50%, -50%) scale(0);
      opacity: 0;
      pointer-events: none;
      z-index: 1;
      background: var(--btn-hover-bg);
      transition: transform var(--ripple-ms, 280ms) var(--ease-out-expo), opacity var(--ripple-ms, 280ms) ease;
    }

    .spot-btn.ripple-on::after {
      transform: translate(-50%, -50%) scale(1);
      opacity: 1;
    }

    .spot-btn.ripple-on>span {
      color: var(--btn-hover-text);
    }

    /* Done message */
    .done-msg {
      background: rgba(66, 200, 140, 0.18);
      border-radius: 16px;
      padding: 16px 20px;
      margin-top: 18px;
      display: none;
      border: 1px solid rgba(66, 200, 140, 0.25);
    }

    .done-msg.show {
      display: block;
    }

    .done-msg p {
      color: #bbf7d0;
      font-weight: 600;
      font-size: 15px;
    }

    @media (max-width: 768px) {
      :root {
        --card-padding: 1.4rem;
        --card-radius: 24px;
        --glass-edge-size: 1px;
      }

      .card {
        max-width: 92vw;
      }
    }
  </style>
</head>

<body>
  <div class="bg-fluid" aria-hidden="true"></div>
  <div class="bg-noise" aria-hidden="true"></div>

  <div class="card">
    <span class="emoji">👋</span>
    <h1>收到挪车请求</h1>
    <p class="subtitle">对方正在等待，请尽快确认</p>
    <div class="card input-card owner-input">
      <textarea id="ownerMsgInput" placeholder="给对方留言...（可选）"></textarea>
      <div class="tags">
        <div class="tag spot-btn" onclick="addOwnerTag('我已出发')"><span>🚗 已出发</span></div>
        <div class="tag spot-btn" onclick="addOwnerTag('马上到')"><span>⏱️ 马上到</span></div>
        <div class="tag spot-btn" onclick="addOwnerTag('请稍等')"><span>🙏 请稍等</span></div>
        <div class="tag spot-btn" onclick="addOwnerTag('已在路上')"><span>🛣️ 在路上</span></div>
      </div>
    </div>
    <div id="mapArea" class="map-section">
      <p>📍 对方位置</p>
      <div class="map-links">
        <a id="amapLink" href="#" class="map-btn amap spot-btn"><span>🗺️ 高德地图</span></a>
        <a id="appleLink" href="#" class="map-btn apple spot-btn"><span>🍎 Apple Maps</span></a>
      </div>
    </div>

    <div class="loc-row">
      <div class="loc-title">向对方发送我的位置</div>
      <label class="toggle">
        <input id="shareLocationToggle" type="checkbox" checked>
        <span class="toggle-slider"></span>
      </label>
    </div>

    <div id="sessionInfo" class="session-info">
      来自 <strong id="sessionCode">#------</strong> 的挪车会话
    </div>

    <button id="endSessionBtn" class="btn-ghost spot-btn" onclick="terminateSession()" style="display:none;">
      <span>终止会话</span>
    </button>

    <button id="clearLocBtn" class="btn-ghost spot-btn" onclick="clearOwnerLocation()">
      <span>清除我的位置</span>
    </button>
    <div id="clearMsg" class="clear-msg"></div>

    <button id="confirmBtn" class="btn spot-btn" onclick="confirmMove()">
      <span>🚀</span>
      <span>我已知晓，正在前往</span>
    </button>
    <div id="doneMsg" class="done-msg">
      <p>✅ 已通知对方您正在赶来！</p>
    </div>
  </div>
  <script>
const API_BASE = '${apiBase}';
const SESSION_TOKEN = '${sessionToken}';
const SESSION_ID = '${sessionId}';
let ownerLocation = null;
      window.onload = async () => {
        try {
          const sessionInfo = document.getElementById('sessionInfo');
          const sessionCode = document.getElementById('sessionCode');
          const endBtn = document.getElementById('endSessionBtn');
          if (sessionCode) sessionCode.innerText = '#' + SESSION_ID;
          if (sessionInfo) sessionInfo.style.display = 'block';
          if (endBtn) endBtn.style.display = 'block';

          const res = await fetch(API_BASE + '/get-location?session=' + encodeURIComponent(SESSION_TOKEN));
          if(res.ok) {
            const data = await res.json();
            if(data.amapUrl) {
              document.getElementById('mapArea').classList.add('show');
              document.getElementById('amapLink').href = data.amapUrl;
              document.getElementById('appleLink').href = data.appleUrl;
            }
          }
          await fetch(API_BASE + '/get-session?role=owner&session=' + encodeURIComponent(SESSION_TOKEN));
        } catch(e) {}
      }
      let idleKick = null;
      function setupPowerMode() {
        const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const saveData = navigator.connection && navigator.connection.saveData;
        const lowMem = navigator.deviceMemory && navigator.deviceMemory <= 4;
        const lowPower = !!(prefersReduced || saveData || lowMem);
        document.body.classList.toggle('low-power', lowPower);
      }
      function setupIdlePause() {
        const IDLE_MS = 4500;
        let timer = 0;
        const kick = () => {
          if (!document.hidden) {
            document.body.classList.remove('anim-paused');
          }
          if (timer) clearTimeout(timer);
          if (!document.hidden) {
            timer = setTimeout(() => {
              if (!document.hidden) document.body.classList.add('anim-paused');
            }, IDLE_MS);
          }
        };
        idleKick = kick;
        ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach((evt) => {
          window.addEventListener(evt, kick, { passive: true });
        });
        kick();
      }
      setupPowerMode();
      setupIdlePause();
      if (window.matchMedia) {
        const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        if (motionQuery.addEventListener) motionQuery.addEventListener('change', setupPowerMode);
        else if (motionQuery.addListener) motionQuery.addListener(setupPowerMode);
      }
      if (navigator.connection && navigator.connection.addEventListener) {
        navigator.connection.addEventListener('change', setupPowerMode);
      }
      document.addEventListener('visibilitychange', () => {
        document.body.classList.toggle('anim-paused', document.hidden);
        if (!document.hidden && idleKick) idleKick();
      });
      document.addEventListener('contextmenu', (e) => e.preventDefault());

      function addOwnerTag(text) {
        const input = document.getElementById('ownerMsgInput');
        if (input) input.value = text;
      }
      function getOwnerMessage() {
        const input = document.getElementById('ownerMsgInput');
        if (!input) return '';
        return input.value.trim().slice(0, 120);
      }
      async function confirmMove() {
        const btn = document.getElementById('confirmBtn');
        const shareLocation = document.getElementById('shareLocationToggle').checked;
        const ownerMessage = getOwnerMessage();
        
        btn.disabled = true;
        
        if (shareLocation) {
             btn.innerHTML = '<span>📍</span><span>获取位置中...</span>';
             if ('geolocation' in navigator) {
               navigator.geolocation.getCurrentPosition(
                 async (pos) => { ownerLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude }; await doConfirm(ownerMessage); },
                 async (err) => { ownerLocation = null; await doConfirm(ownerMessage); },
                 { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
               );
             } else { ownerLocation = null; await doConfirm(ownerMessage); }
        } else {
            ownerLocation = null;
            await doConfirm(ownerMessage);
        }
      }
      async function clearOwnerLocation() {
        const msg = document.getElementById('clearMsg');
        try {
          const res = await fetch(API_BASE + '/clear-owner-location?session=' + encodeURIComponent(SESSION_TOKEN), { method: 'POST' });
          if (!res.ok) throw new Error('CLEAR_FAILED');
          if (msg) msg.innerText = '已清除位置';
        } catch (e) {
          if (msg) msg.innerText = '清除失败，请重试';
        }
        if (msg) {
          setTimeout(() => { msg.innerText = ''; }, 2000);
        }
      }
      async function terminateSession() {
        const msg = document.getElementById('clearMsg');
        try {
          const res = await fetch(API_BASE + '/terminate-session?session=' + encodeURIComponent(SESSION_TOKEN), { method: 'POST' });
          if (!res.ok) throw new Error('TERMINATE_FAILED');
          if (msg) msg.innerText = '会话已终止';
          const endBtn = document.getElementById('endSessionBtn');
          if (endBtn) endBtn.style.display = 'none';
        } catch (e) {
          if (msg) msg.innerText = '终止失败，请重试';
        }
        if (msg) {
          setTimeout(() => { msg.innerText = ''; }, 2000);
        }
      }
      async function doConfirm(ownerMessage) {
        const btn = document.getElementById('confirmBtn');
        btn.innerHTML = '<span>⏳</span><span>确认中...</span>';
        try {
          await fetch(API_BASE + '/owner-confirm?session=' + encodeURIComponent(SESSION_TOKEN), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ location: ownerLocation, message: ownerMessage || '' })
          });
          if (btn) {
              btn.innerHTML = '<span>✅</span><span>已确认</span>';
              btn.style.background = 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)';
          }
          const doneMsg = document.getElementById('doneMsg');
          if (doneMsg) doneMsg.classList.add('show');
        } catch(e) {
          btn.disabled = false;
          btn.innerHTML = '<span>🚀</span><span>我已知晓，正在前往</span>';
        }
      }

// Spotlight tracking effect
    (function () {
      const buttons = Array.from(document.querySelectorAll('.spot-btn'));
      if (!buttons.length) return;
      const isCoarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      const isFine = window.matchMedia && window.matchMedia('(pointer: fine)').matches;
      const MAX_DIST = 110;
      const SOURCE_RADIUS = 300;
      let lastX = -10000;
      let lastY = -10000;
      let sourceX = -10000;
      let sourceY = -10000;
      let sourceIntensity = 0;
      let targetSourceIntensity = 0;
      let rafId = 0;
      let pointerRaf = 0;
      let pointerActive = false;

      const shouldUpdate = () => {
        if (document.hidden) return false;
        if (document.body.classList.contains('anim-paused')) return false;
        if (isCoarse && !pointerActive && sourceIntensity === 0 && targetSourceIntensity === 0) return false;
        return true;
      };

      const resetSpot = (btn) => {
        btn.style.setProperty('--bx', '-1000px');
        btn.style.setProperty('--by', '-1000px');
        btn.style.setProperty('--sx', '-1000px');
        btn.style.setProperty('--sy', '-1000px');
        btn.style.setProperty('--si', '0');
        btn.style.setProperty('--border-alpha', '0');
      };

      const setSpot = (btn, x, y, strength) => {
        const rect = btn.getBoundingClientRect();
        const bx = x - rect.left;
        const by = y - rect.top;
        const si = Math.max(0, Math.min(1, strength));
        btn.style.setProperty('--bx', bx + 'px');
        btn.style.setProperty('--by', by + 'px');
        btn.style.setProperty('--border-alpha', (0.04 + 0.22 * si).toFixed(3));
      };

      const updateAll = (x, y) => {
        const currentSource = sourceIntensity;
        buttons.forEach((btn) => {
          const rect = btn.getBoundingClientRect();
          const dx = Math.max(rect.left - x, 0, x - rect.right);
          const dy = Math.max(rect.top - y, 0, y - rect.bottom);
          const dist = Math.hypot(dx, dy);
          let borderAlpha = 0;

          if (dist <= MAX_DIST) {
            const strength = 1 - dist / MAX_DIST;
            setSpot(btn, x, y, strength);
            borderAlpha = Math.max(borderAlpha, 0.04 + 0.22 * strength);
          } else {
            resetSpot(btn);
          }

          if (currentSource > 0) {
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const sdist = Math.hypot(cx - sourceX, cy - sourceY);
            const sStrength = Math.max(0, 1 - sdist / SOURCE_RADIUS) * currentSource;
            const sBoost = Math.min(1, sStrength * 1.25);
            if (sBoost > 0) {
              btn.style.setProperty('--sx', (sourceX - rect.left) + 'px');
              btn.style.setProperty('--sy', (sourceY - rect.top) + 'px');
              btn.style.setProperty('--si', sBoost.toFixed(3));
              borderAlpha = Math.max(borderAlpha, 0.08 + 0.28 * sBoost);
            } else {
              btn.style.setProperty('--sx', '-1000px');
              btn.style.setProperty('--sy', '-1000px');
              btn.style.setProperty('--si', '0');
            }
          } else {
            btn.style.setProperty('--sx', '-1000px');
            btn.style.setProperty('--sy', '-1000px');
            btn.style.setProperty('--si', '0');
          }
          btn.style.setProperty('--border-alpha', borderAlpha.toFixed(3));
        });
      };

      const scheduleUpdate = () => {
        if (!shouldUpdate()) {
          resetAll();
          return;
        }
        if (pointerRaf) return;
        pointerRaf = requestAnimationFrame(() => {
          pointerRaf = 0;
          if (lastX > -9999) {
            updateAll(lastX, lastY);
          }
        });
      };
      const tick = () => {
        if (!shouldUpdate()) {
          resetAll();
          return;
        }
        sourceIntensity += (targetSourceIntensity - sourceIntensity) * 0.12;
        if (Math.abs(targetSourceIntensity - sourceIntensity) < 0.01) {
          sourceIntensity = targetSourceIntensity;
        }
        if (lastX > -9999) {
          updateAll(lastX, lastY);
        }
        if (Math.abs(targetSourceIntensity - sourceIntensity) >= 0.01) {
          rafId = requestAnimationFrame(tick);
        } else {
          rafId = 0;
        }
      };

      const resetAll = () => {
        buttons.forEach(resetSpot);
        if (pointerRaf) {
          cancelAnimationFrame(pointerRaf);
          pointerRaf = 0;
        }
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
        sourceIntensity = 0;
        targetSourceIntensity = 0;
        sourceX = -10000;
        sourceY = -10000;
        lastX = -10000;
        lastY = -10000;
        pointerActive = false;
      };

      document.addEventListener('pointermove', (e) => {
        lastX = e.clientX;
        lastY = e.clientY;
        if (isCoarse && !pointerActive) return;
        if (isCoarse) {
          sourceX = lastX;
          sourceY = lastY;
          targetSourceIntensity = 1;
          if (!rafId) rafId = requestAnimationFrame(tick);
        }
        scheduleUpdate();
      });

      document.addEventListener('pointerup', () => {
        if (!isCoarse) return;
        pointerActive = false;
        targetSourceIntensity = 0;
        if (!rafId) rafId = requestAnimationFrame(tick);
      });

      document.addEventListener('pointercancel', () => {
        if (!isCoarse) return;
        pointerActive = false;
        targetSourceIntensity = 0;
        if (!rafId) rafId = requestAnimationFrame(tick);
      });

      document.addEventListener('pointerout', (e) => {
        if (!e.relatedTarget) resetAll();
      });

      document.addEventListener('pointerleave', resetAll);
      document.addEventListener('mouseleave', resetAll);

      window.addEventListener('blur', resetAll);
      window.addEventListener('resize', () => {
        if (lastX > -9999) scheduleUpdate();
      });

      buttons.forEach((btn) => {
        resetSpot(btn);
        btn.addEventListener('pointerenter', (e) => {
          if (!isFine) return;
          sourceX = e.clientX;
          sourceY = e.clientY;
          targetSourceIntensity = 1;
          if (!rafId) rafId = requestAnimationFrame(tick);
        });
        btn.addEventListener('pointerleave', () => {
          if (!isFine) return;
          targetSourceIntensity = 0;
          if (!rafId) rafId = requestAnimationFrame(tick);
        });
        btn.addEventListener('pointerdown', (e) => {
          pointerActive = true;
          sourceX = e.clientX;
          sourceY = e.clientY;
          targetSourceIntensity = 1;
          if (!rafId) rafId = requestAnimationFrame(tick);
          btn.dataset.pressStart = String(performance.now());
          const rect = btn.getBoundingClientRect();
          const rx = e.clientX - rect.left;
          const ry = e.clientY - rect.top;
          const size = Math.max(rect.width, rect.height) * 2.2;
          btn.style.setProperty('--rx', rx + 'px');
          btn.style.setProperty('--ry', ry + 'px');
          btn.style.setProperty('--rsize', size + 'px');
          btn.style.setProperty('--ripple-ms', '180ms');
          btn.classList.remove('ripple-on');
          void btn.offsetWidth;
          btn.classList.add('ripple-on');
          if (btn._rippleTimer) clearTimeout(btn._rippleTimer);
        });
        const endRipple = () => {
          const start = Number(btn.dataset.pressStart || 0);
          const elapsed = Math.max(0, performance.now() - start);
          const outMs = Math.min(520, Math.max(160, Math.round(160 + elapsed * 0.45)));
          btn.style.setProperty('--ripple-ms', outMs + 'ms');
          if (btn._rippleTimer) clearTimeout(btn._rippleTimer);
          btn._rippleTimer = setTimeout(() => btn.classList.remove('ripple-on'), outMs);
          if (isCoarse) {
            pointerActive = false;
            targetSourceIntensity = 0;
            if (!rafId) rafId = requestAnimationFrame(tick);
          }
        };
        btn.addEventListener('pointerup', endRipple);
        btn.addEventListener('pointercancel', endRipple);
      });
    })();
  </script>
</body>

</html>
  `;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
