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
import { usePrivacy } from '../composables/usePrivacy.js';

const { privacyMode } = usePrivacy();

const indices      = ref({});
const positions    = ref([]);
const quotes       = ref({});
const loadingIndex = ref(false);
const loadingPos   = ref(true);
const staleIndex   = ref(false);
const sseActive    = ref(false);
const activeTab    = ref('全部');

let esSource    = null; // 大盘 SSE
let posEsSource = null; // 持仓 SSE
let pollTimer   = null;

// ── 大盘 SSE（失败时降级为轮询）──────────────────────────────
function connectSSE() {
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
      indices.value    = payload.data || payload;
      staleIndex.value = !!payload.stale;
      loadingIndex.value = false;
    } catch (err) {
      console.error('[SSE] 大盘数据解析失败:', err);
    }
  };
  esSource.onerror = () => {
    staleIndex.value = true;
    if (esSource.readyState === 2) startPolling();
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

// ── 持仓 SSE ─────────────────────────────────────────────────
function connectPositionSSE() {
  posEsSource = new EventSource('/api/positions/stream', { withCredentials: true });

  posEsSource.onmessage = (e) => {
    try {
      const payload = JSON.parse(e.data);
      if (payload.code === 0) {
        positions.value = payload.positions || [];
        quotes.value    = payload.quotes    || {};
      }
      loadingPos.value = false;
      sseActive.value  = true;
    } catch (err) {
      console.error('[SSE] 持仓数据解析失败:', err);
    }
  };

  posEsSource.onerror = () => {
    sseActive.value = false;
    // SSE 断开后降级：手动刷新仍可用
  };
}

// ── 手动刷新（强制 HTTP 拉取）────────────────────────────────
async function refresh() {
  loadingPos.value = true;
  try {
    const posRes = await api.getPositions();
    positions.value  = posRes.data;
    const stockCodes = posRes.data.filter(p => p.type === 'stock').map(p => p.code);
    const fundCodes  = posRes.data.filter(p => p.type === 'fund').map(p => p.code);
    const results    = {};
    if (stockCodes.length > 0) {
      try { Object.assign(results, (await api.getQuote(stockCodes)).data); } catch (_) {}
    }
    for (const code of fundCodes) {
      try {
        const d   = (await api.getFundQuote(code)).data;
        const pct = d.gszzl || 0;
        results[code] = { name: d.name, current: +(d.dwjz*(1+pct/100)).toFixed(4), close: d.dwjz, change_pct: pct, change_amount: +(d.dwjz*pct/100).toFixed(4) };
      } catch (_) {}
    }
    quotes.value = results;
    window.showToast('持仓已刷新', 'success');
  } catch (e) {
    window.showToast('持仓数据加载失败：' + e.message, 'error');
  } finally {
    loadingPos.value = false;
  }
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
  const todayPct = totalAsset - todayProfit > 0 ? todayProfit / (totalAsset - todayProfit) * 100 : 0;
  return { totalAsset, totalProfit, totalPct: totalCost > 0 ? totalProfit / totalCost * 100 : 0, todayProfit, todayPct };
});

const positionRows = computed(() => currentRows.value.slice(0, 8));

// ── 格式化 ────────────────────────────────────────────────────
const colorClass  = (v) => v > 0 ? 'rise' : v < 0 ? 'fall' : 'flat';
const fmtNum      = (v, d = 2) => (v || v === 0) ? v.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d }) : '--';
const fmtMoney    = (v) => `${v >= 0 ? '+' : ''}¥${Math.abs(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtPct      = (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
const fmtPrivate  = (v, fmt) => privacyMode.value ? '****' : fmt(v);

onMounted(() => {
  loadingIndex.value = true;
  connectSSE();
  connectPositionSSE();
});

onUnmounted(() => {
  if (esSource)    esSource.close();
  if (posEsSource) posEsSource.close();
  if (pollTimer)   clearInterval(pollTimer);
});
</script>