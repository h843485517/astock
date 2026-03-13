<template>
  <div class="page">
    <div class="section-header" style="margin-bottom:16px;">
      <span class="section-title">
        持仓管理
        <span v-if="loading" class="loading-spinner" style="margin-left:8px;"></span>
        <span v-if="sseActive" class="badge-sse">实时</span>
      </span>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-secondary" @click="manualRefresh">🔄 刷新</button>
        <router-link to="/add" class="btn btn-primary">+ 添加持仓</router-link>
      </div>
    </div>

    <!-- 骨架屏 -->
    <div v-if="loading" class="table-wrap skeleton-wrap">
      <div v-for="i in 6" :key="i" class="skeleton-row">
        <div class="skeleton-block" style="width:90px;"></div>
        <div class="skeleton-block" style="width:60px;"></div>
        <div class="skeleton-block" style="width:40px;"></div>
        <div class="skeleton-block" style="flex:1;"></div>
        <div class="skeleton-block" style="width:80px;"></div>
        <div class="skeleton-block" style="width:80px;"></div>
      </div>
    </div>

    <div v-else-if="!loading && grouped.size === 0 && tabs.length <= 1" class="table-wrap">
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <p>还没有任何持仓记录</p>
        <router-link to="/add" class="btn btn-primary">添加第一笔持仓</router-link>
      </div>
    </div>

    <template v-else-if="!loading">
      <div class="tab-bar">
        <button v-for="tab in tabs" :key="tab" class="tab-item" :class="{ active: activeTab === tab }" @click="activeTab = tab">{{ tab }}</button>
      </div>

      <div class="tab-summary" v-if="currentRows.length > 0">
        <div class="tab-summary-item">
          <div class="ts-label">持仓市值</div>
          <div class="ts-value">{{ fmtPrivate(tabSummary.totalAsset, v => '¥' + fmtNum(v)) }}</div>
        </div>
        <div class="tab-summary-item">
          <div class="ts-label">累计收益</div>
          <div class="ts-value" :class="colorClass(tabSummary.totalProfit)">
            {{ fmtPrivate(tabSummary.totalProfit, fmtMoney) }}
            <span style="font-size:12px;margin-left:4px;">{{ fmtPrivate(tabSummary.totalPct, fmtPct) }}</span>
          </div>
        </div>
        <div class="tab-summary-item">
          <div class="ts-label">今日盈亏</div>
          <div class="ts-value" :class="colorClass(tabSummary.todayProfit)">{{ fmtPrivate(tabSummary.todayProfit, fmtMoney) }}</div>
        </div>
        <div class="tab-summary-item">
          <div class="ts-label">持仓数量</div>
          <div class="ts-value">{{ currentRows.length }} 只</div>
        </div>
      </div>

      <!-- 全部 Tab：按分组分块 -->
      <template v-if="activeTab === '全部'">
        <div v-for="[group, rows] in grouped" :key="group" style="margin-bottom:16px;">
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th colspan="7" style="text-align:left;padding:8px 16px;font-size:12px;color:var(--text-muted);">📁 {{ group }} <span style="margin-left:8px;font-weight:normal;">{{ rows.length }} 只</span></th></tr>
                <tr><th>名称</th><th>持仓总金额</th><th>当日估算净值</th><th>当日收益</th><th>持有收益</th><th>操作</th></tr>
              </thead>
              <tbody>
                <tr v-for="row in rows" :key="row.id">
                  <td class="td-name">{{ row.name || '--' }}</td>
                  <td>{{ row.current ? fmtPrivate(row.current * row.shares, v => '¥' + fmtNum(v)) : '--' }}</td>
                  <td :class="colorClass(row.change_pct)">
                    <div>{{ row.current ? fmtNum(row.current) : '--' }}</div>
                    <div style="font-size:11px;">{{ row.current ? fmtPct(row.change_pct) : '' }}</div>
                  </td>
                  <td :class="colorClass(row.todayProfit)">{{ row.current ? fmtPrivate(row.todayProfit, fmtMoney) : '--' }}</td>
                  <td :class="colorClass(row.profit)">
                    <div>{{ row.current ? fmtPrivate(row.profit, fmtMoney) : '--' }}</div>
                    <div style="font-size:11px;">{{ row.current ? fmtPrivate(row.profitPct, fmtPct) : '' }}</div>
                  </td>
                  <td>
                    <div style="display:flex;gap:6px;">
                      <button class="btn btn-secondary btn-sm" @click="openEdit(row)">编辑</button>
                      <button class="btn btn-danger btn-sm" @click="handleDelete(row)">删除</button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>

      <!-- 单分组 Tab：平铺 -->
      <template v-else>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>名称</th><th>持仓总金额</th><th>当日估算净值</th><th>当日收益</th><th>持有收益</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in currentRows" :key="row.id">
                <td class="td-name">{{ row.name || '--' }}</td>
                <td>{{ row.current ? fmtPrivate(row.current * row.shares, v => '¥' + fmtNum(v)) : '--' }}</td>
                <td :class="colorClass(row.change_pct)">
                  <div>{{ row.current ? fmtNum(row.current) : '--' }}</div>
                  <div style="font-size:11px;">{{ row.current ? fmtPct(row.change_pct) : '' }}</div>
                </td>
                <td :class="colorClass(row.todayProfit)">{{ row.current ? fmtPrivate(row.todayProfit, fmtMoney) : '--' }}</td>
                <td :class="colorClass(row.profit)">
                  <div>{{ row.current ? fmtPrivate(row.profit, fmtMoney) : '--' }}</div>
                  <div style="font-size:11px;">{{ row.current ? fmtPrivate(row.profitPct, fmtPct) : '' }}</div>
                </td>
                <td>
                  <div style="display:flex;gap:6px;">
                    <button class="btn btn-secondary btn-sm" @click="openEdit(row)">编辑</button>
                    <button class="btn btn-danger btn-sm" @click="handleDelete(row)">删除</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>

    <!-- 编辑弹窗 -->
    <Teleport to="body">
      <div v-if="editModal.show" class="modal-mask" @click.self="closeEdit">
        <div class="modal-box">
          <div class="modal-header">
            <span class="modal-title">编辑持仓 · {{ editModal.name || editModal.code }}</span>
            <button class="btn-icon" @click="closeEdit">✕</button>
          </div>

          <div class="modal-body">
            <!-- 只读信息 -->
            <div class="edit-info-row">
              <span class="edit-info-label">类型</span>
              <span class="edit-info-value">{{ editModal.type === 'stock' ? '📈 股票' : '💹 基金' }}</span>
              <span class="edit-info-label" style="margin-left:20px;">代码</span>
              <span class="edit-info-value">{{ editModal.code }}</span>
            </div>

            <div class="edit-field">
              <label class="edit-label">{{ editModal.type === 'stock' ? '持有股数' : '持有份额' }}</label>
              <input
                v-model="editForm.shares"
                class="edit-input"
                type="number"
                min="0"
                :step="editModal.type === 'stock' ? '100' : '0.01'"
                placeholder="请输入份额"
              />
              <span v-if="editErrors.shares" class="edit-error">{{ editErrors.shares }}</span>
            </div>

            <div class="edit-field">
              <label class="edit-label">成本价（元）</label>
              <input
                v-model="editForm.cost_price"
                class="edit-input"
                type="number"
                min="0"
                step="0.001"
                placeholder="请输入成本价"
              />
              <span v-if="editErrors.cost_price" class="edit-error">{{ editErrors.cost_price }}</span>
            </div>

            <div class="edit-field">
              <label class="edit-label">分组名称 <span style="color:var(--text-muted);font-weight:normal;">(可选)</span></label>
              <select v-model="editForm.group_name" class="edit-input edit-select">
                <option value="">不分组（默认分组）</option>
                <option v-for="g in editGroupList" :key="g" :value="g">{{ g }}</option>
                <option value="__new__">＋ 新建分组...</option>
              </select>
              <input
                v-if="editForm.group_name === '__new__'"
                v-model="editForm.newGroupInput"
                class="edit-input"
                type="text"
                maxlength="30"
                placeholder="输入新分组名称"
                style="margin-top:8px;"
              />
            </div>
          </div>

          <div class="modal-footer">
            <button class="btn btn-secondary" @click="closeEdit">取消</button>
            <button class="btn btn-primary" @click="saveEdit" :disabled="editSaving">
              <span v-if="editSaving" class="loading-spinner" style="margin-right:4px;"></span>
              保存修改
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import * as api from '../api.js';
import { usePrivacy } from '../composables/usePrivacy.js';

