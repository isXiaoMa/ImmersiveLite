/**
 * 侧边栏面板交互逻辑（自研，功能形态对齐原版 side-panel）
 * 职责：
 * 1. 当前页面翻译控制（与 popup 同协议：TOGGLE_TRANSLATION / GET_STATUS）
 * 2. 文本翻译工具：长文本自动分块（≤2000 字符）逐块翻译拼接，
 *    语言选择仅侧边栏内生效（随消息传递，不落盘、不打扰页面翻译状态）
 * 3. 服务选择共用全局设置（GET_SETTINGS / SAVE_SETTINGS）
 */

/** 单块翻译请求的字符上限（与 background 分批阈值一致，避免单请求超限） */
const CHUNK_LIMIT = 2000;

/** 当前设置缓存 */
let settings = null;

/**
 * 下拉框填充选项
 * @param {HTMLSelectElement} select 下拉框元素
 * @param {Array} options 选项数组 [{code|id, name}]
 * @param {string} value 当前选中值
 */
function fillSelect(select, options, value) {
  select.innerHTML = "";
  for (const opt of options) {
    const el = document.createElement("option");
    el.value = opt.code ?? opt.id;
    el.textContent = opt.name;
    el.selected = el.value === value;
    select.appendChild(el);
  }
}

/**
 * 渲染语言 / 服务下拉框（初始值取全局设置）
 */
function renderSelects() {
  fillSelect(document.getElementById("fromLang"), IT_LANGUAGES, settings.from);
  fillSelect(
    document.getElementById("toLang"),
    IT_LANGUAGES.filter((l) => l.code !== "auto"),
    settings.to,
  );
  const llmOptions = (settings.llmConfigs || []).map((c) => ({
    id: "llm:" + c.id,
    name: c.name + (c.apiKey ? "" : "（未配置）"),
  }));
  fillSelect(
    document.getElementById("service"),
    [...IT_SERVICES, ...llmOptions],
    settings.service,
  );
}

/**
 * 获取当前激活标签页
 * @returns {Promise<chrome.tabs.Tab|null>} 标签页对象
 */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/* ==================== 区块一：页面翻译控制 ==================== */

/**
 * 查询页面翻译状态并更新按钮文案
 */
async function refreshStatus() {
  const statusBar = document.getElementById("statusBar");
  const btn = document.getElementById("toggleBtn");
  const tab = await getActiveTab();
  if (!tab || tab.id == null) return;
  let status = null;
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "GET_STATUS" });
    if (resp && resp.ok) status = resp;
  } catch {
    statusBar.textContent = "当前页面不支持翻译";
    statusBar.className = "status-bar error";
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  if (!status) return;
  if (status.translating) {
    btn.textContent = "翻译中…";
    btn.classList.add("restore");
    statusBar.className = "status-bar";
    statusBar.innerHTML =
      '<span class="mini-spinner"></span>进度：' +
      `${status.done} / ${status.total} 段`;
  } else if (status.translated) {
    btn.textContent = "还原原文";
    btn.classList.add("restore");
    statusBar.className = "status-bar";
    statusBar.textContent = status.error
      ? `部分失败：${status.error}`
      : "本页已翻译";
  } else {
    btn.textContent = "翻译网页";
    btn.classList.remove("restore");
    statusBar.className = "status-bar";
    statusBar.textContent = status.error ? `失败：${status.error}` : "";
  }
}

/**
 * 绑定页面翻译开关（与 popup 相同消息协议）
 */
function bindPageControls() {
  document.getElementById("toggleBtn").addEventListener("click", async () => {
    const tab = await getActiveTab();
    if (!tab || tab.id == null) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_TRANSLATION" });
    } catch {
      // ignore
    }
    refreshStatus();
  });
  document.getElementById("openOptions").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
}

/* ==================== 区块二：文本翻译工具 ==================== */

/**
 * 将长文本按段落边界分块（段落间双换行拼接，超限段落硬切）
 * @param {string} text 原始文本
 * @returns {string[]} 分块数组（每块 ≤ CHUNK_LIMIT 字符）
 */
