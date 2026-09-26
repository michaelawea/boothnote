# 故障对照表

> 展会现场翻这一份。**症状 → 一条命令 → 原因 → 修法**，不讲原理。
> 原理在 `architecture.md`；部署步骤在 `deploy.md`；agent 内部在 `agent.md`。

## 0. 先跑这一条

```bash
./scripts/smoke.sh https://<采集端域名> https://<CRM 域名>
```

只读，对生产安全。12 项里哪一项红，直接跳到下面对应的行。

---

## 1. 手机端

| 症状 | 第一条命令 | 原因 | 修法 |
|---|---|---|---|
| 打开是白屏 / 一直转 | `curl -I https://<采集端>/` | Caddy 没起来，或 DNS 还没生效 | `docker compose ps`，看 caddy |
| `ERR_TOO_MANY_REDIRECTS` | `./scripts/preflight.sh prod` | **`SITE_SCHEME` 和 `TLS_DIRECTIVE` 没配成对**（Flexible 模式漏了 `SITE_SCHEME=http://`） | 改 `.env` 那两行，重起 caddy。这个报错完全指不到原因，别浪费时间猜 |
| 装到主屏幕后一直是旧版本 | `curl -I https://<采集端>/sw.js \| grep -i cache` | **R17**：Cloudflare 缓存了 `/sw.js`（`max-age=14400` / `cf-cache-status` 不是 DYNAMIC 或 BYPASS） | Cache Rules 建一条 `bypass-sw`：`(http.request.uri.path eq "/sw.js") or (http.request.uri.path eq "/registerSW.js")` → **Bypass cache**，然后 Purge。**就这一条，不要动 zone 级 Browser Cache TTL**（`deploy.md` §1.3 / 规划文档 §2.29）。2026-08-07 已建并验证 |
| **装到主屏幕后还是旧版本（`/sw.js` 已经是 `no-cache` / `DYNAMIC`）** | 打开「我的」页 → **版本**那一段，点「检查更新」 | **和 R17 不是同一件事**（D83 / §2.30）。服务器如实交出新版本 ≠ 手机会去问、会换过去：iOS 桌面图标进去多数是**恢复**不是加载，只挂在 `load` 上的注册一次都不跑；而且新 SW 接管换的是「以后从缓存拿什么」，**页面里跑着的旧 JS 不会自己换** | 「我的」页点「检查更新」；显示「有新版本」就点「立即更新」。<br>正常情况下切回前台会自动检查，**但正在录音 / 有草稿没存 / 正在上传 / AI 对话开着时不会自动刷**（那时刷新会丢内存里的东西）—— 这时顶栏会挂一条「有新版本 · 点这里更新」，等手上的事完了再点 |
| 「我的」页里语言切不动 | 看那一格下面那行小字 | 语言存在**账号**上（D80/D84），改它要连服务器 | 有网时再切。**没有本地假开关** —— 本机英文而服务端小结仍是中文，那种半边天更难查 |
| 按麦克风没反应 | 打开「我的」页看那三行诊断 | 不是 https（secure context），或者 iOS 曾经被点过「不允许」 | 换 https；iOS 进「设置 → Safari → 麦克风」改回允许 |
| 麦克风在 iframe 里失效 | `curl -I https://<采集端>/ \| grep -i permissions` | `Permissions-Policy` 被边缘吃掉了 | Caddy 那条透传配置回来 |
| 录了但传不上去 | 「我的」页看待传数量 | 多半是离线。**数据没丢** —— 在本地 IndexedDB 里等着 | 有网时会自动补传。急的话点顶部那个「待传 N」 |
| **点了「待传」完全没反应，那条也永远传不上去** | 三条路径，都会让一条速记**永久卡住而且界面上看不出来**（2026-08-03 修）：<br>① 上传中途关页面 / 热重载 → 卡在 `syncing`，而重传只捞 `queued`/`failed`、「待传 N」也只数这两种 → **凭空消失**<br>② 攒够 8 次失败后静默 `continue` → 点了没反应<br>③ `fetch` 没超时，一次挂住的上传让 `running` 永远为 true → **整个队列不动** | 已修：启动时把 `syncing` 掰回 `queued`；「待传」= 强制重试并清零次数；上传 90 秒超时；`syncing` 也计入待传。<br>旧版本上救数据：DevTools → Application → IndexedDB → `boothnote-capture` → `notes`，把那条的 `sync` 改成 `queued` |
| 换了台手机，之前的都不见了 | — | 正常。下行同步会拉回来（`GET /inbox`） | 等几秒，或切一次前后台触发同步 |
| 同一台手机换人登录，看到别人的记录 | — | **不该发生**（T30 已修：所有查询按 `recordedBy` 过滤） | 如果还发生，是某个页面直接用了 `db.notes` 而不是 `myNotes()` |

