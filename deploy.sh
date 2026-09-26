#!/usr/bin/env bash
# 一条命令部署到 VPS。**每一步都幂等，跑第二遍不会出事。**
#
#   ./deploy.sh                  完整部署
#   ./deploy.sh --migrate-only   只跑数据库迁移
#   ./deploy.sh --provision-only 只同步 Twenty 的对象与字段
#   ./deploy.sh --skip-tests     跳过本地测试（不建议：CI 仍会拦）
#
# ⚠️ **这个脚本是从 Mac 上跑的**（它会 ssh 进服务器、还会 git push）。
#    **人已经在服务器上时不要跑它** —— 跑 `./scripts/deploy-server.sh` 代替，
#    那是同一段流程的同一份代码，不是抄写的副本。
#
# 部署序列的服务器段全部在 `scripts/deploy-server.sh` 里。
# 🔴 这里**不要**再复制一份 —— 那个序列的顺序是承重的（迁移必须早于新网关、
#    caddy 不能跟数据层一起起、数据守卫要卡在 provision 之后 backfill 之前），
#    两份一定会漂。判据：**一段必须被精确执行的流程只能有一个定义处。**
#
# D29：**镜像在目标机器上 build**，Mac 永不产出生产镜像
# （M3 是 arm64、VPS 是 x86_64，本地 build 推上去是 exec format error）。
#
# 需要 .env 里有：DEPLOY_HOST（如 root@203.0.113.10）· DEPLOY_PATH（服务器上仓库路径）
set -euo pipefail
cd "$(dirname "$0")"

step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31m🔴 %s\033[0m\n\n' "$*" >&2; exit 1; }

[ -f .env ] && set -a && . ./.env && set +a
: "${DEPLOY_HOST:?请在 .env 里设置 DEPLOY_HOST，例如 root@203.0.113.10}"
# ⚠️ 服务器上仓库实际在 /opt/boothnote（不是早期文档写的 ~/boothnote）。
#    compose 里写死了 name: boothnote，所以 `--network boothnote_default` 那类命令照抄即可。
DEPLOY_PATH="${DEPLOY_PATH:-/opt/boothnote}"

SKIP_TESTS=0
for a in "$@"; do [ "$a" = "--skip-tests" ] && SKIP_TESTS=1; done

# 服务器上跑一段：先拉代码，再交给那边的 deploy-server.sh。
# 拉取放在这里而不是脚本里，是因为**要先有新版本的脚本，才能用新版本的流程**。
remote() { ssh "$DEPLOY_HOST" "cd $DEPLOY_PATH && git pull --ff-only && bash scripts/deploy-server.sh $*"; }

# ── 只做一件事的两个快捷入口 ───────────────────────────────────────
if [ "${1:-}" = "--migrate-only" ];   then remote --migrate-only;   exit 0; fi
if [ "${1:-}" = "--provision-only" ]; then remote --provision-only; exit 0; fi

# ── 0. 本地先把能挡住的挡住 ───────────────────────────────────────
# 这一步不联网、几十秒，换的是「别把明显坏的东西推到生产上」。
if [ "$SKIP_TESTS" = 0 ]; then
  step "本地测试（类型 + 单元 + 构建）"
  ./scripts/test.sh >/dev/null || die "本地测试没过。修好再部署 —— CI 也会拦。"
  echo "  ✅ 通过"
fi

step "推送代码"
git push origin main

# ── 1. 服务器段（自检 → 构建 → 迁移 → schema → 数据 → 两道对账 → 冒烟）──
step "服务器上部署（构建在目标架构上进行）"
remote || die "服务器段失败。上面最后一条 🔴 就是原因；对照 docs/deploy.md §10。"

step "完成"
echo "  采集端  https://${CAPTURE_DOMAIN}"
echo "  CRM     https://${CRM_DOMAIN}"
echo
echo "  接下来："
echo "   · 给同事发账号之前，确认 Cloudflare 的 bypass-sw 规则已生效（冒烟里那一项）"
echo
