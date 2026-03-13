# pnpm 迁移 — 完成总结

## 变更概览

将项目包管理器从 npm 全面迁移至 pnpm，解决国内 ECS 环境下 `npm install` 速度极慢的问题。

---

## 修改文件清单

| 文件 | 变更内容 |
|---|---|
| `package.json` | 新增 `packageManager: pnpm@10.12.4`；`start` 脚本内调用改为 `pnpm run build`；新增 `pnpm.onlyBuiltDependencies` 允许 bcrypt/esbuild 自动编译原生模块 |
| `pnpm-lock.yaml` | 新增，替代 `package-lock.json` |
| `package-lock.json` | 已删除 |
| `.gitignore` | 新增排除 `package-lock.json` |
| `.dockerignore` | 新增排除 `package-lock.json` |
| `Dockerfile` | builder/runtime 两个阶段均改用 `corepack` 激活 pnpm；`npm ci` → `pnpm install --frozen-lockfile`；`npm ci --only=production` → `pnpm install --frozen-lockfile --prod` |
| `docs/deployment.md` | 阿里云指南第一步增加 `corepack enable` 安装 pnpm；第四、七步所有 `npm install` 命令替换为 `pnpm install --prod` |

---

## 关键决策说明

- **`onlyBuiltDependencies`**：pnpm v10 默认禁止原生模块构建脚本，通过在 `package.json` 中声明白名单（`bcrypt`、`esbuild`）代替交互式 `pnpm approve-builds`，确保 CI/Docker 环境自动通过。
- **`--frozen-lockfile`**：Docker 构建中等价于 `npm ci` 语义，严格锁定版本，避免构建产物不一致。
- **corepack**：Node.js 20 内置，无需额外安装步骤，ECS/Docker 均可直接启用。

---

## 本地验证

```bash
pnpm install   # 10.5s 完成，无 Warning
```

ECS 上建议配合淘宝镜像进一步加速：

```bash
pnpm config set registry https://registry.npmmirror.com
pnpm install --prod
```