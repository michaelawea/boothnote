# 部署手册 · VPS + Cloudflare

> 目标机器 `203.0.113.10`（VPS，欧盟）· 域名 `example.com`（Cloudflare 托管）
> 仓库 `git@github.com:michaelawea/boothnote.git`
> 上位文档：内部设计日志（未公开）（D6 部署 / D29 构建策略 / §4.5 工作流 / R16 TLS 风险）

**这份文档是可以从头照着敲到尾的。** 每一节都标了「谁做」和「做完怎么验」。

**客户国家字段升级（#61）**：完整部署先完成数据库迁移、provision 新的 `hqCountryCode` SELECT 和只读预览，
再暂停旧网关、验证回填并停用旧文本输入，启动新网关/PWA 并检查健康。
停止后的回填失败会尝试恢复 schema 已就绪的新网关，同时以非零退出报告升级未完成；避免仅因国家迁移失败持续停机，也不会启动只写旧列的旧版本。
未回填客户暂显示未选国家，历史文本保留。[迁移、有限重试与异常处理](company-fields.md)。

**多事项灰度（#64–#65）**：`AGENT_MULTI_ITEMS` 默认 `0`，首次上线保持关闭；明确设置 `1` 并重新创建网关容器才注册多事项工具。
此开关通过 Compose 传入进程，`preflight.sh` 核对取值和传递链路。它不关闭既有事项的核对与回执，也不等于 assistant-ui 的前端界面开关。
`VITE_ASSISTANT_UI_ENABLED` 是 Caddy 镜像的构建参数，默认 `1` 仅开放 assistant-ui 设置选项，现行界面仍为默认。
设为 `0` 并重建 Caddy 镜像后，测试版库不进入产物和离线预缓存。

---

## 0. 全景与前置检查

### 0.1 部署后长什么样

```
浏览器 ──https──▶ Cloudflare 边缘 ──http(测试期)──▶ 203.0.113.10:80 ──▶ Caddy
                                                                        ├─ capture.example.com/      → PWA 静态文件
                                                                        ├─ capture.example.com/api/* → gateway:4000
                                                                        └─ crm.example.com/  → server:3000（Twenty）

容器：caddy · gateway · server(Twenty) · worker · db(Postgres) · redis
数据库：default（Twenty 自管，我们不碰）  +  boothnote（我们的 inbox/staging/账号）
```

**为什么 Cloudflare 之外还要 Caddy**：Cloudflare 在边缘管防护与缓存；Caddy 在源站管
「这个请求交给哪个容器」。一台机器一个 IP、两个子域名、三个后端 —— 源站必须有东西分流，
而且 PWA 是一堆静态文件，Twenty 不会替你发。删掉 Caddy 的代价是三个服务全部裸露公网。

**为什么子域名都是一层**：Cloudflare 免费版 Universal SSL 只覆盖 `example.com` 与 `*.example.com`。
`capture.example.com` 这种两层的**边缘证书不覆盖**，需要付费的 Advanced Certificate Manager。

### 0.2 开工前的检查清单

| 检查 | 命令 / 位置 | 期望 |
|---|---|---|
| 能 SSH | `ssh root@203.0.113.10` | 进得去 |
| 磁盘 | `df -h /` | ≥ 20 GB 可用（镜像约 5 GB） |
| 内存 | `free -g` | ≥ 4 GB（不足由 `server-init.sh` 加 swap 兜底） |
| 域名在 Cloudflare | `dig +short NS example.com` | 返回 `*.ns.cloudflare.com` |
| 手上有的东西 | — | 公司 OpenAI API Key · GitHub 账号 |

### 0.3 命名与端口

| 名称 | 值 |
|---|---|
| 采集 PWA | `capture.example.com`（**所有人用，手机上要手输一次**，故取短名） |
| Twenty | `crm.example.com`（你 + Lena，桌面） |
| 网关 | 不占子域名 —— `capture.example.com/api`，**同源零 CORS** |
| 对公网开放 | 仅 22（SSH）、80、443；Postgres 与 Twenty 只在容器内网 |

> D6：V1 之后要迁公司服务器，**这两个地址是临时的**，别印在任何对外材料上。

---

## 1. Cloudflare 后台（约 10 分钟）

### 1.1 DNS

**DNS → Records → Add record**，两条：

| Type | Name | IPv4 address | Proxy status |
|---|---|---|---|
| A | `voltline` | `203.0.113.10` | 🟠 **Proxied** |
| A | `voltline-crm` | `203.0.113.10` | 🟠 **Proxied** |

验证：

```bash
dig +short capture.example.com
# 橙云下会返回 Cloudflare 的 IP（104.x / 172.67.x），**不是** 203.0.113.10 —— 这是正常的
```

### 1.2 SSL/TLS —— 测试期用 `Flexible`

**SSL/TLS → Overview → `Flexible`**

源站不需要任何证书，Caddy 只服务 HTTP，配置最少。

