<template>
  <div class="page">

    <!-- 页面头部 -->
    <div class="page-head">
      <div class="page-head-left">
        <h1 class="page-title">收益历史</h1>
        <span class="page-sub">点击有记录的日期查看当日详情</span>
      </div>

    </div>

    <!-- 月度统计栏 -->
    <div class="stats-row" v-if="monthStats.count > 0">
      <div class="stat-card">
        <div class="stat-icon">📆</div>
        <div class="stat-body">
          <div class="stat-label">已记录</div>
          <div class="stat-val">{{ monthStats.count }} 天</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">📈</div>
        <div class="stat-body">
          <div class="stat-label">盈利日</div>
          <div class="stat-val rise">{{ monthStats.upDays }} 天</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">📉</div>
        <div class="stat-body">
          <div class="stat-label">亏损日</div>
          <div class="stat-val fall">{{ monthStats.downDays }} 天</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">💰</div>
        <div class="stat-body">
          <div class="stat-label">月累计盈亏</div>
          <div class="stat-val" :class="colorClass(monthStats.totalTodayProfit)">
            {{ fmtPrivate(monthStats.totalTodayProfit, fmtMoney) }}
          </div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">🏦</div>
        <div class="stat-body">
          <div class="stat-label">最新总资产</div>
          <div class="stat-val">{{ fmtPrivate(monthStats.latestAsset, v => '¥' + fmtNum(v)) }}</div>
        </div>
      </div>
    </div>

    <!-- 日历主体 -->
    <div class="cal-wrap">
      <!-- 导航头 -->
      <div class="cal-nav">
        <button class="cal-nav-btn" @click="prevMonth"><span>‹</span></button>
        <div class="cal-nav-title">
          <span class="cal-nav-year">{{ currentYear }}</span>
          <span class="cal-nav-sep">年</span>
          <span class="cal-nav-year">{{ String(currentMonth).padStart(2,'0') }}</span>
          <span class="cal-nav-sep">月</span>
        </div>
        <button class="cal-nav-btn" @click="nextMonth" :disabled="isCurrentMonth"><span>›</span></button>
      </div>

      <!-- 星期标题行 -->
      <div class="cal-head-row">
        <div v-for="(d, i) in weekDays" :key="d" class="cal-head-cell" :class="{ 'cal-head-weekend': i===0||i===6 }">{{ d }}</div>
      </div>

      <!-- 骨架屏 -->
      <div v-if="loading" class="cal-skeleton">
        <div v-for="i in 35" :key="i" class="cal-skel-cell"></div>
      </div>

      <!-- 日历格子 -->
      <div v-else class="cal-body">
        <div v-for="n in firstDayOfWeek" :key="'ph'+n" class="cal-cell cal-cell-ph"></div>
        <div
          v-for="day in daysInMonth"
          :key="day"
          class="cal-cell"
          :class="getCellClasses(day)"
          @click="selectDay(day)"
        >
          <div class="cell-day">
            <span class="cell-day-num" :class="{ 'cell-today-num': isToday(day) }">{{ day }}</span>
            <span v-if="isToday(day)" class="cell-today-dot"></span>
          </div>
          <template v-if="getCellSnap(day)">
            <div class="cell-profit" :class="colorClass(getCellSnap(day).today_profit)">
              {{ fmtPrivate(getCellSnap(day).today_profit, fmtMoneyCompact) }}
            </div>
            <div class="cell-pct" :class="colorClass(getCellSnap(day).today_pct)">
              {{ fmtPrivate(getCellSnap(day).today_pct, fmtPct) }}
            </div>
          </template>
          <template v-else-if="isWeekend(day)">
            <div class="cell-rest">休</div>
          </template>
          <template v-else-if="isFuture(day)">
            <div class="cell-future">—</div>
          </template>
        </div>
      </div>

      <!-- 图例 -->
      <div class="cal-legend">
        <div class="legend-item"><span class="legend-dot dot-rise"></span>盈利</div>
        <div class="legend-item"><span class="legend-dot dot-fall"></span>亏损</div>
        <div class="legend-item"><span class="legend-dot dot-flat"></span>持平</div>
      </div>
    </div>

    <!-- 详情抽屉弹窗 -->
    <Teleport to="body">
      <Transition name="drawer">
        <div v-if="detail.show" class="drawer-mask" @click.self="detail.show = false">
          <div class="drawer-panel">
            <div class="drawer-header">
              <div>
                <div class="drawer-date">{{ detail.date }}</div>
                <div class="drawer-weekday">{{ detail.weekday }}</div>
              </div>
              <button class="btn-icon" @click="detail.show = false">✕</button>
            </div>
            <div class="drawer-body" v-if="detail.snap">
              <!-- 核心收益 -->
              <div class="detail-hero" :class="colorClass(detail.snap.today_profit)">
                <div class="detail-hero-label">当日盈亏</div>
                <div class="detail-hero-val">{{ fmtPrivate(detail.snap.today_profit, fmtMoney) }}</div>
                <div class="detail-hero-pct">{{ fmtPrivate(detail.snap.today_pct, fmtPct) }}</div>
                <div class="detail-bar-track">
                  <div
                    class="detail-bar-fill"
                    :class="Number(detail.snap.today_profit) >= 0 ? 'bar-rise' : 'bar-fall'"
                    :style="{ width: Math.min(Math.abs(Number(detail.snap.today_pct)) * 10, 100) + '%' }"
                  ></div>
                </div>
              </div>
              <!-- 数据网格 -->
              <div class="detail-grid">
                <div class="detail-kv">
                  <div class="detail-k">总资产</div>
                  <div class="detail-v">{{ fmtPrivate(detail.snap.total_asset, v => '¥' + fmtNum(v)) }}</div>
                </div>
                <div class="detail-kv">
                  <div class="detail-k">持仓成本</div>
                  <div class="detail-v">{{ fmtPrivate(detail.snap.total_cost, v => '¥' + fmtNum(v)) }}</div>
                </div>
                <div class="detail-kv">
                  <div class="detail-k">累计收益</div>
                  <div class="detail-v" :class="colorClass(detail.snap.total_profit)">{{ fmtPrivate(detail.snap.total_profit, fmtMoney) }}</div>
                </div>
                <div class="detail-kv">
                  <div class="detail-k">累计收益率</div>
                  <div class="detail-v" :class="colorClass(detail.snap.total_pct)">{{ fmtPrivate(detail.snap.total_pct, fmtPct) }}</div>
                </div>
                <div class="detail-kv">
                  <div class="detail-k">持仓数量</div>
                  <div class="detail-v">{{ detail.snap.position_count }} 只</div>
                </div>
              </div>
            </div>
            <div class="drawer-footer">
              <button class="btn btn-secondary" @click="detail.show = false">关闭</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, reactive, onMounted, watch } from 'vue';
