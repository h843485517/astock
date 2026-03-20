import { ref } from 'vue';
import * as api from '../api.js';

const POS_SSE_RETRY_DELAYS = [3000, 6000, 15000, 30000];

/**
 * 持仓 SSE 流 + 手动刷新 composable
 *
 * @param {object} options
 * @param {Function} [options.onData]   每次 SSE 推送或手动刷新成功后的回调，参数为 { positions, quotes }
 * @param {Function} [options.onToast] Toast 通知函数，默认使用 window.showToast
 *
 * @returns {{ positions, quotes, loading, sseActive, connect, disconnect, manualRefresh }}
 */
export function usePositionStream({ onData, onToast } = {}) {
  const positions = ref([]);
  const quotes    = ref({});
  const loading   = ref(true);
  const sseActive = ref(false);

  const toast = onToast || ((msg, type) => window.showToast?.(msg, type));

  let esSource        = null;
  let retryCount      = 0;
  let retryTimer      = null;

  function connect() {
    if (esSource) { try { esSource.close(); } catch (_) {} esSource = null; }

    esSource = new EventSource('/api/positions/stream', { withCredentials: true });

    esSource.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.code === 0) {
          positions.value = payload.positions || [];
          quotes.value    = payload.quotes    || {};
          onData?.({ positions: positions.value, quotes: quotes.value });
        }
        loading.value   = false;
        sseActive.value = true;
        retryCount      = 0;
      } catch (err) {
        console.error('[SSE] 持仓数据解析失败:', err);
      }
    };

    esSource.onerror = () => {
      sseActive.value = false;
      if (esSource) { try { esSource.close(); } catch (_) {} esSource = null; }
      if (retryCount < POS_SSE_RETRY_DELAYS.length) {
        const delay = POS_SSE_RETRY_DELAYS[retryCount++];
        console.warn(`[SSE] 持仓断线，${delay / 1000}s 后重连（第 ${retryCount} 次）`);
        retryTimer = setTimeout(connect, delay);
      } else {
        console.warn('[SSE] 持仓重连失败，请手动刷新');
      }
    };
  }

  function disconnect() {
    if (retryTimer)  { clearTimeout(retryTimer); retryTimer = null; }
    if (esSource)    { try { esSource.close(); } catch (_) {} esSource = null; }
    retryCount = 0;
  }

  async function manualRefresh() {
    loading.value = true;
    try {
      const posRes     = await api.getPositions();
      positions.value  = posRes.data || [];

      const stockCodes = positions.value.filter(p => p.type === 'stock').map(p => p.code);
      const fundCodes  = positions.value.filter(p => p.type === 'fund').map(p => p.code);
      const results    = {};

      if (stockCodes.length > 0) {
        try { Object.assign(results, (await api.getQuote(stockCodes)).data); } catch (_) {}
      }

      if (fundCodes.length > 0) {
        const settled = await Promise.allSettled(
          fundCodes.map(async (code) => {
            const d   = (await api.getFundQuote(code)).data;
            const pct = d.gszzl || 0;
            return {
              code,
              data: { name: d.name, current: +(d.dwjz*(1+pct/100)).toFixed(4), close: d.dwjz, change_pct: pct, change_amount: +(d.dwjz*pct/100).toFixed(4) },
            };
          })
        );
        for (const r of settled) {
          if (r.status === 'fulfilled') results[r.value.code] = r.value.data;
        }
      }

      quotes.value = results;
      onData?.({ positions: positions.value, quotes: quotes.value });
      toast('持仓已刷新', 'success');
    } catch (e) {
      toast('持仓数据加载失败：' + e.message, 'error');
    } finally {
      loading.value = false;
    }
  }

  return { positions, quotes, loading, sseActive, connect, disconnect, manualRefresh };
}