**✅ 录音不受影响**：secure context 看的是**浏览器到 Cloudflare** 那一段，那段是 HTTPS，
`isSecureContext` 为 true，`MediaRecorder` 照常可用。

**🔴 代价（R16）**：Cloudflare 到服务器那一段是**明文 HTTP** ——
**登录密码、JWT、录音文件都在公网裸奔**。测试期数据丢了无所谓，故接受。
**退出条件写死：开始录真实客户情报、或给同事发正式账号之前，必须切 Full (strict)（见 §8）。**

`.env` 对应两行：

```
SITE_SCHEME=http://
TLS_DIRECTIVE=
```

> 🔴 **`SITE_SCHEME=http://` 不能漏。** 少了它，Caddy 会把 HTTP 跳转到 HTTPS，
> 而 Cloudflare 又用 HTTP 回源 → **无限重定向**（`ERR_TOO_MANY_REDIRECTS`）。
> 这是 Flexible 最常见的坑，而且报错完全指不到原因。

### 1.3 三条容易漏但会咬人的设置

针对 **`capture.example.com`**（PWA 那个）：

1. **Speed → Optimization → Content Optimization → Rocket Loader：关**
   它会重排 `<script>`，能把 SPA 和 Service Worker 弄坏。
2. **Caching → Cache Rules → Create rule**（R17，2026-08-07 实测有效）
   - 名称：`bypass-sw`
   - 表达式（点 `Edit expression` 直接粘，比点下拉框快且不会点错）：
     ```
     (http.request.uri.path eq "/sw.js") or (http.request.uri.path eq "/registerSW.js")
     ```
   - `Cache eligibility`：**Bypass cache**
     （**不要选 `Eligible for cache`** —— 它自己那行说明就写着「缓不缓存**仍然取决于
     cache-control 头**」，而这条防线必须是无条件的：哪天 Caddy 的 matcher 被改坏，
     `Eligible` 会老老实实开始缓存，而这类故障**完全无声**）
   - 选了 Bypass 之后 Edge TTL / Browser TTL 会消失 —— **这是对的，不是漏设了**

   建完 **Purge Cache** 清一次（不清的话边缘手里那份旧的还在，规则只管以后），然后复验：

   ```bash
   curl -sI https://<采集端>/sw.js | grep -iE 'cache-control|cf-cache-status'
   # cache-control: no-cache
   # cf-cache-status: DYNAMIC     ← BYPASS 或 DYNAMIC 都算过，都表示不走边缘缓存
   ```

   > **不做这条，用户卡在旧版本上** —— 你本地看着是新的、手机上永远是旧的。
   > 这是最难自查的一类故障，而展会前最后几天必然要改代码。
   >
   > 🔴 **只需要这一条规则，不要去动 zone 级的 Browser Cache TTL。**
   > 源站发的是 `no-cache`，被改写成 `max-age=14400` 看着像是第二个独立问题，
   > 其实是同一个：**Browser Cache TTL 只作用于 Cloudflare 判定「可缓存」的响应**，
   > Bypass 之后改写整个不发生。动 zone 设置是全 zone 的代价换零收益（规划文档 §2.29）。
3. 免费版**上传上限 100 MB**。90 秒音频约 1 MB，够用，知道有这条即可。

---

## 2. 服务器初始化（一次性）

### 2.1 一键脚本（Docker + swap + 防火墙）

```bash
ssh root@203.0.113.10
curl -fsSL https://raw.githubusercontent.com/michaelawea/boothnote/main/infra/server-init.sh | bash
```

> 仓库是私有的，上面这条 raw 链接取不到 —— **先按 §2.2 拿到代码，再跑 `./infra/server-init.sh`**。
> 或者把脚本内容手动粘贴执行。脚本是幂等的，重复跑无害。

它做三件事：**加 4 G swap**（构建镜像时内存会尖峰，小机器会 OOM）、**装 Docker**、
**配 ufw 只放行 SSH + Cloudflare 回源网段的 80/443**。

> **为什么防火墙这么配**：橙云的防护，只有在别人无法绕过它直连你的 IP 时才成立。

验证：

```bash
docker compose version        # 应输出 v2.x
ufw status | head -5          # 22 allow + 一堆 Cloudflare 网段
free -h | grep Swap           # 4G
```

### 2.2 拿到代码（deploy key，只读）

```bash
ssh-keygen -t ed25519 -C "boothnote-deploy" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub          # ← 复制这一整行
```

把公钥加到 **GitHub → `michaelawea/boothnote` → Settings → Deploy keys → Add deploy key**
（标题随便，**不要勾** Allow write access）。然后：

```bash
ssh -o StrictHostKeyChecking=accept-new -T git@github.com   # 应回 "Hi michaelawea/boothnote! You've successfully authenticated"
git clone git@github.com:michaelawea/boothnote.git ~/boothnote
cd ~/boothnote && ./infra/server-init.sh     # 若 §2.1 还没跑，现在跑
```

