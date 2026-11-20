/**
 * Front-end for the privacy-preserving aggregate query service.
 *
 * Plain ES module, no framework, no build step. All rendering goes through
 * `textContent` / `createElement` — never `innerHTML` — so data derived from
 * the query or the server cannot inject markup.
 */

const state = {
  meta: null,
  caller: null,
  me: null,
  requestId: 0,
  lastResult: null,
  adminOpen: false,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

// ------------------------------------------------------------------ helpers

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function fmtNumber(value, digits = 0) {
  if (value === null || value === undefined) return '—';
  return Number(value).toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtEpsilon(value) {
  if (value === null || value === undefined) return '—';
  return `ε ${Number(value).toFixed(2).replace(/\.00$/, '.0')}`.replace('0.', '.');
}

function fmtTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms <= 0) return '已过期';
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  return `${Math.round(ms / 60_000)} 分钟`;
}

const OUTCOME_TONE = {
  released: 'ok',
  cached: 'info',
  replayed: 'info',
  denied_stale_authority: 'warn',
  denied_repeat_limit: 'warn',
  denied_request_replay: 'warn',
  denied_budget_exhausted: 'warn',
  denied_k_threshold: 'danger',
  denied_complementary_suppression: 'danger',
  denied_differencing: 'danger',
  denied_permission: 'danger',
  denied_caller_inactive: 'danger',
  denied_caller_not_found: 'danger',
  denied_invalid_request: 'danger',
};

const OUTCOME_LABEL = {
  released: '已发布',
  cached: '缓存命中',
  replayed: '幂等重放',
  denied_k_threshold: '低于阈值',
  denied_complementary_suppression: '小分组抑制',
  denied_differencing: '差异性拒绝',
  denied_budget_exhausted: '预算不足',
  denied_repeat_limit: '重复过多',
  denied_request_replay: '请求重放',
  denied_stale_authority: '权限已变更',
  denied_permission: '无权限',
  denied_caller_inactive: '权限已撤销',
  denied_caller_not_found: '身份不存在',
  denied_invalid_request: '参数错误',
};

function outcomeLabel(code) {
  return OUTCOME_LABEL[code] ?? code ?? '—';
}

function outcomeTone(code) {
  return OUTCOME_TONE[code] ?? 'warn';
}

function showBanner(message, tone = 'info', timeout = 6000) {
  const banner = $('#banner');
  banner.textContent = message;
  banner.dataset.tone = tone;
  banner.hidden = false;
  clearTimeout(showBanner.timer);
  if (timeout > 0) {
    showBanner.timer = setTimeout(() => {
      banner.hidden = true;
    }, timeout);
  }
}

// -------------------------------------------------------------- api client

async function api(path, { method = 'GET', body, admin = false } = {}) {
  const headers = {};
  if (state.caller) headers['x-caller-id'] = state.caller.callerId;
  if (admin) headers['x-admin'] = '1';
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(data?.error?.message ?? `请求失败 (${response.status})`);
    error.status = response.status;
    error.code = data?.error?.code;
    error.details = data?.error?.details;
    error.payload = data;
    throw error;
  }
  return data;
}

// ------------------------------------------------------------------- boot

async function boot() {
  try {
    state.meta = await api('/api/meta');
  } catch (error) {
    showBanner(`无法加载服务信息：${error.message}`, 'danger', 0);
    return;
  }

  const seen = localStorage.getItem('privacy-caller');
  const saved = state.meta.callers.find((caller) => caller.callerId === seen);
  state.caller = saved ?? state.meta.callers[0] ?? null;

  renderCallerSelect();
  renderMetricOptions();
  renderFilterFields();
  renderPolicyStrip();

  if (!state.caller) {
    showBanner('没有可用身份，请先运行 seed 脚本。', 'danger', 0);
    return;
  }
  await loadMe();
  await loadHistory();

  $('#caller-select').addEventListener('change', onCallerChange);
  $('#refresh-btn').addEventListener('click', () => refreshAuthority());
  $('#metric').addEventListener('change', () => {
    updateMetricHint();
    renderPolicyStrip();
  });
  $('#groupBy').addEventListener('change', () => {
    syncFilterDisabled();
    renderPolicyStrip();
  });
  $('#query-form').addEventListener('submit', onSubmit);
  $('#query-form').addEventListener('reset', () => {
    setTimeout(() => {
      $('#note').value = '';
      syncFilterDisabled();
      renderPolicyStrip();
    }, 0);
  });
  $('#history-refresh').addEventListener('click', loadHistory);

  for (const button of $$('[data-admin]')) {
    button.addEventListener('click', () => runAdminAction(button.dataset.admin));
  }
  $('#policy-form').addEventListener('submit', savePolicy);
  $('#admin-panel').addEventListener('toggle', (event) => {
    state.adminOpen = event.target.open;
    if (state.adminOpen) runAdminAction('overview');
  });
}

