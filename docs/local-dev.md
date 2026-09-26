# 本地开发手册

> 从零到跑起来。生产部署见 `docs/deploy.md`，测试见 `docs/testing.md`。
> 上位文档：内部设计日志（未公开）（§4.5 工作流 / D29 构建策略 / D37 本地生产同构）

---

## 0. 核心原则：本地与生产**同路径**，不靠代码分支

这是整个本地环境设计里唯一需要记住的事：

```
线上   浏览器 → Cloudflare → Caddy ┬─ /        → PWA 静态文件
                                   └─ /api/*   → gateway:4000

本地   浏览器 → Vite dev server ────┬─ /        → PWA（热重载）
                                   └─ /api/*   → localhost:4000（dev proxy）
```

**两边前端请求的路径完全一样，都是 `/api`。** 代码里没有任何 `if (本地)`，
所以不存在「本地好好的、上线就 404」。切换靠各自的代理配置，不靠代码。

> **这条是踩出来的（D37）**：`auth.ts` 默认 `/api`、`sync.ts` 却用「没设
> `VITE_GATEWAY_URL` = 走模拟上传」判断 —— 同一件事两处默认值不一致，
> 结果本地登录 404、上传却静默假装成功。
> **网关地址的默认值现在只有一处：`apps/capture-pwa/src/config.ts`。**

### 本地与生产的**全部**差异

| | 本地 | 生产 |
|---|---|---|
| 应用怎么跑 | 网关与 PWA 在**宿主机**（热重载、能断点） | 都在容器里 |
| `/api` 谁转发 | Vite dev proxy | Caddy |
| Twenty 地址 | `localhost:3000` | 容器内网 `server:3000` |
| TLS | 无（`localhost` 本身就是 secure context） | Cloudflare |
| compose profile | 默认（db/redis/server/worker） | `--profile prod`（多 gateway/caddy） |

**除此之外代码完全相同。**

---

## 1. 端口

| 端口 | 谁 | 备注 |
|---|---|---|
| 5173 | PWA dev server | `/api` 代理到 4000 |
| 4000 | 网关 | 宿主机上 `npm run dev` |
| 3000 | Twenty | 容器，绑 `127.0.0.1` |
| 5432 | Postgres | 容器，绑 `127.0.0.1`（宿主机的网关要连它） |

> compose 里所有端口都只绑 `127.0.0.1` —— 同一份文件在 VPS 上也安全，
> 不需要 override 文件，也就不会有「忘了加 `-f` 把数据库暴露到公网」。

---

## 2. 从零起环境

### 2.1 前置

```bash
docker --version && docker compose version   # Docker Desktop 要开着
node --version                               # ≥ 24（原生跑 .ts，网关没有构建步骤）
```

### 2.2 `.env` —— 注意有**两个**

| 文件 | 谁读 | 进 git 吗 |
|---|---|---|
| `<仓库根>/.env` | docker compose、网关、`scripts/*.mjs` | ❌ |
| `apps/capture-pwa/.env.local` | 只有 Vite（`VITE_*`） | ❌ |

> 🔴 **Vite 不读仓库根的 `.env`。** `VITE_` 开头的变量必须放在
> `apps/capture-pwa/.env.local` 里，否则设了也不生效。

根 `.env` 照 `.env.example` 填。本地跑起来只需要这几个：

```bash
cp .env.example .env
# 至少要有：
#   PG_DATABASE_PASSWORD  ENCRYPTION_KEY  APP_SECRET   ← openssl rand
#   SERVER_URL=http://localhost:3000
#   APP_DATABASE_URL=postgres://postgres:<上面那个密码>@localhost:5432/boothnote
#   GATEWAY_JWT_SECRET   ← openssl rand -base64 48
#   OPENAI_API_KEY  TWENTY_API_KEY
```

PWA 侧一般**什么都不用配**（默认 `/api` + dev proxy 就对）。只有两种情况才需要：

```bash
# apps/capture-pwa/.env.local
VITE_MOCK_UPLOAD=1                      # 没有后端、纯调 UI 时
VITE_GATEWAY_ORIGIN=http://192.168.1.5:4000   # 网关不在本机时（dev proxy 的目标）
```

### 2.3 起数据层与 Twenty

```bash
docker compose up -d          # db / redis / server / worker
docker compose ps             # 等 server 变 healthy
```

> ⚠️ **首次会先报一次 `dependency failed`，是正常的**（生产也一样，见 `deploy.md` §3.1）：
> healthcheck 只给 100 秒，而首次要跑 213 步升级序列。等 server 转 healthy 后
> **再跑一次 `docker compose up -d`** 把 worker 补起来。

首次还要在 http://localhost:3000 建工作区、拿一个 API key 填进根 `.env` 的 `TWENTY_API_KEY`。

### 2.4 建表 + 建结构 + 导数据

```bash
cd services/gateway && npm install && npm run migrate    # boothnote 库的 app_user/inbox/staging
cd ../.. && node scripts/provision-twenty.mjs            # Twenty 的 7 个对象 + 70 个字段（幂等）
node scripts/import-accounts.mjs                         # 56 家展会目标客户（幂等）
```

### 2.5 建一个本地账号