## 2. 网关

| 症状 | 第一条命令 | 原因 | 修法 |
|---|---|---|---|
| 网关起不来，日志说「缺少环境变量」 | `./scripts/preflight.sh prod` | 必填项少了一个。`assertEnv()` 故意让它**起不来**，而不是半残地跑着 | 补 `.env` |
| `/api/health` 200 但所有接口 401 | 看前端有没有带 `Authorization` | token 过期 / 被撤权（`is_active=false` 或 `token_version+1`） | 重新登录 |
| 上传 413 | — | 附件超过 40 MB | 前端本来就拦在 20 MB；413 说明有人直接打接口 |
| 上传很慢 / 超时 | `curl -s https://<采集端>/api/agent/health` | **不该是 agent 的锅** —— 上行不等 agent（集成测试断言 < 3 秒） | 多半是网络或磁盘写入。看 `docker stats` |
| `POST /companies` 一直 409 | — | 查重命中了。**这是设计** —— 名字写法不同但其实是同一家 | 界面上把候选点一下，或确认「都不是」再建 |
| 确认入库点了没反应 | `select status, confirm_after from staging where id='…'` | 状态是 `confirming` = 排队中，5 秒后才写 | 等 5 秒。撤销要在这 5 秒内 |
| 确认之后 Twenty 里没有 | `select error from staging where id='…'` | 到点提交失败了，状态退回 `ready` 并写了 error | 看 error。**Twenty 里什么都没写**，再点一次确认即可 |
| 确认之后核对卡直接消失，没有「已入库 / 撤销」 | 卡片的渲染条件只认 `status==='ready'`。确认后变 `confirming` → **整个卡片被卸载**，倒计时和撤销跟着没了 | 已修：条件放宽到 ready/confirming/confirmed，倒计时从服务端的 `confirm_after` 推 —— 刷新页面都还在走 |
| 「记录一下这个售后问题」落成了产品选型情报 | 以前 `commitToTwenty()` **只会建 productFitment**，agent 也没有字段可以表达「这是售后」 | 已修：`propose_fields` 加 `recordType`（fitment/support），入库按它分流。**缺的是字段不是提示词** |
| `400 Invalid object value '…' for field "issueDescription"` | `issueDescription` 是 **RICH_TEXT**，不收纯字符串 | 传 `{ markdown: '…' }`。这类错只在真去写那一刻才炸 |
| 对话里看不到自己传的文件 | `/threads/:id` 以前不返回附件 | 已修：每条消息带 `attachments`，标出「已读 / 没读开」，点一下能下载原件 |

## 3. Agent 抽不出东西

先跑：

```bash
node scripts/e2e-agent.mjs        # 只对本地
```

| 症状 | 原因 | 修法 |
|---|---|---|
| `trace=[]`、`extracted={}`、`stop_reason=done` | 模型调用本身失败。**Pi 不抛异常**，它把错误记在消息上 | 看 `agent_run.error`。踩过一次：`400 Function tools with reasoning_effort are not supported … in /v1/chat/completions` → 已改走 Responses API |
| 全部 failed，error 里 404 | 模型名不对 | `node scripts/check-models.mjs` |
| `partial=true` 很多 | 8 步不够 | 看 trace 里它在重复调什么；必要时调 `AGENT_MAX_STEPS` |
| `companyCode` 总是 null | 白名单丢弃了 | trace 里 `propose_fields` 的返回写明了丢了什么 |
| 品牌名一直听错 | 转写 prompt 没喂到品牌名 | `GET /companies` 是不是挂了 / 返回空 |
| `queued` 一直涨 | 队列积压 | `GET /agent/health` 的 `lastError` |