function renderCallerSelect() {
  const select = $('#caller-select');
  clear(select);
  for (const caller of state.meta.callers) {
    select.append(
      el(
        'option',
        { value: caller.callerId },
        `${caller.displayName} · ${caller.callerId}${caller.active ? '' : '（已停用）'}`,
      ),
    );
  }
  if (state.caller) select.value = state.caller.callerId;
}

function renderMetricOptions() {
  const select = $('#metric');
  clear(select);
  for (const metric of state.meta.metrics) {
    select.append(el('option', { value: metric.id }, metric.label));
  }
  updateMetricHint();
}

function updateMetricHint() {
  const metric = state.meta.metrics.find((item) => item.id === $('#metric').value);
  $('#metric-hint').textContent = metric?.description ?? '';
}

function renderFilterFields() {
  const container = $('#filter-fields');
  clear(container);
  for (const dimension of state.meta.dimensions) {
    const id = `filter-${dimension.id}`;
    const select = el('select', { id, name: dimension.id });
    select.append(el('option', { value: '' }, '不限'));
    for (const value of dimension.values) {
      select.append(el('option', { value }, value));
    }
    container.append(
      el('div', { class: 'field' }, el('label', { for: id }, dimension.label), select),
    );
  }
  const groupSelect = $('#groupBy');
  clear(groupSelect);
  const labels = { none: '不分组（整体）', region: '按地区', dept: '按部门', ageBand: '按年龄段' };
  for (const option of state.meta.groupBy) {
    groupSelect.append(el('option', { value: option }, labels[option] ?? option));
  }
  syncFilterDisabled();
}

/** A grouping column cannot also be filtered on (mirrors the server rule). */
function syncFilterDisabled() {
  const groupBy = $('#groupBy').value;
  for (const dimension of state.meta.dimensions) {
    const select = $(`#filter-${dimension.id}`);
    const disabled = dimension.id === groupBy;
    select.disabled = disabled;
    if (disabled) select.value = '';
  }
}

function renderPolicyStrip() {
  const policy = state.meta.policy;
  const strip = $('#policy-strip');
  clear(strip);
  const chips = [
    `k = ${policy.k}`,
    `单次 ${fmtEpsilon(policy.perQueryEpsilon)}`,
    `预算上限 ${fmtEpsilon(policy.perCallerEpsilonCap)}`,
    `重复上限 ${policy.repeatLimit} 次/${fmtDuration(policy.repeatWindowMs)}`,
    `缓存 ${policy.cacheTtlMs > 0 ? fmtDuration(policy.cacheTtlMs) : '关闭'}`,
    policy.complementarySuppression ? '互补抑制 开' : '互补抑制 关',
    policy.differencingProtection ? '差异性防护 开' : '差异性防护 关',
  ];
  for (const text of chips) strip.append(el('span', { class: 'chip' }, text));
}

// ------------------------------------------------------------------ caller

async function onCallerChange(event) {
  state.caller = state.meta.callers.find((caller) => caller.callerId === event.target.value);
  localStorage.setItem('privacy-caller', state.caller.callerId);
  state.lastResult = null;
  renderResultEmpty('身份已切换，请重新执行查询。');
  await loadMe();
  await loadHistory();
}

async function refreshAuthority() {
  try {
    const meta = await api('/api/meta');
    state.meta = meta;
    const fresh = meta.callers.find((caller) => caller.callerId === state.caller?.callerId);
    if (!fresh) {
      showBanner('当前身份已不存在。', 'danger');
      return;
    }
    state.caller = fresh;
    renderCallerSelect();
    renderPolicyStrip();
    await loadMe();
    showBanner(
      `权限已刷新：版本 v${fresh.version}，${fresh.active ? '状态正常' : '已被撤销'}。`,
      fresh.active ? 'ok' : 'danger',
    );
  } catch (error) {
    showBanner(`刷新失败：${error.message}`, 'danger');
  }
}

