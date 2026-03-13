async function request(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'include',                                    // 携带 HttpOnly Cookie
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(json.message || '请求失败');
  return json;
}

// ── 持仓接口 ──────────────────────────────────────────────────
export const getPositions    = ()       => request('/api/positions');
export const createPosition  = (data)   => request('/api/positions', { method: 'POST', body: JSON.stringify(data) });
export const updatePosition  = (id, d)  => request(`/api/positions/${id}`, { method: 'PUT', body: JSON.stringify(d) });
export const deletePosition  = (id)     => request(`/api/positions/${id}`, { method: 'DELETE' });

// ── 行情接口 ──────────────────────────────────────────────────
export const getQuote        = (codes)  => request(`/api/quote?codes=${encodeURIComponent(Array.isArray(codes) ? codes.join(',') : codes)}`);
export const getFundQuote    = (code)   => request(`/api/fund-quote?code=${encodeURIComponent(code)}`);
export const getMarketIndex  = ()       => request('/api/market-index');

// ── 认证接口 ──────────────────────────────────────────────────
export const login          = (data) => request('/api/auth/login',     { method: 'POST', body: JSON.stringify(data) });
export const register       = (data) => request('/api/auth/register',  { method: 'POST', body: JSON.stringify(data) });
export const logout         = ()     => request('/api/auth/logout',    { method: 'POST' });
export const getMe          = ()     => request('/api/auth/me');
export const changePassword = (data) => request('/api/auth/password',  { method: 'PUT',  body: JSON.stringify(data) });