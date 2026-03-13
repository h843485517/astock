# pnpm 迁移：将项目包管理器从 npm 替换为 pnpm

- [x] 任务 1：本地生成 pnpm-lock.yaml 并清理 npm 锁文件
    - 1.1 在本地安装 pnpm：`corepack enable && corepack prepare pnpm@latest --activate`
    - 1.2 执行 `pnpm install` 生成 `pnpm-lock.yaml`
    - 1.3 删除 `package-lock.json`

- [x] 任务 2：更新 package.json（声明 packageManager + 修复 start 脚本）
    - 2.1 新增 `"packageManager": "pnpm@10.6.5"` 字段
    - 2.2 将 `scripts.start` 中的 `npm run build` 改为 `pnpm run build`

- [x] 任务 3：更新 .gitignore 和 .dockerignore，排除 package-lock.json
    - 3.1 在 `.gitignore` 中新增 `package-lock.json`
    - 3.2 在 `.dockerignore` 中新增 `package-lock.json`

- [x] 任务 4：重写 Dockerfile，将 npm 替换为 pnpm
    - 4.1 builder 阶段：添加 `corepack enable && corepack prepare pnpm@latest --activate`，复制 `pnpm-lock.yaml`，`npm ci` → `pnpm install --frozen-lockfile`
    - 4.2 runtime 阶段：同样启用 corepack，`npm ci --only=production` → `pnpm install --frozen-lockfile --prod`

- [x] 任务 5：更新 docs/deployment.md 中的阿里云部署指南
    - 5.1 第一步初始化 ECS 中追加安装 pnpm 的命令（corepack enable + prepare）
    - 5.2 第四步部署应用代码中 `npm install --omit=dev` → `pnpm install --prod`
    - 5.3 第七步后续更新代码中 `npm install --omit=dev` → `pnpm install --prod`
