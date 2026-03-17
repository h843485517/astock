# ── 阶段一：构建前端 ────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# 启用 corepack，锁定 pnpm 版本（与 pnpm-lock.yaml 一致，避免联网下载 latest）
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

# 配置 npm/pnpm 使用淘宝镜像，防止 ECS 访问 registry.npmjs.org 超时
RUN npm config set registry https://registry.npmmirror.com && \
    pnpm config set registry https://registry.npmmirror.com

COPY package.json pnpm-lock.yaml ./

# 安装全量依赖（包含 vite 等 devDependencies）
RUN pnpm install --frozen-lockfile

COPY . .

# 编译前端静态资源到 dist/
RUN pnpm run build

# ── 阶段二：生产运行 ────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# 启用 corepack，锁定 pnpm 版本
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

# 配置镜像源
RUN npm config set registry https://registry.npmmirror.com && \
    pnpm config set registry https://registry.npmmirror.com

COPY package.json pnpm-lock.yaml ./

# 仅安装生产依赖
RUN pnpm install --frozen-lockfile --prod

# 从构建阶段复制源码和编译产物
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src  ./src
COPY --from=builder /app/server.js ./server.js

# 确保数据目录存在
RUN mkdir -p data

CMD ["node", "server.js"]