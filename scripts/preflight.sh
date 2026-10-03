#!/usr/bin/env bash
# 部署前自检 —— **本机和服务器上都能跑，不改任何东西**。
#
#   ./scripts/preflight.sh            本机开发：只查跑起来需要的东西
#   ./scripts/preflight.sh prod       服务器：外加域名、TLS 配对这些只有线上才有的
#   ./scripts/preflight.sh prod --models   再核对一次 OpenAI 模型名（要联网、要 key）
#
# 存在的理由：`docs/deploy.md` §10 那张故障对照表里，11 个症状有 7 个的根因
# 是「.env 里某两项没配成对」。那些错的共同点是 **报错完全指不到原因** ——
# ERR_TOO_MANY_REDIRECTS 不会告诉你是 SITE_SCHEME 漏了。这个脚本 5 秒给答案。
#
# 🔴 **只报「有没有」，绝不回显任何值。** 秘密不进日志、不进终端记录。
set -uo pipefail
cd "$(dirname "$0")/.."

MODE=local
for a in "$@"; do [ "$a" = "prod" ] && MODE=prod; done

PASS=0; FAIL=0; WARN=0
ok()   { printf '  ✅ %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  ❌ %s\n' "$*"; FAIL=$((FAIL+1)); }
warn() { printf '  ⚠️  %s\n' "$*"; WARN=$((WARN+1)); }
head_() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

# ── .env ───────────────────────────────────────────────────────────
head_ "配置文件"
if [ ! -f .env ]; then
  bad ".env 不存在。从 .env.example 复制一份，值只有 维护者 能填。"
  echo; echo "  通过 $PASS · 警告 $WARN · 失败 $FAIL"; exit 1
fi
ok ".env 存在"

# 只取键名，**不取值**。下面所有判断都基于「这个键有没有非空值」。
has() { grep -qE "^[[:space:]]*$1[[:space:]]*=[[:space:]]*[^[:space:]]" .env; }
# 🔴 **这个脚本从不 source .env** —— 所有判断都走上面这些 grep。
#    极少数检查需要值本身（比如「这个路径指的文件在不在」），用它取，
#    但**取到的值只许参与判断，绝不许出现在任何输出里**（脚本头上那条纪律）。
#    2026-08-17 踩过：有段代码直接写 `${PRODUCT_PRICING_FILE}`，以为它在环境里 ——
#    `set -u` 下当场 unbound，**只要配了那一项，每一次部署都被卡死在自检**。
val() {
  grep -E "^[[:space:]]*$1[[:space:]]*=" .env | tail -1 |
    sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}
val_is() { grep -qE "^[[:space:]]*$1[[:space:]]*=[[:space:]]*[\"']?$2[\"']?[[:space:]]*$" .env; }
is_empty() { grep -qE "^[[:space:]]*$1[[:space:]]*=[[:space:]]*$" .env; }

head_ "必填项（只看有没有，不看是什么）"
for k in APP_DATABASE_URL GATEWAY_JWT_SECRET SERVER_URL TWENTY_API_KEY OPENAI_API_KEY; do
  has "$k" && ok "$k 已设置" || bad "$k 缺失或为空 —— 网关会拒绝启动"
done

for k in PG_DATABASE_PASSWORD APP_SECRET; do
  has "$k" && ok "$k 已设置" || warn "$k 没设置（Twenty 那边可能起不来）"
done

# ── 那对最容易漏的 ─────────────────────────────────────────────────
# 下面这一整段只对线上有意义 —— 本机跑 vite + node，没有 Caddy、没有域名。
# 一个在本地永远红的检查，很快就会被人无视，那时它连线上也保不住了。
if [ "$MODE" = prod ]; then
head_ "Cloudflare 模式：SITE_SCHEME 与 TLS_DIRECTIVE 必须成对"
# 测试期用 Flexible：Cloudflare 到源站是 http，所以 Caddy 不能自己签证书，
# 而 Twenty 生成的绝对链接必须是 http:// —— 漏掉前者就 ERR_TOO_MANY_REDIRECTS，
# 而且那个报错完全指不到原因（踩过，见规划文档 §2.11）。
if val_is SITE_SCHEME 'http://'; then
  if is_empty TLS_DIRECTIVE || ! has TLS_DIRECTIVE; then
    ok "Flexible 模式配对正确（SITE_SCHEME=http:// + TLS_DIRECTIVE 空）"
  else
    bad "SITE_SCHEME=http:// 但 TLS_DIRECTIVE 非空 —— Caddy 会去签证书然后打架"
  fi
