# A股实时收益追踪器 — 全栈项目任务计划

- [x] 任务 1：初始化项目结构与依赖
    - 1.1: 在项目根目录创建 `package.json`，配置 `name`、`main`、`scripts`（start/dev）及依赖：`express`、`better-sqlite3`、`axios`、`cors`、`nodemon`（devDependency）
    - 1.2: 执行 `npm install` 安装所有依赖
    - 1.3: 创建目录骨架：`src/db/`、`src/routes/`、`src/services/`、`public/css/`、`public/js/pages/`、`public/js/components/`、`data/`
    - 1.4: 创建 `.gitignore`，忽略 `node_modules/` 和 `data/*.db`

- [x] 任务 2：实现数据库层（database.js）
    - 2.1: 在 `src/db/database.js` 中引入 `better-sqlite3`，读取环境变量 `DB_PATH`（默认 `./data/astock.db`），确保 `data/` 目录存在后初始化数据库连接
    - 2.2: 执行建表 SQL 创建 `positions` 表（id、type、code、name、shares、cost_price、group_name、created_at 字段），使用 `IF NOT EXISTS` 保证幂等
    - 2.3: 导出 CRUD 方法：`getAllPositions()`、`createPosition(data)`、`updatePosition(id, data)`、`deletePosition(id)`，所有写操作使用预编译语句防 SQL 注入

- [x] 任务 3：实现行情服务层（quoteService.js）
    - 3.1: 在 `src/services/quoteService.js` 中实现 `fetchStockQuote(codes)` 函数，使用 axios 请求新浪财经接口 `http://hq.sinajs.cn/list=<codes>`，设置 Referer 头为 `http://finance.sina.com.cn`，超时 5s
    - 3.2: 解析新浪返回的字符串格式，提取 name、current（当前价）、open、high、low、close（昨收）、change_pct（涨跌幅）、volume 字段
    - 3.3: 实现 `fetchFundQuote(code)` 函数，请求天天基金 JSONP 接口 `http://fundgz.1234567.com.cn/js/{code}.js`，用正则提取 JSON 内容，解析 fundcode、name、dwjz（净值）、gszzl（估算涨跌幅）、gztime
    - 3.4: 添加内存缓存机制（Map + 时间戳），TTL 设为 60s；缓存命中时直接返回并附带 `cached: true` 标志
    - 3.5: 实现 `fetchMarketIndex()` 函数，固定请求上证（sh000001）、深证（sz399001）、创业板（sz399006）三个指数，复用 `fetchStockQuote`

- [x] 任务 4：实现后端路由层
    - 4.1: 创建 `src/routes/positions.js`，注册 `GET /api/positions`（返回全部持仓）、`POST /api/positions`（校验 type/code/shares/cost_price 必填项，code 自动补全 sh/sz 前缀后存储）、`PUT /api/positions/:id`、`DELETE /api/positions/:id` 四个路由，统一使用 `{code:0, data}` / `{code:1, message}` 响应结构
    - 4.2: 创建 `src/routes/quote.js`，注册 `GET /api/quote`（接收 `?codes=` 参数，调用 quoteService 批量查询）、`GET /api/fund-quote`（接收 `?code=` 参数）、`GET /api/market-index` 三个路由，异常时返回缓存数据并设 `stale: true`
    - 4.3: POST /api/positions 中，新增持仓成功后额外调用行情接口回填证券名称并更新 name 字段（异步，失败不影响主流程）

- [x] 任务 5：实现 Express 服务入口（server.js）
    - 5.1: 在 `server.js` 中创建 Express 实例，注册 `express.json()` 中间件，挂载 `/api/positions` 和 `/api/quote` 路由，托管 `public/` 为静态目录
    - 5.2: 添加统一错误处理中间件，捕获未处理异常返回 `{code:1, message: "Internal Server Error"}`
    - 5.3: 所有非 `/api` 路径回退到 `public/index.html`（SPA 支持），监听 `process.env.PORT || 3000`

