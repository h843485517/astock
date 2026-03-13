# A股实时收益追踪器 — 需求设计文档

## 一、项目概述

开发一个前后端不分离的 Node.js Web 应用，用于追踪 A 股市场（股票 + 基金）的实时持仓收益情况。前端为单页应用（SPA），后端使用 Express.js 提供 REST API 并作为行情数据代理，数据持久化使用 SQLite。

---

## 二、技术栈

| 层级 | 技术选型 | 说明 |
|---|---|---|
| 后端框架 | Express.js | REST API + 静态文件托管 |
| 数据库 | better-sqlite3 | 轻量级 SQLite，无需额外部署 |
| HTTP 客户端 | axios | 代理行情 API 请求 |
| 前端 | Vue 3（CDN 引入）| 无需构建工具，响应式数据绑定，国内最主流框架 |
| 打包部署 | Dockerfile + npm scripts | 容器化 + 本地一键启动 |

---

## 三、数据来源（行情 API）

### 股票行情（新浪财经）
```
GET http://hq.sinajs.cn/list=sh000001,sz399001,sh600519,...
```
返回格式：`var hq_str_sh000001="上证指数,3300.00,3280.00,..."`

### 基金净值（天天基金）
```
GET http://fundgz.1234567.com.cn/js/{code}.js
```
返回格式：JSONP，含 `gszzl`（估算涨跌幅）、`dwjz`（净值）

后端作代理层统一对外提供 `/api/quote` 接口，屏蔽跨域及第三方依赖。

---

## 四、数据库设计

### 表：positions（持仓）
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PRIMARY KEY | 自增主键 |
| type | TEXT | 'stock' 或 'fund' |
| code | TEXT | 证券代码（如 sh600519 / 000001）|
| name | TEXT | 证券名称（首次获取行情时写入）|
| shares | REAL | 持有份额/股数 |
| cost_price | REAL | 成本价（元）|
| group_name | TEXT | 自定义分组名（可为空）|
| created_at | TEXT | 创建时间 |

---

## 五、后端 API 设计

### 持仓管理
| Method | Path | 说明 |
|---|---|---|
| GET | /api/positions | 获取所有持仓 |
| POST | /api/positions | 新增持仓 |
| PUT | /api/positions/:id | 修改持仓 |
| DELETE | /api/positions/:id | 删除持仓 |

### 行情代理
| Method | Path | 说明 |
|---|---|---|
| GET | /api/quote?codes=sh000001,sh600519 | 批量获取股票行情 |
| GET | /api/fund-quote?code=000001 | 获取单只基金估值 |
| GET | /api/market-index | 获取大盘指数（上证、深证、创业板）|

### 请求/响应示例

**POST /api/positions**
```json
{
  "type": "stock",
  "code": "sh600519",
  "shares": 10,
  "cost_price": 1800.00,
  "group_name": "白酒板块"
}
```

**GET /api/quote 响应**
```json
{
  "code": 0,
  "data": {
    "sh600519": {
      "name": "贵州茅台",
      "current": 1920.00,
      "change_pct": 1.5,
      "open": 1900.00,
      "high": 1930.00,
      "low": 1895.00,
      "volume": 12345
    }
  }
}
```

---

## 六、前端页面设计

### 页面路由（Vue Router 4 CDN + Hash 模式）
- `#/` — 首页：大盘指数 + 持仓总览
- `#/positions` — 持仓列表页
- `#/add` — 添加持仓页

### 首页布局
```
┌─────────────────────────────────────────┐
│  📈 A股收益追踪器              [刷新]    │
├─────────┬──────────────┬────────────────┤
│ 上证指数 │   深证成指   │   创业板指     │
│ 3,300   │   11,200     │    2,250       │
│ +1.2%  │   +0.8%      │    +1.5%       │
├─────────────────────────────────────────┤
│ 总资产     总收益      今日盈亏          │
│ ¥12,000   ¥+800        ¥+200           │
├─────────────────────────────────────────┤
│ 持仓列表                    [添加持仓]   │
│ ┌─────────────────────────────────────┐ │
│ │ 名称  代码  当前价  涨跌  持仓收益   │ │
│ │ 茅台 600519 1920  +1.5% +¥1200     │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### 添加持仓页面
- 表单字段：类型（股票/基金切换）、代码、持有份额、成本价、分组（可选）
- 代码格式验证：股票 6 位数字，基金 6 位数字
- 代码输入失焦后自动调接口验证并回填证券名称
- 底部双按钮：**继续添加**（保存后重置表单）/ **保存并返回**（保存后跳转 `#/`）

---

## 七、收益计算逻辑

```
持仓市值 = 当前价 × 持有份额
持仓成本 = 成本价 × 持有份额
持仓收益 = 持仓市值 - 持仓成本
持仓收益率 = (当前价 - 成本价) / 成本价 × 100%
今日收益 = (当前价 - 昨收价) × 持有份额
```

基金使用 `gszzl`（估算涨跌幅）计算当日涨跌，`dwjz`（昨日净值）作为成本参考。

---

## 八、影响文件列表

```
/Users/hujiahao/Desktop/project/A/
├── package.json                  # 项目依赖与 npm scripts
├── server.js                     # Express 入口，路由注册，静态托管
├── src/
│   ├── db/
│   │   └── database.js           # SQLite 初始化，表创建，CRUD 方法
│   ├── routes/
│   │   ├── positions.js          # 持仓 CRUD 路由
│   │   └── quote.js              # 行情代理路由
│   └── services/
│       └── quoteService.js       # 调用新浪/天天基金 API，解析数据
├── public/
│   ├── index.html                # 单页应用 HTML 入口
│   ├── css/
│   │   └── style.css             # 全局样式（深色金融风格）
│   └── js/
│       ├── app.js                # SPA 路由，页面切换逻辑
│       ├── api.js                # 前端封装的 fetch 调用方法
│       ├── pages/
│       │   ├── home.js           # 首页：大盘 + 持仓总览渲染
│       │   ├── positions.js      # 持仓列表页渲染
│       │   └── addPosition.js    # 添加持仓表单逻辑
│       └── components/
│           └── marketIndex.js    # 大盘指数组件
└── Dockerfile                    # 容器化打包配置
```

---

## 九、打包与部署

### 本地运行
```bash
npm install
npm start        # 生产模式，端口 3000
npm run dev      # 开发模式（nodemon 热重启）
```

### Docker 部署
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

### 环境变量
- `PORT`：服务端口（默认 3000）
- `DB_PATH`：SQLite 文件路径（默认 `./data/astock.db`）

---

## 十、边界条件与异常处理

- 行情 API 超时：返回缓存数据（内存缓存，TTL 60s），前端显示"数据稍旧"提示
- 证券代码不存在：后端返回 404，前端表单显示"代码无效"错误
- 数据库操作失败：统一返回 `{code: 1, message: "..."}` 错误结构
- 股票代码前缀处理：自动识别 6 位代码，6开头加 `sh` 前缀，0/3开头加 `sz` 前缀
- 非交易时段（夜间/周末）：基金 API 返回上一交易日数据，前端标注"非交易时段"