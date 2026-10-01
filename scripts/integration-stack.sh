#!/usr/bin/env bash
# 一次性集成测试环境 —— **跑完什么都不留**。
#
# ── 起因 ────────────────────────────────────────────────────────────
#
# 维护者 2026-08-10：「无论我是在生产服务器，还是本地开发环境中跑测试代码，
# 都不会在我的数据库里面写一堆 crap」。
#
# 在这个脚本之前，集成测试是**对着你自己那套开发环境跑的**，于是每跑一轮：
#   · `boothnote` 里多几十条 inbox / staging / thread / attachment
#   · `app_user` 里多两个测试账号，而且**删不掉**（`inbox.user_id` 有外键，
#     原文只增不改 §4.2 第2条）—— 只能停用，于是列表越来越长
#   · Twenty 里多几十条拜访 / 售后 / 选型情报，**和真实记录长得一模一样**
#     （维护者 2026-08-03 的原话：「你每次测试的时候，都会在 crm 里面
#     产生一堆屎山」，实测积到 62 条拜访 / 32 条售后 / 24 家假客户）
#
# `purge-test-records.mjs` 是**事后**打扫，能救回大部分，但它有三个洞：
#   ① 跑不完就中断 → 留下一半（第一次跑它，111 个 DELETE 里 58 个撞 429 失败）
#   ② `inbox` 有触发器挡着 UPDATE/DELETE，只能靠临时关触发器那一招
#   ③ **它得有人记得跑**
#
# 🔴 **判据：不产生垃圾，比产生之后再打扫可靠。**
#    这个脚本换的是路子 —— 每次跑都开一套全新的、跑完就销毁的环境。
#    你那套开发环境（`boothnote` 库 + Twenty + 4000 端口上的网关）**一个字节都不碰**。
#
# ── 默认关掉的两样外部依赖 ──────────────────────────────────────────
#
#   `SERVER_URL` 指向一个不通的端口 → **一条 Twenty 记录都不会建**
#                                     （要真写 CRM 的用例会显式 skip）
#   `AGENT_ENABLED=0` + 占位 key     → **一次模型调用都不会发**（账单是真的）
#
# 想连真 Twenty 跑那 20 条 NEEDS_TWENTY，加 `--with-twenty`（见下面的闸门）。
#
# ── 用法 ────────────────────────────────────────────────────────────
#
#   ./scripts/integration-stack.sh                 # 默认：全隔离
#   ./scripts/integration-stack.sh --with-twenty   # 连本地 Twenty（会写 CRM，末尾自动清）
#   ./scripts/integration-stack.sh -- --test-name-pattern=重录   # -- 之后原样传给 node --test
#
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

WITH_TWENTY=0
PASSTHRU=()
while [ $# -gt 0 ]; do
  case "$1" in
    --with-twenty) WITH_TWENTY=1; shift ;;
    --) shift; PASSTHRU=("$@"); break ;;
    *) PASSTHRU+=("$1"); shift ;;
  esac
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m🔴 %s\033[0m\n\n' "$*" >&2; exit 1; }

# ── 前置：docker ────────────────────────────────────────────────────
#
# 🔴 **拿不到 docker 就直接停，绝不「退回用你现在那个库」。**
#    静默降级正是这个脚本要根除的东西 —— 那会让「我以为它是隔离的」
#    和「它其实写进了我的库」长得一模一样。
command -v docker >/dev/null 2>&1 || die "没有 docker —— 这个脚本靠它开一次性数据库。
   装了 docker 再跑；或者明确地用 ./scripts/test.sh integration --here
   对着你自己那套环境跑（那会在你的库里留数据）。"
docker info >/dev/null 2>&1 || die "docker 装了但没跑起来。先把它启动。"

# ── 挑两个没人用的端口 ──────────────────────────────────────────────
freeport() {
  node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close();});'
}
PG_PORT="$(freeport)"
GW_PORT="$(freeport)"
CID="boothnote-itest-$$"
AUDIO_DIR="$(mktemp -d "${TMPDIR:-/tmp}/boothnote-itest-audio.XXXXXX")"
LOG="$(mktemp "${TMPDIR:-/tmp}/boothnote-itest-gw.XXXXXX.log")"
GW_PID=""