function splitChunks(text) {
  const paras = String(text).split(/\n{2,}/);
  const chunks = [];
  let buf = "";
  for (const p of paras) {
    // 单段落自身超限：按行/硬边界继续切
    if (p.length > CHUNK_LIMIT) {
      if (buf) {
        chunks.push(buf);
        buf = "";
      }
      for (let i = 0; i < p.length; i += CHUNK_LIMIT) {
        chunks.push(p.slice(i, i + CHUNK_LIMIT));
      }
      continue;
    }
    if ((buf + (buf ? "\n\n" : "") + p).length > CHUNK_LIMIT) {
      if (buf) chunks.push(buf);
      buf = p;
    } else {
      buf += (buf ? "\n\n" : "") + p;
    }
  }
  if (buf) chunks.push(buf);
  return chunks.length ? chunks : [""];
}

/**
 * 执行文本翻译：分块 → 逐块请求 → 按序拼接展示
 * 语言方向取侧边栏下拉当前值（不落盘），服务取全局设置
 */
async function translateInput() {
  const text = document.getElementById("inputText").value.trim();
  if (!text) return;
  const btn = document.getElementById("translateBtn");
  const spinner = document.getElementById("transSpinner");
  const resultWrap = document.getElementById("resultWrap");
  const resultText = document.getElementById("resultText");
  btn.disabled = true;
  spinner.classList.remove("hidden");
  try {
    const from = document.getElementById("fromLang").value;
    const to = document.getElementById("toLang").value;
    const parts = [];
    for (const chunk of splitChunks(text)) {
      const resp = await chrome.runtime.sendMessage({
        type: "TRANSLATE_BATCH",
        texts: [chunk],
        from,
        to,
      });
      if (!resp || !resp.ok) throw new Error(resp && resp.error);
      parts.push(resp.translations[0] || "");
    }
    resultText.textContent = parts.join("\n\n");
    resultWrap.classList.remove("hidden");
  } catch (e) {
    resultText.textContent = "翻译失败：" + (e && e.message ? e.message : e);
    resultWrap.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    spinner.classList.add("hidden");
  }
}

/**
 * 绑定文本翻译区交互：翻译按钮 / Ctrl+Enter / 交换语言 / 复制 / 清空
 */
function bindTextControls() {
  document
    .getElementById("translateBtn")
    .addEventListener("click", translateInput);
  document
    .getElementById("inputText")
    .addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        translateInput();
      }
    });
  document.getElementById("swapLangs").addEventListener("click", () => {
    const fromSel = document.getElementById("fromLang");
    const toSel = document.getElementById("toLang");
    const from = fromSel.value;
    // auto 不能作为目标语言，交换后落在中文
    fromSel.value = toSel.value;
    toSel.value = from === "auto" ? "zh-CN" : from;
  });
  document.getElementById("copyResult").addEventListener("click", async () => {
    const text = document.getElementById("resultText").textContent;
    try {
      await navigator.clipboard.writeText(text);
      const btn = document.getElementById("copyResult");
      btn.textContent = "已复制";
      setTimeout(() => (btn.textContent = "复制"), 1200);
    } catch {
      // 剪贴板权限失败静默
    }
  });
  document.getElementById("clearAll").addEventListener("click", () => {
    document.getElementById("inputText").value = "";
    document.getElementById("resultWrap").classList.add("hidden");
  });
}

/* ==================== 初始化 ==================== */

/**
 * 初始化：加载设置、渲染下拉、绑定事件、启动状态轮询
 */
async function init() {
  const resp = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  settings = resp && resp.settings ? resp.settings : {};
  renderSelects();
  // 美化：将全部原生 select 替换为自绘下拉（值仍读写原 select）
  mountAllDropdowns();
  bindPageControls();
  bindTextControls();
  refreshStatus();
  setInterval(refreshStatus, 1000);
}

init();