async function loadMe() {
  if (!state.caller) return;
  try {
    state.me = await api('/api/me');
    renderBudget(state.me.budget);
  } catch (error) {
    if (error.status === 404) {
      state.me = null;
      showBanner('当前身份已不存在。', 'danger');
    } else {
      showBanner(`加载身份信息失败：${error.message}`, 'danger');
    }
  }
}

function renderBudget(budget) {
  const stats = $('#budget-stats');
  clear(stats);
  if (!budget) {
    stats.append(el('div', {}, el('dt', {}, '状态'), el('dd', {}, '未知')));
    return;
  }
  const pct = budget.cap > 0 ? Math.min(100, (budget.spent / budget.cap) * 100) : 0;
  const fill = $('#budget-fill');
  fill.style.width = `${pct}%`;
  fill.dataset.tone = pct >= 90 ? 'danger' : pct >= 60 ? 'warn' : '';
  $('#budget-meter').setAttribute(
    'aria-label',
    `已使用 ${fmtNumber(budget.spent, 2)}，共 ${fmtNumber(budget.cap, 2)} ε`,
  );

  const rows = [
    ['已消耗', fmtEpsilon(budget.spent)],
    ['上限', fmtEpsilon(budget.cap)],
    ['剩余', fmtEpsilon(budget.remaining)],
    ['单组成本', fmtEpsilon(budget.perCell ?? state.meta.policy.perQueryEpsilon)],
    ['还可发布', `${budget.affordableCells ?? '—'} 组`],
  ];
  for (const [label, value] of rows) {
    stats.append(el('div', {}, el('dt', {}, label), el('dd', {}, value)));
  }
}

// ------------------------------------------------------------------- query

function readQueryForm() {
  const filters = {};
  for (const dimension of state.meta.dimensions) {
    const value = $(`#filter-${dimension.id}`).value;
    if (value) filters[dimension.id] = value;
  }
  return {
    metric: $('#metric').value,
    groupBy: $('#groupBy').value,
    filters,
    note: $('#note').value.trim(),
  };
}

async function onSubmit(event) {
  event.preventDefault();
  if (!state.caller) return;
  const form = readQueryForm();
  const button = $('#run-btn');
  button.disabled = true;
  button.textContent = '查询中…';

  // A fresh client-generated request id per submission makes retries safe: a
  // double-click or network retry can never be billed twice.
  state.requestId += 1;
  const requestId = `${state.caller.callerId}-${Date.now()}-${state.requestId}`;

  try {
    const result = await api('/api/query', {
      method: 'POST',
      body: {
        query: {
          metric: form.metric,
          groupBy: form.groupBy,
          filters: form.filters,
          requestId,
          // Echo the authority version we rendered under; if the server has
          // since changed it, the query is refused instead of silently using
          // newer/older permissions than the user saw.
          callerVersion: state.caller.version,
        },
        note: form.note,
      },
    });
    state.lastResult = result;
    renderResult(result, form);
    renderBudget(result.budget);
    await loadHistory();
    if (result.outcome === 'denied_stale_authority') {
      showBanner('服务器上的权限版本已变化，正在刷新…', 'warn');
      await refreshAuthority();
    }
  } catch (error) {
    if (error.status === 400 && error.payload?.result) {
      state.lastResult = error.payload.result;
      renderResult(error.payload.result, form);
    } else if (error.status === 401 || error.status === 404) {
      showBanner(error.message, 'danger');
      await loadMe();
    } else {
      showBanner(`查询失败：${error.message}`, 'danger');
    }
  } finally {
    button.disabled = false;
    button.textContent = '执行查询';
  }
}

function renderResultEmpty(message) {
  $('#result-empty').hidden = false;
  $('#result-empty').textContent = message;
  $('#result-body').hidden = true;
  setStatusPill('尚未查询', null);
}

function setStatusPill(text, tone) {
  const pill = $('#status-pill');
  pill.textContent = text;
  if (tone) pill.dataset.tone = tone;
  else delete pill.dataset.tone;
}

function renderResult(result, form) {
  void form;
  $('#result-empty').hidden = true;
  $('#result-body').hidden = false;

  const tone = outcomeTone(result.outcome);
  setStatusPill(outcomeLabel(result.outcome), tone);

  renderConditions(result.conditions);
  renderPrivacyCard(result);
  renderData(result);
  renderAuditFoot(result);
}

