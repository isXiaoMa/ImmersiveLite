/**
 * Options 设置页交互逻辑
 * 职责：
 * 1. 从 background 读取设置并回填表单
 * 2. 表单变更即暂存，点击"保存设置"统一写入
 * 3. 每个大模型配置卡片可独立测试该服务是否接入成功
 */

/** 从表单收集到的最新设置（未保存前的缓存） */
let draft = null;

/**
 * 填充语言/服务下拉框（服务下拉含各已配置大模型）
 */
function fillSelects() {
  const from = document.getElementById('fromLang');
  const to = document.getElementById('toLang');
  const svc = document.getElementById('service');
  from.innerHTML = IT_LANGUAGES.map(l =>
    `<option value="${l.code}" ${l.code === draft.from ? 'selected' : ''}>${l.name}</option>`).join('');
  to.innerHTML = IT_LANGUAGES.filter(l => l.code !== 'auto').map(l =>
    `<option value="${l.code}" ${l.code === draft.to ? 'selected' : ''}>${l.name}</option>`).join('');
  const llmOpts = (draft.llmConfigs || []).map(c =>
    `<option value="llm:${c.id}" ${'llm:' + c.id === draft.service ? 'selected' : ''}>${c.name}</option>`).join('');
  svc.innerHTML = IT_SERVICES.map(s =>
    `<option value="${s.id}" ${s.id === draft.service ? 'selected' : ''}>${s.name}</option>`).join('') + llmOpts;
}

/**
 * 渲染大模型配置卡片列表（每个配置独立编辑，服务下拉按其名称展示）
 */
function renderLlmList() {
  const list = document.getElementById('llmList');
  list.innerHTML = '';
  (draft.llmConfigs || []).forEach((cfg, idx) => {
    const card = document.createElement('div');
    card.className = 'llm-card';
    card.innerHTML = `
      <div class="llm-card-head">
        <input class="llm-name" type="text" value="${cfg.name}" placeholder="服务名称（如 GPT-5.2）" />
        <button class="llm-del" type="button" title="删除此配置">✕</button>
      </div>
      <div class="llm-grid">
        <input class="llm-baseurl" type="text" value="${cfg.baseUrl}" placeholder="API 地址 https://api.openai.com/v1" />
        <input class="llm-apikey" type="password" value="${cfg.apiKey}" placeholder="API Key（sk-...）" />
        <input class="llm-model" type="text" value="${cfg.model}" placeholder="模型名（gpt-5.2）" />
      </div>
      <div class="llm-card-foot">
        <button class="llm-test" type="button">测试此模型</button>
        <span class="llm-test-result"></span>
      </div>`;
    card.querySelector('.llm-name').addEventListener('input', (e) => { draft.llmConfigs[idx].name = e.target.value; });
    card.querySelector('.llm-baseurl').addEventListener('input', (e) => { draft.llmConfigs[idx].baseUrl = e.target.value.trim(); });
    card.querySelector('.llm-apikey').addEventListener('input', (e) => { draft.llmConfigs[idx].apiKey = e.target.value.trim(); });
    card.querySelector('.llm-model').addEventListener('input', (e) => { draft.llmConfigs[idx].model = e.target.value.trim(); });
    card.querySelector('.llm-test').addEventListener('click', () => runLlmTest(idx, card));
    card.querySelector('.llm-del').addEventListener('click', () => {
      // 预置模板删除后记录 id，防止 getSettings 合并默认模板时复活
      if (!/^custom-/.test(cfg.id)) {
        if (!Array.isArray(draft.deletedLlm)) draft.deletedLlm = [];
        if (!draft.deletedLlm.includes(cfg.id)) draft.deletedLlm.push(cfg.id);
      }
      draft.llmConfigs.splice(idx, 1);
      if (draft.service === 'llm:' + cfg.id) draft.service = 'free';
      renderLlmList();
      fillSelects();
    });
    list.appendChild(card);
  });
}

/**
 * 新增一个大模型配置（默认 OpenAI 模板，可改）
 */