import * as api from '../api.js';
import { useFormat } from '../composables/useFormat.js';

const { fmtNum, fmtMoney, fmtMoneyCompact, fmtPct, fmtPrivate, colorClass } = useFormat();

// ── 状态 ─────────────────────────────────────────────────────
const loading       = ref(false);
const snapshots     = ref([]);
const selectedDay   = ref(null);
const detail        = reactive({ show: false, date: '', weekday: '', snap: null });

function getBJNow() {
  const now = new Date();
  return new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
}
const bjNow        = getBJNow();
const currentYear  = ref(bjNow.getFullYear());
const currentMonth = ref(bjNow.getMonth() + 1);
const weekDays     = ['日', '一', '二', '三', '四', '五', '六'];
const WEEK_NAMES   = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];

// ── 计算属性 ─────────────────────────────────────────────────
const daysInMonth    = computed(() => new Date(currentYear.value, currentMonth.value, 0).getDate());
const firstDayOfWeek = computed(() => new Date(currentYear.value, currentMonth.value - 1, 1).getDay());
const isCurrentMonth = computed(() => {
  const bj = getBJNow();
  return currentYear.value === bj.getFullYear() && currentMonth.value === bj.getMonth() + 1;
});

const snapMap = computed(() => {
  const m = {};
  for (const s of snapshots.value) m[parseInt(s.snap_date.slice(8), 10)] = s;
  return m;
});