elif val_is SITE_SCHEME 'https://'; then
  has TLS_DIRECTIVE && ok "Full 模式配对正确（https:// + TLS_DIRECTIVE 非空）" \
                    || bad "SITE_SCHEME=https:// 但 TLS_DIRECTIVE 空 —— 源站没有证书"
else
  warn "SITE_SCHEME 不是 http:// 也不是 https://，自己确认一下"
fi

head_ "域名"
for k in CAPTURE_DOMAIN CRM_DOMAIN; do
  has "$k" && ok "$k 已设置" || bad "$k 缺失 —— Caddy 的站点块会是空的"
done
has ACME_EMAIL && ok "ACME_EMAIL 已设置" || warn "ACME_EMAIL 没设（Full 模式签证书要用）"
else
head_ "线上项"
echo "  ⏭  本机模式，跳过域名 / TLS / Caddy 相关检查（服务器上加 prod 参数）"
fi

# ── D66：.env 写了 ≠ 容器读得到 ───────────────────────────────────
# 2026-08-04 踩的：ADMIN_TOKEN 在 .env 里好好的，preflight 报绿，
# 但 docker-compose 的 gateway 段压根没转发它 —— 容器里是空的，
# 于是管理控制台永远 503，而所有检查都说没问题。
# 这一段把「env.ts 会读的键」和「compose/Dockerfile 会传的键」对一遍。
head_ "网关容器拿得到吗（.env → docker-compose → 进程）"
GW_ENV=$(sed -n '/^  gateway:/,/^  [a-z]/p' docker-compose.yml)
GW_DOCKERFILE=$(cat services/gateway/Dockerfile 2>/dev/null || true)
leak=0
for k in $(grep -oE "(opt|get)\('[A-Z_0-9]+'" services/gateway/src/env.ts | grep -oE "[A-Z_0-9]{3,}" | sort -u); do
  has "$k" || continue                      # .env 里没设的，用默认值，不关这段的事
  if printf '%s' "$GW_ENV" | grep -qE "^      $k:" || printf '%s' "$GW_DOCKERFILE" | grep -qE "^ENV $k="; then
    continue
  fi
  bad "$k 在 .env 里设了，但 docker-compose.yml 的 gateway environment 没传 —— 容器里读不到，等于没设"
  leak=1
done
[ "$leak" = 0 ] && ok ".env 里设过的键，网关容器都拿得到"

head_ "可选开关"
has ADMIN_TOKEN && ok "ADMIN_TOKEN 已设置（管理控制台开）" \
               || warn "ADMIN_TOKEN 为空 → 管理控制台整个 503 关闭（这是**安全默认**，不是故障）"
# 订单门户的项目进度（D139）。留空 = 门户那边「Projects」菜单不出现，不是故障。
has PORTAL_SECRET && ok "PORTAL_SECRET 已设置（/portal/* 开 —— 门户的 data/.projects-secret 必须是同一个值）" \
                  || warn "PORTAL_SECRET 为空 → /portal/* 503 关闭（安全默认；门户的项目功能跟着关）"
# 钉钉渠道（T93）。展会前刻意留空 —— 留空 = 这个功能不存在，不是故障。
if has CHANNEL_DINGTALK_SECRET; then
  ok "CHANNEL_DINGTALK_SECRET 已设置（钉钉渠道开）"
  has CAPTURE_URL || has CAPTURE_DOMAIN \
    || warn "CAPTURE_URL / CAPTURE_DOMAIN 都为空 → 钉钉回执里不会有「去确认入库」的链接（不放坏链接，见 D67）"
else
  warn "CHANNEL_DINGTALK_SECRET 为空 → 钉钉渠道 503 关闭（安全默认；展会前就该是这样）"
fi
# 实验室 agent（T94）：第二个 bot，**默认和录入 bot 共用同一个 secret**
if has CHANNEL_LAB_SECRET; then
  ok "CHANNEL_LAB_SECRET 已设置 —— 实验室 agent 用它自己那把（覆盖了默认的共用）"
elif has CHANNEL_DINGTALK_SECRET; then
  ok "实验室 agent 开，和录入 bot 共用同一个 secret（两条流程填同一个值）"
else
  warn "两个 secret 都为空 → 实验室 agent 503 关闭（安全默认）"
fi
# Voltline skill：文档下载 + 定价资料（T95）
has PRODUCT_DOCS_SHARE_URL && ok "PRODUCT_DOCS_SHARE_URL 已设置（fetch_document 会注册）" \
                        || warn "PRODUCT_DOCS_SHARE_URL 为空 → agent 取不了文档，只能查本地资料和索引"