| **agent 回了话，但底下没有核对卡** | 那条 agent 消息的 `inbox_id` 是空的 → `GET /threads/:id` 里的 `left join staging on s.inbox_id = m.inbox_id` 落空 → 前端拿到的 `staging_id` 是 null | 查：`select role, inbox_id from thread_message order by created_at desc limit 5`。agent 那行必须有 `inbox_id`。2026-08-03 修过一次（数据其实在 `meta.stagingId` 里，只是不在前端找的位置）——**这类 bug 不报错，只是少一块 UI，最难发现** |
| **界面一直转圈，但其实早跑完了** | `agent_run` 里留了一行 `status='running'` | `select status, stage from agent_run where status='running'`。任何提前 return 的分支都必须把它改掉 |
| 进度里 stage 一直是「在想」 | **正常。** 工具只要 3–60ms，慢的是模型那一轮生成 | 看「已完成 N 个工具」那个列表，那才是有信息量的部分 |

更细的在 [`agent.md` §4.5 / §5](agent.md)。

## 3.5 进不去管理控制台

**地址：本地 `http://localhost:5173/console` · 线上 `https://<采集端域名><ADMIN_PATH>`（没设就是 `/console`）**

先记住一件事：**两个路径是两回事。**

| | 谁在管 | 值 |
|---|---|---|
| 网关里的真实路由 | `src/admin.ts` | **永远是 `/admin`**，写死的，不认识 `ADMIN_PATH` |
| 对外的路径 | 本地 = `vite.config.ts` proxy；线上 = `Caddyfile` | `ADMIN_PATH`，默认 `/console` |

| 症状 | 原因 | 修法 |
|---|---|---|
| **打开是采集端 PWA，不是控制台** | 两个根因，先分清是哪个：<br>**① Service Worker 截胡**（更常见，也更难查）—— PWA 的 SW 作用域是 `/`，`navigateFallback` 会把域名下**所有**导航请求答成 PWA 的壳。**浏览器根本不会去问服务器。**<br>**② 路径没被代理接住** → 落到 SPA 兜底<br>🔴 两种都是 **200 + 页面正常渲染，只是渲染的是另一个应用**，不报 404 | **先用 curl 判断是哪一个** —— curl 不走 SW：<br>`curl -s <地址> \| grep -o '<title>[^<]*'`<br>· curl 拿到「账号管理」而浏览器拿到「Boothnote」→ **是 SW**，见下一行<br>· curl 也拿到「Boothnote」→ 是路径/代理，用对地址 |
| 确认是 SW 截胡了 | 那台机器上装的还是**旧版 SW**（2026-08-03 之前的构建没有 `navigateFallbackDenylist`） | ① 部署新版（denylist 已加进 `vite.config.ts`）；② 那台机器上强制更新一次：DevTools → Application → Service Workers → **Unregister**，然后硬刷新（⌘⇧R）。手机上：设置里清掉该站点数据，或把主屏幕图标删了重装 |
| 试 `/console-<token>` 进不去 | **token 从来不放 URL 里。** 页面上有输入框，粘进去 | 见上 |
| `503 admin_disabled`，**而 `.env` 里明明有 `ADMIN_TOKEN`** | 🔴 **2026-08-04 实测踩到过（D66）**：`.env` 对、preflight 报绿、代码也对，但 **compose 没把这个键传进容器** —— 进程里读到的是空 | **第一条命令查进程，不是查 `.env`**（只看长度不看值）：<br>`docker compose exec gateway sh -c 'echo ${#ADMIN_TOKEN}'`<br>· 是 0 → 看 `docker-compose.yml` 的 `gateway.environment` 里有没有这一行（现在应该有），补上后 `docker compose --profile prod up -d gateway`（**`restart` 不够，环境变量要重建容器**）<br>· 非 0 → 不是这个问题，往下看 401 |
| `503 admin_disabled`，`.env` 里确实没有 | 没设 `ADMIN_TOKEN` | 设上后 `up -d gateway`。**留空 = 控制台整个关闭，这是安全默认，不是故障** |
| **粘了 token 点「进入」，页面上什么都不显示** | 老版本的 bug（2026-08-04 已修）：消息条 `#msg` 嵌在只有登录成功才显示的容器里，所有报错都写进了 `display:none` | 更新到含此修复的镜像。在那之前只能开 DevTools 看 Network/Console 里的真实状态码 |
| `401 bad_token` | 粘错，或改了 `.env` 但网关没重起 | `docker compose --profile prod restart gateway` |
| `429 locked` | 连续错 8 次，锁 15 分钟 | 等，或重起 gateway 清计数 |
| 改了 `ADMIN_PATH` 地址没变 | 重起错了东西 | 本地重起 **vite**，线上重起 **caddy** —— 这个变量不是网关读的 |