const monthStats = computed(() => {
  const entries = Object.values(snapMap.value);
  if (!entries.length) return { count: 0, upDays: 0, downDays: 0, totalTodayProfit: 0, latestAsset: 0 };
  let upDays = 0, downDays = 0, totalTodayProfit = 0, latestAsset = 0, latestDate = '';
  for (const s of entries) {
    const p = Number(s.today_profit);
    if (p > 0) upDays++; else if (p < 0) downDays++;
    totalTodayProfit += p;
    if ((s.snap_date || '') >= latestDate) { latestDate = s.snap_date || ''; latestAsset = Number(s.total_asset); }
  }
  return { count: entries.length, upDays, downDays, totalTodayProfit, latestAsset };
});

// ── 数据加载 ─────────────────────────────────────────────────
async function loadSnapshots() {
  loading.value = true;
  try {
    const res = await api.getMonthSnapshots(currentYear.value, currentMonth.value);
    snapshots.value = res.data || [];
  } catch (e) {
    snapshots.value = [];
    window.showToast?.('加载历史数据失败：' + e.message, 'error');
  } finally {
    loading.value = false;
  }
}

// ── 月份导航 ─────────────────────────────────────────────────
function prevMonth() {
  if (currentMonth.value === 1) { currentMonth.value = 12; currentYear.value--; }
  else currentMonth.value--;
  selectedDay.value = null;
}
function nextMonth() {
  if (isCurrentMonth.value) return;
  if (currentMonth.value === 12) { currentMonth.value = 1; currentYear.value++; }
  else currentMonth.value++;
  selectedDay.value = null;
}

// ── 日期工具 ─────────────────────────────────────────────────
function isToday(day)   { return isCurrentMonth.value && day === getBJNow().getDate(); }
function isWeekend(day) { return [0,6].includes(new Date(currentYear.value, currentMonth.value-1, day).getDay()); }
function isFuture(day)  { return isCurrentMonth.value && day > getBJNow().getDate(); }
function getCellSnap(day) { return snapMap.value[day] || null; }

function getCellClasses(day) {
  const snap = getCellSnap(day);
  const c = [];
  if (snap) {
    c.push('cal-cell-clickable');
    const p = Number(snap.today_profit);
    c.push(p > 0 ? 'cal-cell-rise' : p < 0 ? 'cal-cell-fall' : 'cal-cell-flat');
  } else if (isWeekend(day)) {
    c.push('cal-cell-weekend');
  } else if (isFuture(day)) {
    c.push('cal-cell-future');
  }
  if (isToday(day))            c.push('cal-cell-today');
  if (selectedDay.value === day) c.push('cal-cell-selected');
  return c;
}

function selectDay(day) {
  const snap = getCellSnap(day);
  if (!snap) return;
  selectedDay.value = day;
  const pad = n => String(n).padStart(2,'0');
  detail.date    = `${currentYear.value}-${pad(currentMonth.value)}-${pad(day)}`;
  detail.weekday = WEEK_NAMES[new Date(currentYear.value, currentMonth.value-1, day).getDay()];
  detail.snap    = snap;
  detail.show    = true;
}

// ── 格式化（由 useFormat composable 提供）────────────────────

// ── 生命周期 ─────────────────────────────────────────────────
watch([currentYear, currentMonth], loadSnapshots);
onMounted(() => { loadSnapshots(); });
</script>

<style scoped>
/* ── 页面头部 ── */
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}
.page-title {
  font-size: 22px;
  font-weight: 800;
  color: var(--text-primary);
  margin: 0 0 4px;
}
.page-sub { font-size: 13px; color: var(--text-muted); }

/* ── 月度统计 ── */
.stats-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
.stat-card {
  flex: 1; min-width: 100px;
  display: flex; align-items: center; gap: 10px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 14px;
}
.stat-icon { font-size: 20px; flex-shrink: 0; }
.stat-label { font-size: 11px; color: var(--text-muted); margin-bottom: 2px; white-space: nowrap; }
.stat-val { font-size: 16px; font-weight: 700; color: var(--text-primary); white-space: nowrap; }
.stat-val.rise { color: var(--color-rise); }
.stat-val.fall { color: var(--color-fall); }

/* ── 日历容器 ── */
.cal-wrap {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 18px;
  overflow: hidden;
  margin-bottom: 20px;
}