- [x] 任务 6：实现前端基础层（index.html + style.css + api.js）
    - 6.1: 创建 `public/index.html`，通过 CDN 引入 Vue 3（`unpkg.com/vue@3/dist/vue.global.prod.js`）和 Vue Router 4（`unpkg.com/vue-router@4/dist/vue-router.global.prod.js`），在 `<div id="app">` 中放置 `<router-view>` 和顶部导航栏
    - 6.2: 创建 `public/css/style.css`，实现深色金融风格主题：深色背景（#0d1117）、卡片式布局、涨跌红绿色（涨红 #f03e3e，跌绿 #0ca678）、响应式网格布局，设计大盘指数卡片、持仓表格、表单的视觉样式
    - 6.3: 创建 `public/js/api.js`，封装 `request(url, options)` 基础函数（统一错误提示），导出 `getPositions()`、`createPosition(data)`、`updatePosition(id,data)`、`deletePosition(id)`、`getQuote(codes)`、`getFundQuote(code)`、`getMarketIndex()` 方法

- [x] 任务 7：实现前端 Vue 页面组件
    - 7.1: 创建 `public/js/components/MarketIndex.js`，定义 `MarketIndex` Vue 组件，props 接收 `indices` 数组，模板渲染三个指数卡片（名称、当前点位、涨跌幅），涨跌色通过计算属性动态绑定
    - 7.2: 创建 `public/js/pages/Home.js`，`onMounted` 时并发调用 `getMarketIndex()` 和 `getPositions()+getQuote()`，计算总资产、总收益、今日盈亏并展示；集成 MarketIndex 组件；页面顶部设刷新按钮（手动触发重新拉取）；每 60s 自动刷新一次（`setInterval`，离开页面时用 `onUnmounted` 清除）
    - 7.3: 创建 `public/js/pages/Positions.js`，展示持仓列表（支持按 group_name 分组展示），每行显示名称、代码、成本价、当前价、涨跌幅、持仓收益（金额+百分比），提供每行删除按钮（确认弹窗），右上角有"添加持仓"按钮跳转 `#/add`
    - 7.4: 创建 `public/js/pages/AddPosition.js`，包含 Vue 响应式表单（`ref` 管理 type/code/shares/cost_price/group_name），type 切换时重置 code；code 字段 `@blur` 触发自动校验（调用 `/api/quote` 或 `/api/fund-quote` 验证代码并回填 name 预览）；表单提交前校验所有必填项，错误信息响应式展示；底部两个按钮"继续添加"（提交后重置表单）/"保存并返回"（提交后 `router.push('/')`）

- [x] 任务 8：实现前端路由入口（app.js）
    - 8.1: 创建 `public/js/app.js`，使用 `VueRouter.createRouter` 配置 hash 模式路由，注册三个路由：`/` → Home、`/positions` → Positions、`/add` → AddPosition
    - 8.2: 使用 `Vue.createApp({})` 挂载，注册全局组件 MarketIndex，`use(router)` 后 `mount('#app')`
    - 8.3: 在 `index.html` 底部按顺序引入 `api.js`、各页面组件 JS、`app.js`，确保依赖顺序正确

- [x] 任务 9：创建打包与部署配置
    - 9.1: 创建 `Dockerfile`，基于 `node:20-alpine`，WORKDIR `/app`，COPY package*.json，`RUN npm ci --only=production`，COPY 全部文件，EXPOSE 3000，CMD `["node", "server.js"]`
    - 9.2: 创建 `.dockerignore`，排除 `node_modules`、`data/`、`.git` 等
    - 9.3: 在 `package.json` 的 scripts 中补充 `"docker:build": "docker build -t astock-tracker ."` 和 `"docker:run": "docker run -p 3000:3000 astock-tracker"`
    - 9.4: 创建 `README.md`，说明本地运行步骤、Docker 部署步骤、环境变量说明

- [x] 任务 10：集成测试与功能验证
    - 10.1: 启动服务，验证 `GET /api/market-index` 能正确返回三大指数数据
    - 10.2: 通过 curl 测试 `POST /api/positions` 添加一只股票和一只基金，验证数据入库及名称回填
    - 10.3: 验证 `GET /api/positions` 返回正确数据，`DELETE /api/positions/:id` 删除成功
    - 10.4: 浏览器访问 `http://localhost:3000`，验证首页大盘、持仓总览、添加持仓流程（含"继续添加"/"保存并返回"两个按钮）均正常工作
