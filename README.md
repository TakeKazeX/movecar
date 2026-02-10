# MoveCar - 挪车通知系统

基于 Cloudflare Workers 的智能挪车通知系统，扫码即可通知车主，保护双方隐私。

## 界面预览

| 请求者页面 | 车主页面 |
|:---:|:---:|
| [🔗 在线预览](https://htmlpreview.github.io/?https://github.com/TakeKazeX/movecar/blob/main/preview-requester.html) | [🔗 在线预览](https://htmlpreview.github.io/?https://github.com/TakeKazeX/movecar/blob/main/preview-owner.html) |

## 亮点

- 🚗 扫码即用，不暴露电话号码
- 📍 位置共享可选，关闭共享会触发 30 秒延迟发送并支持取消
- 🧭 双向位置共享，附带高德地图与 Apple Maps 快捷入口
- 🔔 支持 Bark、PushPlus、MeoW 三种推送方式
- 🔁 会话内可再次通知，车主可留言、清除位置、终止会话
- 🧾 车主会话总览页，显示活跃会话与最近历史
- ☁️ 纯 Serverless，Cloudflare 免费额度即可覆盖日常使用

## 使用流程

### 请求者

1. 扫描车上二维码进入页面。
2. 输入留言内容（可选）。
3. 选择是否共享位置，关闭共享会触发 30 秒延迟发送并可取消。
4. 点击「一键通知车主」。
5. 等待车主确认，确认后可查看车主位置与留言。
6. 若无回应，可「再次通知」或使用 `PHONE_NUMBER` 直接联系。

### 车主

1. 收到 Bark / PushPlus / MeoW 推送通知。
2. 点击通知进入确认页面。
3. 可选择共享位置并添加留言。
4. 点击「我已知晓，正在前往」，对方将收到确认反馈。
5. 可清除自己的位置或终止会话。

### 会话规则

- 会话标识自动生成，默认 10 分钟未完成会自动结束。
- 会话结束后仍可查看约 10 分钟，随后自动清理。
- 请求者与车主的位置及留言默认保留 1 小时。
- 历史会话最多保留 5 条，默认保留 30 天。

## 流程图

```
请求者                              车主
  │                                  │
  ├─ 扫码进入页面                     │
  ├─ 填写留言、获取位置                │
  ├─ 点击发送                         │
  │   ├─ 有位置 → 立即推送 ──────────→ 收到通知
  │   └─ 无位置 → 30秒后推送 ────────→ 收到通知
  │                                  │
  ├─ 等待中...                        ├─ 查看请求者位置
  │                                  ├─ 点击确认，分享位置
  │                                  │
  ├─ 收到确认，查看车主位置 ←──────────┤
  │                                  │
  ▼                                  ▼
```

## 路径说明

- `/` 请求者页面
- `/<sessionId>` 恢复当前会话的请求者页面
- `/<ownerToken>` 车主确认页面（推送中提供）
- `/owner-home` 或 `/<PASSWORD>/owner-home` 车主会话总览

## 部署教程

### 第一步：注册 Cloudflare 账号

1. 打开 https://dash.cloudflare.com/sign-up
2. 输入邮箱和密码，完成注册

### 第二步：创建 Worker

1. 登录后点击左侧菜单「Workers & Pages」
2. 点击「Create」→「Create Worker」
3. 名称填 `movecar`（或你喜欢的名字）
4. 点击「Deploy」
5. 点击「Edit code」，删除默认代码
6. 复制 `movecar.js` 全部内容粘贴进去
7. 点击右上角「Deploy」保存

### 第三步：创建 KV 存储

1. 左侧菜单点击「KV」
2. 点击「Create a namespace」
3. 名称填 `MOVE_CAR_STATUS`，点击「Add」
4. 回到你的 Worker →「Settings」→「Bindings」
5. 点击「Add」→「KV Namespace」
6. Variable name 填 `MOVE_CAR_STATUS`
7. 选择刚创建的 namespace，点击「Deploy」

### 第四步：配置环境变量

至少配置一种推送方式：`BARK_URL`、`PUSHPLUS_TOKEN` 或 `MEOW_NICKNAME`。

| 变量 | 是否必填 | 说明 | 示例 |
|---|---|---|---|
| `BARK_URL` | 可选 | Bark 推送地址 | `https://api.day.app/xxxxx` |
| `PUSHPLUS_TOKEN` | 可选 | PushPlus 令牌 | `xxxxxx` |
| `MEOW_NICKNAME` | 可选 | MeoW 昵称 | `mycar` |
| `MEOW_BASE_URL` | 可选 | MeoW 服务地址，默认官方 | `https://api.chuckfang.com` |
| `MEOW_MSG_TYPE` | 可选 | `text` 或 `html`，默认 `text` | `html` |
| `MEOW_HTML_HEIGHT` | 可选 | MeoW HTML 消息高度，默认 260 | `320` |
| `MEOW_LOCAL_SEND` | 可选 | `true` 时由前端本地发送 MeoW | `true` |
| `EXTERNAL_URL` | 可选 | 通知里的确认链接域名，需 `https` 且无尾斜杠 | `https://nc.example.com` |
| `PHONE_NUMBER` | 可选 | 备用联系电话，将显示在请求者页面 | `13000000000` |
| `PASSWORD` | 可选 | 访问 `owner-home` 的路径前缀 | `mysecret` |

### 第五步：绑定域名（可选）

1. Worker →「Settings」→「Domains & Routes」
2. 点击「Add」→「Custom Domain」
3. 输入你的域名，按提示完成 DNS 配置
4. 如果使用自定义域名或反代，建议设置 `EXTERNAL_URL`

## 制作挪车码

### 生成二维码

1. 复制你绑定的自定义域名或者你的 Worker 地址（如 `https://movecar.你的账号.workers.dev`）
2. 使用任意二维码生成工具（如 草料二维码、QR Code Generator）
3. 将链接转换为二维码并下载

### 美化挪车牌

使用 AI 工具生成精美的装饰设计：

- **Nanobanana Pro** - 生成装饰图案和背景
- **ChatGPT** - 生成创意设计图

制作步骤：

1. 用 AI 工具生成你喜欢的装饰图案
2. 将二维码与生成的图案组合排版
3. 添加「扫码通知车主」提示文字
4. 打印、过塑，贴在车上

> 💡 用 AI 生成独一无二的挪车牌，让你的爱车更有个性！

### 效果展示

![挪车码效果](demo.jpg)

## 安全设置（推荐）

为防止境外恶意攻击，建议只允许中国地区访问。

### 方法一：使用 WAF 规则（推荐）

1. 进入 Cloudflare Dashboard → 你的域名
2. 左侧菜单点击「Security」→「WAF」
3. 点击「Create rule」
4. Rule name 填 `Block non-CN traffic`
5. If incoming requests match 选择 `Country does not equal China`
6. Then 选择 `Block`
7. 点击「Deploy」

### 方法二：在 Worker 代码中过滤

在 `movecar.js` 的 `handleRequest` 函数开头添加：

```javascript
async function handleRequest(request) {
  const country = request.cf?.country;
  if (country && country !== 'CN') {
    return new Response('Access Denied', { status: 403 });
  }

  // 下面保持原有逻辑
}
```

> ⚠️ 曾经被境外流量攻击过，强烈建议开启地区限制。

## License

MIT
