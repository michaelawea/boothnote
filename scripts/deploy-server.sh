#!/usr/bin/env bash
# 部署序列的**服务器段** —— 这是它唯一的一份。
#
#   人在 Mac 上：  ./deploy.sh              （它 ssh 进来调这个脚本）
#   人在服务器上： ./scripts/deploy-server.sh
#
#   ./scripts/deploy-server.sh --pull            先 git pull 再走完整序列
#   ./scripts/deploy-server.sh --migrate-only    只跑数据库迁移
#   ./scripts/deploy-server.sh --provision-only  只同步 Twenty 的对象与字段
#   ./scripts/deploy-server.sh --skip-smoke      跑完不冒烟
#
# ══ 为什么单独有这个文件 ═══════════════════════════════════════════
#
# 以前这一整段是 `deploy.sh` 里的一个 ssh heredoc。后果是：
# **人已经在服务器上时跑不了它** —— `deploy.sh` 会 ssh 自己、还会 git push。
# 于是每次在服务器上部署，都是有人去 grep `deploy.sh`、把它的服务器段手抄一遍。
# 而这个序列的顺序是**承重的**（下面每一步都写了为什么），
# 手抄一次就有一次抄错的机会，CLAUDE.md 里那份散文描述还得靠人同步。
#
# 🔴 判据：**一段必须被精确执行的流程，不能只存在于一个「某些人跑不了」的入口里。**
#
# 顺带好处：不再是 heredoc，所以 `$` 和反引号不用转义了。
# ══════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

PULL=0 SKIP_SMOKE=0 ONLY=""
for a in "$@"; do
  case "$a" in
    --pull)           PULL=1 ;;
    --migrate-only)   ONLY=migrate ;;
    --provision-only) ONLY=provision ;;
    --skip-smoke)     SKIP_SMOKE=1 ;;
    *) echo "未知参数：$a"; exit 2 ;;
  esac
done

# 一次性容器跑 scripts/ 里的 node 脚本：网关镜像里没有 scripts/，但仓库就在这台机器上。
# 抽成函数是为了**只有一处**写这串参数 —— 以前 10 处复制粘贴，改一个要改十遍。
nrun() {
  docker run --rm --network boothnote_default -v "$PWD:/repo" -w /repo --env-file .env \
    node:24-alpine node "$@"
}

if [ "$PULL" = 1 ]; then
  echo "  ── 拉取代码 ──"
  git pull --ff-only
fi
echo "  仓库 $(git rev-parse --short HEAD) · $(git log -1 --format=%s | cut -c1-60)"

# ── 只做一件事的两个快捷入口 ───────────────────────────────────────
if [ "$ONLY" = migrate ]; then
  # ⚠️ 先 build 再用一次性容器跑。migrations 打在镜像里，
  #    正在跑的旧容器没有这次的迁移文件（exec 会「成功」但一个都没执行）。
  docker compose --profile prod build gateway
  docker compose --profile prod run --rm --no-deps gateway node src/migrate.ts
  exit 0
fi
if [ "$ONLY" = provision ]; then
  nrun scripts/provision-twenty.mjs
  exit 0
fi

echo
echo "  ── 部署前自检 ──"
# 只报「有没有」，绝不回显任何值
bash scripts/preflight.sh prod || { echo "  🔴 自检没过，停止部署"; exit 1; }

echo
echo "  ── 构建（先不换正在跑的网关）──"
# 🔴 **构建和启动分开，是因为迁移必须跑在新网关起来之前。**
#
# 原来这里是一句 `up -d --build`，紧接着 `exec gateway node src/migrate.ts`。
# 2026-08-04 的 migration 005 让这个顺序当场失效：它给 staging 加 `attempts` 列，
# 而新网关**启动时**（index.ts 的顶层 await resumePending）就要查这一列 ——
# 列还不存在 → 顶层 await 抛错 → 进程退出 → restart: always 循环 →
# 后面那句 exec 根本 attach 不上一个稳定的容器。**部署会卡死在迁移这一步。**
#
# 判据：**只要一次迁移加的东西是「新代码启动时就要用的」，先起后迁就是死锁。**
# 这次是列，下次可能是表或约束 —— 所以改的是顺序，不是给 resumePending 加 try。
docker compose --profile prod build