function addLlmConfig() {
  if (!Array.isArray(draft.llmConfigs)) draft.llmConfigs = [];
  const id = 'custom-' + Date.now().toString(36);
  draft.llmConfigs.push({ id, name: '新模型', baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-5.2' });
  renderLlmList();
}

/**
 * 将设置回填到全部表单控件
 */
function fillForm() {
  fillSelects();
  renderLlmList();
  document.getElementById('displayMode').value = draft.display === 'single' ? 'single' : 'dual';
  document.getElementById('showFloatBall').checked = draft.showFloatBall !== false;
  document.getElementById('selectionTranslate').checked = draft.selectionTranslate !== false;
  document.getElementById('baiduAppid').value = draft.baidu.appid || '';
  document.getElementById('baiduKey').value = draft.baidu.key || '';
  document.getElementById('openaiPrompt').value =
    (draft.openai && draft.openai.prompt) || '';
  document.getElementById('styleColor').value = draft.style.color || '#6a5cff';
  document.getElementById('styleFollowColor').checked =
    draft.style.followColor !== false; // 默认跟随原文颜色
  syncColorDisabled();
  document.getElementById('styleBold').checked = !!draft.style.bold;
  document.getElementById('styleFontSize').value = draft.style.fontSize || 'inherit';
}

/**
 * 同步颜色选择器的禁用状态（勾选"跟随原文"时禁用）
 */
function syncColorDisabled() {
  const follow = document.getElementById('styleFollowColor').checked;
  document.getElementById('styleColor').disabled = follow;
}

/**
 * 从表单控件收集设置到 draft
 */
function collectForm() {
  draft.from = document.getElementById('fromLang').value;
  draft.to = document.getElementById('toLang').value;
  draft.service = document.getElementById('service').value;
  draft.display = document.getElementById('displayMode').value;
  draft.showFloatBall = document.getElementById('showFloatBall').checked;
  draft.selectionTranslate = document.getElementById('selectionTranslate').checked;
  draft.baidu = {
    appid: document.getElementById('baiduAppid').value.trim(),
    key: document.getElementById('baiduKey').value.trim()
  };
  // llmConfigs 由各卡片输入框实时写入 draft，此处仅需保证结构存在
  if (!Array.isArray(draft.llmConfigs)) draft.llmConfigs = [];
  draft.openai = {
    prompt: document.getElementById('openaiPrompt').value.trim()
  };
  draft.style = {
    color: document.getElementById('styleColor').value,
    followColor: document.getElementById('styleFollowColor').checked,
    bold: document.getElementById('styleBold').checked,
    fontSize: document.getElementById('styleFontSize').value
  };
}

/**
 * 保存 draft 到 storage（通过 background 落盘）
 */
async function saveDraft() {
  collectForm();
  const resp = await chrome.runtime.sendMessage({
    type: 'SAVE_SETTINGS', settings: draft
  });
  const tip = document.getElementById('saveTip');
  if (resp && resp.ok) {
    tip.textContent = '✓ 已保存';
    setTimeout(() => (tip.textContent = ''), 2000);
  } else {
    tip.textContent = '保存失败，请重试';
  }
}

/**
 * 测试指定的大模型配置：仅用该模型翻译一句英文并展示结果
 * 通过 overrideService 指定服务，不改变全局"默认翻译服务"设置
 * @param {number} idx 配置在 llmConfigs 中的下标
 * @param {HTMLElement} card 对应的卡片元素（用于展示结果）
 */
async function runLlmTest(idx, card) {
  collectForm();
  // 临时把 draft 保存后测试，保证测试的是表单当前填写的内容
  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: draft });
  const cfg = draft.llmConfigs[idx];
  const btn = card.querySelector('.llm-test');
  const out = card.querySelector('.llm-test-result');
  btn.disabled = true;
  out.className = 'llm-test-result';
  out.textContent = '测试中…';
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'TRANSLATE_BATCH',
      texts: ['Hello! This is a translation test for the immersive translate extension.'],
      from: 'auto',
      to: draft.to,
      overrideService: 'llm:' + cfg.id
    });
    if (resp && resp.ok) {
      out.className = 'llm-test-result ok';
      out.textContent = '✓ ' + resp.translations[0];
    } else {
      out.className = 'llm-test-result error';
      out.textContent = '✗ ' + (resp && resp.error ? resp.error : '未知错误');
    }
  } catch (err) {
    out.className = 'llm-test-result error';
    out.textContent = '✗ ' + (err.message || err);
  } finally {
    btn.disabled = false;
  }
}

/**
 * 初始化：加载设置、绑定事件、导航高亮
 */
async function init() {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  draft = resp && resp.settings ? resp.settings : {};

  // 美化：将全部原生 select 替换为自绘下拉（值仍读写原 select）
  mountAllDropdowns();

  fillForm();

  document.getElementById('saveBtn').addEventListener('click', saveDraft);
  document.getElementById('addLlmBtn').addEventListener('click', addLlmConfig);

  // "跟随原文颜色"勾选联动：禁用/启用颜色选择器
  document.getElementById('styleFollowColor').addEventListener('change', syncColorDisabled);

  // 侧边导航：点击高亮 + 平滑滚动
  document.querySelectorAll('.sidebar nav a').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('.sidebar nav a').forEach(x => x.classList.remove('active'));
      a.classList.add('active');
      document.querySelector(a.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth' });
    });
  });

  // 滚动联动：视口顶部的分区对应的导航项自动高亮
  const navLinks = [...document.querySelectorAll('.sidebar nav a')];
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const link = navLinks.find(a => a.getAttribute('href') === '#' + en.target.id);
      if (link) {
        navLinks.forEach(x => x.classList.remove('active'));
        link.classList.add('active');
      }
    }
  }, { rootMargin: '-15% 0px -75% 0px' });
  document.querySelectorAll('main .card[id]').forEach(s => io.observe(s));
}

init();