不想开浏览器：`cd services/gateway && npm run adduser`（密码本地随机生成，只打印一次，不接受命令行传入）。

## 4. Twenty

| 症状 | 第一条命令 | 原因 | 修法 |
|---|---|---|---|
| `/healthz` 不通 | `docker compose logs server --tail 50` | 多半是 DB 连不上或 `APP_SECRET` 变了 | 对照 `deploy.md` §10 |
| 少了对象 / 字段 | `./deploy.sh --provision-only` | schema 没同步 | 那条命令幂等，随便跑 |
| `Invalid value "text" for field valueType` | — | **SELECT 的值在 Twenty 里是大写的** | 代码里统一走 `twenty.ts` 的 `sel()`，别在调用点各写各的 |
| `Invalid object value '…' for field "issueDescription"` | — | 它是 **RICH_TEXT**，收 `{ markdown }` 不收字符串 | 注意 `Visit.visitSummary` 相反 —— 那个是 **TEXT**，收裸字符串。字段类型查 `scripts/twenty-schema.mjs`，别凭印象 |
| **CRM 里那条记录是空的 / 什么都没看到** | `select extracted from staging where id='…'` | `extracted={}` —— agent 没调 `propose_fields`（常见于查不到客户时） | 现在有两层兜底：`loop.ts` 会用原文凑一份并标 `agentSkipped`，`commitToTwenty` 的正文一路兜到原文。**再出现空记录就是回归**，两条集成测试盯着 |
| **CRM 里全是测试数据** | `node scripts/purge-test-records.mjs`（预览） | 集成测试 / 验证脚本造的 | `node scripts/purge-test-records.mjs --yes --db`。`./scripts/test.sh all` 跑完会自动清一次 |
| 客户类型 / 集团树是空的 | `node scripts/import-accounts.mjs --backfill --dry` | 导入那次 Twenty 上还没建那个字段，值被静默丢掉了 | `node scripts/import-accounts.mjs --backfill`（**只补空格子**，有值的一个不动） |
| 客户名单是空的 | `curl -H 'Authorization: Bearer …' <crm>/rest/companies` | 没导数据，或 API key 失效 | `node scripts/import-accounts.mjs` |
| 建渠道链回 `422 bad_order` | — | **这是对的。** 链必须从上游到下游排：`DISTRIBUTOR → SUB_DISTRIBUTOR → DEALER → SUB_DEALER → END_USER` | 返回里的 `got` 就是它收到的顺序。校验在写入之前，所以**一条边都没写**，原来的链没被动过 |
| 建了渠道链，集团树也变了 | `curl … /rest/companies/<id>?depth=1` 看 `parentCompany` | 🔴 写错字段了 —— 渠道链只能碰 `soldVia` | 只有 `twenty.ts` 的 `setSoldVia()` 能改这个。两棵树混了**拆不回来**，见 `architecture.md` §3 |

## 5. 数据库

