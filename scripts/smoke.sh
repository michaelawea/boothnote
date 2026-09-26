#!/usr/bin/env bash
# 冒烟测试 —— **只读，对生产也安全**。不写任何数据。
#
#   ./scripts/smoke.sh                                  # 本地（localhost:5173 + :4000）
#   ./scripts/smoke.sh https://capture.example.com https://crm.example.com
#
# 集成测试（会建/删数据）在 services/gateway/src/__tests__/api.test.ts，那个只对本地跑。
set -uo pipefail

CAPTURE="${1:-http://localhost:5173}"
CRM="${2:-http://localhost:3000}"
CAPTURE="${CAPTURE%/}"; CRM="${CRM%/}"

PASS=0; FAIL=0
ok()   { printf '  ✅ %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  ❌ %s\n' "$*"; FAIL=$((FAIL+1)); }
warn() { printf '  ⚠️  %s\n' "$*"; }

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }

printf '\n▸ 采集端 %s\n' "$CAPTURE"

c=$(code "$CAPTURE/")
[ "$c" = 200 ] && ok "PWA 首页 200" || bad "PWA 首页 HTTP $c"

# 重定向环 —— Flexible 模式漏了 SITE_SCHEME=http:// 的典型症状
n=$(curl -s -o /dev/null -w '%{num_redirects}' --max-time 15 -L "$CAPTURE/")
[ "$n" = 0 ] && ok "无重定向环（num_redirects=0）" || bad "有 $n 次重定向 —— 检查 SITE_SCHEME"

c=$(code "$CAPTURE/api/health")
[ "$c" = 200 ] && ok "网关 /api/health 200" || bad "网关 HTTP $c"

# 鉴权必须在服务端拦住（§4.2 第1条）
c=$(code "$CAPTURE/api/companies")
[ "$c" = 401 ] && ok "无 token 取 /api/companies → 401（服务端拦住了）" \
               || bad "无 token 竟然拿到 HTTP $c —— 鉴权没生效"

# 麦克风权限策略：被边缘吃掉的话手机上直接录不了音。
# ⚠️ 本地是 Vite dev server，没有 Caddy —— 这个头本来就不存在，不该判失败。
#    一个在本地永远红的检查，很快就会被人无视。
LOCAL=0; case "$CAPTURE" in *localhost*|*127.0.0.1*) LOCAL=1 ;; esac
h=$(curl -s -I --max-time 15 "$CAPTURE/" | tr -d '\r' | grep -i '^permissions-policy:' || true)
if echo "$h" | grep -qi 'microphone'; then
  ok "Permissions-Policy 透传（含 microphone）"
elif [ "$LOCAL" = 1 ]; then
  warn "本地无 Caddy，Permissions-Policy 不存在（正常）"
else
  bad "Permissions-Policy 丢了 —— MediaRecorder 会被挡"
fi

# R17：Service Worker 被边缘缓存 = 所有人卡在旧版本，且极难自查
sw=$(curl -s -I --max-time 15 "$CAPTURE/sw.js" | tr -d '\r')
cc=$(echo "$sw" | grep -i '^cache-control:' | head -1 | cut -d' ' -f2-)
cf=$(echo "$sw" | grep -i '^cf-cache-status:' | head -1 | cut -d' ' -f2-)
[ -n "$cc" ] || cc='(none)'
[ -n "$cf" ] || cf='(none)'
if echo "$cc" | grep -qiE 'no-cache|no-store|max-age=0'; then
  ok "sw.js 不被缓存（cache-control: ${cc}）"
elif [ "$cf" != '(none)' ] && [ "$cf" != 'BYPASS' ]; then
  bad "R17：sw.js 被 Cloudflare 缓存（cf-cache-status: $cf · cache-control: ${cc}）→ 建 bypass-sw 规则"
else
  warn "sw.js cache-control: $cc · cf-cache-status: $cf"
fi

