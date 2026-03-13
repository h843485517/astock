<template>
  <div class="page">
    <div class="form-card">
      <div class="form-title">添加持仓</div>

      <!-- 类型切换 -->
      <div class="form-group">
        <label class="form-label">持仓类型 <span class="required">*</span></label>
        <div class="type-switch">
          <button class="type-switch-btn" :class="{ active: form.type === 'stock' }" @click="switchType('stock')" type="button">📈 股票</button>
          <button class="type-switch-btn" :class="{ active: form.type === 'fund' }"  @click="switchType('fund')"  type="button">💹 基金</button>
        </div>
      </div>

      <!-- 证券代码 -->
      <div class="form-group">
        <label class="form-label">{{ form.type === 'stock' ? '股票' : '基金' }}代码 <span class="required">*</span></label>
        <input v-model="form.code" class="form-control" :class="{ 'is-invalid': errors.code }"
          :placeholder="form.type === 'stock' ? '如 600519 或 sh600519' : '如 000001'"
          @blur="validateCode" maxlength="8" />
        <div v-if="errors.code" class="form-error">{{ errors.code }}</div>
        <div v-if="codeStatus === 'checking'" class="code-preview"><span class="loading-spinner"></span> 验证中...</div>
        <div v-else-if="codeStatus === 'valid' && namePreview" class="code-preview valid">✅ {{ namePreview }}</div>
        <div v-else-if="codeStatus === 'invalid' && !errors.code" class="code-preview invalid">❌ 代码无效</div>
        <div v-else class="form-hint">{{ form.type === 'stock' ? '沪市以6开头，深市以0或3开头' : '6位基金代码' }}</div>
      </div>

      <!-- 份额 & 成本价 -->
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">{{ form.type === 'stock' ? '持有股数' : '持有份额' }} <span class="required">*</span></label>
          <input v-model="form.shares" class="form-control" :class="{ 'is-invalid': errors.shares }" type="number" min="0"
            :step="form.type === 'stock' ? '100' : '0.01'" :placeholder="form.type === 'stock' ? '如 100' : '如 1000.00'" />
          <div v-if="errors.shares" class="form-error">{{ errors.shares }}</div>
        </div>
        <div class="form-group">
          <label class="form-label">成本价（元）<span class="required">*</span></label>
          <input v-model="form.cost_price" class="form-control" :class="{ 'is-invalid': errors.cost_price }" type="number" min="0"
            step="0.001" :placeholder="form.type === 'stock' ? '如 1800.00' : '如 1.2500'" />
          <div v-if="errors.cost_price" class="form-error">{{ errors.cost_price }}</div>
        </div>
      </div>

      <!-- 分组 -->
      <div class="form-group">
        <label class="form-label">自定义分组 <span style="color:var(--text-muted);font-weight:normal;">（可选）</span></label>
        <select v-model="selectedGroup" class="form-control">
          <option value="">不分组（默认分组）</option>
          <option v-for="g in existingGroups" :key="g" :value="g">{{ g }}</option>
          <option value="__new__">＋ 新建分组...</option>
        </select>
        <input v-if="selectedGroup === '__new__'" v-model="newGroupInput" class="form-control" style="margin-top:8px;" placeholder="输入新分组名称" maxlength="20" />
        <div class="form-hint">当前分组：<span style="color:var(--text-primary);">{{ resolvedGroup || '默认分组' }}</span></div>
      </div>

      <!-- 操作按钮 -->
      <div class="form-actions">
        <button class="btn btn-secondary" :disabled="submitting" @click="submitAndContinue" type="button">
          <span v-if="submitting" class="loading-spinner"></span>继续添加
        </button>
        <button class="btn btn-primary" :disabled="submitting" @click="submitAndReturn" type="button">
          <span v-if="submitting" class="loading-spinner"></span>保存并返回
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import * as api from '../api.js';

const router = useRouter();

const form = reactive({ type: 'stock', code: '', shares: '', cost_price: '' });
const errors         = reactive({});
const namePreview    = ref('');
const codeStatus     = ref('');
const submitting     = ref(false);
const existingGroups = ref([]);
const selectedGroup  = ref('');
const newGroupInput  = ref('');

const resolvedGroup = computed(() => selectedGroup.value === '__new__' ? newGroupInput.value.trim() : selectedGroup.value);

async function loadGroups() {
  try {
    const res = await api.getPositions();
    existingGroups.value = [...new Set(res.data.map(p => p.group_name || '默认分组').filter(Boolean))];
  } catch (_) {}
}

function switchType(t) {
  form.type = t; form.code = ''; namePreview.value = ''; codeStatus.value = ''; errors.code = '';
}

async function validateCode() {
  const raw = form.code.trim().replace(/^(sh|sz)/i, '');
  if (!raw) { codeStatus.value = ''; namePreview.value = ''; return; }
  if (!/^\d{6}$/.test(raw)) { codeStatus.value = 'invalid'; namePreview.value = ''; errors.code = '代码格式不正确，应为 6 位数字'; return; }
  codeStatus.value = 'checking'; namePreview.value = ''; errors.code = '';
  try {
    if (form.type === 'stock') {
      const res = await api.getQuote([raw]);
      const key = Object.keys(res.data)[0];
      const item = key ? res.data[key] : null;
      if (item?.name) { namePreview.value = item.name; codeStatus.value = 'valid'; }
      else { codeStatus.value = 'invalid'; errors.code = '未找到该股票，请检查代码'; }
    } else {
      const res = await api.getFundQuote(raw);
      if (res.data?.name) { namePreview.value = res.data.name; codeStatus.value = 'valid'; }
      else { codeStatus.value = 'invalid'; errors.code = '未找到该基金，请检查代码'; }
    }
  } catch (e) { codeStatus.value = 'invalid'; errors.code = '验证失败：' + e.message; }
}

function validate() {
  Object.keys(errors).forEach(k => delete errors[k]);
  let valid = true;
  if (!form.code.trim().replace(/^(sh|sz)/i, '').match(/^\d{6}$/)) { errors.code = '证券代码格式不正确，应为 6 位数字'; valid = false; }
  if (!form.shares || isNaN(form.shares) || Number(form.shares) <= 0) { errors.shares = '持有份额必须为大于 0 的数字'; valid = false; }
  if (!form.cost_price || isNaN(form.cost_price) || Number(form.cost_price) <= 0) { errors.cost_price = '成本价必须为大于 0 的数字'; valid = false; }
  return valid;
}

async function doSubmit() {
  if (!validate()) return false;
  submitting.value = true;
  try {
    await api.createPosition({ type: form.type, code: form.code.trim().replace(/^(sh|sz)/i, ''), shares: Number(form.shares), cost_price: Number(form.cost_price), group_name: resolvedGroup.value });
    return true;
  } catch (e) { window.showToast('保存失败：' + e.message, 'error'); return false; }
  finally { submitting.value = false; }
}

function resetForm() {
  form.code = ''; form.shares = ''; form.cost_price = '';
  namePreview.value = ''; codeStatus.value = ''; newGroupInput.value = '';
  Object.keys(errors).forEach(k => delete errors[k]);
}

async function submitAndContinue() {
  if (await doSubmit()) { window.showToast('保存成功，可继续添加', 'success'); await loadGroups(); resetForm(); }
}

async function submitAndReturn() {
  if (await doSubmit()) { window.showToast('保存成功', 'success'); router.push('/'); }
}

onMounted(loadGroups);
</script>