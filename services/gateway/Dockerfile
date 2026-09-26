# 网关。构建**在目标机器上跑**（D29：Mac 永不产出生产镜像）。
# Node 24+ 原生剥离 TypeScript 类型，没有构建步骤 —— 源码直接是产物。
FROM node:24-alpine

WORKDIR /app

# 依赖层单独缓存：只有 lock 变了才重装
COPY services/gateway/package.json services/gateway/package-lock.json ./
RUN npm ci --omit=dev

COPY services/gateway/src ./src
COPY services/gateway/migrations ./migrations
# 🔴 **agent 是 `src/` 的兄弟目录，不是它的子目录**（issue #17，2026-08-05）。
#    网关用 `../agent/src/...` 引它，所以这一行漏了 = 容器起不来（而且是启动即崩，
#    不是静默失败 —— 这一点是刻意的）。
#    它必须留在 /app 之下：node 只往祖先目录找 node_modules，而依赖装在 /app。
COPY services/gateway/agent ./agent

# 音频落这里，由 named volume 挂载。
# ⚠️ pg_dump 不含这些文件，备份脚本要单独同步（infra/backup.sh）
RUN mkdir -p /data/audio
ENV GATEWAY_AUDIO_DIR=/data/audio
ENV GATEWAY_PORT=4000

EXPOSE 4000
CMD ["node", "src/index.ts"]
