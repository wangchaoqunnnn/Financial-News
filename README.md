# Financial-News · 财经资讯聚合平台（真实数据版）

面向 **A股个人投资者** 的财经资讯聚合平台。对应《项目需求.md》（需求规格说明书 v1.1）。

> ⚠️ 本项目仅用于学习与研究，聚合第三方**公开接口**信息：内容版权归原平台所有，仅展示标题/摘要并保留原文链接；页面信息**不构成任何投资建议**。

## 运行（真实数据模式，推荐）

需要 **Node.js ≥ 18**（无需安装任何依赖）：

```bash
cd Financial-News
node server/server.js        # 启动后端（内置静态页面 + 数据代理）
# 浏览器打开 http://127.0.0.1:8899/
```

可选环境变量：

```bash
# 企业微信真实推送（重要消息 → 企微群机器人）。未配置时为本地记录/模拟。
WECOM_WEBHOOK=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx node server/server.js
PORT=8899 node server/server.js
```

页面**在线优先、仅实时模式**：连不上后端时**不会**显示演示数据，而是显示连接失败诊断面板（尝试的 URL、排查步骤、数据服务地址可填）并每 12 秒自动重连，连接成功即进入实时模式。"内置演示数据"仅作为面板中的调试按钮（显式点击才加载，并标注非实时）。

后端可部署在同源（nginx `/api` 反代）或**独立域名/端口**：页面离线面板可填写后端根地址（如 `https://api.wangchaoqun.top`，也可用 `?api=…` 或本地存储 `fn_api_base`），跨域已支持（服务端允许 CORS）。

## 真实数据源（服务端抓取，每 ~20s 增量轮询）

| 频道 | 来源 | 说明 |
|---|---|---|
| 快讯/资讯 | 新浪财经7×24、新浪财经滚动（要闻/国际/产经） | 实时财经快讯；相关性过滤 |
| 公告 | 巨潮资讯网（cninfo 官方公告检索 szse/sse） | 真实公告标题 + 巨潮 PDF 原文链接 |
| 传闻 | 真实媒体"传/曝/知情人士/网传"类消息 | 如实标注"未经证实"、默认不推送 |
| 行情（延时） | 东方财富 push2delay | 最新价/涨跌/成交额/换手，15s 级 |
| 分时图 | 东方财富 push2delay trends2 | 价格+均价+昨收 |
| 日K | 腾讯证券（前复权，备选：新浪） | 160 个交易日 |

> 雪球/微博直连需要登录授权或第三方舆情 API，默认关闭。启用方法见下文「社交源（雪球/微博）授权」。

## 社交源（雪球/微博）授权

雪球/微博的公开数据接口需要**登录态 Cookie**（雪球返回 WAF 验证页或 400016、微博返回"新浪访客验证"即为此原因）。配置后服务端会自动抓取「雪球热帖」「微博热搜（财经相关）」进入"传闻"频道（一律标注**未经证实**、默认不推送）。

> **Cookie 有效性校验**：设置页提交前会先调用真实接口验证——区分"有效 / 登录态失效 / 雪球WAF拦截 / 微博未登录"，**无效会拦截保存**并提示原因。
> **实测边界（2026）**：微博在提供**新鲜 SUB/SUBP Cookie**后可用；雪球热帖接口当前受**阿里云 WAF**保护，服务器端直连即使带 Cookie 也可能返回验证页（Cookie 需含 acw_* 参数，且受 IP 风控影响）——若雪球持续被 WAF 拦截，建议改用第三方舆情/雪球官方合作数据，页面会如实显示原因而不显示假数据。真实媒体"传/曝/知情人士"类标题**无需 Cookie** 即可进入"传闻"频道。

**第 1 步：获取 Cookie（浏览器操作）**

1. 用 Chrome/Edge 登录 https://xueqiu.com （雪球）和 https://weibo.com 或 https://m.weibo.cn （微博）；
2. 按 `F12` 打开开发者工具 → 切到 **Application（应用）** 面板 → 左侧 **Cookies** → 点击站点域名；
3. 逐条 Cookie 双击 **Value** 全选复制并拼接，或更简单：切到 **Network** 面板 → 刷新页面 → 点任意 xueqiu.com/m.weibo.cn 请求 → **Request Headers** 中找到 `Cookie:` 一整行，把整行值复制下来；
4. 关键 Cookie 参考：雪球 `xq_a_token`（及 `u`、`xqat`）；微博 `SUB`、`SUBP`（m.weibo.cn 另需 `WBPSESS`）。直接整串复制最稳妥。

