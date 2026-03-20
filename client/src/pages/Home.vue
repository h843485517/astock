<template>
  <div class="page">
    <MarketIndex :indices="indices" :stale="staleIndex" :loading="loadingIndex" />

    <!-- 汇总栏 -->
    <div style="margin-top:20px;">
      <div class="section-header" style="margin-bottom:10px;">
        <span class="section-title">资产概览</span>
      </div>
      <div class="summary-bar">
        <div class="summary-item">
          <div class="label">总资产</div>
          <div class="value">{{ fmtPrivate(summary.totalAsset, v => '¥' + fmtNum(v)) }}</div>
        </div>
        <div class="summary-item">
          <div class="label">累计收益</div>
          <div class="value" :class="colorClass(summary.totalProfit)">
            {{ fmtPrivate(summary.totalProfit, fmtMoney) }}
          </div>
          <div class="sub-value" :class="colorClass(summary.totalProfit)">{{ fmtPrivate(summary.totalPct, fmtPct) }}</div>
        </div>
        <div class="summary-item">
          <div class="label">今日盈亏</div>
          <div class="value" :class="colorClass(summary.todayProfit)">{{ fmtPrivate(summary.todayProfit, fmtMoney) }}</div>
          <div class="sub-value" :class="colorClass(summary.todayProfit)">{{ fmtPrivate(summary.todayPct, fmtPct) }}</div>
        </div>
      </div>
    </div>

    <!-- 持仓速览 -->
    <div style="margin-top:20px;">
      <div class="section-header">
        <span class="section-title">
          持仓速览
          <span v-if="loadingPos" class="loading-spinner" style="margin-left:8px;"></span>
          <span v-if="sseActive" class="badge-sse">实时</span>
        </span>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-secondary" @click="refresh">🔄 刷新</button>
          <router-link to="/positions" class="btn btn-secondary">查看全部</router-link>
          <router-link to="/add" class="btn btn-primary">+ 添加持仓</router-link>
        </div>
      </div>

      <!-- 分组 Tab -->
      <div v-if="tabs.length > 1" class="tab-bar" style="margin-bottom:14px;">
        <button v-for="tab in tabs" :key="tab" class="tab-item" :class="{ active: activeTab === tab }" @click="activeTab = tab">{{ tab }}</button>
      </div>

      <!-- 骨架屏 -->
      <div v-if="loadingPos" class="table-wrap skeleton-wrap">
        <div v-for="i in 4" :key="i" class="skeleton-row">
          <div class="skeleton-block" style="width:80px;"></div>
          <div class="skeleton-block" style="width:60px;"></div>
          <div class="skeleton-block" style="width:40px;"></div>
          <div class="skeleton-block" style="flex:1;"></div>
          <div class="skeleton-block" style="width:90px;"></div>
        </div>
      </div>

      <div v-else-if="positionRows.length === 0" class="table-wrap">
        <div class="empty-state">
          <div class="empty-icon">📊</div>
          <p>暂无持仓数据</p>
          <router-link to="/add" class="btn btn-primary">添加第一笔持仓</router-link>
        </div>
      </div>

      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>名称</th><th>持仓总金额</th><th>当日估算净值</th><th>当日收益</th><th>持有收益</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in positionRows" :key="row.id">
              <td class="td-name">{{ row.name || row.code }}</td>
              <td data-label="持仓总金额">{{ row.current ? fmtPrivate(row.current * row.shares, v => '¥' + fmtNum(v)) : '--' }}</td>
              <td data-label="当日净值" :class="colorClass(row.change_pct)">
                <div class="td-value-wrap">
                  <div>{{ row.current ? fmtNum(row.current) : '--' }}</div>
                  <div v-if="row.current" class="td-pct">{{ fmtPct(row.change_pct) }}</div>
                </div>
              </td>
              <td data-label="当日收益" :class="colorClass(row.todayProfit)">{{ row.current ? fmtPrivate(row.todayProfit, fmtMoney) : '--' }}</td>
              <td data-label="持有收益" :class="colorClass(row.profit)">
                <div class="td-value-wrap">
                  <div>{{ row.current ? fmtPrivate(row.profit, fmtMoney) : '--' }}</div>
                  <div v-if="row.current" class="td-pct">{{ fmtPrivate(row.profitPct, fmtPct) }}</div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import MarketIndex from '../components/MarketIndex.vue';
import * as api from '../api.js';
import { useFormat } from '../composables/useFormat.js';
import { usePositionStream } from '../composables/usePositionStream.js';

const { fmtNum, fmtMoney, fmtPct, fmtPrivate, colorClass } = useFormat();