# ── agent（阶段 P 之后新增）────────────────────────────────────────
# 队列积压是典型的「等你发现时已经影响所有人」：手机端一切正常、
# 速记照收，但没有一条抽出字段 —— 而没有人会主动去看 staging 的状态分布。
ah=$(curl -s --max-time 15 "$CAPTURE/api/agent/health")
if echo "$ah" | grep -q '"enabled"'; then
  ok "agent /health 有响应"
  echo "$ah" | grep -q '"enabled":true' && ok "agent 开着" || bad "agent 是关的（AGENT_ENABLED=0）"
  q=$(echo "$ah" | sed -n 's/.*"queued":\([0-9]*\).*/\1/p')
  [ -n "$q" ] || q=0
  if [ "$q" -gt 20 ]; then bad "agent 队列积压 $q 条 —— 抽取跟不上，去看网关日志"
  else ok "agent 队列 $q 条"; fi
  le=$(echo "$ah" | sed -n 's/.*"lastError":"\([^"]*\)".*/\1/p')
  [ -n "$le" ] && warn "上一次处理报过错：${le:0:80}"

  # ── 转写链路（D85 · issue #19）────────────────────────────────────
  #
  # 🔴 **这一项是 bad，不是 warn**，而且和上面那个 lastError 问的不是同一个问题：
  #   · lastError    —— 「**已经**有人踩雷了吗」。它天然滞后：08-07 上线那次
  #     这一项是空的（当时还没人录音），一路绿灯；直到下午 维护者 录了那段
  #     语音才有 warn。**它只能在第一段录音已经丢了之后才开口。**
  #   · 这一项       —— 「**现在**踩下去会不会响」。网关一起来就有答案。
  #
  # 而 2026-08-07 那次事故正是：部署当天冒烟 15✅/0❌，语音却 100% 不可用。
  st=$(echo "$ah" | sed -n 's/.*"transcribeSelfTest":{"status":"\([a-z]*\)".*/\1/p')
  case "$st" in
    ok)       ok "转写自检通过（语音链路现在是通的）" ;;
    degraded) warn "转写自检降级：可选参数被拒、已自动关掉 —— 转写能用，但更容易听错专有名词" ;;
    failed)   bad "🔴 转写自检失败 —— **语音输入多半是坏的**。这是展会现场的主输入路径，先修它" ;;
    skipped)  warn "转写自检被关掉了（TRANSCRIBE_SELFTEST=0）—— 生产上不该关" ;;
    *)        warn "转写自检还没有结果（网关刚起来？隔十几秒再跑一次）" ;;
  esac
else
  bad "agent /health 拿不到（网关是旧版？）"
fi

# 新端点也必须在服务端拦住 —— 前端过滤等于没过滤（§4.2 第4条）
for p in threads companies/search gaps/ANY; do
  c=$(code "$CAPTURE/api/$p")
  [ "$c" = 401 ] && ok "无 token /api/$p → 401" || bad "/api/$p 无 token 返回 HTTP $c"
done

# ── 管理控制台 ────────────────────────────────────────────────────
# 这一项抓的是一个**不报错的失败**：路径没被 Caddy 接住时，请求落到 SPA 兜底，
# 返回 200 + index.html —— 看起来像"进去了"，其实是采集端首页。
ADMIN_PATH="${ADMIN_PATH:-/console}"
t=$(curl -s --max-time 15 "$CAPTURE$ADMIN_PATH" | grep -o '<title>[^<]*' | head -1)
case "$t" in
  *账号管理*) ok "管理控制台在 $ADMIN_PATH" ;;
  *速记*)     warn "$ADMIN_PATH 返回的是采集端首页 —— 要么 ADMIN_PATH 设成了别的，要么代理没接住" ;;
  *)          warn "$ADMIN_PATH 拿到「${t:-空}」，自己确认一下" ;;
esac
# 数据接口必须要 token（页面壳本身不需要）
c=$(code "$CAPTURE$ADMIN_PATH/users")
case "$c" in
  401) ok "控制台数据接口无 token → 401" ;;
  503) warn "控制台已关闭（.env 没有 ADMIN_TOKEN）—— 这是安全默认，不是故障" ;;
  *)   bad "控制台数据接口无 token 返回 HTTP $c" ;;
esac

printf '\n▸ Twenty %s\n' "$CRM"
c=$(code "$CRM/healthz")
[ "$c" = 200 ] && ok "Twenty /healthz 200" || bad "Twenty HTTP $c"

printf '\n%s\n  通过 %d · 失败 %d\n' "$(printf '─%.0s' {1..50})" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
