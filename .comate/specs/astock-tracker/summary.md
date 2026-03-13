# A股追踪器优化总结：旧代码清理 + 现代化UI + 后端安全与并发加固

## 完成情况

所有 4 个任务全部完成，构建验证通过，三项安全测试通过。

---

## 任务 1：删除旧 public/js 前端文件

- 删除 `public/js/`（api.js、app.js、pages/、components/ 共 6 个文件）
- 删除 `public/index.html`（旧 CDN 入口）
- 生产静态资源已由 Vite 构建输出的 `dist/` 全面接管

---

## 任务 2：现代化 UI 样式重构

完整重写 `client/src/assets/style.css`（从 9.7KB 增至 14.2KB），引入以下视觉效果：

| 改动 | 实现方式 |
|---|---|
| 毛玻璃卡片 | `backdrop-filter: blur(20px)` + 半透明背景 |
| 动态渐变背景 | `body::before` 多层 radial-gradient，`body::after` 网格线 |
| 大盘指数卡片悬停 | `translateY(-3px)` + `box-shadow` 过渡 |
| 涨跌呼吸光效 | `@keyframes rise-pulse / fall-pulse` text-shadow 动画 |
| 页面切换动画 | `App.vue` `<Transition name="page">` fade-slide |
| 表格行交互 | 悬停左侧 3px 蓝色高亮条 + 背景色渐变 |
| 按钮波纹 | `::after` pseudo-element + `radial-gradient` scale 动画 |
| 主按钮发光 | `box-shadow glow` + hover 提亮 |
| 骨架屏 | `shimmer` 动画占位条，替代 loading-spinner |
| 导航品牌图标 | 双色呼吸发光动画 |

---

## 任务 3：后端 SQL 注入防护

**核心结论**：better-sqlite3 全程使用预编译语句（`@named` 绑定参数），从底层杜绝 SQL 注入；此次在应用层追加多层防护：

- `src/routes/positions.js`：新增统一 `validateInput()` 函数，包含：
  - `type` 枚举白名单（`Object.freeze` 固化，仅允许 `stock`/`fund`）
  - `code` 正则 `/^(sh|sz)?\d{6}$/i`，杜绝特殊字符
  - `shares` 范围 `(0, 1e10]`，`cost_price` 范围 `(0, 1e7]`
  - `group_name` ≤ 30 字，`name` ≤ 50 字
- `src/db/database.js`：`ALLOWED_UPDATE_FIELDS` 改为 `Object.freeze`，防止原型链污染

测试验证：注入 `"type":"evil; DROP TABLE positions;--"` → 被拦截，返回 `type 必须为 stock 或 fund`。

---

## 任务 4：后端高并发处理

| 措施 | 详情 |
|---|---|
| `cluster` 多进程 | 生产环境按 CPU 核数 fork worker，崩溃自动重启；开发模式（`NODE_ENV=development`）单进程 |
| SSE 连接数上限 | `MAX_SSE_CLIENTS=100`，超出返回 503 |
| SQLite busy_timeout | `db.pragma('busy_timeout = 5000')`，并发写入不再抛出 SQLITE_BUSY |
| 请求体限制 | `express.json({ limit: '100kb' })`，超出返回 413 + 精确提示 |

测试验证：
- SSE 推送 9 个指数正常
- 超大包体（200KB）→ 413 `请求体超出大小限制（最大 100KB）`

---

## 文件变更清单

| 文件 | 操作 |
|---|---|
| `public/js/`、`public/index.html` | 删除 |
| `client/src/assets/style.css` | 全量重写（现代化 UI）|
| `client/src/App.vue` | 加入 `<Transition>` 页面切换动画 |
| `client/src/pages/Home.vue` | 加入骨架屏 |
| `client/src/pages/Positions.vue` | 加入骨架屏 |
| `src/routes/positions.js` | 统一输入校验 `validateInput()` |
| `src/db/database.js` | `Object.freeze` 白名单 + `busy_timeout` |
| `src/routes/quote.js` | SSE 连接数限制（MAX 100）|
| `server.js` | `cluster` 多进程 + 请求体限制 + 413 错误处理 |