const { privacyMode } = usePrivacy();

const positions = ref([]);
const quotes    = ref({});
const loading   = ref(true);
const sseActive = ref(false);
const activeTab = ref('全部');

let posEsSource = null;

// ── 编辑弹窗状态 ─────────────────────────────────────────────
const editModal     = reactive({ show: false, id: null, name: '', code: '', type: '' });
const editForm      = reactive({ shares: '', cost_price: '', group_name: '', newGroupInput: '' });
const editErrors    = reactive({});
const editSaving    = ref(false);
const editGroupList = ref([]);

function openEdit(row) {
  editModal.show         = true;
  editModal.id           = row.id;
  editModal.name         = row.name;
  editModal.code         = row.code;
  editModal.type         = row.type;
  editForm.shares        = row.shares;
  editForm.cost_price    = row.cost_price;
  editForm.newGroupInput = '';
  const groups = [...new Set(positions.value.map(p => p.group_name).filter(Boolean))];
  editGroupList.value = groups;
  editForm.group_name = groups.includes(row.group_name) ? row.group_name : (row.group_name || '');
  Object.keys(editErrors).forEach(k => delete editErrors[k]);
}

function closeEdit() {
  editModal.show = false;
}

async function saveEdit() {
  Object.keys(editErrors).forEach(k => delete editErrors[k]);
  let valid = true;
  if (!editForm.shares || isNaN(editForm.shares) || Number(editForm.shares) <= 0) {
    editErrors.shares = '份额必须为大于 0 的数字'; valid = false;
  }
  if (!editForm.cost_price || isNaN(editForm.cost_price) || Number(editForm.cost_price) <= 0) {
    editErrors.cost_price = '成本价必须为大于 0 的数字'; valid = false;
  }
  if (!valid) return;

  const resolvedGroup = editForm.group_name === '__new__'
    ? editForm.newGroupInput.trim()
    : editForm.group_name;

  editSaving.value = true;
  try {
    await api.updatePosition(editModal.id, {
      shares:     Number(editForm.shares),
      cost_price: Number(editForm.cost_price),
      group_name: resolvedGroup,
    });
    // 本地更新，不等 SSE 推送
    const idx = positions.value.findIndex(p => p.id === editModal.id);
    if (idx >= 0) {
      positions.value[idx] = {
        ...positions.value[idx],
        shares:     Number(editForm.shares),
        cost_price: Number(editForm.cost_price),
        group_name: resolvedGroup,
      };
    }
    window.showToast('持仓已更新', 'success');
    closeEdit();
  } catch (e) {
    window.showToast('更新失败：' + e.message, 'error');
  } finally {
    editSaving.value = false;
  }
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
      loading.value   = false;
      sseActive.value = true;
    } catch (err) {
      console.error('[SSE] 持仓数据解析失败:', err);
    }
  };
  posEsSource.onerror = () => { sseActive.value = false; };
}