**第 2 步：提交到设置页（推荐，立即生效、无需重启）**

1. 打开页面 **http://127.0.0.1:8899/** → 右上角 **「⚙ 设置」**；
2. 分别粘贴：雪球 Cookie / 微博 Cookie / 企业微信推送机器人 URL；
3. 点 **「保存并立即启用」** → 服务端立刻开始抓取社交源；可点 **「📨 发送测试推送」** 验证企微连通；
4. 「💬 企微推送」抽屉实时展示服务端自动推送记录（重要消息自动推送：同事件去重 + 20s 频控）。

以下为等效的 CLI / 配置文件方式（不想用页面设置时可选）：环境变量方式（PowerShell）：

```powershell
$env:XUEQIU_COOKIE="xq_a_token=xxxx; u=xxxx; xqat=xxxx"
$env:WEIBO_COOKIE="SUB=xxxx; SUBP=xxxx"
node server/server.js
```

或直接编辑配置文件（效果相同，已被 .gitignore 排除、不会提交）：

```json
// server/cookies.json
{ "xueqiu": "xq_a_token=…; u=…; …", "weibo": "SUB=…; SUBP=…; …" }
```

保存后**重启** `node server/server.js`（若用设置页提交则无需重启）。页面「⚙ 设置」与「数据来源与说明」会显示"雪球/微博：已启用 ✓"及最近的请求错误。

**注意**
- Cookie 等同账号凭证，**切勿提交到 Git/公开分享**（本项目已忽略 `server/cookies.json`）；
- 雪球/微博接口随时可能调整或触发风控，偶发失败属正常（页面会显示错误原因，服务端自动重试）；
- 请遵守目标平台服务条款与 robots 约定，控制频率（本项目已内置 30s/60s 节流），仅用于个人研究。

## 处理规则（轻量启发式，已在页面明示）

- 去重：标题指纹 + 小时窗 + 公告按证券代码区分（DP-1）
- 关联个股：A股代码词典（5900+ 只，含简称表）→ 点击股票标签打开**分时/日K走势图**（FR-04/FR-17）
- 重要消息：停复牌/立案/业绩预告/重组/政策等硬规则（DP-4）→ 进入企微推送队列
- 文本倾向：词典启发式，仅供参考（DP-3 简化版）
- 数据保留：服务端仅保留近 7 日正文，过期自动清理（R-1）

## 目录结构

```
├── 项目需求.md          # 需求规格说明书 v1.1
├── README.md
├── index.html           # 入口（JS 相对跳转到 web/index.html，兼容子路径部署并保留 #n= 深链）
├── server/              # Node 后端（零依赖）
│   ├── server.js        # 静态服务 + 数据源适配 + 去重/分类/关联 + 行情/K线代理 + API
│   └── package.json
└── web/                 # 前端（真实模式 + 离线演示降级）
    ├── index.html / styles.css
    ├── app.js           # 交互：轮询/筛选/搜索/自选/重要消息/热点榜/企微推送/canvas 分时+日K
    └── data.js          # 后端不可达时的内置演示数据（明确标注）
```

## API（前端同源调用）

`/api/meta` `/api/feed?type=&market=&q=&imp=&max=` `/api/stocks?q=` `/api/stocknews?code=`
`/api/quote?codes=600519,300750` `/api/minute?code=` `/api/kline?code=&days=` `/api/push-send`

## 部署到 https://wangchaoqun.top/news

企微推送消息自带**可点击的详情链接**（点击 → 在站点打开对应资讯详情页）。链接格式：`https://wangchaoqun.top/news#n=<消息id>`，页面会自动直达该条资讯。

> ⚠️ 子路径部署的经典坑：入口页 `index.html` 的跳转**必须用相对路径**。本仓库入口已改为 JS 相对跳转（`web/index.html` + 携带 `#n=`/`?` 参数），因此 `/news/` 下会正确解析为 `/news/web/index.html`，不会再跳到域名根 `/web/index.html` 造成 404。

