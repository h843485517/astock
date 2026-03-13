<template>
  <div>
    <div class="section-header" style="margin-bottom:12px;">
      <span class="section-title">大盘指数</span>
      <div>
        <span v-if="stale" class="stale-badge">数据稍旧</span>
        <span v-if="loading" class="loading-spinner"></span>
      </div>
    </div>

    <div class="index-group-label">🇨🇳 A股指数</div>
    <div class="market-grid market-grid-6" style="margin-bottom:16px;">
      <div v-for="idx in aList" :key="idx.code" class="index-card">
        <div class="index-name">{{ idx.label }}</div>
        <div class="index-value" :class="colorClass(idx.change_pct)">{{ formatNum(idx.current) }}</div>
        <div class="index-change" :class="colorClass(idx.change_pct)">
          {{ formatPct(idx.change_pct) }}&nbsp;{{ idx.change_amount > 0 ? '+' : '' }}{{ idx.change_amount.toFixed(2) }}
        </div>
      </div>
    </div>

    <div class="index-group-label">🌍 全球指数</div>
    <div class="market-grid">
      <div v-for="idx in gList" :key="idx.code" class="index-card">
        <div class="index-name">{{ idx.label }}</div>
        <div class="index-value" :class="colorClass(idx.change_pct)">{{ formatNum(idx.current) }}</div>
        <div class="index-change" :class="colorClass(idx.change_pct)">
          {{ formatPct(idx.change_pct) }}&nbsp;{{ idx.change_amount > 0 ? '+' : '' }}{{ idx.change_amount.toFixed(2) }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  indices: { type: Object, default: () => ({}) },
  stale:   { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
});

const A_CONFIG = [
  { code: 'sh000001', label: '上证指数' },
  { code: 'sz399001', label: '深证成指' },
  { code: 'sz399006', label: '创业板指' },
  { code: 'sh000016', label: '上证50' },
  { code: 'sh000300', label: '沪深300' },
  { code: 'sh000905', label: '中证500' },
];
const G_CONFIG = [
  { code: 'gb_dji',  label: '道琼斯' },
  { code: 'gb_ixic', label: '纳斯达克' },
  { code: 'gb_inx',  label: '标普500' },
];

function buildList(cfg) {
  return cfg.map(({ code, label }) => {
    const item = props.indices[code] || {};
    return { code, label, current: item.current || 0, change_pct: item.change_pct || 0, change_amount: item.change_amount || 0 };
  });
}

const aList = computed(() => buildList(A_CONFIG));
const gList = computed(() => buildList(G_CONFIG));

const colorClass = (v) => v > 0 ? 'rise' : v < 0 ? 'fall' : 'flat';
const formatNum  = (v) => v ? v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '--';
const formatPct  = (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
</script>