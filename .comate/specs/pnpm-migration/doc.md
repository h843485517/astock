# pnpm 迁移需求文档

## 需求背景

当前项目使用 npm 管理依赖，在国内 ECS 环境下 `npm install` 速度极慢。pnpm 通过硬链接共享全局缓存、并行下载，速度显著优于 npm，且天然支持 `--registry` 切换镜像，是本次迁移的核心动机。

---

## 影响文件与修改类型

| 文件 | 修改类型 | 影响函数/字段 |
|---|---|---|
| `package.json` | 修改字段、更新脚本 | `scripts.start`、新增 `packageManager` |
| `Dockerfile` | 替换安装命令 | builder 阶段 `npm ci`、runtime 阶段 `npm ci --only=production` |
| `.dockerignore` | 新增排除项 | 排除 `package-lock.json` |
| `.gitignore` | 新增排除项 | 排除 `package-lock.json` |
| `docs/deployment.md` | 更新命令示例 | 阿里云指南中所有 `npm install` 命令 |

---

## 实现细节

### 1. package.json

**新增 `packageManager` 字段**，声明项目使用 pnpm，Node.js corepack 可据此自动激活正确版本：

```json
"packageManager": "pnpm@10.6.5"
```

**更新 `start` 脚本**，内部 `npm run build` 改为 `pnpm run build`（避免在 pnpm 环境中嵌套调用 npm）：

```json
"start": "pnpm run build && node server.js"
```

### 2. Dockerfile

**builder 阶段**：
- 启用 corepack 并激活 pnpm（Node.js 20 内置 corepack，无需额外安装）
- 复制 `pnpm-lock.yaml` 而非 `package-lock.json`（利用 Docker 层缓存）
- `npm ci` → `pnpm install --frozen-lockfile`（等价于 ci 语义，锁定版本）

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build
```

**runtime 阶段**：
- 同样启用 corepack
- `npm ci --only=production` → `pnpm install --frozen-lockfile --prod`

```dockerfile
FROM node:20-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src  ./src
COPY --from=builder /app/server.js ./server.js
RUN mkdir -p data
EXPOSE 3000
CMD ["node", "server.js"]
```

### 3. .dockerignore

新增排除 `package-lock.json`（已切换到 `pnpm-lock.yaml`，避免旧锁文件混入镜像）：

```
package-lock.json
```

### 4. .gitignore

同样排除 `package-lock.json`，仅跟踪 `pnpm-lock.yaml`：

```
package-lock.json
```

### 5. docs/deployment.md

更新阿里云完整指南中的安装命令：

| 原命令 | 新命令 |
|---|---|
| `npm install --omit=dev` | `pnpm install --prod` |
| `npm install --omit=dev`（更新步骤） | `pnpm install --prod` |

并在第一步初始化 ECS 时增加安装 pnpm 的步骤：

```bash
# 安装 pnpm（通过 corepack，Node.js 16+ 内置）
corepack enable
corepack prepare pnpm@latest --activate
```

---

## 边界条件与注意事项

- 迁移前需在本地执行 `pnpm install` 生成 `pnpm-lock.yaml`，并将其提交到 Git
- 原 `package-lock.json` 在生成 `pnpm-lock.yaml` 后可删除
- `bcrypt` 依赖原生模块编译，pnpm 同样需要 `build-essential`，ECS 上已有相关提示，无需额外处理
- Docker 镜像中使用 `corepack prepare pnpm@latest` 确保 pnpm 版本与本地一致

---

## 预期成果

- 本地 `pnpm install` 速度比 npm 快 2~5 倍（全局缓存复用）
- ECS 上首次安装加镜像后可在 30 秒内完成
- Docker 构建层缓存命中率与原 `npm ci` 方案持平
- 项目文档同步更新，部署步骤描述准确