| 症状 | 原因 |
|---|---|
| `inbox 只增不改（§4.2 第2条）：UPDATE 被拒绝` | **这是对的。** 触发器在干活。派生结果写 `staging`，不要回写原文 |
| `thread_message 只增不改` / `attachment 只增不改` | 同上。解析结果写 `attachment_text` |
| 删测试账号删不掉 | `inbox.user_id` 外键挡着。**只能停用**（`is_active=false` + `token_version+1`） |
| 迁移跑了两遍 | 没关系，`schema_migrations` 记着，已跑过的跳过 |

## 6. 部署

| 症状 | 修法 |
|---|---|
| `exec format error` | 镜像是在 Mac（arm64）上 build 的。**必须在目标机器上 build**（D29）。`./deploy.sh` 已经是这么做的 |
| `./deploy.sh` 在自检那步停了 | 照它打印的那几行改 `.env`。**它只报「有没有」，不回显任何值** |
| Twenty 5 分钟还没健康 | `docker compose logs server`。对照 `deploy.md` §10 |
| schema 同步失败 | `./deploy.sh --provision-only` 单独重试 |
| **部署卡在迁移那一步**（`exec` attach 不上，或网关一直重启） | `docker compose logs gateway --tail 20` | 新代码启动就要用新列 → 列不存在 → 顶层 `await` 抛错 → `restart: always` 循环。**顺序错了**：迁移必须在新网关起来**之前**、并且用**新镜像的一次性容器**（`run --rm --no-deps`）。2026-08-04 已改进 `deploy.sh` |
| **迁移说「无待执行」，但明明加了新的 .sql** | 看它打印的「镜像里共 N 个」 | `migrations/` 是 **COPY 进镜像**的，不是挂载的 —— 镜像旧就看不见新文件。现在库里记着而镜像里没有的会**直接中止**并提示先 `build` |
| **部署停在「出口对账」** | 照它列的那几项去看部署日志里对应那一步的输出。它只回读不改东西 —— 报红说明**那一步真的没生效**，不是它误报 |
| 想单独查一次「线上到底生效了没」 | `node scripts/verify-deploy.mjs`（只读，对生产安全） |

---

## 6b. agent 相关

| 症状 | 一条命令 | 原因 |
|---|---|---|
| 启动横幅报 **「有 N 条试了 3 次仍失败，已不再自动重跑」** | `select error, count(*) from staging where attempts >= 3 group by 1;` | 这是**正常的保护**，不是故障。三次都失败的不再自动重跑，免得每次重启烧一遍模型钱 |
| 上面那些修好之后想重跑 | `update staging set attempts = 0, status = 'pending' where …;` 然后重启网关 | 预算清零它才会被重新捡回来 |
| **agent 老是 60 秒超时、走原文兜底** | 看启动横幅「捡回 N 条」那个数 | N 很大时队列被旧记录占满，**新来的那条排不上** —— 人以为是 agent 不行，其实和他这条无关 |
| 日志里 `Our servers are currently overloaded` | —— | 上游临时故障。现在会**自动退避重排**（2s → 4s → 8s，最多 3 次），不用管 |

---

## 6a. CRM 里看到的东西不对