### 2.3 生成 `.env`

> 🔴 **密钥在服务器上现生成，不要从本机拷。** 本机那套是开发用的，
> 而且开发环境的密码可能出现在聊天记录、shell history 里。

```bash
cd ~/boothnote
cat > .env <<EOF
# ── Twenty ────────────────────────────────────────────────
TAG=v2.25.1
SERVER_URL=https://crm.example.com
PG_DATABASE_USER=postgres
PG_DATABASE_PASSWORD=$(openssl rand -hex 24)
PG_DATABASE_HOST=db
PG_DATABASE_PORT=5432
REDIS_URL=redis://redis:6379
ENCRYPTION_KEY=$(openssl rand -base64 32)
APP_SECRET=$(openssl rand -base64 32)
FALLBACK_ENCRYPTION_KEY=
STORAGE_TYPE=local
DISABLE_DB_MIGRATIONS=
DISABLE_CRON_JOBS_REGISTRATION=
STORAGE_S3_REGION=
STORAGE_S3_NAME=
STORAGE_S3_ENDPOINT=

# ── 域名与 TLS（测试期 = Cloudflare Flexible）──────────────
CAPTURE_DOMAIN=capture.example.com
CRM_DOMAIN=crm.example.com
ACME_EMAIL=you@example.com
SITE_SCHEME=http://
TLS_DIRECTIVE=

# ── 网关 ──────────────────────────────────────────────────
GATEWAY_JWT_SECRET=$(openssl rand -base64 48)
GATEWAY_PORT=4000
GATEWAY_TOKEN_DAYS=90
OPENAI_TRANSCRIBE_MODEL=gpt-4o-transcribe
OPENAI_EXTRACT_MODEL=gpt-5.6-luna

# ── 要手填的三个 ──────────────────────────────────────────
OPENAI_API_KEY=
TWENTY_API_KEY=
APP_DATABASE_URL=
EOF
chmod 600 .env

# 把 OpenAI key 填进去（粘贴时注意别带引号）
nano .env

# APP_DATABASE_URL 从上面生成的密码推出来，别手抄
PGPW=$(grep '^PG_DATABASE_PASSWORD=' .env | cut -d= -f2-)
sed -i "s#^APP_DATABASE_URL=.*#APP_DATABASE_URL=postgres://postgres:${PGPW}@db:5432/boothnote#" .env
grep -c '^[A-Z].*=.\+' .env      # 应为 22 左右；TWENTY_API_KEY 此刻仍为空，正常
```

---

## 3. 首次启动

分两步 —— 因为 Twenty 的 API key 要登录之后才拿得到，而网关需要它。

### 3.1 起数据层与 Twenty

```bash
cd ~/boothnote
docker compose up -d                    # db / redis / server / worker
watch -n5 'docker compose ps'           # 等 server 变 healthy，首次约 1–3 分钟（要跑 60+ 迁移）
```

> 🔴 **首次启动 compose 会先报一次失败，这是正常的**（2026-07-31 实测）。
> healthcheck 只给 100 秒（`5s × 20`），而首次要跑 213 步升级序列 —— 实测 **70 秒**才转 healthy，
> 但 compose 在此之前已经打出 `dependency failed to start: container boothnote-server-1 is unhealthy` 并退出，
> **`worker` 会停在 `Created` 起不来**。别当成部署失败：
>
> ```bash
> # 等 server 真的转 healthy（一般 1–3 分钟）
> until [ "$(docker inspect -f '{{.State.Health.Status}}' boothnote-server-1)" = healthy ]; do sleep 10; done
> docker compose up -d          # 再跑一次，把 worker 补起来
> ```

卡住的话看日志：`docker compose logs -f server`

### 3.2 起 Caddy，让域名通

```bash
docker compose --profile prod up -d --build caddy    # 首次构建含 PWA 编译，约 1–2 分钟
curl -sI http://localhost/ | head -3                  # 本机应返回 200
```

浏览器打开 **https://crm.example.com** → 创建工作区和管理员账号。

> 这一步只能你本人做 —— 账号密码不经第三方。

### 3.3 拿 Twenty API key，补 `.env`，起网关

Twenty 里 **Settings → API & Webhooks → 生成一个 key**，然后：

```bash
cd ~/boothnote
nano .env                                            # 填 TWENTY_API_KEY=

# 🔴 顺序：先迁移，再起网关。用一次性容器跑，不要用 exec（原因见下）
docker compose --profile prod run --rm --no-deps -T gateway node src/migrate.ts

docker compose --profile prod up -d --build gateway
curl -s http://localhost/api/health                  # {"ok":true,...}
```