echo "  ── 起数据层（网关先不动）──"
# 🔴 **这里不能带 caddy。**
#
# `caddy` 的 depends_on 里有 `gateway`，而 `up -d <服务>` 默认**连依赖一起起** ——
# 2026-08-04 用 `--dry-run` 实测，`up -d db redis server worker caddy` 的输出里
# 明明白白有 `boothnote-gateway-1 Creating → Started`。
# 也就是说：把 caddy 写进这一行，新网关照样在迁移之前起来，**死锁一点没躲开**。
#
# caddy 挪到下面和 gateway 一起起 —— 那样还顺带没有「caddy 已经在转发、
# 而后面那个还没起来」的 502 窗口。
docker compose --profile prod up -d db redis server worker

echo "  等待 Twenty 健康…"
ok=0
for i in $(seq 1 60); do
  if docker compose ps --format '{{.Service}} {{.Health}}' | grep -qE '^server healthy'; then ok=1; break; fi
  sleep 5
done
[ "$ok" = 1 ] || { echo "  🔴 Twenty 5 分钟还没健康。看 docker compose logs server，对照 docs/deploy.md §10"; exit 1; }

echo
echo "  ── 🛡  变更前：标签备份 + 数据快照（D79）──"
# 🔴 **这两步是 §2.28 那次事故的直接产物。**
#    那次 `provision-twenty.mjs` 整包换枚举选项、把三列数据静默清空 ——
#    HTTP 200、日志全绿、`verify-deploy` 也照过（它查的是「配置生效了没有」，
#    不查「数据还在不在」）。
#    · 标签备份进 `backups/labeled/`，**永不参与自动清理**，出事就是它救命
#    · 数据快照在后面两处和改完之后逐条对，任何一格的非空计数下降就中止
./infra/backup.sh --label "pre-deploy-$(git rev-parse --short HEAD)" || {
  echo "  🔴 变更前备份失败 —— **不要继续**。没有回退绳的部署不叫部署。"; exit 1; }
nrun scripts/data-guard.mjs snapshot || {
  echo "  ⚠️  数据快照拍不上（Twenty 还没起来？）—— 后面那两道对账会跳过"; }

# 数据守卫的一次比对。退出码约定见 data-guard.mjs 顶部：
#   0 = 没掉   1 = 有东西掉了（中止）   2 = 没有基线，跳过
# 🔴 2 必须和 1 分开：拍快照那步是「失败只告警」的，
#    如果把「没有基线」也当成「数据掉了」，一次拍不上就会让部署以最吓人的方式中止。
guard() {
  local rc=0
  nrun scripts/data-guard.mjs check || rc=$?
  case "$rc" in
    0) ;;
    2) echo "  ⚠️  没有基线快照，这一道跳过" ;;
    *) echo "  🔴 有数据在「$1」这一步消失了。回退用 backups/labeled/ 里那份标签备份。"; exit 1 ;;
  esac
}

echo
echo "  ── 数据库迁移（幂等）──"
# 🔴 用**新镜像的一次性容器**跑，不是 exec 正在跑的那个 ——
#    migrations 目录是**打进镜像**的（Dockerfile 第 12 行），所以还没换掉的旧容器里
#    压根没有这次的迁移文件；而新容器又不能先起（见上面那段）。
#    `run --rm --no-deps` 正好两头都躲开：用新镜像、不启动服务、跑完就没。
docker compose --profile prod run --rm --no-deps gateway node src/migrate.ts

echo
echo "  ── Twenty 对象与字段（幂等）──"
nrun scripts/provision-twenty.mjs || {
  echo "  ⚠️  schema 同步失败。单独重试：./scripts/deploy-server.sh --provision-only"; exit 1; }

echo
echo "  ── 🛡  数据守卫（第一道：**紧跟 provision，早于任何 backfill**）──"
# 🔴 **这一道的位置就是它的全部意义。**
#
# §2.28 那个 bug（整包 PATCH 枚举 options → 数据静默清空）出在上面那一步。
# 而下面 `import-accounts --backfill` 会把 `company.accountType` **治好** ——
# 于是只在末尾对一次账的话，provision 清掉的东西被 backfill 补了回来，
# 末尾那道看到的是「没掉」。
#
# 这正是 §2.22 那次误诊的成因：现象被自愈掩盖，于是去修了 backfill 而不是根因，
# bug 又活了好几周。**在自愈发生之前对一次，掩盖就不成立了。**
#
# 判据：**对账要卡在「可能弄坏它的那一步」和「可能掩盖它的那一步」之间。**
guard "Twenty 对象与字段"