```bash
cd services/gateway
npm run adduser -- alex "Alex" admin     # 密码随机生成，只打印一次
```

> 密码不接受命令行传入 —— 免得留在 shell history 里。

### 2.6 跑起来（两个终端）

```bash
# 终端 A —— 网关
cd services/gateway && npm run dev        # http://localhost:4000

# 终端 B —— PWA
cd apps/capture-pwa && npm install && npm run dev    # http://localhost:5173
```

打开 http://localhost:5173 登录。

### 2.7 验一下

```bash
./scripts/test.sh all      # 单元 + 集成
./scripts/smoke.sh         # 只读冒烟
```

---

## 2.8 管理控制台（建账号、停用账号）

**本地地址：`http://localhost:5173/console`**

它和采集端是**两个东西**：不进 PWA 的包，销售的手机上永远没有这段代码。

### 两个路径是两回事 —— 这里最容易搞混

| | 谁在管 | 值 |
|---|---|---|
| 网关里的真实路由 | `services/gateway/src/admin.ts` | **永远是 `/admin`**，写死的 |
| 对外的路径 | 本地 = `vite.config.ts` 的 proxy；线上 = `infra/caddy/Caddyfile` | `ADMIN_PATH`，**没设就是 `/console`** |

所以下面三个地址都能到同一个页面：

```
http://localhost:5173/console        ← 和线上长得一样，日常用这个
http://localhost:5173/api/admin      ← 走 /api 代理，等价
http://localhost:4000/admin          ← 直连网关，绕过前端
```

### 进去之后

页面上有一个 **Access token** 输入框，粘 `.env` 里 `ADMIN_TOKEN` 的值。

🔴 **token 不进 URL。** 不存在 `/console-<token>` 这种地址 ——
URL 会落进访问日志和浏览器历史。路径不好猜只是降噪，真正的门是那个输入框。

令牌只存在这个标签页的 `sessionStorage`，关掉就没了；连续错 8 次锁 15 分钟。

### 进不去的时候

| 症状 | 原因 |
|---|---|
| 打开的是**采集端 PWA** 不是控制台 | 路径没被代理接住，落到了 SPA 兜底 → **200，但返回的是 `index.html`**。这个失败最骗人：它不报 404 |
| `503 admin_disabled` | `.env` 里没有 `ADMIN_TOKEN`。**留空 = 控制台整个关闭，这是安全默认** |
| `401 bad_token` | 粘错了，或者改了 `.env` 但网关没重起 |
| 改了 `ADMIN_PATH` 没生效 | 本地要重起 **vite**（它在 proxy 配置里读这个变量）；线上要重起 **caddy** |

### 不想开浏览器的话

```bash
cd services/gateway && npm run adduser        # 密码本地随机生成，只打印一次
```

**密码不接受命令行传入** —— 免得留在 shell history 里。

---

## 3. 用手机测（T8 必须这么做）

**`localhost` 是 secure context，但 Mac 的局域网 IP 不是** —— 用手机开
`http://192.168.x.x:5173` 会直接拿不到 `navigator.mediaDevices`，录音按钮报错，
而且报错完全指不到原因。

```bash
cd apps/capture-pwa && npm run tunnel      # cloudflared，拿一个临时 https 地址
```

手机打开那个 `*.trycloudflare.com` 地址即可。进「我的」页看**本机录音能力**三项诊断。

> 隧道只转发 5173（PWA），而 `/api` 由 Vite dev proxy 转到本机 4000 —— 手机侧照常工作。

---

## 4. 日常

```bash
# 只改前端 → 只需要终端 B，网关不用重启
# 改了网关 → npm run dev 已带 --watch，自动重载
# 改了 twenty-schema.mjs → node scripts/provision-twenty.mjs（幂等，只补缺的）
# 改了 migrations/*.sql → cd services/gateway && npm run migrate

docker compose logs -f server    # Twenty 的日志
docker compose down              # 停掉数据层（数据在 volume 里，不会丢）
```

清空重来（**会删掉本地所有数据**）：

```bash
docker compose down -v && docker compose up -d
```

---

## 5. 常见问题

| 症状 | 原因 |
|---|---|
| 登录报「连不上服务器」 | 网关没跑。终端 A 起 `npm run dev` |
| `/api/*` 返回 Vite 的 404 页面 | dev server 是在改 `vite.config.ts` 之前起的，重启终端 B |
| 网关起不来，报缺 `TWENTY_API_KEY` | `env.ts` 是硬校验。去 Twenty 后台生成一个填进根 `.env` |
| 网关连不上库 | `APP_DATABASE_URL` 用的是 `@db:5432`（容器内名字）。**本机跑要用 `@localhost:5432`** |
| 上传显示成功但库里没有 | `VITE_MOCK_UPLOAD=1` 还开着。删掉 `apps/capture-pwa/.env.local` 里那行 |
| 手机上录音按钮报错 | 走了局域网 IP，不是 secure context → 用 `npm run tunnel` |
| `npm run build` 报 `Cannot find name 'process'` | `tsconfig.json` 的 `types` 里要有 `node`（`vite.config.ts` 用到了） |
| 集成测试说「跳过」 | 网关没跑，或不是 localhost（脚本会硬拒绝非本地） |
