addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

const CONFIG = { KV_TTL: 3600 }
const SESSION_TTL_SECONDS = 1800;
const SESSION_VIEW_TTL_SECONDS = 600;
const MESSAGE_MAX_LENGTH = 120;
const CN_PLATE_PROVINCES = new Set(Array.from('京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领警学港澳'));
const CN_PLATE_REGION_RE = /^[A-HJ-NP-Z]$/;
const CN_PLATE_SUFFIX_RE = /^[A-HJ-NP-Z0-9]{5,6}$/;
const RESPONSE_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin'
};

function normalizePlateValue(value) {
  return String(value || '').trim().toUpperCase().replace(/[\s\-_.·]/g, '');
}

function validateChinaPlateValue(rawPlate) {
  const plate = normalizePlateValue(rawPlate);
  if (plate.length < 7 || plate.length > 8) {
    return { ok: false, code: 'LENGTH' };
  }
  const [province, region, ...tail] = Array.from(plate);
  const suffix = tail.join('');
  if (!CN_PLATE_PROVINCES.has(province)) {
    return { ok: false, code: 'PROVINCE' };
  }
  if (!CN_PLATE_REGION_RE.test(region || '')) {
    return { ok: false, code: 'REGION' };
  }
  if (!CN_PLATE_SUFFIX_RE.test(suffix)) {
    return { ok: false, code: 'SUFFIX' };
  }
  if (!/\d/.test(suffix)) {
    return { ok: false, code: 'DIGIT' };
  }
  return {
    ok: true,
    plate,
    isNewEnergy: suffix.length === 6
  };
}

function getConfiguredPlateRaw() {
  if (typeof CAR_PLATE !== 'undefined' && CAR_PLATE) return String(CAR_PLATE);
  return '';
}

function getConfiguredPlateRule() {
  const raw = getConfiguredPlateRaw();
  if (!raw) return { enabled: false, invalid: false };
  const parsed = validateChinaPlateValue(raw);
  if (!parsed.ok) return { enabled: false, invalid: true, reason: parsed.code };
  return {
    enabled: true,
    invalid: false,
    plate: parsed.plate
  };
}

function withSecurityHeaders(headersLike) {
  const headers = new Headers(headersLike || {});
  for (const [k, v] of Object.entries(RESPONSE_SECURITY_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return headers;
}

function jsonResponse(payload, status = 200, headersLike) {
  const headers = withSecurityHeaders(headersLike);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  if (!headers.has('Pragma')) headers.set('Pragma', 'no-cache');
  return new Response(JSON.stringify(payload), { status, headers });
}

function htmlResponse(html, status = 200, headersLike) {
  const headers = withSecurityHeaders(headersLike);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'text/html;charset=UTF-8');
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  return new Response(html, { status, headers });
}

function buildSessionCookie(sessionId) {
  return `mc_session=${encodeURIComponent(sessionId)}; Max-Age=${SESSION_VIEW_TTL_SECONDS}; Path=/; SameSite=Lax; Secure; HttpOnly`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeUserMessage(value, fallback = '') {
  const clean = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MESSAGE_MAX_LENGTH);
  if (clean) return clean;
  return fallback;
}

function normalizeLocationPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const lat = Number(payload.lat);
  const lng = Number(payload.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return {
    lat: Number(lat.toFixed(7)),
    lng: Number(lng.toFixed(7))
  };
}

function safeJsonParse(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (e) {
    return null;
  }
}

function resolveExternalBaseDomain(origin) {
  const raw = (typeof EXTERNAL_URL !== 'undefined' && EXTERNAL_URL)
    ? String(EXTERNAL_URL).trim()
    : '';
  if (!raw) return origin;
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (parsed.protocol !== 'https:') return origin;
    const safePath = parsed.pathname && parsed.pathname !== '/'
      ? parsed.pathname.replace(/\/+$/, '')
      : '';
    return `${parsed.origin}${safePath}`;
  } catch (e) {
    return origin;
  }
}

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
  const [currentSession, ownerToken] = await Promise.all([
    MOVE_CAR_STATUS.get('session_id'),
    MOVE_CAR_STATUS.get('session_owner_token')
  ]);
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
  const [ownerToken, createdAt] = await Promise.all([
    MOVE_CAR_STATUS.get('session_owner_token'),
    MOVE_CAR_STATUS.get('session_created_at')
  ]);
  const closedAt = Date.now();
  await Promise.all([
    MOVE_CAR_STATUS.put('session_id', sessionId, { expirationTtl: SESSION_VIEW_TTL_SECONDS }),
    MOVE_CAR_STATUS.put('session_status', 'closed', { expirationTtl: SESSION_VIEW_TTL_SECONDS }),
    MOVE_CAR_STATUS.put('session_completed_at', String(closedAt), { expirationTtl: SESSION_VIEW_TTL_SECONDS }),
    MOVE_CAR_STATUS.put('notify_status', 'closed', { expirationTtl: SESSION_VIEW_TTL_SECONDS }),
    MOVE_CAR_STATUS.delete('session_expires_at'),
    MOVE_CAR_STATUS.delete('owner_location'),
    MOVE_CAR_STATUS.delete('owner_message')
  ]);
  await appendSessionHistory({
    sessionId,
    ownerToken,
    createdAt: createdAt ? Number(createdAt) : null,
    closedAt
  });
}

async function autoCloseIfExpired() {
  if (typeof MOVE_CAR_STATUS === 'undefined') return;
  const [sessionStatus, expiresAt] = await Promise.all([
    MOVE_CAR_STATUS.get('session_status'),
    MOVE_CAR_STATUS.get('session_expires_at')
  ]);
  if (sessionStatus !== 'closed' && expiresAt && Date.now() > Number(expiresAt)) {
    await markSessionClosed();
  }
}