// ── 手动刷新 ─────────────────────────────────────────────────
async function manualRefresh() {
  loading.value = true;
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
        const d = (await api.getFundQuote(code)).data;
        const pct = d.gszzl || 0;
        results[code] = { name: d.name, current: +(d.dwjz*(1+pct/100)).toFixed(4), close: d.dwjz, change_pct: pct, change_amount: +(d.dwjz*pct/100).toFixed(4) };
      } catch (_) {}
    }
    quotes.value = results;
    window.showToast('持仓已刷新', 'success');
  } catch (e) {
    window.showToast('持仓数据加载失败：' + e.message, 'error');
  } finally {
    loading.value = false;
  }
}

// ── 计算属性 ──────────────────────────────────────────────────
const enriched = computed(() => positions.value.map(pos => {
  const q = quotes.value[pos.code] || {};
  const current = q.current || 0, change_pct = q.change_pct || 0, close = q.close || 0;
  return {
    ...pos, current, change_pct, close,
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

const tabSummary = computed(() => {
  let totalAsset = 0, totalCost = 0, todayProfit = 0;
  for (const r of currentRows.value) {
    totalAsset  += r.current * r.shares;
    totalCost   += r.cost_price * r.shares;
    todayProfit += (r.current - (quotes.value[r.code]?.close || r.cost_price)) * r.shares;
  }
  const totalProfit = totalAsset - totalCost;
  return { totalAsset, totalProfit, totalPct: totalCost > 0 ? totalProfit / totalCost * 100 : 0, todayProfit };
});

const grouped = computed(() => {
  const map = new Map();
  for (const r of currentRows.value) {
    const g = r.group_name || '默认分组';
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(r);
  }
  return map;
});

async function handleDelete(pos) {
  if (!confirm(`确认删除「${pos.name || pos.code}」的持仓？`)) return;
  try {
    await api.deletePosition(pos.id);
    positions.value = positions.value.filter(p => p.id !== pos.id);
    window.showToast('删除成功', 'success');
  } catch (e) {
    window.showToast('删除失败：' + e.message, 'error');
  }
}

// ── 格式化 ────────────────────────────────────────────────────
const colorClass = (v) => v > 0 ? 'rise' : v < 0 ? 'fall' : 'flat';
const fmtNum     = (v, d = 2) => (v || v === 0) ? v.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d }) : '--';
const fmtMoney   = (v) => `${v >= 0 ? '+' : ''}¥${Math.abs(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtPct     = (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
const fmtPrivate = (v, fmt) => privacyMode.value ? '****' : fmt(v);

onMounted(connectPositionSSE);
onUnmounted(() => { if (posEsSource) posEsSource.close(); });
</script>

<style scoped>
/* 弹窗遮罩 */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}

.modal-box {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 16px;
  width: 100%;
  max-width: 440px;
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.14);
  animation: modal-in 0.2s ease;
}
@keyframes modal-in {
  from { opacity: 0; transform: scale(0.97) translateY(6px); }
  to   { opacity: 1; transform: scale(1)    translateY(0);   }
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 20px 14px;
  border-bottom: 1px solid #f1f5f9;
}
.modal-title {
  font-size: 15px;
  font-weight: 700;
  color: #1e293b;
}

.modal-body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.edit-info-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  font-size: 13px;
}
.edit-info-label { color: #94a3b8; font-weight: 500; }
.edit-info-value { color: #1e293b; font-weight: 600; }

.edit-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.edit-label {
  font-size: 13px;
  color: #475569;
  font-weight: 600;
}
.edit-input {
  padding: 10px 13px;
  background: #f8fafc;
  border: 1.5px solid #e2e8f0;
  border-radius: 8px;
  color: #1e293b;
  font-size: 14px;
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.edit-input:focus {
  border-color: #2563eb;
  background: #fff;
  box-shadow: 0 0 0 3px rgba(37,99,235,0.10);
}
.edit-input::placeholder { color: #94a3b8; }
.edit-error { font-size: 12px; color: #e03535; }

/* select 自定义箭头 */
.edit-select {
  cursor: pointer;
  background: #f8fafc url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2394a3b8' d='M6 8L1 3h10z'/%3E%3C/svg%3E") no-repeat right 13px center;
  -webkit-appearance: none;
  -moz-appearance: none;
  appearance: none;
  padding-right: 36px;
}
.edit-select:focus {
  border-color: #2563eb;
  background-color: #fff;
  box-shadow: 0 0 0 3px rgba(37,99,235,0.10);
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 20px 18px;
  border-top: 1px solid #f1f5f9;
}
</style>