**方案 A（推荐）：把应用目录直接挂到 /news，无跳转页**

把 `web/` 目录整体放到服务器 `/path/to/financial-news-web/`（内容：`index.html / styles.css / app.js / data.js`）：

```nginx
location = /news { return 301 /news/; }          # 目录补尾斜杠
location /news/ {
    alias /path/to/financial-news-web/;          # 直接指向 web 目录
    index index.html;
}
location /api {                                   # 后端代理（必须）
    proxy_pass http://127.0.0.1:8899;
    proxy_set_header Host $host;
    proxy_read_timeout 30s;
}
```

**方案 B：托管仓库根目录（入口页自动相对跳转）**

把整个仓库放到 `/path/to/Financial-News/`（含 `index.html` 与 `web/`）：

```nginx
location = /news { return 301 /news/; }
location /news/ {
    alias /path/to/Financial-News/;              # 仓库根：先出 index.html，再相对跳转 web/index.html
    index index.html;
}
location /api {
    proxy_pass http://127.0.0.1:8899;
    proxy_set_header Host $host;
    proxy_read_timeout 30s;
}
```

两种方式下：
- 前端所有资源用**相对路径**引用，`/news/` 下自动按子路径解析；
- 前端 API 用同源绝对路径 `/api/*`，由上面的 `/api` 反代转发到本机 8899（无跨域）；
- 深链 `https://wangchaoqun.top/news#n=<id>`：方案 A 直达应用并自动打开详情；方案 B 经入口页相对跳转，`#n=` 参数会被保留并同样直达详情。

**2. 后端与推送链接域名**

在同一台服务器运行 `node server/server.js`，并设置对外地址：

```bash
SITE_URL=https://wangchaoqun.top/news node server/server.js
# 未设置时默认即为 https://wangchaoqun.top/news（本地联调可改为 http://127.0.0.1:8899）
```

- 前端全部请求走相对路径 `/api/*`，由上面的 `/api` 反代转发到本机 8899（同源，无跨域问题）；
- 若站点本身没有其它应用、域名整个给本项目，可简化为 `location / { proxy_pass http://127.0.0.1:8899; }`，此时 `SITE_URL=https://wangchaoqun.top`；
- 在「⚙ 设置」填好企微 Webhook 后，推送消息中的"点击查看详情"链接即指向 `SITE_URL#n=<消息id>`；手机点击会打开浏览器并直达该资讯详情（超过 7 日保留期的消息会提示已清理）。

## 云服务器部署与更新（阿里云/腾讯云 Linux 推荐）

首次部署：

```bash
# 安装 Node（LTS，若无）
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs

# 拉代码（示例放 /www/wwwroot）
cd /www/wwwroot
git clone git@github.com:wangchaoqunnnn/Financial-News.git
cd Financial-News

# 装 systemd 服务并启动（编辑 deploy/financial-news.service 中目录/域名后）
cp deploy/financial-news.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now financial-news

# 验证
curl -s http://127.0.0.1:8899/api/meta   # version 应为 commit 短哈希
```

日常更新（一次一条命令）：

```bash
cd /www/wwwroot/Financial-News && bash deploy/update.sh
# 等效：git pull origin main && systemctl restart financial-news
# 验证：curl -s http://127.0.0.1:8899/api/meta  或 https://wangchaoqun.top/api/meta
```

- 配置 `server/cookies.json`（Cookie/企微/推送策略）不会被 git pull 覆盖（已 gitignore）；
- nginx 的 `/api` 反代与 `/news` 静态配置**首次配好就不用再动**；
- 想彻底自动化：给 GitHub 仓库加 `deploy` 分支的 Actions（SSH 到服务器执行 update.sh），需要时我可以帮你生成 workflow 文件（需服务器配置 SSH 私钥，勿提交私钥）。

## 已知边界

- 社交传闻（雪球/微博）需授权数据源；当前仅收录真实媒体的"传/曝"类标题。
- 北交所个股：行情可用，K线源暂缺（腾讯/新浪未覆盖时提示）。
- 新浪 7x24 为整点后短时快讯流，部分时段更新频率与源相关。
- 页面文本倾向为关键词启发式，非专业情绪模型。