const indices      = ref({});
const loadingIndex = ref(false);
const staleIndex   = ref(false);
const activeTab    = ref('全部');
const prevDayAsset = ref(0); // 昨日收盘总资产，用于计算今日涨跌幅基准

let esSource    = null; // 大盘 SSE
let pollTimer   = null;
let snapshotTimeout  = null;
let snapshotInterval = null;

// ── 持仓 SSE（由 composable 管理）────────────────────────────
const {
  positions,
  quotes,
  loading:       loadingPos,
  sseActive,
  connect:       connectPositionSSE,
  disconnect:    disconnectPositionSSE,
  manualRefresh: refresh,
} = usePositionStream({ onData: () => throttledSnapshot() });

// 获取昨日快照资产，作为今日涨跌幅的基准
async function loadPrevDayAsset() {
  try {
    const now = new Date();
    const bjTime = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
    const yesterday = new Date(bjTime);
    yesterday.setDate(yesterday.getDate() - 1);
    const pad = n => String(n).padStart(2, '0');
    const dateStr = `${yesterday.getFullYear()}-${pad(yesterday.getMonth()+1)}-${pad(yesterday.getDate())}`;
    const res = await api.getDateSnapshot(dateStr);
    prevDayAsset.value = Number(res.data?.total_asset) || 0;
  } catch (_) {
    prevDayAsset.value = 0; // 无昨日快照时为 0，降级用行情 close 估算
  }
}

// ── 大盘 SSE（断线指数退避重连，最终降级为轮询）───────────────
const SSE_RETRY_DELAYS = [3000, 6000, 15000, 30000]; // 退避梯度（ms）
let   sseRetryCount    = 0;
let   sseRetryTimer    = null;

function connectSSE() {
  if (pollTimer) return; // 已降级为轮询，不再重连 SSE
  if (esSource) { try { esSource.close(); } catch (_) {} esSource = null; }
  try {
    esSource = new EventSource('/api/market-index/stream');
  } catch (err) {
    console.warn('[SSE] 大盘连接失败，降级为轮询:', err);
    startPolling();
    return;
  }
  esSource.onmessage = (e) => {
    try {
      const payload = JSON.parse(e.data);
      indices.value      = payload.data || payload;
      staleIndex.value   = !!payload.stale;
      loadingIndex.value = false;
      sseRetryCount      = 0; // 收到数据，重置退避计数
    } catch (err) {
      console.error('[SSE] 大盘数据解析失败:', err);
    }
  };
  esSource.onerror = () => {
    staleIndex.value = true;
    if (esSource) { try { esSource.close(); } catch (_) {} esSource = null; }
    if (sseRetryCount < SSE_RETRY_DELAYS.length) {
      // 指数退避重连
      const delay = SSE_RETRY_DELAYS[sseRetryCount++];
      console.warn(`[SSE] 大盘断线，${delay / 1000}s 后重连（第 ${sseRetryCount} 次）`);
      sseRetryTimer = setTimeout(connectSSE, delay);
    } else {
      // 超出重连次数，降级为轮询
      console.warn('[SSE] 大盘重连失败，降级为轮询');
      startPolling();
    }
  };
}

async function pollIndex() {
  try {
    const res = await api.getMarketIndex();
    indices.value    = res.data || {};
    staleIndex.value = !!res.stale;
    loadingIndex.value = false;
  } catch (err) {
    staleIndex.value = true;
  }
}

function startPolling() {
  if (pollTimer) return;
  pollIndex();
  pollTimer = setInterval(pollIndex, 10000);
}

// ── 计算属性 ──────────────────────────────────────────────────
const enriched = computed(() => positions.value.map(pos => {
  const q          = quotes.value[pos.code] || {};
  const current    = q.current    || 0;
  const change_pct = q.change_pct || 0;
  const close      = q.close      || 0;
  return {
    ...pos,
    current, change_pct, close,
    todayProfit: (current - close) * pos.shares,
    profit:      (current - pos.cost_price) * pos.shares,
    profitPct:   pos.cost_price > 0 ? (current - pos.cost_price) / pos.cost_price * 100 : 0,
  };
}));

const tabs = computed(() => ['全部', ...[...new Set(positions.value.map(p => p.group_name || '默认分组'))]]);

const currentRows = computed(() =>
  activeTab.value === '全部'
    ? enriched.value
    : enriched.value.filter(p => (p.group_name || '默认分组') === activeTab.value)
);

