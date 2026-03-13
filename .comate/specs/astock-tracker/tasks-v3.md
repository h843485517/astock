# A股追踪器优化：清理旧代码 + 现代化UI + 后端加固

- [x] 任务 1：删除旧 public/js 前端文件
    - 1.1: 删除 `public/js/` 目录下所有文件（api.js、app.js、pages/*.js、components/*.js）
    - 1.2: 删除 `public/index.html`（旧 CDN 版入口）
    - 1.3: 保留 `public/css/style.css`（兼容旧版访问，不影响 Vite 构建）

- [x] 任务 2：现代化 UI 样式重构
    - 2.1: 重写 `client/src/assets/style.css`：整体采用深色玻璃拟态风格（backdrop-filter blur + 半透明卡片），背景改为动态渐变网格，去掉纯色背景
    - 2.2: 大盘指数卡片：添加悬停上浮动画（transform translateY + box-shadow 过渡），涨跌幅数字添加颜色呼吸动画（@keyframes pulse）
    - 2.3: 数字变化动画：持仓收益/涨跌幅数字更新时添加 CSS `transition` 过渡，涨跌颜色切换带淡入效果
    - 2.4: 页面切换过渡：在 `App.vue` 的 `<router-view>` 外层包裹 `<Transition>`，配置 fade-slide 动画（opacity + translateY）
    - 2.5: 表格行悬停：添加左侧高亮条（border-left: 3px solid accent color）+ 背景渐变过渡
    - 2.6: 按钮交互：添加点击波纹效果（ripple，纯 CSS 实现），primary 按钮添加微发光效果（box-shadow glow）
    - 2.7: 加载骨架屏：持仓列表加载时显示 skeleton 占位动画（shimmer 效果），替代原来的 loading-spinner

- [x] 任务 3：后端 SQL 注入防护加固
    - 3.1: 在 `src/routes/positions.js` 中对 type 字段增加枚举白名单校验（仅允许 'stock'/'fund'），对 code 字段增加严格正则校验（仅允许字母数字），防止特殊字符注入
    - 3.2: 在 `src/db/database.js` 的 `updatePosition` 中，字段名白名单改用 `Object.freeze` 固化，防止原型链污染
    - 3.3: 对所有路由入参进行长度限制（code ≤ 10，group_name ≤ 30，shares/cost_price 数值范围校验），在路由层统一拦截

- [x] 任务 4：后端高并发处理
    - 4.1: 在 `server.js` 中引入 Node.js `cluster` 模块，主进程 fork `os.cpus().length` 个 worker，worker 进程崩溃时自动重启；生产模式启用，开发模式（NODE_ENV=development）单进程运行
    - 4.2: 为 SSE `/api/market-index/stream` 添加最大连接数限制（MAX_SSE_CLIENTS=100），超出时返回 503，防止内存耗尽
    - 4.3: 在 `src/db/database.js` 中为耗时操作设置 SQLite busy_timeout（5000ms），避免并发写入时 SQLITE_BUSY 报错
    - 4.4: 在 `server.js` 中添加请求体大小限制（`express.json({ limit: '100kb' })`），防止超大请求体攻击