> 🔴 **不能按「先起网关、再 `exec` 跑迁移」的顺序**（2026-07-31 实测）。
> 表还不存在时，网关启动阶段的 `resumePending`（`pipeline.ts`）就会去查 `inbox`，
> 直接 `42P01 relation does not exist` 崩溃 → 容器进入 `Restarting` 循环 → **`exec` 根本进不去**，
> 陷入「要起容器才能建表，要建表才能起容器」的死锁。
> `run --rm --no-deps` 起的是一次性容器，绕开这个循环。迁移是幂等的，重复跑无害。

---

## 4. 数据结构与初始数据

两个脚本都在仓库里，用一次性的 node 容器跑，**走 compose 内网直连 Twenty**（比绕公网快且不受 Cloudflare 影响）。

```bash
cd ~/boothnote

# ① 建 7 个自定义对象 + 64 个字段 + 阶段枚举（幂等，可反复跑）
docker run --rm --network boothnote_default -v ~/boothnote:/w -w /w \
  -e SERVER_URL=http://server:3000 node:24-alpine \
  node scripts/provision-twenty.mjs

# ② 导入 56 家展会目标客户（7 集团 + 49 品牌，幂等）
docker run --rm --network boothnote_default -v ~/boothnote:/w -w /w \
  -e SERVER_URL=http://server:3000 node:24-alpine \
  node scripts/import-accounts.mjs
```

> `data/accounts.json` 已在仓库里，所以服务器上**不需要 Python、也不需要那份 Excel**。
> 名单要更新时，在本机跑 `python3 scripts/extract-accounts.py` 重新生成后提交。

验证：Twenty 左侧应出现「竞品/供应商 · Voltline 产品 · 产品选型情报 · 情报清单项 ·
拜访/事件 · 录入人 · 售后问题」，Companies 里有 56 条。

---

## 5. 账号

```bash
cd ~/boothnote
docker compose --profile prod exec -T gateway node src/cli-adduser.ts alex "维护者" admin
docker compose --profile prod exec -T gateway node src/cli-adduser.ts jonas  "Jonas"   staff
docker compose --profile prod exec -T gateway node src/cli-adduser.ts lena "Lena"  management
```

> **密码由脚本随机生成、只打印一次，抄走。** 脚本不接受命令行传密码 —— 免得留在 history 里。
> 角色见 D35：`admin` 全权 · `management`/`staff` 能看看板 · `user` 只看自己的。
> 建账号会自动在 Twenty 里同步一条 `contributor`（只有代号和名字，**密码永不进 Twenty**）。

撤权（立即生效，不用等 token 过期）：

```bash
docker compose exec -T db psql -U postgres -d boothnote \
  -c "update app_user set is_active=false where user_code='jonas'"
```

---

## 5.1 管理控制台

> **它在哪、怎么进、为什么进不去** —— 这一节被踩过一次（2026-08-03），所以写全。

### 先搞清楚两个路径是两回事

| | 谁在管 | 值 |
|---|---|---|
| **网关里的真实路由** | `services/gateway/src/admin.ts` | **永远是 `/admin`**，写死的，不受任何环境变量影响 |
| **对外的路径** | `infra/caddy/Caddyfile` 里的 `handle {$ADMIN_PATH:/console}*` | `.env` 的 `ADMIN_PATH`，**没设就是 `/console`** |

Caddy 把 `<对外路径>*` 重写成 `/admin` 再转给网关。
**所以 `ADMIN_PATH` 是 Caddy 读的，网关根本不认识这个变量** —— 改了它只改对外地址，不改网关。

### 配置

```bash
cd /opt/boothnote
cat >> .env <<EOF
ADMIN_TOKEN=$(openssl rand -base64 32 | tr -d '\n=')
EOF
docker compose --profile prod up -d --build caddy gateway
```

`ADMIN_PATH` **可以不设** —— 不设就是 `/console`。想要一个不好猜的：

```bash
echo "ADMIN_PATH=/console-$(openssl rand -hex 6)" >> .env
grep '^ADMIN_PATH=' .env          # 记下来，那就是地址
docker compose --profile prod up -d caddy    # 只有 caddy 需要重起
```

### 怎么进

1. 浏览器打开 **`https://<采集端域名><ADMIN_PATH>`**（没设 `ADMIN_PATH` 就是 `https://<采集端域名>/console`）
2. 页面上有一个 **Access token** 输入框 —— 把 `.env` 里 `ADMIN_TOKEN` 的值粘进去，点「进入」
3. 令牌只存在这个标签页的 `sessionStorage`，**关掉就没了**；连续错 8 次锁 15 分钟

🔴 **token 不进 URL。** 不存在 `/console-<token>` 这种地址 ——
URL 会落进 Caddy 访问日志、Cloudflare 日志、浏览器历史和任何一次截图。
路径不好猜只是降噪，**真正的门是那个输入框**。

### 能做什么

| 能做 | 说明 |
|---|---|
| 新建账号 | 密码可自填、也可留空由服务端生成。**只显示一次** —— 服务端只存 scrypt 哈希，之后看不了 |
| 停用 / 启用 | 停用会 `token_version+1`，本人**当场下线**，不用等 90 天 token 过期 |
| 真删 | **只有一条速记都没有的账号才允许** —— 原文只增不改，删账号会连着删掉他录过的东西。守卫在服务端 |
| 改密码 | **没有这个功能。** 忘了只能停用后重建 |