/* 导航 */
.cal-nav {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--border);
}
.cal-nav-title { font-size: 17px; font-weight: 700; color: var(--text-primary); }
.cal-nav-year  { font-variant-numeric: tabular-nums; }
.cal-nav-sep   { font-size: 13px; color: var(--text-muted); margin: 0 2px; }
.cal-nav-btn {
  width: 36px; height: 36px; border-radius: 10px;
  border: 1px solid var(--border); background: transparent;
  color: var(--text-secondary); font-size: 22px; font-weight: 300;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
  font-family: inherit; line-height: 1;
}
.cal-nav-btn:hover:not(:disabled) { background: var(--bg-card-hv); color: var(--text-primary); border-color: var(--border-hv); }
.cal-nav-btn:disabled { opacity: 0.3; cursor: not-allowed; }

/* 星期头 */
.cal-head-row {
  display: grid; grid-template-columns: repeat(7, 1fr);
  padding: 0 12px; margin-top: 10px;
}
.cal-head-cell {
  text-align: center; font-size: 12px; font-weight: 600;
  color: var(--text-muted); padding: 4px 0 10px; letter-spacing: 0.5px;
}
.cal-head-weekend { color: #f87171; opacity: 0.8; }

/* 骨架屏 */
.cal-skeleton {
  display: grid; grid-template-columns: repeat(7, 1fr);
  gap: 6px; padding: 6px 12px 16px;
}
.cal-skel-cell {
  height: 88px; border-radius: 10px; background: var(--bg-page);
  animation: shimmer 1.4s ease-in-out infinite;
}
@keyframes shimmer { 0%,100%{opacity:.5} 50%{opacity:1} }

/* 格子网格 */
.cal-body {
  display: grid; grid-template-columns: repeat(7, 1fr);
  gap: 6px; padding: 6px 12px 16px;
}

.cal-cell {
  min-height: 88px; border-radius: 12px;
  padding: 9px 8px 7px;
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  cursor: default;
  border: 1.5px solid transparent;
  background: var(--bg-page);
  transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s;
  position: relative; overflow: hidden;
}
.cal-cell-ph      { background: transparent; border-color: transparent; }
.cal-cell-weekend { opacity: 0.4; }
.cal-cell-future  { opacity: 0.3; }

.cal-cell-clickable { cursor: pointer; }
.cal-cell-clickable:hover {
  transform: translateY(-3px);
  box-shadow: 0 6px 20px rgba(0,0,0,0.10);
  border-color: var(--border-hv); z-index: 1;
}
.cal-cell-rise {
  background: linear-gradient(150deg, rgba(220,252,231,0.92) 0%, rgba(187,247,208,0.55) 100%);
  border-color: rgba(34,197,94,0.25);
}
.cal-cell-fall {
  background: linear-gradient(150deg, rgba(254,226,226,0.92) 0%, rgba(252,165,165,0.55) 100%);
  border-color: rgba(239,68,68,0.25);
}
.cal-cell-flat { background: var(--bg-page); border-color: var(--border); }

.cal-cell-today {
  border-color: var(--color-primary) !important;
  box-shadow: 0 0 0 2px rgba(37,99,235,0.18);
}
.cal-cell-selected {
  border-color: var(--color-primary) !important;
  box-shadow: 0 0 0 3px rgba(37,99,235,0.3) !important;
  transform: translateY(-3px);
}

/* 格子内容 */
.cell-day {
  display: flex; flex-direction: column; align-items: center;
  gap: 2px; width: 100%; margin-bottom: 1px;
}
.cell-day-num {
  font-size: 13px; font-weight: 600; color: var(--text-secondary); line-height: 1;
}
.cell-today-num {
  color: var(--color-primary); font-weight: 800; font-size: 14px;
}
.cell-today-dot {
  width: 4px; height: 4px; border-radius: 50%; background: var(--color-primary);
}
.cell-profit {
  font-size: 11px; font-weight: 700; text-align: center;
  width: 100%; line-height: 1.3; letter-spacing: -0.2px;
}
.cell-pct {
  font-size: 10px; font-weight: 600; text-align: center;
  width: 100%; opacity: 0.8; line-height: 1.2;
}
.cell-rest, .cell-future {
  font-size: 11px; color: var(--text-muted); margin-top: 4px; opacity: 0.55;
}

.rise { color: var(--color-rise); }
.fall { color: var(--color-fall); }
.flat { color: var(--text-muted); }

/* 图例 */
.cal-legend {
  display: flex; align-items: center; gap: 16px;
  padding: 10px 16px 14px;
  border-top: 1px solid var(--border);
}
.legend-item { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-muted); }
.legend-dot  { width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; }
.dot-rise { background: rgba(34,197,94,0.5); border: 1px solid rgba(34,197,94,0.3); }
.dot-fall { background: rgba(239,68,68,0.5); border: 1px solid rgba(239,68,68,0.3); }
.dot-flat { background: var(--bg-page); border: 1px solid var(--border); }