# ── 出口：无论怎么退出都拆干净 ──────────────────────────────────────
cleanup() {
  local code=$?
  [ -n "$GW_PID" ] && kill "$GW_PID" 2>/dev/null
  docker rm -f "$CID" >/dev/null 2>&1
  rm -rf "$AUDIO_DIR"
  if [ "$code" -ne 0 ] && [ -s "$LOG" ]; then
    printf '\n\033[33m── 一次性网关的最后 30 行日志 ──\033[0m\n'
    tail -30 "$LOG"
  fi
  rm -f "$LOG"
  printf '\n\033[2m一次性环境已拆除（容器 %s · 端口 %s/%s）\033[0m\n' "$CID" "$PG_PORT" "$GW_PORT"
  exit "$code"
}
trap cleanup EXIT INT TERM

# ── Twenty：默认指向一个不通的端口 ──────────────────────────────────
TWENTY_URL="http://127.0.0.1:9"
TWENTY_KEY="itest-placeholder"
if [ "$WITH_TWENTY" -eq 1 ]; then
  [ -f "$ROOT/.env" ] || die "--with-twenty 要从 .env 读 SERVER_URL / TWENTY_API_KEY，而这里没有 .env。
   （worktree 里通常没有 —— 到主仓库目录下跑，或者别加这个参数。）"
  # shellcheck disable=SC1091
  set -a; . "$ROOT/.env" 2>/dev/null; set +a
  TWENTY_URL="${SERVER_URL:-}"
  TWENTY_KEY="${TWENTY_API_KEY:-}"
  [ -n "$TWENTY_URL" ] && [ -n "$TWENTY_KEY" ] || die "--with-twenty：.env 里没读到 SERVER_URL / TWENTY_API_KEY。"
  # 🔴 生产的 CRM 一个字都不许写。集成测试会建**真记录**，而线上那份是真数据。
  case "$TWENTY_URL" in
    http://localhost:*|http://127.0.0.1:*|http://\[::1\]:*) ;;
    *) die "--with-twenty 只对**本地** Twenty 开放，而 SERVER_URL = $TWENTY_URL。
   集成测试会往里建真记录 —— 线上的 CRM 一条都不许写。
   要验生产只能用只读的 ./scripts/smoke.sh <地址>。" ;;
  esac
  printf '\n\033[33m⚠️  --with-twenty：这一轮会往 %s 建**真的** CRM 记录。\033[0m\n' "$TWENTY_URL"
  printf '\033[33m    跑完会自动清（purge-test-records.mjs）。\033[0m\n'
fi

# ── 起一次性 Postgres ───────────────────────────────────────────────
say ""
say "━━ 一次性环境 · Postgres:${PG_PORT} · 网关:${GW_PORT} ━━"
docker run -d --name "$CID" \
  -e POSTGRES_PASSWORD=itest -e POSTGRES_DB=boothnote \
  -p "127.0.0.1:${PG_PORT}:5432" postgres:16 >/dev/null \
  || die "起不来一次性 Postgres。"

for i in $(seq 1 60); do
  docker exec "$CID" pg_isready -q 2>/dev/null && break
  [ "$i" -eq 60 ] && die "一次性 Postgres 60 秒还没就绪。"
  sleep 1
done

export APP_DATABASE_URL="postgres://postgres:itest@127.0.0.1:${PG_PORT}/boothnote"
export GATEWAY_PORT="$GW_PORT"
export GATEWAY_URL="http://127.0.0.1:${GW_PORT}"
export SERVER_URL="$TWENTY_URL"
export TWENTY_API_KEY="$TWENTY_KEY"
export OPENAI_API_KEY="${OPENAI_API_KEY:-itest-placeholder}"
export GATEWAY_JWT_SECRET="itest-not-a-real-secret-$$"
export GATEWAY_AUDIO_DIR="$AUDIO_DIR"
# 管理台那一档要它非空才跑得到（`/admin/*` 的 T85）
export ADMIN_TOKEN="itest-admin-token-$$"
# 钉钉渠道那一档同理（T93）：secret 留空 = 渠道 503，出站 ticker 也不跳
export CHANNEL_DINGTALK_SECRET="itest-channel-secret-$$"
# 订单门户那一档（D139）同理：留空 = /portal/* 503，真 HTTP 那两档整个 skip
export PORTAL_SECRET="itest-portal-secret-$$"
# 实验室 agent（T94）**故意不设自己的 secret** —— 生产上默认就是和上面那个共用，
# 测试要走的就是那条路径（有一条用例拿同一把钥匙打两个端点）。
# 同步等待压到 1 秒：一次性环境里模型必然失败，没必要每条用例都等 12 秒
export LAB_SYNC_WAIT_MS="${LAB_SYNC_WAIT_MS:-1000}"
# 默认不烧模型（占位 key 下 agent 也跑不出东西来）。
#
# 🔴 **但要能被覆盖 —— 因为 CI 是开着 agent 跑的，写死就再也复现不了 CI。**
#    2026-08-10 实测吃过一次：一条断言在 `AGENT_ENABLED=0` 下绿、在 CI 里红，
#    根因是转写队列开着时跑得比断言快。本地复现不了 CI 的配置，
#    就只能靠推 commit 上去撞 —— 那个循环一次要几分钟。
#
#        AGENT_ENABLED=1 ./scripts/test.sh integration     # 复现 CI 的那半边
#
#    ⚠️ 开着也不会花钱：`OPENAI_API_KEY` 是占位符，模型调用一律 401。
export AGENT_ENABLED="${AGENT_ENABLED:-0}"