async function purgeIfViewExpired() {
  if (typeof MOVE_CAR_STATUS === 'undefined') return false;
  const [sessionStatus, completedAt] = await Promise.all([
    MOVE_CAR_STATUS.get('session_status'),
    MOVE_CAR_STATUS.get('session_completed_at')
  ]);
  if (sessionStatus === 'closed' && completedAt && Date.now() - Number(completedAt) > SESSION_VIEW_TTL_SECONDS * 1000) {
    await Promise.all([
      MOVE_CAR_STATUS.delete('session_id'),
      MOVE_CAR_STATUS.delete('session_status'),
      MOVE_CAR_STATUS.delete('session_completed_at'),
      MOVE_CAR_STATUS.delete('session_owner_token'),
      MOVE_CAR_STATUS.delete('session_created_at'),
      MOVE_CAR_STATUS.delete('owner_location'),
      MOVE_CAR_STATUS.delete('owner_message'),
      MOVE_CAR_STATUS.delete('notify_status')
    ]);
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
    return jsonResponse({ error: 'NOT_FOUND' }, 404);
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
    if (typeof MOVE_CAR_STATUS === 'undefined') {
      throw new Error('KV 数据库未绑定！请在 Cloudflare 后台 Settings -> Bindings 中绑定 MOVE_CAR_STATUS');
    }
    await autoCloseIfExpired();
    const body = await request.json();
    const message = normalizeUserMessage(body.message, '车旁有人等待');
    const configuredPlateRule = getConfiguredPlateRule();
    if (configuredPlateRule.invalid) {
      throw new Error('车牌变量 CAR_PLATE 格式错误，请检查配置');
    }
    let plate = '';
    if (configuredPlateRule.enabled) {
      const plateProof = body.plateProof && typeof body.plateProof === 'object' ? body.plateProof : {};
      const inputPlate = normalizePlateValue(plateProof.plate || '');
      if (inputPlate !== configuredPlateRule.plate) {
        throw new Error('车牌验证失败');
      }
      plate = configuredPlateRule.plate;
    }
    const location = normalizeLocationPayload(body.location);
    const delayed = !!body.delayed;
    const incomingSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : null;

    const [currentSession, currentStatus] = await Promise.all([
      MOVE_CAR_STATUS.get('session_id'),
      MOVE_CAR_STATUS.get('session_status')
    ]);
    let sessionId = null;
    const reuseSession = incomingSessionId && currentSession && incomingSessionId === currentSession && currentStatus !== 'closed';
    const nextSessionStatus = reuseSession && currentStatus === 'arriving' ? 'arriving' : 'active';

    if (reuseSession) {
      sessionId = currentSession;
      await Promise.all([
        MOVE_CAR_STATUS.put('session_id', sessionId, { expirationTtl: SESSION_VIEW_TTL_SECONDS }),
        MOVE_CAR_STATUS.put('session_status', nextSessionStatus, { expirationTtl: SESSION_VIEW_TTL_SECONDS }),
        MOVE_CAR_STATUS.delete('session_completed_at')
      ]);
    } else {
      sessionId = generateSessionId();
      const createdAt = Date.now();
      const ownerToken = formatOwnerToken(sessionId, createdAt);
      await Promise.all([
        MOVE_CAR_STATUS.delete('owner_location'),
        MOVE_CAR_STATUS.delete('owner_message'),
        MOVE_CAR_STATUS.put('session_id', sessionId, { expirationTtl: SESSION_VIEW_TTL_SECONDS }),
        MOVE_CAR_STATUS.put('session_status', 'active', { expirationTtl: SESSION_VIEW_TTL_SECONDS }),
        MOVE_CAR_STATUS.put('session_created_at', String(createdAt), { expirationTtl: SESSION_VIEW_TTL_SECONDS }),
        MOVE_CAR_STATUS.put('session_owner_token', ownerToken, { expirationTtl: SESSION_VIEW_TTL_SECONDS }),
        MOVE_CAR_STATUS.delete('session_completed_at')
      ]);
    }
    await MOVE_CAR_STATUS.put('session_expires_at', String(Date.now() + SESSION_VIEW_TTL_SECONDS * 1000), { expirationTtl: SESSION_VIEW_TTL_SECONDS });

    const baseDomain = resolveExternalBaseDomain(url.origin);

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
    let notifyBody = `💬 留言: ${message}\n⌛️日期：${dateStr}`;
    if (plate) {
      notifyBody = `🚘 车牌: ${plate}\n` + notifyBody;
    }

    if (location) {
      const urls = generateMapUrls(location.lat, location.lng);
      notifyBody += '\n📍 已附带位置信息，点击查看';

      await MOVE_CAR_STATUS.put('requester_location', JSON.stringify({
        lat: location.lat,
        lng: location.lng,
        ...urls
      }), { expirationTtl: CONFIG.KV_TTL });
    } else {
      notifyBody += '\n⚠️ 未提供位置信息';
    }
    const notifyBodyHtml = escapeHtml(notifyBody).replace(/\n/g, '<br>');

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
        const text = await response.text();
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
      const pushPlusContent = notifyBodyHtml + `<br><br><a href="${escapeHtml(confirmUrl)}">👉 点击此处处理挪车请求</a>`;
      notificationTasks.push(
        ensureNotifyOk(fetch('https://www.pushplus.plus/send', {
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

    // 检测 MeoW 变量（固定官方服务地址，仅维护 text 模式）
    if (typeof MEOW_NICKNAME !== 'undefined' && MEOW_NICKNAME) {
      const meowBaseUrl = 'https://api.chuckfang.com';
      const meowLocalSend = isTruthyEnv(typeof MEOW_LOCAL_SEND !== 'undefined' ? MEOW_LOCAL_SEND : null);
      const meowUrl = new URL(`${meowBaseUrl}/${encodeURIComponent(MEOW_NICKNAME)}`);
      meowUrl.searchParams.set('msgType', 'text');
      const meowContent = `${notifyBody}\n\n👉 点击此处处理挪车请求: ${confirmUrl}`;
      const meowRequest = {
        url: meowUrl.toString(),
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: {
          title: '🚗 挪车请求',
          msg: meowContent,
          url: confirmUrl // 某些客户端可能优先读取 body 中的 url
        }
      };

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

    const results = notificationTasks.length ? await Promise.allSettled(notificationTasks) : [];
    const successCount = results.filter((item) => item.status === 'fulfilled').length;
    if (!localMeowRequest && successCount === 0) {
      const firstErr = results.find((item) => item.status === 'rejected');
      const reason = firstErr && firstErr.reason && firstErr.reason.message
        ? firstErr.reason.message
        : 'NOTIFY_FAILED';
      throw new Error(reason);
    }
    const failedServices = results
      .filter((item) => item.status === 'rejected')
      .map((item) => item.reason && item.reason.message ? item.reason.message : 'UNKNOWN');
    if (failedServices.length) {
      console.warn('Notify partial failures:', failedServices.join(' | '));
    }

    const responsePayload = {
      success: true,
      sessionId: sessionId
    };
    if (failedServices.length) responsePayload.partialFailure = true;
    if (localMeowRequest) responsePayload.localMeowRequest = localMeowRequest;
    return jsonResponse(responsePayload, 200, { 'Set-Cookie': buildSessionCookie(sessionId) });

  } catch (error) {
    console.error('Notify Error:', error);
    const publicErrors = [
      'KV 数据库未绑定！请在 Cloudflare 后台 Settings -> Bindings 中绑定 MOVE_CAR_STATUS',
      '未配置通知方式！请在后台设置 BARK_URL、PUSHPLUS_TOKEN 或 MEOW_NICKNAME 变量',
      '车牌变量 CAR_PLATE 格式错误，请检查配置',
      '车牌验证失败'
    ];
    const publicMessage = publicErrors.includes(error.message) ? error.message : 'NOTIFY_FAILED';
    return jsonResponse({ success: false, error: publicMessage }, 500);
  }
}

async function handleGetLocation(request) {
  if (typeof MOVE_CAR_STATUS === 'undefined') return jsonResponse({ error: 'KV_NOT_BOUND' }, 500);
  const sessionId = await resolveSessionFromRequest(request);
  if (!sessionId) {
    return jsonResponse({ error: 'SESSION_INVALID' }, 404);
  }
  const data = await MOVE_CAR_STATUS.get('requester_location');
  if (data) {
    const parsed = safeJsonParse(data);
    if (parsed) return jsonResponse(parsed);
  }
  return jsonResponse({ error: 'No location' }, 404);
}

function handleGetPhone() {
  const phone = typeof PHONE_NUMBER !== 'undefined' ? String(PHONE_NUMBER).trim() : '';
  if (!phone) {
    return jsonResponse({ success: false, error: 'NO_PHONE' }, 404);
  }
  return jsonResponse({ success: true, phone: phone });
}

async function handleGetSession(request) {
  if (typeof MOVE_CAR_STATUS === 'undefined') {
    return jsonResponse({ sessionId: null });
  }
  const url = new URL(request.url);
  const role = url.searchParams.get('role');
  const requestedSession = url.searchParams.get('session');
  await autoCloseIfExpired();
  if (await purgeIfViewExpired()) {
    return jsonResponse({ sessionId: null, sessionStatus: null, sessionCompletedAt: null });
  }
  const [sessionId, sessionStatus, sessionCompletedAt, ownerToken] = await Promise.all([
    MOVE_CAR_STATUS.get('session_id'),
    MOVE_CAR_STATUS.get('session_status'),
    MOVE_CAR_STATUS.get('session_completed_at'),
    MOVE_CAR_STATUS.get('session_owner_token')
  ]);
  const completedAtNum = sessionCompletedAt ? Number(sessionCompletedAt) : null;
  if (role === 'owner') {
    if (!ownerToken || (requestedSession && ownerToken !== requestedSession)) {
      return jsonResponse({ sessionId: null, sessionStatus: null, sessionCompletedAt: null });
    }
  } else {
    const cookieSession = getCookie(request, 'mc_session');
    if (!sessionId || !cookieSession || cookieSession !== sessionId) {
      return jsonResponse({ sessionId: null, sessionStatus: null, sessionCompletedAt: null });
    }
  }
  const safeCompletedAt = sessionStatus === 'closed' ? (completedAtNum || null) : null;
  return jsonResponse({ sessionId: sessionId || null, sessionStatus: sessionStatus || null, sessionCompletedAt: safeCompletedAt });
}

async function handleCheckStatus(request) {
  if (typeof MOVE_CAR_STATUS === 'undefined') {
    return jsonResponse({ status: 'error', error: 'KV_NOT_BOUND' });
  }
  await autoCloseIfExpired();
  if (await purgeIfViewExpired()) {
    return jsonResponse({
      status: 'waiting',
      ownerLocation: null,
      sessionId: null,
      sessionStatus: null,
      sessionCompletedAt: null
    });
  }
  const [sessionId, sessionStatus, sessionCompletedAt, notifyStatus, ownerLocationRaw, ownerMessage] = await Promise.all([
    MOVE_CAR_STATUS.get('session_id'),
    MOVE_CAR_STATUS.get('session_status'),
    MOVE_CAR_STATUS.get('session_completed_at'),
    MOVE_CAR_STATUS.get('notify_status'),
    MOVE_CAR_STATUS.get('owner_location'),
    MOVE_CAR_STATUS.get('owner_message')
  ]);
  const completedAtNum = sessionCompletedAt ? Number(sessionCompletedAt) : null;
  const cookieSession = getCookie(request, 'mc_session');
  if (!sessionId || !cookieSession || cookieSession !== sessionId) {
    return jsonResponse({
      status: 'waiting',
      ownerLocation: null,
      sessionId: null,
      sessionStatus: null,
      sessionCompletedAt: null
    });
  }
  let status = notifyStatus || 'waiting';
  if (!notifyStatus && sessionStatus === 'arriving') status = 'arriving';
  if (sessionStatus === 'closed') status = 'closed';
  return jsonResponse({
    status: status,
    ownerLocation: safeJsonParse(ownerLocationRaw),
    ownerMessage: ownerMessage || null,
    sessionId: sessionId || null,
    sessionStatus: sessionStatus || null,
    sessionCompletedAt: sessionStatus === 'closed' ? (completedAtNum || null) : null
  });
}

async function handleTerminateSession(request) {
  try {
    if (typeof MOVE_CAR_STATUS === 'undefined') return jsonResponse({ error: 'KV_NOT_BOUND' }, 500);
    const sessionId = await resolveSessionFromRequest(request);
    if (!sessionId) {
      return jsonResponse({ error: 'SESSION_INVALID' }, 404);
    }
    await markSessionClosed();
    return jsonResponse({ success: true });
  } catch (e) {
    return jsonResponse({ success: false }, 500);
  }
}

async function handleOwnerConfirmAction(request) {
  try {
    if (typeof MOVE_CAR_STATUS === 'undefined') return jsonResponse({ error: 'KV_NOT_BOUND' }, 500);
    const sessionId = await resolveSessionFromRequest(request);
    if (!sessionId) {
      return jsonResponse({ error: 'SESSION_INVALID' }, 404);
    }
    const [currentSessionId, sessionStatus] = await Promise.all([
      MOVE_CAR_STATUS.get('session_id'),
      MOVE_CAR_STATUS.get('session_status')
    ]);
    if (!currentSessionId || currentSessionId !== sessionId || sessionStatus === 'closed') {
      return jsonResponse({ success: false, error: 'SESSION_CLOSED' }, 409);
    }
    const body = await request.json();
    const ownerLocation = normalizeLocationPayload(body.location);
    const ownerMessage = normalizeUserMessage(body.message, '');

    const locationTask = ownerLocation
      ? MOVE_CAR_STATUS.put('owner_location', JSON.stringify({
        lat: ownerLocation.lat,
        lng: ownerLocation.lng,
        ...generateMapUrls(ownerLocation.lat, ownerLocation.lng),
        timestamp: Date.now()
      }), { expirationTtl: CONFIG.KV_TTL })
      : MOVE_CAR_STATUS.delete('owner_location');

    const messageTask = ownerMessage
      ? MOVE_CAR_STATUS.put('owner_message', ownerMessage, { expirationTtl: CONFIG.KV_TTL })
      : MOVE_CAR_STATUS.delete('owner_message');

    const expiresAt = String(Date.now() + SESSION_VIEW_TTL_SECONDS * 1000);
    await Promise.all([
      locationTask,
      messageTask,
      MOVE_CAR_STATUS.put('session_id', sessionId, { expirationTtl: SESSION_VIEW_TTL_SECONDS }),
      MOVE_CAR_STATUS.put('session_status', 'arriving', { expirationTtl: SESSION_VIEW_TTL_SECONDS }),
      MOVE_CAR_STATUS.put('notify_status', 'arriving', { expirationTtl: SESSION_VIEW_TTL_SECONDS }),
      MOVE_CAR_STATUS.put('session_expires_at', expiresAt, { expirationTtl: SESSION_VIEW_TTL_SECONDS }),
      MOVE_CAR_STATUS.delete('session_completed_at')
    ]);

    return jsonResponse({ success: true });
  } catch (error) {
    console.error('Owner confirm error:', error);
    return jsonResponse({ success: false, error: 'OWNER_CONFIRM_FAILED' }, 500);
  }
}

async function handleClearOwnerLocation(request) {
  try {
    if (typeof MOVE_CAR_STATUS === 'undefined') return jsonResponse({ error: 'KV_NOT_BOUND' }, 500);
    const sessionId = await resolveSessionFromRequest(request);
    if (!sessionId) {
      return jsonResponse({ error: 'SESSION_INVALID' }, 404);
    }
    await MOVE_CAR_STATUS.delete('owner_location');
    return jsonResponse({ success: true });
  } catch (e) {
    return jsonResponse({ success: false }, 500);
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
  return htmlResponse(html);
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
  return htmlResponse(html);
}

function renderMainPage(origin, apiBase, sessionPathId) {
  const phone = typeof PHONE_NUMBER !== 'undefined' ? PHONE_NUMBER : '';
  const plateRule = getConfiguredPlateRule();
  const verifySlotCount = plateRule.enabled ? Array.from(plateRule.plate).length : 8;
  const plateVerifyInputsHtml = Array.from({ length: verifySlotCount }, (_, idx) => {
    const isProvince = idx === 0;
    const aria = `车牌第${idx + 1}位`;
    const placeholder = isProvince ? '省' : 'X';
    const cls = isProvince ? 'plate-box province plate-proof-box' : 'plate-box plate-proof-box';
    const inputHtml = `<input class="${cls}" data-proof-index="${idx}" inputmode="text" maxlength="1" placeholder="${placeholder}" aria-label="${aria}">`;
    if (idx === 1 && verifySlotCount > 2) {
      return inputHtml + '<span class="plate-sep">·</span>';
    }
    return inputHtml;
  }).join('');
  const plateVerifyRule = {
    enabled: plateRule.enabled,
    plate: plateRule.enabled ? plateRule.plate : '',
    length: verifySlotCount
  };
  const plateVerifyDesc = plateVerifyRule.enabled
    ? '请输入完整车牌号'
    : '未配置 CAR_PLATE，发送时将跳过车牌验证';

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

      --pill-radius: 999px;

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

      --modal-overlay-bg: rgba(2, 6, 23, 0.6);
      --modal-surface: rgba(15, 23, 42, 0.94);
      --modal-border: rgba(148, 163, 184, 0.26);
      --modal-text: #e2e8f0;
      --modal-muted: #94a3b8;
      --modal-shadow: 0 28px 70px rgba(2, 6, 23, 0.45);
      --modal-btn-bg: rgba(30, 41, 59, 0.92);
      --modal-btn-border: rgba(148, 163, 184, 0.28);
      --modal-btn-text: #e2e8f0;
      --modal-danger-bg: rgba(127, 29, 29, 0.88);
      --modal-danger-border: rgba(239, 68, 68, 0.45);
      --modal-danger-text: #fecaca;

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

        --modal-overlay-bg: rgba(15, 23, 42, 0.45);
        --modal-surface: #ffffff;
        --modal-border: rgba(15, 23, 42, 0.12);
        --modal-text: #0f172a;
        --modal-muted: #475569;
        --modal-shadow: 0 30px 70px rgba(15, 23, 42, 0.22);
        --modal-btn-bg: #ffffff;
        --modal-btn-border: rgba(15, 23, 42, 0.12);
        --modal-btn-text: #0f172a;
        --modal-danger-bg: #fee2e2;
        --modal-danger-border: #fecaca;
        --modal-danger-text: #b91c1c;

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

    .low-power .toggle-slider {
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }

    .low-power .toggle-slider {
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

    .plate-meta {
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.4;
    }

    .plate-meta.error {
      color: #fca5a5;
    }

    .plate-grid {
      display: flex;
      align-items: center;
      gap: 6px;
      justify-content: center;
      flex-wrap: nowrap;
      margin-top: 8px;
    }

    .plate-sep {
      color: var(--text-secondary);
      font-size: 18px;
      font-weight: 700;
      padding: 0 2px;
      flex: 0 0 auto;
    }

    .plate-box {
      width: 40px;
      height: 46px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: rgba(255, 255, 255, 0.07);
      color: var(--text-primary);
      font-size: 22px;
      font-weight: 800;
      line-height: 1;
      text-align: center;
      text-transform: uppercase;
      outline: none;
      caret-color: transparent;
      transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
      user-select: text;
      -webkit-user-select: text;
      flex: 0 0 auto;
    }

    .plate-box.province {
      width: 46px;
      font-size: 20px;
    }

    .plate-box:focus {
      border-color: rgba(59, 130, 246, 0.9);
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.24);
    }

    .plate-box.invalid {
      border-color: rgba(239, 68, 68, 0.85);
      box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.2);
    }

    .plate-proof-grid {
      max-width: 100%;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
      padding-top: 4px;
      padding-bottom: 2px;
    }

    .plate-proof-grid::-webkit-scrollbar {
      display: none;
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
      border-radius: var(--pill-radius);
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
      display: contents;
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
      display: grid;
      grid-template-columns: 1fr auto;
      grid-template-rows: auto auto;
      align-items: center;
      column-gap: 12px;
    }

    .loc-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      grid-column: 1;
      grid-row: 1;
    }

    .loc-status {
      font-size: 13px;
      color: var(--text-secondary);
      margin-top: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      grid-column: 1;
      grid-row: 2;
    }

    /* Toggle */
    .toggle {
      position: relative;
      display: inline-flex;
      align-items: center;
      width: 52px;
      height: 30px;
      flex-shrink: 0;
      grid-column: 2;
      grid-row: 1 / span 2;
      align-self: center;
      justify-self: end;
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
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.28), rgba(255, 255, 255, 0.08));
      border: 1px solid var(--toggle-border);
      border-radius: 999px;
      transition: background 0.25s, border 0.25s, box-shadow 0.25s;
      backdrop-filter: blur(10px) saturate(1.6);
      -webkit-backdrop-filter: blur(10px) saturate(1.6);
      box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.45), inset 0 -1px 2px rgba(0, 0, 0, 0.12), 0 6px 14px rgba(0, 0, 0, 0.12);
      overflow: hidden;
    }

    .toggle-slider::before {
      content: "";
      position: absolute;
      height: 24px;
      width: 24px;
      left: 2px;
      top: 2px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(235, 235, 235, 0.92));
      border-radius: 50%;
      transition: transform 0.25s var(--ease-elastic);
      box-shadow: 0 4px 10px rgba(0, 0, 0, 0.25), inset 0 1px 1px rgba(255, 255, 255, 0.8);
    }

    .toggle-slider::after {
      content: "";
      position: absolute;
      inset: 1px;
      border-radius: 999px;
      background: linear-gradient(120deg, rgba(255, 255, 255, 0.65), rgba(255, 255, 255, 0));
      opacity: 0.55;
      pointer-events: none;
    }

    .toggle input:checked+.toggle-slider {
      background: linear-gradient(180deg, rgba(34, 197, 94, 0.95), rgba(22, 163, 74, 0.95));
      border-color: var(--toggle-checked-border);
      box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.35), 0 6px 14px rgba(16, 185, 129, 0.35);
    }

    .toggle input:checked+.toggle-slider::before {
      transform: translateX(22px);
    }

    .toggle input:checked+.toggle-slider::after {
      opacity: 0.25;
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
      border-radius: var(--pill-radius);
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
      border-radius: var(--pill-radius);
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
      border-radius: var(--pill-radius);
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
      background: var(--modal-overlay-bg);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 200;
      padding: 20px;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: opacity 0.3s ease, visibility 0.3s ease;
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }

    .modal-overlay.show {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
    }

    .modal-box {
      background: var(--modal-surface);
      border: 1px solid var(--modal-border);
      border-radius: 24px;
      padding: clamp(24px, 6vw, 32px);
      max-width: 460px;
      width: 100%;
      text-align: center;
      transform: scale(0.9);
      transition: transform 0.3s var(--ease-out-expo);
      box-shadow: var(--modal-shadow);
      color: var(--modal-text);
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
      color: var(--modal-text);
      margin-bottom: 8px;
    }

    .modal-desc {
      font-size: 14px;
      color: var(--modal-muted);
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
      border-radius: var(--pill-radius);
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid var(--modal-btn-border);
      background: var(--modal-btn-bg);
      color: var(--modal-btn-text);
      transition: transform 0.2s ease;
      box-shadow: 0 8px 18px rgba(15, 23, 42, 0.22);
    }

    .modal-btn:active {
      transform: scale(0.96);
    }

    .modal-btn-danger {
      background: var(--modal-danger-bg);
      color: var(--modal-danger-text);
      border-color: var(--modal-danger-border);
    }

    .modal-box .spot-btn {
      background: var(--modal-btn-bg);
      border: 1px solid var(--modal-btn-border);
      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.24);
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }

    .modal-box .spot-btn::before {
      display: none;
    }

    /* Countdown - New Implementation */
    .countdown-container {
      display: flex;
      justify-content: center;
      margin: 20px 0;
    }

    .flip-wrap {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: clamp(8px, 2.5vw, 14px);
    }

    .flip-card {
      --fc-bg: #0a0a0e;
      --fc-bg-top: #111116;
      --fc-bg-btm: #0a0a0e;
      position: relative;
      width: clamp(64px, 16vw, 86px);
      height: clamp(82px, 20vw, 110px);
      border-radius: 16px;
      perspective: 600px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
      font-size: clamp(44px, 12vw, 68px);
      font-weight: 700;
      color: #fff;
      font-variant-numeric: tabular-nums;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
    }

    /* Four layers: upper bg, lower bg, top flap, bottom flap */
    .fc-upper,
    .fc-lower,
    .fc-flap-top,
    .fc-flap-btm {
      position: absolute;
      left: 0;
      right: 0;
      height: 50%;
      overflow: hidden;
    }

    /* Static background layers (z-index 1) */
    .fc-upper {
      top: 0;
      z-index: 1;
      background: var(--fc-bg-top);
      border-radius: 14px 14px 0 0;
    }

    .fc-lower {
      bottom: 0;
      z-index: 1;
      background: var(--fc-bg-btm);
      border-radius: 0 0 14px 14px;
    }

    /* Animated flap layers (z-index 3) */
    .fc-flap-top {
      top: 0;
      z-index: 3;
      background: var(--fc-bg-top);
      border-radius: 14px 14px 0 0;
      transform-origin: bottom center;
      backface-visibility: hidden;
      /* transition set dynamically by JS */
    }

    .fc-flap-btm {
      bottom: 0;
      z-index: 3;
      background: var(--fc-bg-btm);
      border-radius: 0 0 14px 14px;
      transform-origin: top center;
      transform: rotateX(90deg);
      backface-visibility: hidden;
      /* transition set dynamically by JS */
    }

    /* Number text - 200% height trick clips to top or bottom half */
    .fc-num {
      position: absolute;
      left: 0;
      right: 0;
      height: 200%;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
      text-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
    }

    .fc-upper .fc-num,
    .fc-flap-top .fc-num {
      top: 0;
    }

    .fc-lower .fc-num,
    .fc-flap-btm .fc-num {
      bottom: 0;
    }

    /* Center divider line */
    .flip-card::after {
      content: '';
      position: absolute;
      top: 50%;
      left: 4px;
      right: 4px;
      height: 1.5px;
      background: rgba(0, 0, 0, 0.6);
      transform: translateY(-50%);
      z-index: 10;
      pointer-events: none;
    }

    /* Subtle inner shadow on top panel for depth */
    .fc-upper::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 6px;
      background: linear-gradient(transparent, rgba(0,0,0,0.15));
      pointer-events: none;
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
    <div id="plateVerifyModal" class="modal-overlay">
      <div class="modal-box">
        <div class="modal-icon">🪪</div>
        <div class="modal-title">发送前验证车牌</div>
        <div id="plateVerifyDesc" class="modal-desc">${plateVerifyDesc}</div>
        <div id="plateVerifyGrid" class="plate-grid plate-proof-grid" aria-label="车牌验证输入">
          ${plateVerifyRule.enabled ? plateVerifyInputsHtml : '<div class="plate-meta">未配置 CAR_PLATE</div>'}
        </div>
        <div id="plateVerifyError" class="plate-meta" style="min-height: 20px; margin-top: 10px;"></div>
        <div class="modal-buttons">
          <button class="modal-btn modal-btn-danger spot-btn" onclick="cancelPlateVerify()"><span>取消</span></button>
          <button class="modal-btn spot-btn" onclick="confirmPlateVerify()"><span>验证并发送</span></button>
        </div>
      </div>
    </div>
    <div id="delayModal" class="modal-overlay">
      <div class="modal-box">
        <div class="modal-icon">⏳</div>
        <div class="modal-title">正在延迟发送</div>
        <div class="modal-desc">未提供位置信息，<br>将在倒计时结束后发送通知</div>
        <div class="countdown-container">
          <div id="countdownNum" class="flip-wrap" aria-label="30">
            <div class="flip-card" data-digit="tens" data-val="3">
                <div class="fc-upper"><span class="fc-num">3</span></div>
                <div class="fc-lower"><span class="fc-num">3</span></div>
                <div class="fc-flap-top"><span class="fc-num">3</span></div>
                <div class="fc-flap-btm"><span class="fc-num">3</span></div>
            </div>
            <div class="flip-card" data-digit="ones" data-val="0">
                <div class="fc-upper"><span class="fc-num">0</span></div>
                <div class="fc-lower"><span class="fc-num">0</span></div>
                <div class="fc-flap-top"><span class="fc-num">0</span></div>
                <div class="fc-flap-btm"><span class="fc-num">0</span></div>
            </div>
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
        v2.7.1</div>
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
const PLATE_VERIFY_RULE = ${JSON.stringify(plateVerifyRule)};
let userLocation = null;
      let checkTimer = null;
      let pollInFlight = false;
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
      let pendingPlateProofForDelay = null;
      let lastPlateProof = null;
      let plateVerifyResolver = null;
      let locationRequestSeq = 0;
      const CLIENT_CN_PLATE_PROVINCES = new Set(Array.from('京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领警学港澳'));
      const CLIENT_CN_PLATE_REGION_RE = /^[A-HJ-NP-Z]$/;
      const CLIENT_CN_PLATE_SUFFIX_RE = /^[A-HJ-NP-Z0-9]{5,6}$/;
      const SESSION_PROOF_KEY_PREFIX = 'mc_plate_proof_';
      const SESSION_RETRY_KEY_PREFIX = 'mc_retry_ready_';

      function normalizePlateValue(value) {
        return String(value || '').trim().toUpperCase().replace(/[\\s\\-_.·]/g, '');
      }
      function validateChinaPlateValue(rawPlate) {
        const plate = normalizePlateValue(rawPlate);
        if (plate.length < 7 || plate.length > 8) return { ok: false };
        const chars = Array.from(plate);
        const province = chars[0];
        const region = chars[1] || '';
        const suffix = chars.slice(2).join('');
        if (!CLIENT_CN_PLATE_PROVINCES.has(province)) return { ok: false };
        if (!CLIENT_CN_PLATE_REGION_RE.test(region)) return { ok: false };
        if (!CLIENT_CN_PLATE_SUFFIX_RE.test(suffix)) return { ok: false };
        if (!/\\d/.test(suffix)) return { ok: false };
        return { ok: true, plate };
      }
      function safeSessionStorageGet(key) {
        try {
          return sessionStorage.getItem(key);
        } catch (e) {
          return null;
        }
      }
      function safeSessionStorageSet(key, value) {
        try {
          sessionStorage.setItem(key, value);
        } catch (e) {}
      }
      function safeSessionStorageRemove(key) {
        try {
          sessionStorage.removeItem(key);
        } catch (e) {}
      }
      function getPlateProofStorageKey(sessionId) {
        if (!sessionId) return null;
        return SESSION_PROOF_KEY_PREFIX + sessionId;
      }
      function getRetryReadyStorageKey(sessionId) {
        if (!sessionId) return null;
        return SESSION_RETRY_KEY_PREFIX + sessionId;
      }
      function loadStoredPlateProof(sessionId) {
        if (!PLATE_VERIFY_RULE.enabled) return null;
        const key = getPlateProofStorageKey(sessionId);
        if (!key) return null;
        const raw = safeSessionStorageGet(key);
        if (!raw) return null;
        try {
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object') return null;
          const normalized = normalizePlateValue(parsed.plate || '');
          if (!normalized || normalized !== PLATE_VERIFY_RULE.plate) return null;
          const valid = validateChinaPlateValue(normalized);
          if (!valid.ok) return null;
          return { plate: normalized };
        } catch (e) {
          return null;
        }
      }
      function persistPlateProof(sessionId, proof) {
        if (!PLATE_VERIFY_RULE.enabled || !proof || typeof proof !== 'object') return;
        const key = getPlateProofStorageKey(sessionId);
        if (!key) return;
        const normalized = normalizePlateValue(proof.plate || '');
        if (!normalized || normalized !== PLATE_VERIFY_RULE.plate) return;
        safeSessionStorageSet(key, JSON.stringify({ plate: normalized }));
      }
      function clearStoredSessionClientState(sessionId) {
        const proofKey = getPlateProofStorageKey(sessionId);
        const retryKey = getRetryReadyStorageKey(sessionId);
        if (proofKey) safeSessionStorageRemove(proofKey);
        if (retryKey) safeSessionStorageRemove(retryKey);
      }
      function setRetryReadyAtTimestamp(timestamp, persist) {
        const nextTs = Number(timestamp);
        retryReadyAt = Number.isFinite(nextTs) ? nextTs : 0;
        if (retryCooldownTimer) {
          clearInterval(retryCooldownTimer);
          retryCooldownTimer = null;
        }
        if (persist && currentSessionId) {
          const retryKey = getRetryReadyStorageKey(currentSessionId);
          if (retryKey) {
            if (retryReadyAt > Date.now()) safeSessionStorageSet(retryKey, String(retryReadyAt));
            else safeSessionStorageRemove(retryKey);
          }
        }
        if (retryReadyAt > Date.now()) {
          updateRetryCountdown();
          retryCooldownTimer = setInterval(updateRetryCountdown, 1000);
        } else {
          retryReadyAt = 0;
          const btn = document.getElementById('retryBtn');
          if (btn && !btn.innerText.includes('会话已')) {
            btn.disabled = false;
            btn.innerHTML = '<span>🔔</span><span>再次通知</span>';
          }
          updateActionHint();
        }
      }
      function restoreSessionClientState(sessionId, sessionStatus) {
        if (!sessionId) {
          lastPlateProof = null;
          setRetryReadyAtTimestamp(0, false);
          return;
        }
        if (sessionStatus === 'closed' || sessionStatus === 'confirmed') {
          clearStoredSessionClientState(sessionId);
          lastPlateProof = null;
          setRetryReadyAtTimestamp(0, false);
          return;
        }
        if (PLATE_VERIFY_RULE.enabled) {
          const storedProof = loadStoredPlateProof(sessionId);
          if (storedProof) lastPlateProof = storedProof;
        } else {
          lastPlateProof = null;
        }
        const retryKey = getRetryReadyStorageKey(sessionId);
        const retryRaw = retryKey ? safeSessionStorageGet(retryKey) : null;
        const retryTs = retryRaw ? Number(retryRaw) : 0;
        if (Number.isFinite(retryTs) && retryTs > Date.now()) {
          if (Math.abs(retryTs - retryReadyAt) > 500) {
            setRetryReadyAtTimestamp(retryTs, false);
          } else {
            updateRetryCountdown();
          }
        } else {
          if (retryKey) safeSessionStorageRemove(retryKey);
          setRetryReadyAtTimestamp(0, false);
        }
      }

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
        initPlateProofInputs();
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
        window.addEventListener('beforeunload', () => {
          stopPolling();
          if (delayTimer) clearInterval(delayTimer);
          if (retryCooldownTimer) clearInterval(retryCooldownTimer);
          if (phoneCooldownTimer) clearInterval(phoneCooldownTimer);
        });
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
        const previousSessionId = currentSessionId;
        const info = document.getElementById('sessionInfoUser');
        const code = document.getElementById('sessionCodeUser');
        const status = document.getElementById('sessionStatusUser');
        const expire = document.getElementById('sessionExpire');
        currentSessionId = data && data.sessionId ? data.sessionId : null;
        currentSessionStatus = data && data.sessionStatus ? data.sessionStatus : null;
        currentSessionCompletedAt = data && data.sessionCompletedAt ? Number(data.sessionCompletedAt) : null;
        if (previousSessionId && previousSessionId !== currentSessionId) {
          lastPlateProof = null;
          setRetryReadyAtTimestamp(0, false);
        }
        restoreSessionClientState(currentSessionId, currentSessionStatus);
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
          stopPolling();
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
        setRetryReadyAtTimestamp(Date.now() + seconds * 1000, true);
      }
      function updateRetryCountdown() {
        const btn = document.getElementById('retryBtn');
        if (!btn) return;
        const remaining = Math.max(0, Math.ceil((retryReadyAt - Date.now()) / 1000));
        if (remaining <= 0) {
          clearInterval(retryCooldownTimer);
          retryCooldownTimer = null;
          retryReadyAt = 0;
          if (currentSessionId) {
            const retryKey = getRetryReadyStorageKey(currentSessionId);
            if (retryKey) safeSessionStorageRemove(retryKey);
          }
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
      function getPlateProofInputs() {
        return Array.from(document.querySelectorAll('.plate-proof-box'));
      }
      function setPlateVerifyError(text) {
        const el = document.getElementById('plateVerifyError');
        if (!el) return;
        el.textContent = text || '';
        el.classList.toggle('error', !!text);
      }
      function clearPlateProofInvalid() {
        getPlateProofInputs().forEach((input) => input.classList.remove('invalid'));
      }
      function setPlateProofInvalidAll() {
        clearPlateProofInvalid();
        getPlateProofInputs().forEach((input) => {
          if (input) input.classList.add('invalid');
        });
      }
      function sanitizeProofChar(index, raw) {
        if (raw === undefined || raw === null) return '';
        const plain = String(raw).replace(/[\\s\\-_.·]/g, '');
        if (!plain) return '';
        if (index === 0) {
          for (const ch of Array.from(plain)) {
            if (CLIENT_CN_PLATE_PROVINCES.has(ch)) return ch;
          }
          return '';
        }
        const upper = plain.toUpperCase();
        for (const ch of Array.from(upper)) {
          if (/^[A-HJ-NP-Z0-9]$/.test(ch)) return ch;
        }
        return '';
      }
      function focusProofInput(index) {
        const inputs = getPlateProofInputs();
        if (index < 0 || index >= inputs.length) return;
        inputs[index].focus();
      }
      function focusNextProofInput(fromIndex) {
        const inputs = getPlateProofInputs();
        for (let i = Math.max(0, fromIndex); i < inputs.length; i++) {
          if (!inputs[i].value) {
            inputs[i].focus();
            return;
          }
        }
        if (inputs.length) {
          inputs[inputs.length - 1].focus();
        }
      }
      function fillPlateProofFromText(rawText) {
        const inputs = getPlateProofInputs();
        if (!inputs.length) return;
        const chars = Array.from(String(rawText || '').replace(/[\\s\\-_.·]/g, ''));
        inputs.forEach((input, idx) => {
          input.value = sanitizeProofChar(idx, chars[idx] || '');
        });
        clearPlateProofInvalid();
        setPlateVerifyError('');
        focusNextProofInput(0);
      }
      function resetPlateVerifyModal() {
        const inputs = getPlateProofInputs();
        if (!inputs.length) {
          setPlateVerifyError('');
          return;
        }
        inputs.forEach((input) => {
          input.value = '';
          input.classList.remove('invalid');
        });
        setPlateVerifyError('');
        focusProofInput(0);
      }
      function validatePlateProof(showFeedback) {
        if (!PLATE_VERIFY_RULE.enabled) return null;
        const inputs = getPlateProofInputs();
        if (!inputs.length) return null;

        const fail = () => {
          if (showFeedback) {
            setPlateProofInvalidAll();
            setPlateVerifyError('车牌验证失败');
            showToast('❌ 车牌验证失败');
          }
          return null;
        };

        const rawPlate = inputs.map((input) => input.value || '').join('');
        if (rawPlate.length !== PLATE_VERIFY_RULE.length || inputs.some((input) => !input.value)) {
          return fail();
        }
        const normalized = normalizePlateValue(rawPlate);
        if (normalized !== PLATE_VERIFY_RULE.plate) {
          return fail();
        }
        const valid = validateChinaPlateValue(normalized);
        if (!valid.ok) return fail();

        clearPlateProofInvalid();
        setPlateVerifyError('');
        return { plate: normalized };
      }
      function resolvePlateVerify(proof) {
        hideModal('plateVerifyModal');
        const resolver = plateVerifyResolver;
        plateVerifyResolver = null;
        if (resolver) resolver(proof);
      }
      function requestPlateVerify() {
        if (!PLATE_VERIFY_RULE.enabled) return Promise.resolve(null);
        if (plateVerifyResolver) return Promise.resolve(null);
        resetPlateVerifyModal();
        showModal('plateVerifyModal');
        return new Promise((resolve) => {
          plateVerifyResolver = resolve;
        });
      }
      function cancelPlateVerify() {
        resolvePlateVerify(null);
      }
      function confirmPlateVerify() {
        const proof = validatePlateProof(true);
        if (!proof) return;
        resolvePlateVerify(proof);
      }
      function initPlateProofInputs() {
        const grid = document.getElementById('plateVerifyGrid');
        const inputs = getPlateProofInputs();
        if (!grid || !inputs.length || grid.dataset.ready === '1') return;
        inputs.forEach((input) => {
          const index = Number(input.dataset.proofIndex || 0);
          const orderedInputs = getPlateProofInputs();
          const applyInputValue = () => {
            input.value = sanitizeProofChar(index, input.value);
            if (input.value) focusNextProofInput(index + 1);
            clearPlateProofInvalid();
            setPlateVerifyError('');
          };
          input.autocomplete = 'off';
          input.autocapitalize = 'characters';
          input.spellcheck = false;
          input.addEventListener('focus', () => {
            setTimeout(() => input.select(), 0);
          });
          input.addEventListener('compositionstart', () => {
            input.dataset.composing = '1';
          });
          input.addEventListener('compositionend', () => {
            input.dataset.composing = '0';
            applyInputValue();
          });
          input.addEventListener('blur', () => {
            input.dataset.composing = '0';
          });
          input.addEventListener('input', () => {
            if (input.dataset.composing === '1') return;
            applyInputValue();
          });
          input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft') {
              e.preventDefault();
              focusProofInput(index - 1);
              return;
            }
            if (e.key === 'ArrowRight') {
              e.preventDefault();
              focusProofInput(index + 1);
              return;
            }
            if (e.key === 'Backspace' && !input.value) {
              e.preventDefault();
              const prev = orderedInputs[index - 1];
              if (prev) {
                prev.value = '';
                prev.focus();
              }
              return;
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              confirmPlateVerify();
            }
          });
        });
        grid.addEventListener('paste', (e) => {
          const text = (e.clipboardData || window.clipboardData).getData('text');
          if (!text) return;
          e.preventDefault();
          fillPlateProofFromText(text);
        });
        grid.dataset.ready = '1';
      }
      function showModal(id) { document.getElementById(id).classList.add('show'); }
      function hideModal(id) { document.getElementById(id).classList.remove('show'); }
      function requestLocation() {
        const toggle = document.getElementById('shareLocationToggle');
        if (!toggle.checked) return;
        const reqSeq = ++locationRequestSeq;
        const icon = document.getElementById('locIcon');
        const txt = document.getElementById('locStatus');
        icon.className = 'loc-icon loading';
        txt.className = 'loc-status';
        txt.innerText = '正在获取定位...';
        if ('geolocation' in navigator) {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              if (reqSeq !== locationRequestSeq || !toggle.checked) return;
              userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
              icon.className = 'loc-icon ready';
              txt.className = 'loc-status';
              txt.innerText = '已获取位置 ✓';
              showMap(userLocation.lat, userLocation.lng);
            },
            (err) => {
              if (reqSeq !== locationRequestSeq || !toggle.checked) return;
              icon.className = 'loc-icon error';
              txt.className = 'loc-status';
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
          
          L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
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
        locationRequestSeq++;
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
      function startDelayCountdown(plateProof) {
        if (delayTimer) clearInterval(delayTimer);
        showModal('delayModal');
        pendingPlateProofForDelay = plateProof;
        countdownVal = 30;
        lastCountdownVal = null;
        updateDelayMsg();
        delayTimer = setInterval(() => {
          countdownVal--;
          updateDelayMsg();
          if (countdownVal <= 0) {
             clearInterval(delayTimer);
             delayTimer = null;
             hideModal('delayModal');
             doSendNotify(null, pendingPlateProofForDelay);
             pendingPlateProofForDelay = null;
          }
        }, 1000);
      }

      function updateDelayMsg() {
         const el = document.getElementById('countdownNum');
         if (!el) return;
         const current = countdownVal.toString().padStart(2, '0');

         if (lastCountdownVal === null) {
           // Initialization / Reset
           lastCountdownVal = current;
           setFlipDisplay(current);
           return;
         }

         const cards = el.querySelectorAll('.flip-card');
         if (!cards || cards.length < 2) {
           el.innerText = current;
           return;
         }

         // Animate to new digits
         updateFlipCard(cards[0], current[0]);
         updateFlipCard(cards[1], current[1]);
         lastCountdownVal = current;
      }

      function setFlipDisplay(strVal) {
          const el = document.getElementById('countdownNum');
          if (!el) return;
          const str = String(strVal).padStart(2, '0');
          el.setAttribute('aria-label', str);

          el.querySelectorAll('.flip-card').forEach((card, i) => {
              const d = str[i];
              card.dataset.val = d;
              card.querySelectorAll('.fc-num').forEach(n => n.textContent = d);
              // Reset flaps to idle
              const ft = card.querySelector('.fc-flap-top');
              const fb = card.querySelector('.fc-flap-btm');
              if (ft) { ft.style.transition = 'none'; ft.style.transform = 'rotateX(0)'; }
              if (fb) { fb.style.transition = 'none'; fb.style.transform = 'rotateX(90deg)'; }
          });
      }

      function updateFlipCard(card, newDigit) {
          const oldDigit = card.dataset.val;
          if (oldDigit === newDigit) return;

          // Cancel any in-progress animation
          if (card._flipCleanup) clearTimeout(card._flipCleanup);
          if (card._flipRaf) cancelAnimationFrame(card._flipRaf);

          // Grab elements
          const upper = card.querySelector('.fc-upper .fc-num');
          const lower = card.querySelector('.fc-lower .fc-num');
          const flapTop = card.querySelector('.fc-flap-top');
          const flapBtm = card.querySelector('.fc-flap-btm');
          const flapTopN = flapTop.querySelector('.fc-num');
          const flapBtmN = flapBtm.querySelector('.fc-num');

          // 1) Set layer content
          upper.textContent = newDigit;   // revealed
          lower.textContent = oldDigit;   // hidden
          flapTopN.textContent = oldDigit;   // folds away
          flapBtmN.textContent = newDigit;   // unfolds

          // 2) Instantly reset flaps
          flapTop.style.transition = 'none';
          flapBtm.style.transition = 'none';
          flapTop.style.transform = 'rotateX(0)';
          flapBtm.style.transform = 'rotateX(90deg)';

          // 3) Double-rAF for reliable paint
          card._flipRaf = requestAnimationFrame(() => {
              card._flipRaf = requestAnimationFrame(() => {
                  // Apply transition
                  flapTop.style.transition = 'transform 0.3s ease-in';
                  flapBtm.style.transition = 'transform 0.25s ease-out 0.2s';
                  flapTop.style.transform = 'rotateX(-90deg)';
                  flapBtm.style.transform = 'rotateX(0)';
              });
          });

          // 4) Cleanup after animation
          card._flipCleanup = setTimeout(() => {
              upper.textContent = newDigit;
              lower.textContent = newDigit;
              flapTopN.textContent = newDigit;
              flapBtmN.textContent = newDigit;
              flapTop.style.transition = 'none';
              flapBtm.style.transition = 'none';
              flapTop.style.transform = 'rotateX(0)';
              flapBtm.style.transform = 'rotateX(90deg)';
              card.dataset.val = newDigit;
          }, 520);
      }

      function cancelDelay() {
        if (delayTimer) clearInterval(delayTimer);
        delayTimer = null;
        pendingPlateProofForDelay = null;
        hideModal('delayModal');
      }

      async function sendNotify() {
        if (currentSessionId && (currentSessionStatus === 'active' || currentSessionStatus === 'arriving')) {
          showToast('已有进行中的会话，已为你打开');
          resumeSession();
          return;
        }
        let plateProof = null;
        if (PLATE_VERIFY_RULE.enabled) {
          plateProof = await requestPlateVerify();
          if (!plateProof) return;
        }
        const shareLocation = document.getElementById('shareLocationToggle').checked;
        const locationToSend = shareLocation ? userLocation : null;
        
        if (locationToSend) {
          doSendNotify(locationToSend, plateProof);
        } else {
          startDelayCountdown(plateProof);
        }
      }

      async function doSendNotify(locationToSend, plateProof) {
        const btn = document.getElementById('notifyBtn');
        const msg = document.getElementById('msgInput').value;
        const delayed = false; // Client side delay already handled
        const proof = PLATE_VERIFY_RULE.enabled ? (plateProof || lastPlateProof) : null;
        if (PLATE_VERIFY_RULE.enabled && !proof) {
          showToast('❌ 车牌验证信息缺失，请重试');
          return;
        }
        
        btn.disabled = true;
        btn.innerHTML = '<span>🚀</span><span>发送中...</span>';
        try {
          const res = await fetch(API_BASE + '/notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg, plateProof: proof, location: locationToSend, delayed: delayed })
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.success) {
            if (delayed) showToast('⏳ 通知将延迟30秒发送'); // Should basically never happen with forced false
            else showToast('✅ 发送成功！');
            if (data.partialFailure) {
              showToast('⚠️ 部分通道发送失败，请检查通知服务');
            }
            if (proof) lastPlateProof = proof;
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
            if (proof) persistPlateProof(data.sessionId || currentSessionId, proof);
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

      function stopPolling() {
        if (checkTimer) {
          clearInterval(checkTimer);
          checkTimer = null;
        }
        pollInFlight = false;
      }
      function startPolling() {
        stopPolling();
        let count = 0;
        checkTimer = setInterval(async () => {
          if (pollInFlight) return;
          count++;
          if (count > 120) { stopPolling(); return; }
          pollInFlight = true;
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
              stopPolling();
            }
          } catch(e) {
          } finally {
            pollInFlight = false;
          }
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
        let proofForRetry = lastPlateProof;
        if (PLATE_VERIFY_RULE.enabled && !proofForRetry) {
          proofForRetry = loadStoredPlateProof(currentSessionId);
          if (proofForRetry) {
            lastPlateProof = proofForRetry;
          }
        }
        if (PLATE_VERIFY_RULE.enabled && !proofForRetry) {
          proofForRetry = await requestPlateVerify();
          if (!proofForRetry) return;
          lastPlateProof = proofForRetry;
          persistPlateProof(currentSessionId, proofForRetry);
        }
        let success = false;
        btn.disabled = true;
        btn.innerHTML = '<span>🚀</span><span>发送中...</span>';
        try {
          const res = await fetch(API_BASE + '/notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: '再次通知：请尽快挪车', plateProof: PLATE_VERIFY_RULE.enabled ? proofForRetry : null, location: userLocation, sessionId: currentSessionId })
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.success) {
            if (PLATE_VERIFY_RULE.enabled && proofForRetry) {
              lastPlateProof = proofForRetry;
              persistPlateProof(data.sessionId || currentSessionId, proofForRetry);
            }
            if (data.localMeowRequest) {
              sendMeowLocal(data.localMeowRequest).catch((err) => {
                console.error(err);
                showToast('⚠️ MeoW 本地发送失败，请重试');
              });
            }
            showToast('✅ 再次通知已发送！');
            if (data.partialFailure) {
              showToast('⚠️ 部分通道发送失败，请检查通知服务');
            }
            document.getElementById('waitingText').innerText = '已再次通知，等待车主回应...';
            startRetryCooldown(retryCooldownSeconds);
            startPhoneCooldown(callCooldownSeconds);
            success = true;
          } else { throw new Error(data.error || 'API Error'); }
        } catch (e) { showToast('❌ 发送失败：' + (e && e.message ? e.message : '请重试')); }
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
  const headers = {};
  if (sessionPathId) {
    headers['Set-Cookie'] = buildSessionCookie(sessionPathId);
  }
  return htmlResponse(html, 200, headers);
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

      --pill-radius: 999px;
      --success-bg: rgba(34, 197, 94, 0.22);
      --success-border: rgba(34, 197, 94, 0.45);
      --success-text: #d1fae5;
      --success-shadow: 0 12px 28px rgba(16, 185, 129, 0.25);

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

        --success-bg: #dcfce7;
        --success-border: #86efac;
        --success-text: #14532d;
        --success-shadow: 0 12px 24px rgba(16, 185, 129, 0.18);

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
      border-radius: var(--pill-radius);
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
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.28), rgba(255, 255, 255, 0.08));
      border-radius: 999px;
      transition: background 0.25s, border 0.25s, box-shadow 0.25s;
      border: 1px solid var(--toggle-border);
      backdrop-filter: blur(10px) saturate(1.6);
      -webkit-backdrop-filter: blur(10px) saturate(1.6);
      box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.45), inset 0 -1px 2px rgba(0, 0, 0, 0.12), 0 6px 14px rgba(0, 0, 0, 0.12);
      overflow: hidden;
    }

    .toggle-slider::before {
      content: "";
      position: absolute;
      height: 24px;
      width: 24px;
      left: 4px;
      top: 50%;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(235, 235, 235, 0.92));
      border-radius: 50%;
      transform: translateY(-50%);
      transition: transform 0.25s var(--ease-elastic);
      box-shadow: 0 4px 10px rgba(0, 0, 0, 0.25), inset 0 1px 1px rgba(255, 255, 255, 0.8);
    }

    .toggle-slider::after {
      content: "";
      position: absolute;
      inset: 1px;
      border-radius: 999px;
      background: linear-gradient(120deg, rgba(255, 255, 255, 0.65), rgba(255, 255, 255, 0));
      opacity: 0.55;
      pointer-events: none;
    }

    .toggle input:checked+.toggle-slider {
      background: linear-gradient(180deg, rgba(34, 197, 94, 0.95), rgba(22, 163, 74, 0.95));
      border-color: var(--toggle-checked-border);
      box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.35), 0 6px 14px rgba(16, 185, 129, 0.35);
    }

    .toggle input:checked+.toggle-slider::before {
      transform: translate(22px, -50%);
    }

    .toggle input:checked+.toggle-slider::after {
      opacity: 0.25;
    }

    /* Buttons */
    .btn {
      position: relative;
      color: var(--text-primary);
      width: 100%;
      padding: 16px 0;
      border-radius: var(--pill-radius);
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
      border-radius: var(--pill-radius);
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
      background: var(--success-bg);
      border-radius: var(--pill-radius);
      padding: 16px 20px;
      margin-top: 18px;
      display: none;
      border: 1px solid var(--success-border);
      box-shadow: var(--success-shadow);
      text-shadow: none;
    }

    .done-msg.show {
      display: block;
    }

    .done-msg p {
      color: var(--success-text);
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
        <div class="tag spot-btn" onclick="addOwnerTag('来了')"><span>🚗 来了</span></div>
        <div class="tag spot-btn" onclick="addOwnerTag('马上到')"><span>⏱️ 马上到</span></div>
        <div class="tag spot-btn" onclick="addOwnerTag('请稍等')"><span>🙏 请稍等</span></div>
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
      let ownerLocationRequestSeq = 0;
      let ownerSessionPollTimer = null;
      let ownerSessionEnded = false;
      function showOwnerMsg(text, timeoutMs = 2000) {
        const msg = document.getElementById('clearMsg');
        if (!msg) return;
        msg.innerText = text || '';
        if (timeoutMs > 0) {
          setTimeout(() => {
            if (msg.innerText === text) msg.innerText = '';
          }, timeoutMs);
        }
      }
      function applyOwnerArrivingState() {
        if (ownerSessionEnded) return;
        const btn = document.getElementById('confirmBtn');
        if (btn) {
          btn.disabled = true;
          btn.innerHTML = '<span>✅</span><span>已确认</span>';
          btn.style.background = 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)';
        }
        const doneMsg = document.getElementById('doneMsg');
        if (doneMsg) doneMsg.classList.add('show');
      }
      function applyOwnerClosedState(message) {
        ownerSessionEnded = true;
        const btn = document.getElementById('confirmBtn');
        if (btn) {
          btn.disabled = true;
          btn.innerHTML = '<span>✅</span><span>会话已结束</span>';
          btn.style.background = 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)';
        }
        const endBtn = document.getElementById('endSessionBtn');
        if (endBtn) endBtn.style.display = 'none';
        const clearBtn = document.getElementById('clearLocBtn');
        if (clearBtn) clearBtn.disabled = true;
        const toggle = document.getElementById('shareLocationToggle');
        if (toggle) toggle.disabled = true;
        if (message) showOwnerMsg(message, 2500);
        if (ownerSessionPollTimer) {
          clearInterval(ownerSessionPollTimer);
          ownerSessionPollTimer = null;
        }
      }
      function applyOwnerSessionStatus(status) {
        if (status === 'closed') {
          applyOwnerClosedState('会话已结束');
          return;
        }
        if (status === 'arriving') {
          applyOwnerArrivingState();
        }
      }
      async function syncOwnerSessionStatus() {
        try {
          const res = await fetch(API_BASE + '/get-session?role=owner&session=' + encodeURIComponent(SESSION_TOKEN));
          if (!res.ok) return;
          const data = await res.json().catch(() => null);
          if (!data) return;
          if (!data.sessionId || data.sessionStatus === 'closed') {
            applyOwnerClosedState('会话已结束');
            return;
          }
          applyOwnerSessionStatus(data.sessionStatus);
        } catch (e) {}
      }
      function startOwnerSessionPolling() {
        if (ownerSessionPollTimer) clearInterval(ownerSessionPollTimer);
        ownerSessionPollTimer = setInterval(() => {
          if (!ownerSessionEnded) syncOwnerSessionStatus();
        }, 4000);
      }
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
          const sessionRes = await fetch(API_BASE + '/get-session?role=owner&session=' + encodeURIComponent(SESSION_TOKEN));
          const sessionData = await sessionRes.json().catch(() => null);
          if (sessionData) {
            if (!sessionData.sessionId || sessionData.sessionStatus === 'closed') {
              applyOwnerClosedState('会话已结束');
            } else {
              applyOwnerSessionStatus(sessionData.sessionStatus);
            }
          }
          startOwnerSessionPolling();
          window.addEventListener('beforeunload', () => {
            if (ownerSessionPollTimer) clearInterval(ownerSessionPollTimer);
          });
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
        if (ownerSessionEnded) {
          showOwnerMsg('会话已结束，无法确认', 2500);
          return;
        }
        const btn = document.getElementById('confirmBtn');
        const toggle = document.getElementById('shareLocationToggle');
        const shareLocation = !!(toggle && toggle.checked);
        const ownerMessage = getOwnerMessage();
        
        btn.disabled = true;
        
        if (shareLocation) {
             btn.innerHTML = '<span>📍</span><span>获取位置中...</span>';
             if ('geolocation' in navigator) {
               const reqSeq = ++ownerLocationRequestSeq;
               navigator.geolocation.getCurrentPosition(
                 async (pos) => {
                   if (reqSeq !== ownerLocationRequestSeq) return;
                   ownerLocation = (toggle && !toggle.checked)
                     ? null
                     : { lat: pos.coords.latitude, lng: pos.coords.longitude };
                   await doConfirm(ownerMessage);
                 },
                 async (err) => {
                   if (reqSeq !== ownerLocationRequestSeq) return;
                   ownerLocation = null;
                   await doConfirm(ownerMessage);
                 },
                 { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
               );
             } else { ownerLocation = null; await doConfirm(ownerMessage); }
        } else {
            ownerLocationRequestSeq++;
            ownerLocation = null;
            await doConfirm(ownerMessage);
        }
      }
      async function clearOwnerLocation() {
        if (ownerSessionEnded) {
          showOwnerMsg('会话已结束');
          return;
        }
        try {
          const res = await fetch(API_BASE + '/clear-owner-location?session=' + encodeURIComponent(SESSION_TOKEN), { method: 'POST' });
          if (!res.ok) throw new Error('CLEAR_FAILED');
          showOwnerMsg('已清除位置');
        } catch (e) {
          showOwnerMsg('清除失败，请重试');
        }
      }
      async function terminateSession() {
        if (ownerSessionEnded) {
          showOwnerMsg('会话已结束');
          return;
        }
        try {
          const res = await fetch(API_BASE + '/terminate-session?session=' + encodeURIComponent(SESSION_TOKEN), { method: 'POST' });
          if (!res.ok) throw new Error('TERMINATE_FAILED');
          applyOwnerClosedState('会话已终止');
        } catch (e) {
          showOwnerMsg('终止失败，请重试');
        }
      }
      async function doConfirm(ownerMessage) {
        const btn = document.getElementById('confirmBtn');
        btn.innerHTML = '<span>⏳</span><span>确认中...</span>';
        try {
          const res = await fetch(API_BASE + '/owner-confirm?session=' + encodeURIComponent(SESSION_TOKEN), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ location: ownerLocation, message: ownerMessage || '' })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.success) {
            throw new Error(data.error || 'OWNER_CONFIRM_FAILED');
          }
          applyOwnerArrivingState();
        } catch(e) {
          if (String(e && e.message || '') === 'SESSION_CLOSED') {
            applyOwnerClosedState('会话已结束');
            return;
          }
          btn.disabled = false;
          btn.innerHTML = '<span>🚀</span><span>我已知晓，正在前往</span>';
          showOwnerMsg('确认失败，请重试');
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
  return htmlResponse(html);
}