echo
echo "  ── 国家迁移预览（只读；此时旧网关仍在线）──"
nrun scripts/migrate-company-countries.mjs || {
  echo "  🔴 国家迁移预览失败，尚未停止网关。修正后重跑完整部署。"; exit 1; }

# 只在数据库迁移、provision 和数据守卫已经通过后调用。
# 即使国家回填未完成，新版本也只写受控列，不能回退启动旧国家写入版本。
start_prepared_gateway() {
  docker compose --profile prod up -d --no-deps --force-recreate gateway caddy || return 1
  for attempt in $(seq 1 15); do
    if docker compose --profile prod exec -T gateway node --input-type=module -e \
      'const response = await fetch("http://127.0.0.1:4000/health", { signal: AbortSignal.timeout(3000) }); if (!response.ok || !(await response.json()).ok) process.exit(1);' \
      >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

echo
echo "  ── 暂停旧网关，避免回填期间继续写旧国家列 ──"
docker compose --profile prod stop gateway

echo
echo "  ── 客户国家受控化（保留旧字段，回填后停用旧输入）──"
migration_rc=0
nrun scripts/migrate-company-countries.mjs --apply || migration_rc=$?
if [ "$migration_rc" -ne 0 ]; then
  echo "  🔴 国家迁移未完成。保留历史文本和已核对的回填；尝试恢复 schema 已准备的新网关。"
  if start_prepared_gateway; then
    echo "  ⚠️  新网关健康检查通过，服务已恢复；未回填客户暂显示未选国家。"
    echo "     本次部署仍为失败：处理异常清单后重跑，期间暂停 CRM 国家编辑。"
  else
    echo "  🔴 新网关恢复失败。检查 gateway 日志与单写入者租约；不要启动写旧列的旧版本。"
  fi
  exit "$migration_rc"
fi

echo
echo "  ── 换上新网关 + 入口（数据库与 CRM 字段已就绪）──"
start_prepared_gateway || {
  echo "  🔴 新网关启动或健康检查失败。检查 gateway 日志与单写入者租约。"; exit 1; }

echo
echo "  ── 清掉 Twenty 自带的示例数据（幂等）──"
# 官方镜像自带 Stripe / Airbnb / Figma / Notion / Anthropic 五家 + 它们的商机和联系人。
# 不清的话「机会地图 · 按阶段」看板上会出现 Airbnb —— 而那是需求 2 的主视图。
# 按固定域名匹配且要求 accountCode 为空，双保险，不会误伤手工建的真客户。
nrun scripts/purge-twenty-demo.mjs --yes || {
  echo "  ⚠️  示例数据没清掉（不影响真实数据）。"; }

echo
echo "  ── 竞品/供应商受控名单（幂等 · D23a）──"
# 🔴 少了这一步的后果是**静默的**：supplier 表空着，于是每一条在位品牌都对不上
#    受控名单，全部退化成「来源说明」里的自由文本 —— 需求 2 的「这家在用谁」
#    永远聚合不出来，「在位品牌分布」那个视图永远是空表（issue #2）。
nrun scripts/seed-suppliers.mjs --yes || {
  echo "  ⚠️  supplier 名单没灌上 —— 在位品牌会全部落进「来源说明」。"; }

echo
echo "  ── 客户档案补空格子（只补空的，有值的一个不动）──"
# 「已存在就跳过」的幂等是对的，但它意味着**后来补上的 schema 字段永远补不回去**：
# accountType 是后加的，当初导入 56 家时 Twenty 上还没这一列，被静默丢掉了，
# 而导入脚本报的是「✅ 成功」。生产上因此 61 家全 null，两个客户视图永远空（issue #5）。
nrun scripts/import-accounts.mjs --backfill || {
  echo "  ⚠️  客户档案没补上 —— 按 accountType 筛的视图会是空的。"; }

echo
echo "  ── 情报清单 + 完整度（幂等 · D17/T36）──"
# 清单是数据不是代码：改 data/intel-items.json 重跑即可，不发版。
# 灌完必须重算一次 —— 清单变了，56 家的完整度全部要跟着变。
nrun scripts/seed-intel-items.mjs --yes && nrun scripts/recompute-intel.mjs --yes || {
  echo "  ⚠️  情报清单没灌上 —— 「这家还缺什么」会一直显示「清单还没配内容」。"; }

echo
echo "  ── 项目类型模板（幂等 · D140）──"
# 门户建项目必须先选类型；一个都没有时门户那一屏是空的，而且不报错。
# 只补缺的、不改已有的 —— 类型和阶段是门户 admin 在管，每次部署覆盖一遍等于把他的改动打回去。
# 失败不阻断：下面 verify-deploy 会回读「至少一个在用类型 + 在用阶段」，那一道是硬的。
nrun scripts/seed-project-types.mjs --yes || {
  echo "  ⚠️  项目类型模板没灌上 —— 门户里建项目时没有类型可选。"; }

echo
echo "  ── CRM 视图（幂等 · D60）──"
# 必须在 provision-twenty 之后：视图引用的是字段 id，字段不存在就配不上
nrun scripts/provision-views.mjs --yes || {
  echo "  ⚠️  视图没配上 —— 数据是好的，只是人打开 CRM 看到的还是默认列。"
  echo "     单独重试：node scripts/provision-views.mjs --yes（在一次性容器里）"; }

echo
echo "  ── 侧边栏（幂等 · D114）──"
# 必须在 provision-twenty 之后：Twenty **新建自定义对象时会自动补一个导航项**，
# 所以这一步要跑在它后面，才收得掉新冒出来的那些。
# 🔴 它只删导航项，绝不动对象 —— 停用对象会当场掐断网关（见脚本头部那张表）。
nrun scripts/provision-nav.mjs --yes || {
  echo "  ⚠️  侧边栏没收干净 —— 数据和 API 都是好的，只是左边那一栏多了几项。"; }

echo
echo "  ── Timeline 对账（幂等 · D61）──"
# 代码只管**新**记录；线上已经在的那些不会自己长出事件，要补一次。
# 同时清掉指向已删记录的孤儿事件。失败不阻断部署 —— 这是装饰不是资产。
nrun scripts/backfill-timeline.mjs --yes || {
  echo "  ⚠️  timeline 没对上账（不影响任何记录）。"; }

echo
echo "  ── 出口对账：上面那些到底生效了没有 ──"
# 🔴 **这一步是硬门槛，前面每一步都不是。**
#
# 上面的 seed/provision 各自都写着「失败不阻断部署」——那是对的，
# 一条 timeline 不该挡住上线。但代价是**没有任何地方回头看一眼东西在不在**，
# 于是同一个形状栽了三次（D65 · issue #2 · issue #5）：
# 部署一路绿到「✅ 完成」，而清单、视图、supplier 名单一步都没生效。
#
# verify-deploy.mjs 只回读、不修任何东西；有一项是 0 就 exit 1，
# 让部署停在这里，而不是打印「完成」然后让人第二天在 CRM 里发现。
nrun scripts/verify-deploy.mjs || {
  echo "  🔴 部署「跑完了」但没「做到」—— 见上面那几项。停在这里。"; exit 1; }

echo
echo "  ── 🛡  数据守卫（第二道：整个部署的出口）──"
# 🔴 **和上面那道出口对账问的不是同一个问题。**
#    verify-deploy 问「配置生效了没有」，这一道问「**数据还在不在**」。
#    §2.28 那次事故里前者是绿的、后者才会红 —— 两道都要。
#    只许涨不许跌：部署过程本来就会新建记录（seed / import），
#    但任何一格的非空计数**下降**都意味着有东西被清掉了。
guard "整个部署"

echo
echo "  ── 让网关捡起新 schema ──"
# listCompanies 有 5 分钟缓存，重启一下省得等
docker compose --profile prod restart gateway
sleep 4
docker compose ps

if [ "$SKIP_SMOKE" = 0 ]; then
  echo
  echo "  ── 冒烟（只读，对生产安全）──"
  # 域名从 .env 读。冒烟走的是公网域名，所以在服务器上跑和在 Mac 上跑
  # 都要出到 Cloudflare 再回来 —— 等价。
  set -a; . ./.env; set +a
  ./scripts/smoke.sh "https://${CAPTURE_DOMAIN}" "https://${CRM_DOMAIN}" || {
    echo "  🔴 冒烟没过。对照 docs/deploy.md §10 的故障表。"
    echo "     应用可能仍然是可用的 —— 先看具体哪一项红了。"; exit 1; }
fi

echo
echo "  ✅ 服务器段完成 · $(git rev-parse --short HEAD)"
