/**
 * useFormat.js
 * 统一的格式化函数 composable，避免在多个组件中重复定义
 */
import { usePrivacy } from './usePrivacy.js';

export function useFormat() {
  const { privacyMode } = usePrivacy();

  /** 数字千分位格式化，d 为小数位数 */
  const fmtNum = (v, d = 2) =>
    (v || v === 0)
      ? v.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d })
      : '--';

  /** 带符号金额，如 +¥1,234.56 / -¥100.00 */
  const fmtMoney = (v) =>
    `${v >= 0 ? '+' : ''}¥${Math.abs(v).toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  /** 紧凑金额（万元），用于日历格子等空间有限场景 */
  const fmtMoneyCompact = (v) => {
    const abs = Math.abs(v);
    const sign = v >= 0 ? '+' : '-';
    return abs >= 10000
      ? `${sign}¥${(abs / 10000).toFixed(1)}万`
      : `${sign}¥${abs.toFixed(0)}`;
  };

  /** 带符号百分比，如 +1.23% / -0.50% */
  const fmtPct = (v) => `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}%`;

  /** 隐私遮罩：privacyMode 时返回 '****'，否则调用 fmt(v) */
  const fmtPrivate = (v, fmt) => (privacyMode.value ? '****' : fmt(v));

  /** 涨跌 CSS 类名 */
  const colorClass = (v) => (Number(v) > 0 ? 'rise' : Number(v) < 0 ? 'fall' : 'flat');

  return {
    fmtNum,
    fmtMoney,
    fmtMoneyCompact,
    fmtPct,
    fmtPrivate,
    colorClass,
  };
}