function renderConditions(conditions) {
  const container = $('#conditions');
  clear(container);
  if (!conditions) return;
  container.append(el('span', { class: 'chip' }, conditions.metric.label));
  container.append(el('span', { class: 'chip' }, conditions.groupLabel));
  for (const label of conditions.filterLabels) {
    container.append(el('span', { class: 'chip' }, label));
  }
  container.append(el('span', { class: 'chip' }, `k = ${conditions.k}`));
  container.append(el('span', { class: 'chip' }, `策略 v${conditions.policyVersion}`));
}

function renderPrivacyCard(result) {
  const card = $('#privacy-card');
  const privacy = result.privacy;
  const tone = privacy.status === 'denied' ? outcomeTone(privacy.reasonCode) : outcomeTone(result.outcome);
  card.dataset.tone = tone;

  const icon = $('#privacy-icon');
  icon.dataset.tone = tone;
  icon.textContent = privacy.status === 'denied' ? '!' : privacy.status === 'cached' ? '↻' : '✓';

  $('#privacy-title').textContent =
    privacy.status === 'released'
      ? '结果已发布'
      : privacy.status === 'cached'
        ? '缓存命中'
        : privacy.status === 'replayed'
          ? '幂等重放'
          : '结果未返回';

  $('#privacy-message').textContent = privacy.message ?? '';

  const facts = $('#privacy-facts');
  clear(facts);
  const addFact = (label, value) => {
    if (value === undefined || value === null || value === '') return;
    facts.append(el('div', {}, el('dt', {}, label), el('dd', {}, value)));
  };

  addFact('隐私状态', privacy.status === 'denied' ? '拒绝' : privacy.status);
  addFact('阈值 k', privacy.k);
  if (privacy.cohortBand) {
    const bandLabels = {
      empty: '空',
      below_k: '低于 k',
      small: '≥ k 且较小',
      large: '充足',
    };
    addFact('群体规模', bandLabels[privacy.cohortBand] ?? privacy.cohortBand);
  }
  if (privacy.cohortSize != null) addFact('精确人数', fmtNumber(privacy.cohortSize));
  if (privacy.epsilon != null && privacy.status !== 'denied') {
    addFact('机制 ε', fmtEpsilon(privacy.epsilon));
  }
  if (privacy.budgetCharged != null) addFact('本次计费', fmtEpsilon(privacy.budgetCharged));
  if (privacy.mechanism) addFact('机制', `${privacy.mechanism}${privacy.delta ? ` (δ=${privacy.delta})` : ''}`);
  if (privacy.cache?.hit) addFact('缓存过期', fmtDuration(privacy.cache.expiresAt - Date.now()));
  if (privacy.cache?.replayed) addFact('来源', '首次发布的快照');

  const details = privacy.details ?? {};
  if (details.attempts != null) addFact('窗口内次数', `${details.attempts} / ${details.repeatLimit}`);
  if (details.cost != null) addFact('本次所需 ε', fmtEpsilon(details.cost));
  if (details.remaining != null && privacy.status === 'denied') addFact('剩余 ε', fmtEpsilon(details.remaining));
  if (details.smallCellCount != null) addFact('被抑制分组数', details.smallCellCount);
  if (details.required) addFact('需要权限', details.required.join('、'));
  if (details.serverVersion != null) {
    addFact('权限版本', `客户端 v${details.clientVersion} → 服务器 v${details.serverVersion}`);
  }
}

function renderData(result) {
  const block = $('#data-block');
  const data = result.data;
  if (!data || !data.cells?.length) {
    block.hidden = true;
    return;
  }
  block.hidden = false;

  const groupHeader = $('#group-header');
  groupHeader.textContent = data.groupBy === 'none' ? '范围' : '分组';
  $('#results-caption').textContent =
    `${result.conditions.metric.label}${data.groupBy === 'none' ? '' : ` · ${result.conditions.groupLabel}`}` +
    (data.cohortBand ? ` · 群体规模：${bandLabel(data.cohortBand)}` : '');

  const body = $('#results-body');
  clear(body);
  for (const cell of data.cells) {
    const row = el('tr', cell.suppressed ? { class: 'suppressed' } : {});
    row.append(el('td', {}, cell.label));
    if (cell.suppressed) {
      row.append(el('td', {}, '已抑制'));
    } else {
      const digits = result.data.metric === 'count' ? 0 : 0;
      const unit = cell.unit ?? '';
      row.append(el('td', { class: 'num' }, `${fmtNumber(cell.value, digits)} ${unit}`.trim()));
    }
    body.append(row);
  }

  const note = $('#noise-note');
  const epsilon = result.privacy.epsilon;
  note.textContent =
    result.privacy.status === 'denied'
      ? ''
      : `数值已加入 Laplace 噪声（ε=${epsilon ?? '—'}）。不同时间重复查询可能得到不同数值；` +
        `预算耗尽后将只返回缓存中已发布的结果。`;
}