### 进不去的时候

| 症状 | 原因 | 修法 |
|---|---|---|
| 页面打开是**采集端 PWA**，不是控制台 | 两个根因：**① PWA 的 Service Worker 截胡**（作用域 `/`，`navigateFallback` 把所有导航都答成 PWA 壳，**浏览器不去问服务器**）；② 路径没被 Caddy 接住，落到 SPA 兜底 | 先 `curl -s <地址> \| grep -o '<title>[^<]*'`（curl 不走 SW）：curl 对、浏览器不对 = SW；两个都不对 = 路径。<br>SW 的修法：部署 2026-08-03 之后的版本（`navigateFallbackDenylist` 已加），并在那台机器上 Unregister 一次旧 SW |
| `503 admin_disabled` | `.env` 里没有 `ADMIN_TOKEN` | 设上再重起 gateway。**留空 = 整个控制台关闭，这是安全默认，不是故障** |
| `401 bad_token` | 粘错了，或者 `.env` 改了但 gateway 没重起 | `docker compose --profile prod restart gateway` |
| `429 locked` | 连续错 8 次，锁 15 分钟 | 等，或重起 gateway 清掉计数 |
| 改了 `ADMIN_PATH` 但地址没变 | 只重起了 gateway | **重起的是 `caddy`** —— 这个变量是 Caddy 读的 |

> ⚠️ 现在是 Flexible（R16）：Cloudflare 到源站那一段是明文，**这个 token 和新建的密码都会在那段裸奔**。
> 发正式账号之前先按 §8 切 Full (strict)。

## 6. 验收

### 6.1 服务端

```bash
curl -fsS https://crm.example.com/healthz && echo " ← Twenty ✅"
curl -fsS https://capture.example.com/api/health  && echo " ← 网关 ✅"
curl -fsS -o /dev/null -w "PWA HTTP %{http_code}\n" https://capture.example.com/

# 登录 → 拿 token → 读客户名单
TOK=$(curl -s -X POST https://capture.example.com/api/auth/login \
  -H 'Content-Type: application/json' -d '{"userCode":"alex","password":"刚抄的密码"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -s https://capture.example.com/api/companies -H "Authorization: Bearer $TOK" \
  | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["items"]),"家客户 ✅")'
```

### 6.2 🔴 真机验收（T8，这才是关键的一步）

服务端全绿不代表手机上能录音。**必须用真手机走一遍**：

1. iPhone Safari 打开 `https://capture.example.com`，登录
2. 进「**我的**」页看**本机录音能力**：
   - `Secure context` / `mediaDevices` / `MediaRecorder` 三个是否都 ✓
   - **「将使用容器」是什么** —— 记下来（Safari 18.4 前只有 mp4，之后才有 webm）
3. 回「速记」页**真录一条**（说一句带品牌名的话），保存 → 看顶部状态条是否从「待传」变「已同步」
4. 进「Agent」页，等 10–20 秒，看**转写与抽取结果**
5. **「分享 → 添加到主屏幕」**，从主屏图标启动，再录一条
   （PWA 独立模式下权限与生命周期行为可能不同，必须单独验）
6. 开飞行模式再录一条 → 应显示「离线 · 待传 1」；关飞行模式 → 应自动补传

任何一步不通，回 §10 对照表。

---

## 6.3 测试（本地与生产分层）

```bash
./scripts/test.sh              # 单元 —— 纯逻辑，永远安全，改代码时随手跑
./scripts/test.sh all          # 单元 + 集成（集成需本地网关 + boothnote 库）
./scripts/test.sh smoke        # 只读冒烟，本地
./scripts/smoke.sh https://capture.example.com https://crm.example.com
```

| 层 | 碰什么 | 能对生产跑吗 |
|---|---|---|
| **单元** | 什么都不碰 | ✅ 安全 |
| **集成** | 真 HTTP + **真库（建/删数据）** | 🔴 **不行**，脚本会硬拒绝非 localhost |
| **冒烟** | 只读 curl | ✅ 部署后必跑 |

冒烟测试会检查 R17（`sw.js` 是否被 Cloudflare 缓存）—— 那是「等你发现时已经影响所有人」的那类问题。

每层测了什么、为什么这么分、怎么加新 case，见 **`docs/testing.md`**。

## 7. 日常运维

### 7.1 发版

在**本机**：

```bash
./deploy.sh                    # push → 服务器 pull → 在 x86 上现 build → 迁移 → 冒烟
./deploy.sh --migrate-only     # 只跑数据库迁移
```

需要 `.env` 里有 `DEPLOY_HOST=root@203.0.113.10`。

### 7.2 看日志