# ── 迁移 + 起一次性网关 ─────────────────────────────────────────────
( cd services/gateway && node src/migrate.ts ) >/dev/null 2>&1 || die "迁移没跑成功。"
( cd services/gateway && node src/index.ts ) >"$LOG" 2>&1 &
GW_PID=$!

for i in $(seq 1 60); do
  curl -fsS "${GATEWAY_URL}/health" >/dev/null 2>&1 && break
  kill -0 "$GW_PID" 2>/dev/null || die "一次性网关启动时就退出了。"
  [ "$i" -eq 60 ] && die "一次性网关 60 秒还没起来。"
  sleep 1
done
printf '  ✅ 就绪（Twenty：%s）\n\n' "$([ "$WITH_TWENTY" -eq 1 ] && echo "$TWENTY_URL" || echo '不接 —— 要写 CRM 的用例会 skip')"

# ── 跑 ──────────────────────────────────────────────────────────────
FAILED=0
# ⚠️ `${arr[@]}` 在空数组 + `set -u` 下会报 unbound variable（macOS 自带 bash 3.2）。
#    `${arr[@]+"${arr[@]}"}` 是「空就整个消失」的写法，两种 bash 上都对。
# 🔴 **两个文件必须串行，而且 `api.test.ts` 排最后。**（2026-08-17 被 CI 抓到）
#
# `node --test a b` 默认**并行**跑文件，而 `api.test.ts` 末尾那条「暴力破解 8 次锁 15 分钟」
# 会把这台机器的 IP 锁进网关内存 —— 并行时它会打中渠道档正在做的 `/admin` 调用，
# 后者当场 429。本地两次侥幸躲过（时序不同），CI 上稳定复现。
#
# 仓库里早就写着「暴力破解那条必须排在所有 /admin 用例最后」——
# **这条规则跨文件同样成立**，只是以前只有一个文件用 /admin，撞不出来。
#
# 顺带：两条都要跑完再算总账（`&&` 会让第一条红时第二条整个不跑，
# 那样一次只能看见一半的失败）。
# portal-api.test.ts 不碰 /admin，可以和渠道那两个并行（D139）
( cd services/gateway && node --test ${PASSTHRU[@]+"${PASSTHRU[@]}"} src/__tests__/channels-api.test.ts src/__tests__/lab-api.test.ts src/__tests__/portal-api.test.ts ) || FAILED=1
( cd services/gateway && node --test ${PASSTHRU[@]+"${PASSTHRU[@]}"} src/__tests__/api.test.ts ) || FAILED=1

# ── --with-twenty 时把建出来的 CRM 记录清掉 ─────────────────────────
if [ "$WITH_TWENTY" -eq 1 ]; then
  say ""
  say "━━ 清掉这一轮在 CRM 里建的东西 ━━"
  # 账本在一次性库里（staging.twenty_refs），容器还没销毁，所以这一步必须在 trap 之前
  node scripts/purge-test-records.mjs --yes || {
    printf '\033[33m  ⚠️ 自动清理没跑成功 —— 这一轮在 CRM 里建的记录还在。\033[0m\n'
    printf '\033[33m     一次性库马上就销毁了（线索也就没了），现在手动跑一次：\033[0m\n'
    printf '\033[33m       APP_DATABASE_URL=%s node scripts/purge-test-records.mjs --yes\033[0m\n' "$APP_DATABASE_URL"
    FAILED=1
  }
fi

exit "$FAILED"
