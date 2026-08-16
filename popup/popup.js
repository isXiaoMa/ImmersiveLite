/**
 * Popup 交互逻辑
 * 职责：
 * 1. 渲染语言 / 服务下拉框并回显当前设置
 * 2. 翻译开关按钮：向当前页面 content script 发送切换指令
 * 3. 设置变更即时保存，并通知页面重新翻译
 */

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
 * 渲染全部下拉框（语言 + 服务 + 显示模式）
 * 服务下拉 = 基础服务 + 大模型配置（GPT-5.2 / DeepSeek 等，按名称展示）
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
  document.getElementById("displayMode").value =
    settings.display === "single" ? "single" : "dual";
  document.getElementById("showFloatBall").checked =
    settings.showFloatBall !== false;
  document.getElementById("selectionTranslate").checked =
    settings.selectionTranslate !== false;
  renderServiceHint();
}

/**
 * 根据当前服务显示配置提示（百度 / 大模型未配置时提醒）
 */
function renderServiceHint() {
  const hint = document.getElementById("serviceHint");
  if (
    settings.service === "baidu" &&
    !(settings.baidu && settings.baidu.appid)
  ) {
    hint.textContent = "百度翻译尚未配置，请点击右上角 ⚙ 填写 appid 与密钥";
  } else if (settings.service && settings.service.startsWith("llm:")) {
    const cfg = (settings.llmConfigs || []).find(
      (c) => "llm:" + c.id === settings.service,
    );
    hint.textContent =
      cfg && !cfg.apiKey
        ? `${cfg.name} 尚未配置 API Key，请点击右上角 ⚙ 填写`
        : "";
  } else {
    hint.textContent = "";
  }
}

/**
 * 保存设置并通知当前页面（若已翻译则自动重译）
 */
async function persistSettings() {
  const resp = await chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    settings,
  });
  if (resp && resp.ok) {
    renderServiceHint();
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab && tab.id != null) {
      chrome.tabs
        .sendMessage(tab.id, { type: "SETTINGS_CHANGED" })
        .catch(() => {});
    }
  }
}

/**
 * 获取当前激活标签页
 * @returns {Promise<chrome.tabs.Tab|null>} 标签页对象
 */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

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
  } catch (e) {
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
    // 带迷你转圈的进度反馈
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
 * 初始化：加载设置、绑定事件
 */
async function init() {
  const resp = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  settings = resp && resp.settings ? resp.settings : {};
  renderSelects();
  // 美化：将全部原生 select 替换为自绘下拉（值仍读写原 select）
  mountAllDropdowns();
  refreshStatus();
  // 打开期间每秒轮询一次页面翻译进度
  setInterval(refreshStatus, 1000);

  document.getElementById("toggleBtn").addEventListener("click", async () => {
    const tab = await getActiveTab();
    if (!tab || tab.id == null) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_TRANSLATION" });
    } catch (e) {
      // ignore
    }
    refreshStatus();
  });

  document.getElementById("fromLang").addEventListener("change", async (e) => {
    settings.from = e.target.value;
    await persistSettings();
  });

  document.getElementById("toLang").addEventListener("change", async (e) => {
    settings.to = e.target.value;
    await persistSettings();
  });

  // 交换源/目标语言（auto 不能作为目标语言，自动改为中文）
  document.getElementById("swapLangs").addEventListener("click", async () => {
    const from = settings.from;
    settings.from = settings.to;
    settings.to = from === "auto" ? "zh-CN" : from;
    renderSelects();
    await persistSettings();
  });

  document.getElementById("service").addEventListener("change", async (e) => {
    settings.service = e.target.value;
    await persistSettings();
  });

  // 显示模式切换：双语 / 仅译文（切换后已翻译页面自动重译）
  document
    .getElementById("displayMode")
    .addEventListener("change", async (e) => {
      settings.display = e.target.value;
      await persistSettings();
    });

  // 悬浮球开关：即时生效
  document
    .getElementById("showFloatBall")
    .addEventListener("change", async (e) => {
      settings.showFloatBall = e.target.checked;
      await persistSettings();
    });

  // 划词翻译开关：即时生效
  document
    .getElementById("selectionTranslate")
    .addEventListener("change", async (e) => {
      settings.selectionTranslate = e.target.checked;
      await persistSettings();
    });

  document.getElementById("openOptions").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  // 打开侧边栏面板（Chrome 116+ 需在用户手势内调用 sidePanel.open）
  document.getElementById("openSidePanel").addEventListener("click", async () => {
    const tab = await getActiveTab();
    if (tab && tab.id != null) {
      chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
    }
  });
}

init();