```bash
docker compose logs -f --tail=100 gateway      # 网关（转写/抽取失败会在这）
docker compose logs -f --tail=100 server       # Twenty
docker compose logs -f --tail=50  caddy        # 访问与 TLS
docker compose ps                              # 谁挂了
```

### 7.3 备份与回退（D79）

**先说清楚两个数，别混：**

| | 是什么 | 我们的值 |
|---|---|---|
| **RPO** | 出事时**最多丢多少数据** | **24 小时**（展会期间开 `--quick` 可降到 15 分钟） |
| **保留期** | **能回退多久** | daily 14 天 · weekly 8 周 · **labeled 永久** |

> 🔴 2026-08-07 之前只有「每天 03:00 一次」，也就是 **RPO = 24 小时**。
> 那意味着一次下午的事故要丢掉半天的展会记录 —— 而那是唯一不可再生的资产。
> **真正救命的从来不是「能回退 4 天」，是「能回到那个脚本跑之前」。**

装三条 cron（`crontab -e`）。**生产上 2026-08-07 已经装好了**，这里留作重建时的参照：

```
*/15 * * * *  /opt/boothnote/infra/backup.sh --quick  >> /var/log/boothnote-backup.log 2>&1
0 3 * * *     /opt/boothnote/infra/backup.sh          >> /var/log/boothnote-backup.log 2>&1
0 4 * * 0     /opt/boothnote/infra/backup.sh --verify  >> /var/log/boothnote-backup.log 2>&1
```

**第一条决定 RPO**（24 小时 → 15 分钟）。原来它被写成「展会那 10 天再加」，
但 T61 的教训是：**脚本改了不等于生效** —— D79 把 RPO 压到 15 分钟写进了脚本，
而线上 crontab 还是老的那一条，真实 RPO 一直是 24 小时，直到有人去装。
dump 一次约 0.5 MB（96 小时 ≈ 230 MB），常年开着也不贵，没有理由等到展会才装。
**展会那 10 天把 `*/15` 改成 `*/5`。**

🔴 **第三条（每周恢复演练）不是可选的。** 脚本自己写着「没恢复过的备份不算备份」，
但 `--verify` 原来只能手动跑 —— 于是它在写完那天被跑过一次，然后再也没有。
备份最恶劣的失败模式是**一直在跑、一直有文件、而那些文件恢复不出来**。
排在 daily（03:00）之后一小时，验的就是当天最新那份。

**四档产物**（`backups/` 下）：

```
daily/     每天 + 自包含音频归档 tar          保留 14 天
weekly/    每周日提升上来的                   保留 8 周
labeled/   deploy.sh 在改动前自动打的         **永不自动删** ← 出事就是它救命
audio-mirror/  音频与 agent-sessions 的增量镜像（每次同步只复制新增的）
```

⚠️ **三件必须知道的**：
- **`pg_dump` 不含音频。** 音频走 `audio-mirror/` 增量同步（每 15 分钟），
  daily 再打一个自包含的 tar 供异地推送。原来只有 daily 的 tar，音频 RPO 被钉在 24 小时。
- **本地副本不算异地备份。** 配 `BACKUP_REMOTE`（rclone，欧盟区对象存储，R5 / T21）才算数。
  三份 dump 和数据库在同一块盘上，机器没了就一起没了。
- **没有恢复过的备份不算备份** —— 见下面的演练。

**恢复演练（每周至少跑一次，改数据模型之后必跑）：**

```bash
./infra/backup.sh --verify
```

它把最新的 `boothnote` dump 真的灌进一个临时库，再逐表比对行数，跑完自动删掉临时库。
只看文件大小不算数：gzip 一个空 dump 也有几十字节。

**真的要回退时：**

```bash
# 1. 先给「坏掉的现状」也存一份 —— 不然查不了「到底出了什么事」
./infra/backup.sh --label incident-$(date -u +%Y%m%dT%H%M%SZ)

# 2. 找那次变更之前的标签备份
ls -lt backups/labeled/

# 3. 停网关，避免恢复过程中有新写入
docker compose --profile prod stop gateway

# 4. 恢复（两个库分开来，按需要）
gunzip -c backups/labeled/pre-deploy-<sha>-boothnote-<时间戳>.sql.gz \
  | docker compose exec -T db psql -U postgres -d boothnote
gunzip -c backups/labeled/pre-deploy-<sha>-default-<时间戳>.sql.gz \
  | docker compose exec -T db psql -U postgres -d default

# 5. 起回来 + 冒烟
docker compose --profile prod start gateway
./scripts/smoke.sh https://<capture 域名> https://<crm 域名>
```

> ⚠️ **`inbox` 只增不改**（§4.2 第 2 条，库里有触发器）。
> 恢复是整库导入、不是逐行 UPDATE，所以不会被触发器挡 ——
> 但**恢复之后新录的那些会被覆盖掉**。所以第 1 步的 incident 备份不能省。