/* ── 详情抽屉 ── */
.drawer-mask {
  position: fixed; inset: 0;
  background: rgba(15,23,42,0.4);
  backdrop-filter: blur(4px);
  display: flex; align-items: flex-end; justify-content: center;
  z-index: 1000;
}
@media (min-width: 640px) {
  .drawer-mask { align-items: center; padding: 20px; }
}
.drawer-panel {
  width: 100%; max-width: 460px;
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: 20px 20px 0 0;
  box-shadow: 0 -8px 40px rgba(0,0,0,0.15); overflow: hidden;
}
@media (min-width: 640px) {
  .drawer-panel { border-radius: 20px; box-shadow: 0 8px 40px rgba(0,0,0,0.15); }
}
.drawer-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 18px 20px 14px; border-bottom: 1px solid var(--border);
}
.drawer-date    { font-size: 17px; font-weight: 800; color: var(--text-primary); }
.drawer-weekday { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
.drawer-body    { padding: 16px 20px; }
.drawer-footer  { padding: 10px 20px 20px; display: flex; justify-content: flex-end; }

.detail-hero {
  border-radius: 14px; padding: 18px 20px 14px; margin-bottom: 14px;
  background: var(--bg-page); border: 1px solid var(--border);
}
.detail-hero.rise { background: rgba(220,252,231,0.55); border-color: rgba(34,197,94,0.28); }
.detail-hero.fall { background: rgba(254,226,226,0.55); border-color: rgba(239,68,68,0.28); }
.detail-hero-label { font-size: 12px; color: var(--text-muted); margin-bottom: 4px; }
.detail-hero-val   { font-size: 30px; font-weight: 800; line-height: 1.1; margin-bottom: 2px; }
.detail-hero.rise .detail-hero-val { color: var(--color-rise); }
.detail-hero.fall .detail-hero-val { color: var(--color-fall); }
.detail-hero-pct   { font-size: 15px; font-weight: 600; opacity: 0.8; margin-bottom: 12px; }
.detail-hero.rise .detail-hero-pct { color: var(--color-rise); }
.detail-hero.fall .detail-hero-pct { color: var(--color-fall); }
.detail-bar-track  { height: 6px; border-radius: 100px; background: rgba(0,0,0,0.08); overflow: hidden; }
.detail-bar-fill   { height: 100%; border-radius: 100px; min-width: 3px; transition: width 0.7s cubic-bezier(.4,0,.2,1); }
.bar-rise { background: linear-gradient(90deg, #4ade80, #16a34a); }
.bar-fall { background: linear-gradient(90deg, #f87171, #dc2626); }

.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.detail-kv   { background: var(--bg-page); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
.detail-k    { font-size: 11px; color: var(--text-muted); margin-bottom: 3px; }
.detail-v    { font-size: 15px; font-weight: 700; color: var(--text-primary); }
.detail-v.rise { color: var(--color-rise); }
.detail-v.fall { color: var(--color-fall); }

/* 动画 */
.drawer-enter-active, .drawer-leave-active { transition: opacity 0.22s; }
.drawer-enter-from, .drawer-leave-to { opacity: 0; }
.drawer-enter-active .drawer-panel,
.drawer-leave-active .drawer-panel { transition: transform 0.22s cubic-bezier(.4,0,.2,1); }
.drawer-enter-from .drawer-panel { transform: translateY(40px); }
.drawer-leave-to   .drawer-panel { transform: translateY(40px); }
@media (min-width: 640px) {
  .drawer-enter-from .drawer-panel { transform: scale(0.95) translateY(10px); }
  .drawer-leave-to   .drawer-panel { transform: scale(0.95) translateY(10px); }
}

/* ── 深色模式 ── */

/* 统计卡片 */
:global(html.dark) .stat-card {
  background: #111;
  border-color: #222;
}

/* 日历容器 */
:global(html.dark) .cal-wrap {
  background: #111;
  border-color: #222;
}
:global(html.dark) .cal-nav {
  border-bottom-color: #222;
}
:global(html.dark) .cal-nav-btn {
  border-color: #2a2a2a;
  color: #888;
}
:global(html.dark) .cal-nav-btn:hover:not(:disabled) {
  background: #1a1a1a;
  color: #f1f5f9;
  border-color: #444;
}

/* 星期行 */
:global(html.dark) .cal-head-weekend { color: #f87171; opacity: 0.75; }

/* 骨架屏 */
:global(html.dark) .cal-skel-cell { background: #1a1a1a; }

/* 日历格子 */
:global(html.dark) .cal-cell {
  background: #0a0a0a;
  border-color: transparent;
}
:global(html.dark) .cal-cell-rise {
  background: #0d1f12;
  border-color: rgba(34,197,94,0.35);
}
:global(html.dark) .cal-cell-fall {
  background: #1f0d0d;
  border-color: rgba(239,68,68,0.35);
}
:global(html.dark) .cal-cell-flat {
  background: #0a0a0a;
  border-color: #1e1e1e;
}
:global(html.dark) .cal-cell-clickable:hover {
  box-shadow: 0 6px 24px rgba(0,0,0,0.6);
  border-color: #444;
}
:global(html.dark) .cal-cell-today {
  border-color: var(--color-primary) !important;
  box-shadow: 0 0 0 2px rgba(37,99,235,0.35) !important;
}
:global(html.dark) .cal-cell-selected {
  border-color: var(--color-primary) !important;
  box-shadow: 0 0 0 3px rgba(37,99,235,0.45) !important;
}

/* 图例 */
:global(html.dark) .cal-legend { border-top-color: #222; }
:global(html.dark) .dot-flat { background: #0a0a0a; border-color: #2a2a2a; }
:global(html.dark) .dot-rise { background: rgba(34,197,94,0.45); border-color: rgba(34,197,94,0.3); }
:global(html.dark) .dot-fall { background: rgba(239,68,68,0.45); border-color: rgba(239,68,68,0.3); }

/* 详情抽屉 */
:global(html.dark) .drawer-panel {
  background: #111;
  border-color: #222;
}
:global(html.dark) .drawer-header { border-bottom-color: #222; }
:global(html.dark) .drawer-footer { border-top-color: #222; }
:global(html.dark) .detail-hero {
  background: #0a0a0a;
  border-color: #222;
}
:global(html.dark) .detail-hero.rise {
  background: #0d1f12;
  border-color: rgba(34,197,94,0.40);
}
:global(html.dark) .detail-hero.fall {
  background: #1f0d0d;
  border-color: rgba(239,68,68,0.40);
}
:global(html.dark) .detail-bar-track { background: rgba(255,255,255,0.08); }
:global(html.dark) .detail-kv {
  background: #0a0a0a;
  border-color: #222;
}

/* 响应式 */
@media (max-width: 640px) {
  .stats-row { gap: 8px; }
  .stat-card { min-width: calc(50% - 4px); }
  .cal-body, .cal-skeleton { gap: 4px; padding: 4px 8px 12px; }
  .cal-head-row { padding: 0 8px; }
  .cal-cell { min-height: 70px; padding: 7px 4px 5px; border-radius: 9px; }
  .cell-day-num { font-size: 12px; }
  .cell-profit  { font-size: 10px; }
  .cell-pct     { font-size: 9px; }
  .detail-grid  { grid-template-columns: 1fr; }
}
@media (max-width: 400px) {
  .cal-cell    { min-height: 58px; }
  .cell-profit { font-size: 9px; }
  .cell-pct    { display: none; }
}
</style>
