# MoveCar 挪车通知系统

> 基于 Cloudflare Workers + KV 的隐私友好挪车通知系统。扫码通知车主，不暴露手机号。

## 项目简介

MoveCar 是一个纯 Serverless 的挪车通知方案：

- 路人扫码后可快速发送挪车请求
- 车主通过推送链接进入确认页，一键反馈“正在赶来”
- 双方可选共享位置，支持高德与 Apple Maps 快捷跳转
- 整个流程基于会话状态，不需要注册登录

## 核心能力

- 扫码即用，无需 App
- 支持 Bark / PushPlus / MeoW 多通道通知
- 可选完整车牌验证（`CAR_PLATE`）
- 支持再次提醒、会话终止、位置清除
- 车主端支持留言和“正在赶来”状态回传
- 支持车主会话总览页（活跃会话 + 历史会话）
- 云端部署成本低，适合个人长期使用

## 在线预览

- 请求者页面：https://htmlpreview.github.io/?https://github.com/TakeKazeX/movecar/blob/main/preview-requester.html
- 车主页面：https://htmlpreview.github.io/?https://github.com/TakeKazeX/movecar/blob/main/preview-owner.html

## 快速开始（Cloudflare Dashboard）

1. 创建 Worker
- 打开 Cloudflare Dashboard -> Workers & Pages -> Create -> Create Worker
- 命名为 `movecar`（或自定义）
- 将 `movecar.js` 全量粘贴并 Deploy

2. 创建 KV Namespace
- Dashboard -> KV -> Create namespace
- 名称建议：`MOVE_CAR_STATUS`

3. 绑定 KV 到 Worker
- Worker -> Settings -> Bindings -> Add -> KV Namespace
- Variable name 填：`MOVE_CAR_STATUS`

4. 配置环境变量
- 至少配置一个通知通道变量：`BARK_URL` / `PUSHPLUS_TOKEN` / `MEOW_NICKNAME`

5. 访问 Worker 地址测试
- 打开 `https://<your-worker>.<subdomain>.workers.dev/`
- 页面可正常加载并可发送通知即部署成功

## 环境变量

至少需要配置一项通知通道变量，否则无法发送通知。

| 变量名 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- |
| `BARK_URL` | 否 | Bark 推送地址 | `https://api.day.app/xxxxx` |
| `PUSHPLUS_TOKEN` | 否 | PushPlus Token | `xxxxxxxx` |
| `MEOW_NICKNAME` | 否 | MeoW 昵称（固定官方服务地址，仅 text 推送） | ` A1B2C3D4E5` |
| `MEOW_LOCAL_SEND` | 否 | `true` 时由前端本地发 MeoW | `true` |
| `CAR_PLATE` | 否 | 目标车牌（开启完整车牌验证） | `京A88888` |
| `PHONE_NUMBER` | 否 | 备用联系电话（请求者页显示） | `13000000000` |
| `EXTERNAL_URL` | 否 | 通知内链接域名，建议 HTTPS | `https://car.example.com` |
| `PASSWORD` | 否 | 车主会话总览路径保护前缀 | `mysecret` |

## 访问路径

| 路径 | 说明 |
| --- | --- |
| `/` | 请求者首页 |
| `/<sessionId>` | 恢复请求者会话页 |
| `/<ownerToken>` | 车主确认页（推送内链接） |
| `/owner-home` | 车主会话总览（未设置 `PASSWORD`） |
| `/<PASSWORD>/owner-home` | 车主会话总览（设置 `PASSWORD`） |

## 会话与数据生命周期

- 会话有效期：默认 10 分钟
- 会话结束后保留可查看窗口：默认 10 分钟
- 位置和留言 KV 保留：默认 1 小时
- 历史会话记录：最多 5 条，默认保留 30 天

## 使用流程

1. 请求者扫码打开页面
2. 可填写留言，选择是否共享位置
3. 点击发送通知（若配置 `CAR_PLATE`，会先验证完整车牌）
4. 车主收到通知并进入确认页
5. 车主确认“正在赶来”，可附带留言和位置
6. 请求者实时看到状态变化，可继续提醒或电话联系

## API 概览

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/notify` | `POST` | 发起挪车通知 |
| `/api/get-location` | `GET` | 获取请求者位置（车主侧） |
| `/api/owner-confirm` | `POST` | 车主确认并回传状态/位置/留言 |
| `/api/check-status` | `GET` | 请求者轮询会话状态 |
| `/api/get-session` | `GET` | 获取当前会话信息 |
| `/api/terminate-session` | `POST` | 终止会话 |
| `/api/clear-owner-location` | `POST` | 清除车主位置 |
| `/api/get-phone` | `POST` | 获取备用电话 |

## 安全建议

1. 给总览页加路径密码
    - 设置 `PASSWORD`，避免 `/owner-home` 被直接扫描

2. 开启区域访问限制（推荐）
    - 在 Cloudflare WAF 中限制仅中国地区访问
        1. 进入 Cloudflare Dashboard → 你的域名
        2. 左侧菜单点击「Security」→「WAF」
        3. 点击「Create rule」
        4. Rule name 填 `Block non-CN traffic`
        5. If incoming requests match 选择 `Country does not equal China`
        6. Then 选择 `Block`
        7. 点击「Deploy」

3. 使用 HTTPS 自定义域名
    - 配置 `EXTERNAL_URL` 指向你的正式域名，避免通知链接异常

## 制作挪车码

### 生成二维码

1. 复制你绑定的自定义域名或者你的 Worker 地址（如 `https://movecar.你的账号.workers.dev`）
2. 使用任意二维码生成工具（如 草料二维码、QR Code Generator）
3. 将链接转换为二维码并下载

### 美化挪车牌

使用 AI 工具生成精美的装饰设计：

- **🍌 NanoBanana** - 生成装饰图案和背景
- **🤖 ChatGPT** - 生成创意设计图

制作步骤：

1. 用 AI 工具生成你喜欢的装饰图案
2. 将二维码与生成的图案组合排版
3. 添加「扫码通知车主」提示文字
4. 打印、过塑，贴在车上

> 💡 用 AI 生成独一无二的挪车牌，让你的爱车更有个性！

## 效果图

![挪车码效果](demo.jpg)

## License

MIT

forked from nbbk/movecar from lesnolie/movecar