| 症状 | 一条命令 | 原因 |
|---|---|---|
| **视图的列不对 / 看板没有分栏** | `node scripts/provision-views.mjs`（先看预览） | 视图配置是声明式的（D60）。**别在界面上手点** —— 下次重跑会盖掉，而且没人记得为什么那么配。改 `SPEC` 再 `--yes` |
| **`⚠️ 这些字段在 Twenty 里找不到`** | `node scripts/provision-twenty.mjs` | 字段还没建。schema 先行，视图引用的是字段 id |
| **客户页 / 录入人页的 Timeline 是空的** | `node scripts/backfill-timeline.mjs --yes` | 代码只管**新**记录（D61）。之前入库的不会自己长出事件 |
| **Timeline 上有点不开的灰名字** | 同上 | 记录删了，事件没跟着走。chip 靠 `linkedRecordCachedName` 照样渲染 —— 上面那条命令会把孤儿清掉 |
| **选型情报的标题是 `BATTERY` 这种全大写** | —— | 2026-08-03 之前建的记录（那时标题列写的是原始枚举）。新记录已是中文；老记录不影响任何字段值，`category` 一直是对的 |
| **「情报完整度%」整列空 / 「情报最缺的」视图没排序** | `node scripts/recompute-intel.mjs --yes` | 完整度是**存储字段**（D17③），清单改了要重算一次 |
| **客户情报页说「清单还没配内容」** | `node scripts/seed-intel-items.mjs --yes` | 清单是数据不是代码。改 `data/intel-items.json` 重跑，不发版 |
| **「账户类型」整列空 → 客户视图筛不出东西** | `node scripts/import-accounts.mjs --backfill` | 字段是**后加**的，当初导入时被静默丢掉了。`--backfill` 只补空格子 |
| **列表里混着 Stripe / Airbnb / Figma** | `node scripts/purge-twenty-demo.mjs --yes` | Twenty 官方镜像自带的示例数据。先看预览，它只认那五个固定域名 |
| **跑完测试 CRM 又空了** | 跑 `scenarios` 之后接 `node scripts/keep-scenarios.mjs --yes` | `test.sh all` 末尾会清测试数据（这是对的）。场景数据要改到真人名下才留得住（D64） |
| **同一个线程编号，改了优先级/日期却没变** | 看 `twenty_refs.workItemsUpdated` | 2026-08-03 之前是「撞了就跳过」，更新全丢且静默。现在是更新（D63 那一轮修的） |
| **点「在 CRM 里看完整看板」跳到 `http://server:3000/` 打不开**（本地正常，线上不行） | `docker compose logs gateway \| grep 看板` | `boardUrl` 回退到了 `SERVER_URL` —— 本地是 `localhost:3000`（**恰好也对**），线上是容器名 `server:3000`（手机打不开、**不报错**）。2026-08-04 已修（D67）：现在按 `BOARD_URL → https://${CRM_DOMAIN} → SERVER_URL` 推，且**每次启动都把看板地址打进横幅**。横幅那行不是公网地址就是没修好/没传 `CRM_DOMAIN` |

⚠️ **视图配错了不影响数据。** 上面这些全是「人看到什么」的问题，
`inbox` / `staging` / Twenty 记录里的值一个都没动。改错了重跑就行。

---

## 6.5 想从头测一遍

```bash
node scripts/reset-testdata.mjs           # 先看要删什么（不动手）
node scripts/reset-testdata.mjs --yes     # 真的删
```

清 `boothnote` 的全部业务表 + Twenty 里**今天新增**的自定义对象记录。
**不动**：`app_user`（账号）· Twenty 的 `companies`（56 家客户名单）。

⚠️ 它会**临时关掉三张表的只增不改触发器**（inbox / thread_message / attachment）——
这是 §4.2 第2条，全项目最硬的一条纪律。所以脚本做了三件事：

1. 关和开在**同一个事务**里，中途炸了整体回滚
2. 跑完**逐个自检**三个触发器是否装回去，没装回去就非零退出并大声报警
3. 非本地直接拒跑

「关了忘了开」= 那条纪律从此静默失效，而没有人会发现 —— 这就是要自检的原因。
不放心的话自己撞一下：`update inbox set text='x' where …` 应该被拒绝。

🔴 **清不到你设备上的本地速记**（IndexedDB，采集端的真相源）。
那只能在那台设备上清：DevTools → Application → Storage → **Clear site data**。
它会连登录态一起清掉，清完要重新登录。

---

## 7. 三条不要做的事

1. **不要为了「修数据」去 UPDATE `inbox`。** 触发器会拒绝，而且那是对的。
   要改的是派生结果 —— 改 `staging`，或者重跑。
2. **不要在 Twenty 里删字段来「清理」。** 删字段 = 删掉该字段的所有数据，不可逆。
3. **不要用前端过滤代替服务端作用域。** 改一行 JS 就全看见了。
