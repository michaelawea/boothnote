#!/usr/bin/env bash
# 服务器一次性初始化：Docker + 防火墙 + swap 检查。
# 在**全新的 VPS 机器**上以 root 执行一次。可重复运行（幂等）。
#
#   ssh root@203.0.113.10
#   curl -fsSL https://raw.githubusercontent.com/michaelawea/boothnote/main/infra/server-init.sh | bash
#   （或先 clone 再跑 ./infra/server-init.sh）
set -euo pipefail

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()  { printf '  ✅ %s\n' "$*"; }
warn(){ printf '  ⚠️  %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "请用 root 执行"; exit 1; }

# ── 1. 系统信息 ────────────────────────────────────────────────────
say "系统"
. /etc/os-release
echo "  $PRETTY_NAME · $(uname -m) · $(nproc) vCPU · $(free -g | awk '/^Mem:/{print $2}') GB RAM"
DISTRO=$ID   # debian / ubuntu
case "$DISTRO" in debian|ubuntu) ok "支持的发行版" ;; *) warn "未测试过 ${DISTRO}，脚本按 Debian 系走" ; DISTRO=debian ;; esac

# ── 2. swap：构建镜像时会尖峰吃内存 ────────────────────────────────
say "swap"
if [ "$(swapon --show | wc -l)" -eq 0 ]; then
  # Vite/NestJS 构建的内存尖峰能压垮小机器 —— 给 4G swap 兜底，几乎不花磁盘
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "已建 4G swap（构建时防 OOM）"
else
  ok "已有 swap：$(free -h | awk '/^Swap:/{print $2}')"
fi

# ── 3. Docker ──────────────────────────────────────────────────────
say "Docker"
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  ok "已安装：$(docker --version | cut -d, -f1)"
else
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git ufw >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$DISTRO/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$DISTRO $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --now docker
  ok "已安装 $(docker --version | cut -d, -f1)"
fi

# ── 4. 防火墙：只放行 Cloudflare 回源 ──────────────────────────────
# 橙云的防护，只有在别人无法绕过它直连你的 IP 时才成立。
say "防火墙"
apt-get install -y -qq ufw >/dev/null 2>&1 || true
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
N=0
for ip in $(curl -fsS https://www.cloudflare.com/ips-v4) $(curl -fsS https://www.cloudflare.com/ips-v6); do
  ufw allow from "$ip" to any port 80,443 proto tcp >/dev/null && N=$((N+1))
done
ufw --force enable >/dev/null
ok "已放行 SSH + $N 个 Cloudflare 网段的 80/443；其余全部拒绝"

# ⚠️ Docker 会自己往 iptables 写规则，可能绕过 ufw。把 compose 里
#    对外的端口都交给 Caddy（只有它 map 80/443），其余服务只在内网，即可避免。
say "检查 Docker 是否绕过 ufw"
if [ -f /etc/docker/daemon.json ] && grep -q '"iptables": *false' /etc/docker/daemon.json; then
  ok "已禁用 Docker 自管 iptables"
else
  warn "Docker 默认会自行写 iptables 规则，可能绕过 ufw。"
  warn "本项目只有 Caddy 映射 80/443，其余服务不映射端口，所以影响可控。"
  warn "若之后给别的服务加了 ports:，记得确认它没被暴露到公网。"
fi

# ── 5. 完成 ────────────────────────────────────────────────────────
say "完成"
cat <<'EOS'
  下一步（见 docs/deploy.md §2.3 起）：
    1. ssh-keygen 生成 deploy key，加到 GitHub 仓库
    2. git clone git@github.com:michaelawea/boothnote.git ~/boothnote
    3. 按 §2.5 生成 .env（密钥在本机现生成，不要从别处拷）
    4. 按 §3 分两步启动
EOS