function bandLabel(band) {
  return { empty: '空', below_k: '低于 k', small: '≥ k 且较小', large: '充足' }[band] ?? band;
}

function renderAuditFoot(result) {
  const foot = $('#audit-foot');
  clear(foot);
  if (!result.audit) {
    foot.append(el('span', {}, '本次请求未写入审计（解析失败）。'));
    return;
  }
  foot.append(el('div', {}, `请求编号 ${result.requestId}`));
  foot.append(el('div', {}, `审计序号 #${result.audit.seq} · 哈希 ${result.audit.hash}`));
  if (result.note) foot.append(el('div', {}, `备注：${result.note}`));
}

// ----------------------------------------------------------------- history

async function loadHistory() {
  if (!state.caller) return;
  try {
    const history = await api('/api/me/history?limit=25');
    const body = $('#history-table tbody');
    clear(body);
    for (const entry of history.ledger) {
      const row = el('tr');
      row.append(el('td', { class: 'nowrap' }, fmtTime(entry.at)));
      row.append(
        el(
          'td',
          {},
          el(
            'span',
            { class: 'outcome-tag', dataset: { tone: outcomeTone(entry.outcomeCode) } },
            outcomeLabel(entry.outcomeCode),
          ),
        ),
      );
      row.append(el('td', { class: 'num' }, fmtEpsilon(entry.epsilon)));
      row.append(el('td', { class: 'mono' }, entry.requestId.slice(0, 18)));
      body.append(row);
    }
    $('#history-empty').hidden = history.ledger.length > 0;
  } catch (error) {
    showBanner(`加载查询记录失败：${error.message}`, 'danger');
  }
}

// ------------------------------------------------------------------- admin

async function runAdminAction(action) {
  const status = $('#admin-status');
  try {
    if (action === 'overview') {
      const overview = await api('/api/admin/overview', { admin: true });
      fillPolicyForm(overview.policy);
      renderAdminCallers(overview.callers);
      renderChain(overview.audit);
      renderAdminCache(overview.cache);
      status.textContent = `策略 v${overview.policy.version} · 调用方 ${overview.callers.length} · 缓存 ${overview.cache.total} 条（命中 ${overview.cache.hits}）`;
      const [audit, ledger] = await Promise.all([
        api('/api/admin/audit?limit=12', { admin: true }),
        api('/api/admin/ledger?limit=12', { admin: true }),
      ]);
      renderAuditTable(audit.records);
      renderLedgerTable(ledger.entries);
    } else if (action === 'verify') {
      const chain = await api('/api/admin/audit/verify', { admin: true });
      renderChain(chain);
      status.textContent = chain.ok
        ? `审计链完整：共 ${chain.checked} 条记录。`
        : `审计链在第 ${chain.brokenAt} 条处被破坏！`;
    } else if (action === 'audit') {
      const audit = await api('/api/admin/audit?limit=50', { admin: true });
      renderAuditTable(audit.records);
      status.textContent = `已加载 ${audit.records.length} 条审计记录。`;
    } else if (action === 'purge') {
      const result = await api('/api/admin/cache/purge', { method: 'POST', admin: true });
      status.textContent = `已清空 ${result.purged} 条缓存；后续相同查询将重新消耗预算。`;
    }
    await loadMe();
  } catch (error) {
    status.textContent = `操作失败：${error.message}`;
    showBanner(`运维操作失败：${error.message}`, 'danger');
  }
}

function fillPolicyForm(policy) {
  $('#policy-k').value = policy.k;
  $('#policy-eps').value = policy.perQueryEpsilon;
  $('#policy-cap').value = policy.perCallerEpsilonCap;
  $('#policy-repeat').value = policy.repeatLimit;
  $('#policy-ttl').value = Math.round(policy.cacheTtlMs / 60_000);
  $('#policy-comp').checked = policy.complementarySuppression;
  $('#policy-diff').checked = policy.differencingProtection;
  $('#policy-cohort').checked = policy.showCohortSize;
}

