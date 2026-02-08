addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

const CONFIG = { KV_TTL: 3600 }

function isTruthyEnv(val) {
  if (val === undefined || val === null) return false;
  const v = String(val).trim().toLowerCase();
  return v !== '' && v !== 'false' && v !== '0' && v !== 'no';
}

async function handleRequest(request) {
  const url = new URL(request.url)
  const path = url.pathname

  if (path === '/api/notify' && request.method === 'POST') {
    return handleNotify(request, url);
  }

  if (path === '/api/get-location') {
    return handleGetLocation();
  }

  if (path === '/api/owner-confirm' && request.method === 'POST') {
    return handleOwnerConfirmAction(request);
  }

  if (path === '/api/check-status') {
    // 检查 KV 是否绑定，防止直接报错
    if (typeof MOVE_CAR_STATUS === 'undefined') {
      return new Response(JSON.stringify({ status: 'error', error: 'KV_NOT_BOUND' }), { headers: { 'Content-Type': 'application/json' } });
    }
    const status = await MOVE_CAR_STATUS.get('notify_status');
    const ownerLocation = await MOVE_CAR_STATUS.get('owner_location');
    return new Response(JSON.stringify({
      status: status || 'waiting',
      ownerLocation: ownerLocation ? JSON.parse(ownerLocation) : null
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (path === '/owner-confirm') {
    return renderOwnerPage();
  }

  return renderMainPage(url.origin);
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

    const body = await request.json();
    const message = body.message || '车旁有人等待';
    const location = body.location || null;
    const delayed = body.delayed || false;
    // --- 修改前 ---
    //  const confirmUrl = url.origin + '/owner-confirm';

    // --- 修改后：优先读取环境变量中的域名，如果没有配置则回退到原始域名 ---
    const baseDomain = (typeof EXTERNAL_URL !== 'undefined' && EXTERNAL_URL)
      ? EXTERNAL_URL.replace(/\/$/, "") // 去掉末尾斜杠
      : url.origin;

    const confirmUrl = baseDomain + '/owner-confirm';

    const confirmUrlEncoded = encodeURIComponent(confirmUrl);

    let notifyBody = `💬 留言: ${message}`;

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

    await MOVE_CAR_STATUS.put('notify_status', 'waiting', { expirationTtl: 600 });

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
      const meowBaseUrl = (typeof MEOW_BASE_URL !== 'undefined' && MEOW_BASE_URL)
        ? MEOW_BASE_URL.replace(/\/$/, '')
        : 'https://api.chuckfang.com';
      const meowMsgType = (typeof MEOW_MSG_TYPE !== 'undefined' && MEOW_MSG_TYPE)
        ? MEOW_MSG_TYPE
        : 'text'; // 修改默认值为 text，避免推送显示 html 标签
      const meowLocalSend = isTruthyEnv(typeof MEOW_LOCAL_SEND !== 'undefined' ? MEOW_LOCAL_SEND : null);
      const meowHtmlHeight = (typeof MEOW_HTML_HEIGHT !== 'undefined' && MEOW_HTML_HEIGHT)
        ? Number(MEOW_HTML_HEIGHT)
        : 260; // 适当增加默认高度以适应新样式
      const meowUrl = new URL(`${meowBaseUrl}/${encodeURIComponent(MEOW_NICKNAME)}`);
      meowUrl.searchParams.set('msgType', meowMsgType);

      let meowContent = '';
      if (meowMsgType === 'html') {
        meowUrl.searchParams.set('htmlHeight', String(meowHtmlHeight));
        // 构建完整的 HTML 页面结构
        const htmlBody = notifyBody.replace(/\\n/g, '<br>');
        meowContent = `
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
  <br><br>
  <a href="${confirmUrl}">👉 点击此处处理挪车请求</a>
</body>
</html>`;
      } else {
        // text 模式: 将 literal \n 替换为 实际换行符
        const textBody = notifyBody.replace(/\\n/g, '\n');
        meowContent = `${textBody}\n\n👉 点击此处处理挪车请求: ${confirmUrl}`;
      }

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

    const results = notificationTasks.length ? await Promise.all(notificationTasks) : [];
    if (localMeowRequest) {
      results.push({ service: 'MeoW(local)', status: 0, body: 'CLIENT_SEND' });
    }
    console.log('Notification tasks finished:', results);

    const responsePayload = {
      success: true,
      serviceCount: results.length,
      details: results
    };
    if (localMeowRequest) responsePayload.localMeowRequest = localMeowRequest;

    return new Response(JSON.stringify(responsePayload), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    // 返回具体错误信息给前端，方便调试
    console.error('Notify Error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message, stack: error.stack }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleGetLocation() {
  if (typeof MOVE_CAR_STATUS === 'undefined') return new Response(JSON.stringify({ error: 'KV_NOT_BOUND' }), { status: 500 });
  const data = await MOVE_CAR_STATUS.get('requester_location');
  if (data) {
    return new Response(data, { headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: 'No location' }), { status: 404 });
}

async function handleOwnerConfirmAction(request) {
  try {
    if (typeof MOVE_CAR_STATUS === 'undefined') return new Response(JSON.stringify({ error: 'KV_NOT_BOUND' }), { status: 500 });
    const body = await request.json();
    const ownerLocation = body.location || null;

    if (ownerLocation) {
      const urls = generateMapUrls(ownerLocation.lat, ownerLocation.lng);
      await MOVE_CAR_STATUS.put('owner_location', JSON.stringify({
        lat: ownerLocation.lat,
        lng: ownerLocation.lng,
        ...urls,
        timestamp: Date.now()
      }), { expirationTtl: CONFIG.KV_TTL });
    }

    await MOVE_CAR_STATUS.put('notify_status', 'confirmed', { expirationTtl: 600 });
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    // 即使出错也尝试设为确认，避免卡死
    if (typeof MOVE_CAR_STATUS !== 'undefined') {
      await MOVE_CAR_STATUS.put('notify_status', 'confirmed', { expirationTtl: 600 });
    }
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

function renderMainPage(origin) {
  const phone = typeof PHONE_NUMBER !== 'undefined' ? PHONE_NUMBER : '';

  const html = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, viewport-fit=cover">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="theme-color" content="#0093E9">
    <title>通知车主挪车</title>
    <style>
      :root {
        --sat: env(safe-area-inset-top, 0px);
        --sar: env(safe-area-inset-right, 0px);
        --sab: env(safe-area-inset-bottom, 0px);
        --sal: env(safe-area-inset-left, 0px);
      }
      * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; margin: 0; padding: 0; }
      html { font-size: 16px; -webkit-text-size-adjust: 100%; }
      html, body { height: 100%; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif;
        background: linear-gradient(160deg, #0093E9 0%, #80D0C7 100%);
        min-height: 100vh;
        min-height: -webkit-fill-available;
        padding: clamp(16px, 4vw, 24px);
        padding-top: calc(clamp(16px, 4vw, 24px) + var(--sat));
        padding-bottom: calc(clamp(16px, 4vw, 24px) + var(--sab));
        padding-left: calc(clamp(16px, 4vw, 24px) + var(--sal));
        padding-right: calc(clamp(16px, 4vw, 24px) + var(--sar));
        display: flex;
        justify-content: center;
        align-items: flex-start;
      }
      body::before {
        content: ''; position: fixed; inset: 0;
        background: url("data:image/svg+xml,%3Csvg width='52' height='26' viewBox='0 0 52 26' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.1'%3E%3Cpath d='M10 10c0-2.21-1.79-4-4-4-3.314 0-6-2.686-6-6h2c0 2.21 1.79 4 4 4 3.314 0 6 2.686 6 6 0 2.21 1.79 4 4 4 3.314 0 6 2.686 6 6 0 2.21 1.79 4 4 4v2c-3.314 0-6-2.686-6-6 0-2.21-1.79-4-4-4-3.314 0-6-2.686-6-6zm25.464-1.95l8.486 8.486-1.414 1.414-8.486-8.486 1.414-1.414z' /%3E%3C/g%3E%3C/g%3E%3C/svg%3E");
        z-index: -1;
      }
      .container {
        width: 100%; max-width: 500px; display: flex; flex-direction: column; gap: clamp(12px, 3vw, 20px);
      }
      .card {
        background: rgba(255, 255, 255, 0.95);
        border-radius: clamp(20px, 5vw, 28px);
        padding: clamp(18px, 4vw, 28px);
        box-shadow: 0 10px 40px rgba(0, 147, 233, 0.2);
        transition: transform 0.2s ease;
      }
      .card:active { transform: scale(0.98); }
      .header {
        text-align: left; padding: clamp(20px, 5vw, 32px) clamp(16px, 4vw, 28px); background: white;
        display: flex; align-items: center; gap: clamp(16px, 4vw, 24px);
      }
      .icon-wrap {
        width: clamp(60px, 15vw, 84px); height: clamp(60px, 15vw, 84px);
        background: linear-gradient(135deg, #0093E9 0%, #80D0C7 100%);
        border-radius: clamp(18px, 4vw, 26px);
        display: flex; align-items: center; justify-content: center;
        margin: 0;
        box-shadow: 0 12px 32px rgba(0, 147, 233, 0.35);
        flex-shrink: 0;
      }
      .icon-wrap span { font-size: clamp(32px, 8vw, 44px); }
      .header-content { flex: 1; }
      .header h1 { font-size: clamp(20px, 5vw, 26px); font-weight: 700; color: #1a202c; margin-bottom: 4px; line-height: 1.2; }
      .header p { font-size: clamp(13px, 3.5vw, 15px); color: #718096; font-weight: 500; }
      .input-card { padding: 0; overflow: hidden; }
      .input-card textarea {
        width: 100%; min-height: clamp(90px, 20vw, 120px); border: none;
        padding: clamp(16px, 4vw, 24px); font-size: clamp(15px, 4vw, 18px);
        font-family: inherit; resize: none; outline: none; color: #2d3748; background: transparent; line-height: 1.5;
      }
      .input-card textarea::placeholder { color: #a0aec0; }
      .tags {
        display: flex; gap: clamp(6px, 2vw, 10px);
        padding: 0 clamp(12px, 3vw, 20px) clamp(14px, 3vw, 20px);
        overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none;
      }
      .tags::-webkit-scrollbar { display: none; }
      .tag {
        background: linear-gradient(135deg, #e0f7fa 0%, #b2ebf2 100%);
        color: #00796b; padding: clamp(8px, 2vw, 12px) clamp(12px, 3vw, 18px);
        border-radius: 20px; font-size: clamp(13px, 3.5vw, 15px); font-weight: 600;
        white-space: nowrap; cursor: pointer; border: 1px solid #80cbc4;
        min-height: 44px; display: flex; align-items: center; transition: all 0.2s;
      }
      .tag:active { transform: scale(0.95); background: #80cbc4; }
      .loc-card {
        display: flex; align-items: center; gap: clamp(10px, 3vw, 16px);
        padding: clamp(14px, 3.5vw, 22px) clamp(16px, 4vw, 24px);
        cursor: pointer; min-height: 64px;
      }
      .loc-icon {
        width: clamp(44px, 11vw, 56px); height: clamp(44px, 11vw, 56px);
        border-radius: clamp(14px, 3.5vw, 18px); display: flex; align-items: center; justify-content: center;
        font-size: clamp(22px, 5.5vw, 28px); flex-shrink: 0;
      }
      .loc-icon.loading { background: #fff3cd; }
      .loc-icon.success { background: #d4edda; }
      .loc-icon.error { background: #f8d7da; }
      .loc-content { flex: 1; min-width: 0; }
      .loc-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .loc-title { font-size: clamp(15px, 4vw, 18px); font-weight: 600; color: #2d3748; }
      .loc-status { font-size: clamp(12px, 3.2vw, 14px); color: #718096; margin-top: 3px; }
      .loc-status.success { color: #28a745; }
      .loc-status.error { color: #dc3545; }
      .loc-status.disabled { color: #94a3b8; }
      .loc-icon.disabled { background: #e2e8f0; }
      .toggle {
        position: relative; display: inline-flex; align-items: center;
        width: 52px; height: 30px; flex-shrink: 0;
      }
      .toggle input { opacity: 0; width: 0; height: 0; }
      .toggle-slider {
        position: absolute; cursor: pointer; inset: 0;
        background: #cbd5f5; border-radius: 999px; transition: background 0.2s;
      }
      .toggle-slider::before {
        content: ""; position: absolute; height: 24px; width: 24px; left: 3px; top: 3px;
        background: white; border-radius: 50%; transition: transform 0.2s;
        box-shadow: 0 4px 10px rgba(0,0,0,0.15);
      }
      .toggle input:checked + .toggle-slider { background: #38bdf8; }
      .toggle input:checked + .toggle-slider::before { transform: translateX(22px); }
      .btn-main {
        background: linear-gradient(135deg, #0093E9 0%, #80D0C7 100%); color: white; border: none;
        padding: clamp(16px, 4vw, 22px); border-radius: clamp(16px, 4vw, 22px);
        font-size: clamp(16px, 4.2vw, 20px); font-weight: 700; cursor: pointer;
        display: flex; align-items: center; justify-content: center; gap: 10px;
        box-shadow: 0 10px 30px rgba(0, 147, 233, 0.35); min-height: 56px; transition: all 0.2s;
      }
      .btn-main:active { transform: scale(0.98); }
      .btn-main:disabled { background: linear-gradient(135deg, #94a3b8 0%, #64748b 100%); box-shadow: none; cursor: not-allowed; }
      .toast {
        position: fixed; top: calc(20px + var(--sat)); left: 50%;
        transform: translateX(-50%) translateY(-100px); background: white;
        padding: clamp(12px, 3vw, 16px) clamp(20px, 5vw, 32px); border-radius: 16px;
        font-size: clamp(14px, 3.5vw, 16px); font-weight: 600; color: #2d3748;
        box-shadow: 0 10px 40px rgba(0,0,0,0.15); opacity: 0;
        transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275); z-index: 100;
        max-width: calc(100vw - 40px);
      }
      .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
      #successView { display: none; }
      .success-card { text-align: center; background: linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%); border: 2px solid #28a745; }
      .success-icon { font-size: clamp(56px, 14vw, 80px); margin-bottom: clamp(12px, 3vw, 20px); display: block; }
      .success-card h2 { color: #155724; margin-bottom: 8px; font-size: clamp(20px, 5vw, 28px); }
      .success-card p { color: #1e7e34; font-size: clamp(14px, 3.5vw, 16px); }
      .owner-card { background: white; border: 2px solid #80D0C7; text-align: center; }
      .owner-card.hidden { display: none; }
      .owner-card h3 { color: #0093E9; margin-bottom: 8px; font-size: clamp(18px, 4.5vw, 22px); }
      .owner-card p { color: #718096; margin-bottom: 16px; font-size: clamp(14px, 3.5vw, 16px); }
      .map-links { display: flex; gap: clamp(8px, 2vw, 14px); flex-wrap: wrap; }
      .map-btn {
        flex: 1; min-width: 120px; padding: clamp(12px, 3vw, 16px); border-radius: clamp(12px, 3vw, 16px);
        text-decoration: none; font-weight: 600; font-size: clamp(13px, 3.5vw, 15px);
        text-align: center; min-height: 48px; display: flex; align-items: center; justify-content: center;
      }
      .map-btn.amap { background: #1890ff; color: white; }
      .map-btn.apple { background: #1d1d1f; color: white; }
      .action-card { display: flex; flex-direction: column; gap: clamp(10px, 2.5vw, 14px); }
      .action-hint { text-align: center; font-size: clamp(13px, 3.5vw, 15px); color: #718096; margin-bottom: 4px; }
      .btn-retry, .btn-phone {
        color: white; border: none; padding: clamp(14px, 3.5vw, 18px); border-radius: clamp(14px, 3.5vw, 18px);
        font-size: clamp(15px, 4vw, 17px); font-weight: 700; cursor: pointer; display: flex;
        align-items: center; justify-content: center; gap: 8px; transition: all 0.2s; min-height: 52px; text-decoration: none;
      }
      .btn-retry { background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); box-shadow: 0 8px 24px rgba(245, 158, 11, 0.3); }
      .btn-retry:active { transform: scale(0.98); }
      .btn-phone { background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); box-shadow: 0 8px 24px rgba(239, 68, 68, 0.3); }
      .btn-phone:active { transform: scale(0.98); }
      @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      .loading-text { animation: pulse 1.5s ease-in-out infinite; }
      .modal-overlay {
        position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); display: flex;
        align-items: center; justify-content: center; z-index: 200; padding: 20px;
        opacity: 0; visibility: hidden; transition: all 0.3s;
      }
      .modal-overlay.show { opacity: 1; visibility: visible; }
      .modal-box {
        background: white; border-radius: 20px; padding: clamp(24px, 6vw, 32px); max-width: 340px; width: 100%;
        text-align: center; transform: scale(0.9); transition: transform 0.3s;
      }
      .modal-overlay.show .modal-box { transform: scale(1); }
      .modal-icon { font-size: 48px; margin-bottom: 16px; }
      .modal-title { font-size: 18px; font-weight: 700; color: #1a202c; margin-bottom: 8px; }
      .modal-desc { font-size: 14px; color: #718096; margin-bottom: 24px; line-height: 1.5; }
      .modal-buttons { display: flex; gap: 12px; }
      .modal-btn {
        flex: 1; padding: 14px 16px; border-radius: 12px; font-size: 15px; font-weight: 600; cursor: pointer; border: none; transition: all 0.2s;
      }
      .modal-btn:active { transform: scale(0.96); }
      .modal-btn-primary { background: linear-gradient(135deg, #0093E9 0%, #80D0C7 100%); color: white; }
      .modal-btn-danger { background: linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%); color: #ef4444; }
      .countdown-container {
        display: flex;
        justify-content: center;
        margin: 24px 0;
        position: relative;
      }
      .flip-card {
        background: #1a202c;
        color: white;
        font-size: clamp(60px, 15vw, 80px);
        font-weight: 700;
        line-height: 1;
        padding: clamp(16px, 4vw, 24px) clamp(24px, 6vw, 32px);
        border-radius: 12px;
        min-width: 120px;
        text-align: center;
        box-shadow: 0 10px 30px rgba(0,0,0,0.2);
        position: relative;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        letter-spacing: 2px;
      }
      .flip-card::after {
        content: '';
        position: absolute;
        top: 50%;
        left: 0;
        right: 0;
        height: 2px;
        background: rgba(0,0,0,0.4);
        transform: translateY(-50%);
      }
    </style>
  </head>
  <body>
    <div id="toast" class="toast"></div>
    <div id="locationTipModal" class="modal-overlay">
      <div class="modal-box">
        <div class="modal-icon">📍</div>
        <div class="modal-title">位置信息说明</div>
        <div class="modal-desc">分享位置可让车主确认您在车旁<br>不分享将 <span style="font-weight:bold; font-size:1.2em;"> 延迟 </span> 发送通知</div>
        <div class="modal-buttons">
          <button class="modal-btn modal-btn-primary" onclick="hideModal('locationTipModal');">我知道了</button>
        </div>
      </div>
    </div>
    <div id="delayModal" class="modal-overlay">
      <div class="modal-box">
        <div class="modal-icon">⏳</div>
        <div class="modal-title">正在延迟发送</div>
        <div class="modal-desc">未提供位置信息，<br>将在倒计时结束后发送通知</div>
        <div class="countdown-container">
          <div id="countdownNum" class="flip-card">30</div>
        </div>
        <div class="modal-buttons">
          <button class="modal-btn modal-btn-danger" onclick="cancelDelay()">取消发送</button>
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
          <div class="tag" onclick="addTag('您的车挡住我了')">🚧 挡路</div>
          <div class="tag" onclick="addTag('临时停靠一下')">⏱️ 临停</div>
          <div class="tag" onclick="addTag('电话打不通')">📞 没接</div>
          <div class="tag" onclick="addTag('麻烦尽快')">🙏 加急</div>
        </div>
      </div>
      <div style="position: fixed; bottom: 10px; right: 10px; opacity: 0.3; font-size: 12px; color: #333; pointer-events: none;">v1.0.3</div>
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
      <div id="mapContainer" class="card" style="display:none; height: 200px; padding: 0; overflow: hidden; margin-top: -10px;"></div>
      <button id="notifyBtn" class="card btn-main" onclick="sendNotify()">
        <span>🔔</span>
        <span>一键通知车主</span>
      </button>
    </div>
    <!-- Add Leaflet CSS and JS -->
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin=""/>
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
    <script>
      let userLocation = null;
      let checkTimer = null;
      let delayTimer = null;
      let countdownVal = 30;
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
        if (toggle.checked) {
          requestLocation();
        } else {
          disableLocationSharing();
        }
      };
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
        map.invalidateSize();
      }

      function hideMap() {
        document.getElementById('mapContainer').style.display = 'none';
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
         if(el) el.innerText = countdownVal.toString().padStart(2, '0');
      }

      function cancelDelay() {
        clearInterval(delayTimer);
        hideModal('delayModal');
      }

      function sendNotify() {
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
          const res = await fetch('/api/notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg, location: locationToSend, delayed: delayed })
          });
          const data = await res.json();
          if (res.ok && data.success) {
            if (data.localMeowRequest) {
              sendMeowLocal(data.localMeowRequest).catch((err) => {
                console.error(err);
                showToast('⚠️ MeoW 本地发送失败，请重试');
              });
            }
            if (delayed) showToast('⏳ 通知将延迟30秒发送'); // Should basically never happen with forced false
            else showToast('✅ 发送成功！');
            document.getElementById('mainView').style.display = 'none';
            document.getElementById('successView').style.display = 'flex';
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
      function startPolling() {
        let count = 0;
        checkTimer = setInterval(async () => {
          count++;
          if (count > 120) { clearInterval(checkTimer); return; }
          try {
            const res = await fetch('/api/check-status');
            const data = await res.json();
            if (data.status === 'confirmed') {
              const fb = document.getElementById('ownerFeedback');
              fb.classList.remove('hidden');
              if (data.ownerLocation && data.ownerLocation.amapUrl) {
                document.getElementById('ownerMapLinks').style.display = 'flex';
                document.getElementById('ownerAmapLink').href = data.ownerLocation.amapUrl;
                document.getElementById('ownerAppleLink').href = data.ownerLocation.appleUrl;
              }
              clearInterval(checkTimer);
              if(navigator.vibrate) navigator.vibrate([200, 100, 200]);
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
        btn.disabled = true;
        btn.innerHTML = '<span>🚀</span><span>发送中...</span>';
        try {
          const res = await fetch('/api/notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: '再次通知：请尽快挪车', location: userLocation })
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
          } else { throw new Error('API Error'); }
        } catch (e) { showToast('❌ 发送失败，请重试'); }
        btn.disabled = false;
        btn.innerHTML = '<span>🔔</span><span>再次通知</span>';
      }
    </script>
  </body>
  </html>
  `;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

function renderOwnerPage() {
  const html = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, viewport-fit=cover">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="theme-color" content="#667eea">
    <title>确认挪车</title>
    <style>
      :root {
        --sat: env(safe-area-inset-top, 0px);
        --sar: env(safe-area-inset-right, 0px);
        --sab: env(safe-area-inset-bottom, 0px);
        --sal: env(safe-area-inset-left, 0px);
      }
      * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
      html { font-size: 16px; -webkit-text-size-adjust: 100%; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif;
        background: linear-gradient(160deg, #667eea 0%, #764ba2 100%);
        min-height: 100vh;
        min-height: -webkit-fill-available;
        padding: clamp(16px, 4vw, 24px);
        padding-top: calc(clamp(16px, 4vw, 24px) + var(--sat));
        padding-bottom: calc(clamp(16px, 4vw, 24px) + var(--sab));
        padding-left: calc(clamp(16px, 4vw, 24px) + var(--sal));
        padding-right: calc(clamp(16px, 4vw, 24px) + var(--sar));
        display: flex; flex-direction: column; align-items: center; justify-content: center;
      }
      .card {
        background: rgba(255,255,255,0.95); padding: clamp(24px, 6vw, 36px); border-radius: clamp(24px, 6vw, 32px);
        text-align: center; width: 100%; max-width: 420px; box-shadow: 0 20px 60px rgba(102, 126, 234, 0.3);
      }
      .emoji { font-size: clamp(52px, 13vw, 72px); margin-bottom: clamp(16px, 4vw, 24px); display: block; }
      h1 { font-size: clamp(22px, 5.5vw, 28px); color: #2d3748; margin-bottom: 8px; }
      .subtitle { color: #718096; font-size: clamp(14px, 3.5vw, 16px); margin-bottom: clamp(20px, 5vw, 28px); }
      .map-section {
        background: linear-gradient(135deg, #eef2ff 0%, #e0e7ff 100%); border-radius: clamp(14px, 3.5vw, 18px);
        padding: clamp(14px, 3.5vw, 20px); margin-bottom: clamp(16px, 4vw, 24px); display: none;
      }
      .map-section.show { display: block; }
      .map-section p { font-size: clamp(12px, 3.2vw, 14px); color: #6366f1; margin-bottom: 12px; font-weight: 600; }
      .map-links { display: flex; gap: clamp(8px, 2vw, 12px); flex-wrap: wrap; }
      .map-btn {
        flex: 1; min-width: 110px; padding: clamp(12px, 3vw, 16px); border-radius: clamp(10px, 2.5vw, 14px);
        text-decoration: none; font-weight: 600; font-size: clamp(13px, 3.5vw, 15px); text-align: center;
        transition: transform 0.2s; min-height: 48px; display: flex; align-items: center; justify-content: center;
      }
      .map-btn:active { transform: scale(0.96); }
      .map-btn.amap { background: #1890ff; color: white; }
      .map-btn.apple { background: #1d1d1f; color: white; }
      .btn {
        background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border: none; width: 100%;
        padding: clamp(16px, 4vw, 20px); border-radius: clamp(14px, 3.5vw, 18px); font-size: clamp(16px, 4.2vw, 19px);
        font-weight: 700; cursor: pointer; box-shadow: 0 8px 24px rgba(16, 185, 129, 0.35);
        display: flex; align-items: center; justify-content: center; gap: 10px; transition: all 0.2s; min-height: 56px;
      }
      .btn:active { transform: scale(0.98); }
      .btn:disabled { background: linear-gradient(135deg, #9ca3af 0%, #6b7280 100%); box-shadow: none; cursor: not-allowed; }
      .done-msg {
        background: linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%); border-radius: clamp(14px, 3.5vw, 18px);
        padding: clamp(16px, 4vw, 24px); margin-top: clamp(16px, 4vw, 24px); display: none;
      }
      .done-msg.show { display: block; }
      .done-msg p { color: #065f46; font-weight: 600; font-size: clamp(15px, 4vw, 17px); }
      
      /* Toggle Styles */
      .loc-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 20px; padding: 0 10px; }
      .loc-title { font-size: 16px; font-weight: 600; color: #2d3748; }
      .toggle {
        position: relative; display: inline-flex; align-items: center;
        width: 52px; height: 30px; flex-shrink: 0;
      }
      .toggle input { opacity: 0; width: 0; height: 0; }
      .toggle-slider {
        position: absolute; cursor: pointer; inset: 0;
        background: #cbd5f5; border-radius: 999px; transition: background 0.2s;
      }
      .toggle-slider::before {
        content: ""; position: absolute; height: 24px; width: 24px; left: 3px; top: 3px;
        background: white; border-radius: 50%; transition: transform 0.2s;
        box-shadow: 0 4px 10px rgba(0,0,0,0.15);
      }
      .toggle input:checked + .toggle-slider { background: #38bdf8; }
      .toggle input:checked + .toggle-slider::before { transform: translateX(22px); }
    </style>
  </head>
  <body>
    <div class="card">
      <span class="emoji">👋</span>
      <h1>收到挪车请求</h1>
      <p class="subtitle">对方正在等待，请尽快确认</p>
      <div id="mapArea" class="map-section">
        <p>📍 对方位置</p>
        <div class="map-links">
          <a id="amapLink" href="#" class="map-btn amap">🗺️ 高德地图</a>
          <a id="appleLink" href="#" class="map-btn apple">🍎 Apple Maps</a>
        </div>
      </div>
      
      <div class="loc-row">
        <div class="loc-title">向对方发送我的位置</div>
        <label class="toggle">
          <input id="shareLocationToggle" type="checkbox" checked>
          <span class="toggle-slider"></span>
        </label>
      </div>

      <button id="confirmBtn" class="btn" onclick="confirmMove()">
        <span>🚀</span>
        <span>我已知晓，正在前往</span>
      </button>
      <div id="doneMsg" class="done-msg">
        <p>✅ 已通知对方您正在赶来！</p>
      </div>
    </div>
    <script>
      let ownerLocation = null;
      window.onload = async () => {
        try {
          const res = await fetch('/api/get-location');
          if(res.ok) {
            const data = await res.json();
            if(data.amapUrl) {
              document.getElementById('mapArea').classList.add('show');
              document.getElementById('amapLink').href = data.amapUrl;
              document.getElementById('appleLink').href = data.appleUrl;
            }
          }
        } catch(e) {}
      }
      async function confirmMove() {
        const btn = document.getElementById('confirmBtn');
        const shareLocation = document.getElementById('shareLocationToggle').checked;
        
        btn.disabled = true;
        
        if (shareLocation) {
             btn.innerHTML = '<span>📍</span><span>获取位置中...</span>';
             if ('geolocation' in navigator) {
               navigator.geolocation.getCurrentPosition(
                 async (pos) => { ownerLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude }; await doConfirm(); },
                 async (err) => { ownerLocation = null; await doConfirm(); },
                 { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
               );
             } else { ownerLocation = null; await doConfirm(); }
        } else {
            ownerLocation = null;
            await doConfirm();
        }
      }
      async function doConfirm() {
        const btn = document.getElementById('confirmBtn');
        btn.innerHTML = '<span>⏳</span><span>确认中...</span>';
        try {
          await fetch('/api/owner-confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ location: ownerLocation })
          });
          btn.innerHTML = '<span>✅</span><span>已确认</span>';
          btn.style.background = 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)';
          document.getElementById('doneMsg').classList.add('show');
        } catch(e) {
          btn.disabled = false;
          btn.innerHTML = '<span>🚀</span><span>我已知晓，正在前往</span>';
        }
      }
    </script>
  </body>
  </html>
  `;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