# 🔴 这里填的是**容器里**的路径（data/ 挂成 /data-src）。配了却不存在时，
#    网关只会 warn 一句然后当没有定价 —— 一次配置失误伪装成一次数据缺失。
if has PRODUCT_PRICING_FILE; then
  P="$(val PRODUCT_PRICING_FILE)"
  HOSTP="${P/#\/data-src/./data}"
  if [ -f "$HOSTP" ]; then
    ok "定价资料在位（data/ 下那个文件存在，会随 ./data:/data-src:ro 挂进容器）"
    grep -qE "^[[:space:]]*-[[:space:]]*\./data:/data-src" docker-compose.yml \
      || bad "compose 里没有 ./data:/data-src 这条挂载 —— 文件在宿主机上，容器里看不到"
  else
    # 🔴 路径本身不回显：它来自 .env。要对的是「.env 那一行」和「data/ 下的文件名」。
    bad "PRODUCT_PRICING_FILE 指的文件在宿主机上不存在 —— 容器里读不到，群里问价会答「资料里没有」。对一下 .env 那一行和 data/ 下的实际文件名（容器路径 /data-src/… 对应宿主机 data/…）"
  fi
else
  warn "PRODUCT_PRICING_FILE 为空 → agent 手上没有 EU 分销价这份资料"
fi
# 看板链接是**发到别人手机上**的，绝不能是容器内网地址（D67）。
# 顺序：BOARD_URL → https://CRM_DOMAIN → SERVER_URL（最后这档在线上必错）。
if has BOARD_URL; then
  ok "BOARD_URL 已显式设置"
elif has CRM_DOMAIN; then
  ok "BOARD_URL 未设，将由 CRM_DOMAIN 推出 https:// 公网地址（D67）"
else
  bad "BOARD_URL 和 CRM_DOMAIN 都为空 → 看板链接回退到 SERVER_URL=http://server:3000（容器内网，手机打不开且不报错）"
fi
if val_is AGENT_CAN_CREATE_COLUMNS '1'; then
  warn "AGENT_CAN_CREATE_COLUMNS=1 —— 这条路径尚未实现，agent 仍走 IntelItem+IntelValue（见 D47）"
fi
if ! has AGENT_MULTI_ITEMS || val_is AGENT_MULTI_ITEMS '0'; then
  ok "AGENT_MULTI_ITEMS 关闭（灰度默认；已有事项仍可核对）"
elif val_is AGENT_MULTI_ITEMS '1'; then
  warn "AGENT_MULTI_ITEMS 已开启 —— 确认这是本次灰度范围"
else
  bad "AGENT_MULTI_ITEMS 只能是 0 或 1"
fi
if val_is AGENT_ENABLED '0'; then
  warn "AGENT_ENABLED=0 —— 采集照常，但不抽字段。确认这是你要的。"
fi
if grep -qE "^[[:space:]]*OPENAI_TRANSCRIBE_MODEL[[:space:]]*=[[:space:]]*[\"']?gpt-4o-transcribe" .env; then
  warn "转写模型还是 gpt-4o-transcribe。维护者 2026-08-03 要的是 gpt-transcribe —— 改 .env 那一行。"
fi

# ── 工具链 ─────────────────────────────────────────────────────────
head_ "工具链"
command -v docker >/dev/null && ok "docker 在" || bad "没有 docker"
docker compose version >/dev/null 2>&1 && ok "docker compose 在" || bad "没有 docker compose（v2）"
command -v node >/dev/null && ok "node $(node --version) 在" || warn "本机没有 node（服务器上不需要，容器里有）"

ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
  warn "本机是 $ARCH —— 镜像必须在目标机器上 build（VPS 是 x86_64），别从这里拷镜像过去（D29）"
else
  ok "架构 $ARCH"
fi

# ── 迁移文件 ───────────────────────────────────────────────────────
head_ "数据库迁移"
N=$(ls -1 services/gateway/migrations/*.sql 2>/dev/null | wc -l | tr -d ' ')
[ "$N" -gt 0 ] && ok "$N 个迁移文件（按编号顺序执行，已跑过的跳过）" || bad "找不到迁移文件"

# ── 模型名（可选，要联网）─────────────────────────────────────────
case " $* " in *" --models "*)
  head_ "OpenAI 模型名"
  # check-models.mjs 只读 key 发请求，不打印 key、不写日志
  node scripts/check-models.mjs && ok "两个模型都存在" || bad "模型名对不上 —— 见上面的候选列表"
;; esac

printf '\n%s\n  通过 %d · 警告 %d · 失败 %d\n' "$(printf '─%.0s' {1..52})" "$PASS" "$WARN" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '\n  🔴 有 %d 项必须先修好再部署。对照 docs/deploy.md §10。\n\n' "$FAIL"
  exit 1
fi
printf '\n  可以部署。\n\n'