function renderAdminCallers(callers) {
  const body = $('#admin-callers tbody');
  clear(body);
  for (const caller of callers) {
    const row = el('tr');
    row.append(el('td', {}, `${caller.displayName}`, el('br'), el('span', { class: 'mono muted' }, caller.callerId)));
    row.append(
      el(
        'td',
        {},
        el(
          'span',
          { class: 'outcome-tag', dataset: { tone: caller.active ? 'ok' : 'danger' } },
          caller.active ? '启用' : '已撤销',
        ),
      ),
    );
    row.append(el('td', { class: 'num' }, fmtEpsilon(caller.spent)));
    const actions = el('td');
    const toggle = el(
      'button',
      {
        class: 'ghost small',
        type: 'button',
        onclick: () => toggleCaller(caller),
      },
      caller.active ? '撤销' : '恢复',
    );
    actions.append(toggle);
    row.append(actions);
    body.append(row);
  }
}

async function toggleCaller(caller) {
  try {
    const action = caller.active ? 'revoke' : 'restore';
    await api(`/api/admin/callers/${encodeURIComponent(caller.callerId)}/${action}`, {
      method: 'POST',
      admin: true,
    });
    await refreshAuthority();
    await runAdminAction('overview');
    showBanner(`已${action === 'revoke' ? '撤销' : '恢复'} ${caller.callerId} 的访问权限。`, action === 'revoke' ? 'warn' : 'ok');
  } catch (error) {
    showBanner(`操作失败：${error.message}`, 'danger');
  }
}

function renderChain(chain) {
  const box = $('#admin-audit-chain');
  box.dataset.tone = chain.ok ? 'ok' : 'danger';
  clear(box);
  if (chain.ok) {
    box.append(el('span', {}, `✓ 审计链完整，共 ${chain.checked} 条记录。`));
    box.append(el('div', { class: 'mono muted' }, `链头 ${chain.head.slice(0, 32)}…`));
  } else {
    box.append(el('span', {}, `✗ 审计链在第 ${chain.brokenAt} 条处被破坏。`));
    box.append(el('div', { class: 'hint' }, '记录可能被修改或删除，请立即排查。'));
  }
}

function renderAuditTable(records) {
  const body = $('#admin-audit tbody');
  clear(body);
  for (const record of records) {
    const row = el('tr');
    row.append(el('td', { class: 'num' }, record.seq));
    row.append(el('td', { class: 'nowrap' }, fmtTime(record.at)));
    row.append(el('td', {}, record.action));
    row.append(
      el(
        'td',
        {},
        el('span', { class: 'outcome-tag', dataset: { tone: outcomeTone(record.outcome) } }, record.outcome),
      ),
    );
    body.append(row);
  }
}

function renderLedgerTable(entries) {
  const body = $('#admin-ledger tbody');
  clear(body);
  for (const entry of entries) {
    const row = el('tr');
    row.append(el('td', { class: 'mono' }, entry.callerId));
    row.append(el('td', { class: 'num' }, fmtEpsilon(entry.epsilon)));
    row.append(el('td', {}, entry.status));
    row.append(el('td', { class: 'mono' }, entry.outcomeCode));
    body.append(row);
  }
}

function renderAdminCache(cache) {
  const node = $('#admin-cache-stats');
  if (node) node.textContent = `${cache.total} 条，已过期 ${cache.expired} 条，累计命中 ${cache.hits} 次`;
}

async function savePolicy(event) {
  event.preventDefault();
  try {
    const patch = {
      k: Number($('#policy-k').value),
      perQueryEpsilon: Number($('#policy-eps').value),
      perCallerEpsilonCap: Number($('#policy-cap').value),
      repeatLimit: Number($('#policy-repeat').value),
      cacheTtlMs: Number($('#policy-ttl').value) * 60_000,
      complementarySuppression: $('#policy-comp').checked,
      differencingProtection: $('#policy-diff').checked,
      showCohortSize: $('#policy-cohort').checked,
    };
    const result = await api('/api/admin/policy', { method: 'POST', body: patch, admin: true });
    state.meta.policy = result.policy;
    renderPolicyStrip();
    await runAdminAction('overview');
    showBanner(
      `策略已更新到 v${result.policy.version}，${result.cacheEntriesInvalidated} 条缓存已失效。`,
      'ok',
    );
    await loadMe();
  } catch (error) {
    showBanner(`策略保存失败：${error.message}`, 'danger');
  }
}

boot();
