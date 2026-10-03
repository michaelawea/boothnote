# Caddy 镜像里直接带上构建好的 PWA —— 一个镜像同时负责 HTTPS、反代、静态托管。
# 构建 context 是仓库根目录。

FROM node:24-alpine AS pwa
WORKDIR /src
COPY apps/capture-pwa/package.json apps/capture-pwa/package-lock.json ./
RUN npm ci
COPY apps/capture-pwa/ ./
COPY shared /shared
# 前端与网关同源（/api），所以这里不需要注入绝对地址
ENV VITE_GATEWAY_URL=/api
# 构建期关掉测试界面时，连对应的懒加载包也不生成。
ARG VITE_ASSISTANT_UI_ENABLED=1
ENV VITE_ASSISTANT_UI_ENABLED=$VITE_ASSISTANT_UI_ENABLED
RUN npm run build

FROM caddy:2-alpine
COPY --from=pwa /src/dist /srv/capture
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