**监控备份有没有停：** `backups/LAST_OK_full` 里是最后一次成功的时刻。
超过 25 小时没更新就说明 cron 挂了 —— 而 cron 静默失败和一切正常在外面看来完全一样。

### 7.4 磁盘

音频约 1 MB / 90 秒。展会 10 天 × 5 人 × 20 条 ≈ 1 GB，不紧张，但要看着：

```bash
df -h /
docker system df
docker compose --profile prod exec -T gateway du -sh /data/audio
docker system prune -af --filter "until=168h"    # 清 7 天前的悬空镜像
```

### 7.5 升级 Twenty

```bash
cd ~/boothnote && ./infra/backup.sh          # 🔴 先备份，升级会跑数据库迁移
nano .env                                # 改 TAG=v2.26.0
docker compose up -d server worker
docker compose logs -f server            # 看迁移是否跑完
```

失败就把 `TAG` 改回去、`up -d`、从备份恢复数据库。

### 7.9 清空「录入产生的一切」，回到全新状态（D116）

> **什么时候用**：测试期结束、要开始录真实情报之前，把测试数据清干净。
> 🔴 **展会开始之后不要跑** —— 那时 `inbox` 里的是唯一不可再生的资产（§4.2 第 2 条）。
> 这个脚本会**临时关掉那三张表的只增不改触发器**，跑完自检装回去。

**删**：拜访 · 选型情报 · 情报取值 · 商机 · 售后 · 项目 · 任务线程 · 项目文档 ·
**不在 56 家名单里的客户** · boothnote 八张表 · 音频文件
**留**：56 家名单 · 竞品名单 · 情报清单 19 项 · 录入人 · 联系人 · `app_user` 账号

在**服务器上**（`cd /opt/boothnote`）：

```bash
docker run --rm --network boothnote_default -v "$PWD:/repo" -v boothnote_audio-data:/data/audio -e GATEWAY_AUDIO_DIR=/data/audio -w /repo --env-file .env node:24-alpine node scripts/reset-entry-data.mjs
```

先看这一份清单 —— 它只数数，什么都不动。数对了再加两个参数真删：

```bash
docker run --rm --network boothnote_default -v "$PWD:/repo" -v boothnote_audio-data:/data/audio -e GATEWAY_AUDIO_DIR=/data/audio -w /repo --env-file .env node:24-alpine node scripts/reset-entry-data.mjs --yes --i-am-on crm.example.com
```

🔴 **`-v boothnote_audio-data:/data/audio` 和 `-e GATEWAY_AUDIO_DIR=/data/audio` 都不能省。**
音频真正在的地方由**网关镜像里的 `ENV GATEWAY_AUDIO_DIR=/data/audio`** 定死
（`services/gateway/Dockerfile:22`）—— 它**不在 compose 的 `environment:` 白名单里，
也不一定在服务器的 `.env` 里**。少给这两个参数，`env.ts` 会回退到
`<仓库根>/data/audio`（那是个空目录），于是脚本删掉个寂寞，
而卷里的真音频一个字节没动。
脚本对这种情况**不会假装成功** —— 它会打「🔴 不动 —— GATEWAY_AUDIO_DIR 没显式给」
并在末尾说「音频没动」。但别指望靠它兜底，参数照给。

⚠️ **`--i-am-on` 必须写出 `SERVER_URL` 里那个主机名**，对不上直接拒跑。
故意这么设计的：不接受 `=1` 那种开关 —— 一个忘在 shell profile 里的 `1`
会在你完全没想起它的那天清空生产库。

🔴 **Twenty 侧走 REST DELETE = 硬删**（§2.38），**回不来**。先跑一次备份：

```bash
./infra/backup.sh
```

跑完按脚本末尾的提示收三步（都幂等）：

```bash
docker run --rm --network boothnote_default -v "$PWD:/repo" -w /repo --env-file .env node:24-alpine node scripts/backfill-timeline.mjs --yes
```

```bash
docker run --rm --network boothnote_default -v "$PWD:/repo" -w /repo --env-file .env node:24-alpine node scripts/import-accounts.mjs --backfill
```

```bash
docker run --rm --network boothnote_default -v "$PWD:/repo" -w /repo --env-file .env node:24-alpine node scripts/recompute-intel.mjs --yes
```

**清不到的两处**（脚本自己也会说）：

- **手机 / 浏览器里的本地速记**（IndexedDB）—— 只能在那台设备上清：
  DevTools → Application → Storage → Clear site data。⚠️ 会连登录态一起清，清完要重登。
- **名单内客户上被录入填过的自由文本**（如 `annualProduction`）——
  它在 `accounts.json` 里本来就有，事后分不清是导入写的还是录入写的。
  上面那条 `--backfill` 会把有官方值的补回去，官方值为空的那些留着。


## 8. 测试期结束 → 切 Full (strict)