const summary = computed(() => {
  let totalAsset = 0, totalCost = 0, todayProfit = 0;
  for (const r of currentRows.value) {
    totalAsset  += r.current * r.shares;
    totalCost   += r.cost_price * r.shares;
    todayProfit += (r.current - r.close) * r.shares;
  }
  const totalProfit = totalAsset - totalCost;
  // 用昨日快照资产作基准（更准确），无昨日快照时降级用开盘估算
  const baseAsset = prevDayAsset.value > 0 ? prevDayAsset.value : (totalAsset - todayProfit);
  const todayPct  = baseAsset > 0 ? todayProfit / baseAsset * 100 : 0;
  return { totalAsset, totalCost, totalProfit, totalPct: totalCost > 0 ? totalProfit / totalCost * 100 : 0, todayProfit, todayPct };
});

const positionRows = computed(() => currentRows.value.slice(0, 8));

// ── 格式化（由 useFormat composable 提供）────────────────────

// ── 自动保存每日快照（全自动，无需手动）────────────────────────
// 规则：
//   1. 交易时段（9:25~15:10 北京时间）内，SSE 每次推送数据后节流写入（10分钟最多1次）
//   2. 精确在 15:05 额外触发一次"收盘快照"，保证当天最终数据被记录
//   3. 非交易时段的 SSE 推送不写入，避免夜间/周末产生无意义记录

let lastSnapshotTime = 0; // 上次写入时间戳（ms）
const SNAPSHOT_THROTTLE_MS = 10 * 60 * 1000; // 节流：10 分钟

function getBJHourMin() {
  const now = new Date();
  const bj  = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
  return { h: bj.getHours(), m: bj.getMinutes(), dow: bj.getDay() };
}

function isTradingTime() {
  const { h, m, dow } = getBJHourMin();
  if (dow === 0 || dow === 6) return false; // 周末
  const mins = h * 60 + m;
  return (mins >= 9 * 60 + 25) && (mins <= 15 * 60 + 10);
}

async function saveSnapshotNow() {
  if (positions.value.length === 0) return;
  // 行情尚未就绪（所有持仓的 current 都是 0）时不写入，避免产生脏快照
  const hasQuote = positions.value.some(p => (quotes.value[p.code]?.current || 0) > 0);
  if (!hasQuote) return;
  try {
    const s = summary.value;
    await api.saveSnapshot({
      total_asset:    +s.totalAsset.toFixed(2),
      total_cost:     +s.totalCost.toFixed(2),
      total_profit:   +s.totalProfit.toFixed(2),
      today_profit:   +s.todayProfit.toFixed(2),
      today_pct:      +s.todayPct.toFixed(4),
      total_pct:      +s.totalPct.toFixed(4),
      position_count: positions.value.length,
    });
    lastSnapshotTime = Date.now();
  } catch (_) { /* 静默失败 */ }
}

// 节流：交易时段内每 10 分钟最多存一次
function throttledSnapshot() {
  if (!isTradingTime()) return;
  if (Date.now() - lastSnapshotTime < SNAPSHOT_THROTTLE_MS) return;
  saveSnapshotNow();
}

// 精确安排收盘快照（每天 15:05 存一次最终值）
function scheduleCloseSnapshot() {
  // 清除上次可能残留的定时器
  if (snapshotTimeout)  clearTimeout(snapshotTimeout);
  if (snapshotInterval) clearInterval(snapshotInterval);

  const now   = new Date();
  const bjNow = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
  const target = new Date(bjNow);
  target.setHours(15, 5, 0, 0);
  if (bjNow >= target) target.setDate(target.getDate() + 1); // 已过今天则排到明天
  const ms = target - bjNow;

  snapshotTimeout = setTimeout(async () => {
    snapshotTimeout = null;
    lastSnapshotTime = 0; // 强制忽略节流，保证收盘快照一定写入
    await saveSnapshotNow();
    // 之后每 24 小时重复一次
    snapshotInterval = setInterval(async () => {
      lastSnapshotTime = 0;
      await saveSnapshotNow();
    }, 24 * 60 * 60 * 1000);
  }, ms);
}

onMounted(() => {
  loadingIndex.value = true;
  loadPrevDayAsset();
  connectSSE();
  connectPositionSSE();
  scheduleCloseSnapshot();
});

onUnmounted(() => {
  if (esSource)         esSource.close();
  if (pollTimer)        clearInterval(pollTimer);
  if (sseRetryTimer)    clearTimeout(sseRetryTimer);
  disconnectPositionSSE();
  if (snapshotTimeout)  clearTimeout(snapshotTimeout);
  if (snapshotInterval) clearInterval(snapshotInterval);
});
</script>