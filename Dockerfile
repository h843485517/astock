# ── 阶段一：构建前端 ────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# 启用 corepack 并激活 pnpm（Node.js 20 内置）
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml ./

# 安装全量依赖（包含 vite 等 devDependencies）
RUN pnpm install --frozen-lockfile

COPY . .

# 编译前端静态资源到 dist/
RUN pnpm run build

# ── 阶段二：生产运行 ────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# 启用 corepack 并激活 pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml ./

# 仅安装生产依赖
RUN pnpm install --frozen-lockfile --prod

# 从构建阶段复制源码和编译产物
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src  ./src
COPY --from=builder /app/server.js ./server.js

# 确保数据目录存在
RUN mkdir -p data

EXPOSE 3000

CMD ["node", "server.js"]