**触发条件：开始录真实客户情报，或给同事发正式账号。**
之前是测试数据丢了无所谓；之后是 §4.2 说的「唯一不可再生的资产」，
而 Flexible 下它们在 Cloudflare 到源站之间是明文的（R16）。

```bash
# 1. Cloudflare → SSL/TLS → Origin Server → Create Certificate
#    Hostnames: capture.example.com, crm.example.com
#    有效期 15 年。两段内容分别粘到下面两个文件。
mkdir -p ~/boothnote/infra/caddy/certs
nano ~/boothnote/infra/caddy/certs/origin.pem
nano ~/boothnote/infra/caddy/certs/origin.key
chmod 600 ~/boothnote/infra/caddy/certs/origin.key

# 2. 改 .env 这两行（必须一起改）
#    SITE_SCHEME=
#    TLS_DIRECTIVE=tls /certs/origin.pem /certs/origin.key
nano ~/boothnote/.env

# 3. 重启 Caddy
cd ~/boothnote && docker compose --profile prod up -d caddy
docker compose logs --tail=20 caddy      # 不应有 cert 报错

# 4. 最后才去 Cloudflare → SSL/TLS → Overview → 改成 Full (strict)
```

**顺序重要**：先让源站能收 HTTPS，再改 Cloudflare 模式。反过来会有几十秒 5xx。

---

## 9. 回滚

```bash
# 代码回滚
cd ~/boothnote
git log --oneline -10
git checkout <好的那个 sha>
docker compose --profile prod up -d --build

# 数据库回滚（只在迁移把数据搞坏时）
./infra/backup.sh                                    # 先把当前状态也存一份
gunzip -c backups/boothnote-<时间戳>.sql.gz | docker compose exec -T db psql -U postgres -d boothnote
```

> **`inbox` 表有触发器挡住 UPDATE/DELETE**（§4.2 第2条）。恢复整库不受影响，
> 但别指望能"改几条原文" —— 那是设计如此。

---

## 10. 故障排查

| 症状 | 多半是 | 怎么查 |
|---|---|---|
| **ERR_TOO_MANY_REDIRECTS** | Flexible 模式漏了 `SITE_SCHEME=http://` —— Caddy 跳 HTTPS、Cloudflare 用 HTTP 回源，互踢 | `grep SITE_SCHEME .env` |
| **Error 521 / 522** | 源站没起来，或防火墙没放行 Cloudflare | `docker compose ps` · `ufw status` |
| **Error 526** | SSL 设了 Full (strict) 但源站证书不对 | 检查 `origin.pem` 是否粘全（含 `-----BEGIN/END-----` 两行） |
| **Error 502 但 Twenty 能开** | Caddy 到 gateway 不通 | `docker compose --profile prod ps gateway` · `logs gateway` |
| 手机上**录音按钮报错** | 先看「我的」页诊断。`mediaDevices` 不存在 = 不是 secure context | 确认地址栏是 `https://` 且没有证书警告 |
| **改了代码手机上没变** | Service Worker 缓存 | 检查 §1.3 第 2 条的 Bypass cache 规则；或手机上删掉主屏图标重装 |
| 转写结果**空的或很短** | 先确认音频本身有内容 | 我们踩过一次：测试音频只有 0.74 秒，白查半天 |
| 转写把**品牌名认错** | 已知现象，正常 | 抽取那一步会按客户名单纠正并留痕（`corrections` 字段） |
| 抽取一直 `failed` | OpenAI key 或余额 | `docker compose logs gateway \| grep 失败` |
| **Twenty 起不来** | 首次要跑 60+ 迁移，慢是正常的 | `docker compose logs server \| tail -50` |
| 构建时 **OOM / Killed** | 内存不够 | `free -h` 看 swap 在不在；`server-init.sh` 会加 4 G |

---

## 11. 展会现场应急（8/28–9/6）

**出发前一周必须做完**：

- [ ] 每个要用的人**在办公室**完成一次：登录 → 添加到主屏幕 → 录一条测试 → 确认「已同步」
  （现场第一次打开 = 现场第一次失败）
- [ ] 已切 Full (strict)（§8）
- [ ] 备份 cron 在跑，且 `BACKUP_REMOTE` 已配
- [ ] 每人一副**带麦克风的耳机** —— 麦离嘴 5 cm 和 50 cm，转写质量差一个档，€20 的事

**现场原则**：

- 网断了**照常录**。数据先落手机本地，回酒店有网自动补传，顶部状态条会显示「离线 · 待传 N」。
- **每晚回酒店确认状态条变回「已同步」**，并手动跑一次备份。
- 归属拿不准就**留空**，晚上在 Agent 页统一指派 —— 录入时不阻塞是设计如此（D28）。
- 语音链路彻底不行就**只用文字速记**，它零外部依赖，一定能工作。

**紧急联系点**：所有原文都在 `inbox` 表且**只增不改**。即使抽取、Twenty、看板全挂，
只要 `pg_dump boothnote` 拿得到，那 10 天说过的话就一句没丢。
