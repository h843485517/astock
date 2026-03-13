# ── 阶段一：构建前端 ────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./

# 安装全量依赖（包含 vite 等 devDependencies）
RUN npm ci

COPY . .

# 编译前端静态资源到 dist/
RUN npm run build

# ── 阶段二：生产运行 ────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

# 仅安装生产依赖
RUN npm ci --only=production

# 从构建阶段复制源码和编译产物
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src  ./src
COPY --from=builder /app/server.js ./server.js

# 确保数据目录存在
RUN mkdir -p data

EXPOSE 3000

CMD ["node", "server.js"]