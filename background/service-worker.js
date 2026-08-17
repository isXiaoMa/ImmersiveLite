/**
 * Background Service Worker
 * 职责：
 * 1. 接收 content script / popup / options 的消息并路由
 * 2. 代理所有翻译 API 请求（避免页面 CORS 限制）
 * 3. 处理快捷键（Alt+Q）转发翻译开关命令
 */

// Chrome MV3 Service Worker：同步加载依赖脚本；
// Firefox 后台页面无 importScripts（由 manifest 的 scripts 列表按序加载），需条件保护
if (typeof importScripts === "function") {
  importScripts("../utils/languages.js", "../utils/md5.js");
}

/** 存储设置所用的 key */
const SETTINGS_KEY = "it_settings";

/** 历史版本的默认提示词（读取设置时自动升级到最新版，用户自定义过的不受影响） */
const LEGACY_PROMPTS = [
  "你是一位专业的翻译引擎。请将用户提供的 JSON 数组中的每段文本由{from}翻译为{to}，保持原文的语气与格式，不要添加任何解释。仅输出与输入等长的 JSON 字符串数组，不要输出其他内容。",
  "你是一位专业翻译引擎。请将输入 JSON 数组中第 i 段文本由{from}翻译为{to}，作为输出数组的第 i 段，逐条对应、不得合并或遗漏。直接给出翻译结果，不要输出思考、分析或解释。输出仅为一个 JSON 字符串数组，与输入等长：元素必须为字符串，保留原文的换行与 markdown 格式，禁止输出代码块标记或其他任何文字。",
];

/** 默认设置（首次安装时使用） */
const DEFAULT_SETTINGS = {
  from: "auto", // 源语言（auto 为自动检测）
  to: "zh-CN", // 目标语言
  service: "free", // 当前翻译服务：free | google | baidu | llm:<id>
  display: "dual", // 显示模式：dual 双语对照 | single 仅译文
  showFloatBall: true, // 是否显示页面悬浮球
  selectionTranslate: true, // 是否开启划词翻译
  baidu: { appid: "", key: "" },
  // 大模型服务配置列表（默认为空，用户在设置页自行添加）
  // baseUrl 填根地址即可；Coze 使用原生 /v3/chat 协议，model 字段填 Bot ID
  llmConfigs: [],
  // 历史字段：用户主动删除的预置大模型 id（旧版"预置模板自动补齐"的防复活记录）
  // 当前合并逻辑已移除，但保留默认定义——旧配置中的残留值经 getSettings→draft→saveDraft
  // 链路存活，若未来恢复自动补齐逻辑，缺失默认值会使未删过模型的用户遇到 undefined
  deletedLlm: [],
  // 全局共用的大模型翻译提示词（各 llm 配置共享）
  openai: {
    prompt:
      "你是一位专业翻译引擎。请将输入 JSON 数组中第 i 段文本由{from}完整翻译为{to}，作为输出数组的第 i 段，逐条对应、不得合并或遗漏。必须翻译每一段的全部内容：不得只翻译前半部分而原样保留后面的原文句子，遇到长文本也要逐句翻完。直接给出翻译结果，不要输出思考、分析或解释。输出仅为一个 JSON 字符串数组，与输入等长：元素必须为字符串，保留原文的换行与 markdown 格式，禁止输出代码块标记或其他任何文字。",
  },
  style: { color: "", followColor: true, bold: false, fontSize: "inherit" },
};

/**
 * 读取设置（合并默认值 + 旧版单一大模型配置迁移）
 * @returns {Promise<Object>} 完整设置对象
 */
async function getSettings() {
  const data = await chrome.storage.sync.get(SETTINGS_KEY);
  const saved = data[SETTINGS_KEY] || {};
  const settings = { ...DEFAULT_SETTINGS, ...saved };
  if (!Array.isArray(settings.llmConfigs)) settings.llmConfigs = [];

  // 迁移旧版 openai 单配置（baseUrl/apiKey/model）到 llmConfigs 首个配置项
  if (saved.openai && saved.openai.apiKey) {
    const gpt = (settings.llmConfigs || []).find((c) => c.id === "gpt");
    if (gpt && !gpt.apiKey) {
      gpt.apiKey = saved.openai.apiKey;
      if (saved.openai.baseUrl) gpt.baseUrl = saved.openai.baseUrl;
      if (saved.openai.model) gpt.model = saved.openai.model;
    }
    // 旧服务标识 openai → llm:gpt
    if (settings.service === "openai") settings.service = "llm:gpt";
  }

  // 历史默认提示词自动升级（用户自定义过的提示词不迁移）
  if (settings.openai && LEGACY_PROMPTS.includes(settings.openai.prompt)) {
    settings.openai.prompt = DEFAULT_SETTINGS.openai.prompt;
  }
  return settings;
}

/**
 * 保存设置
 * @param {Object} settings 完整设置对象
 */
async function saveSettings(settings) {
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
}

/**
 * 消息路由入口
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "GET_SETTINGS":
          sendResponse({ ok: true, settings: await getSettings() });
          break;
        case "SAVE_SETTINGS":
          await saveSettings(message.settings);
          // 目标语言可能变化，同步刷新右键菜单标题
          updateContextMenuTitle();
          sendResponse({ ok: true });
          break;
        case "STATUS_NOTIFY":
          // 页面翻译状态变化（翻译完成/还原）：刷新右键菜单标题
          updateContextMenuTitle();
          sendResponse({ ok: true });
          break;
        case "TRANSLATE_BATCH": {
          const settings = await getSettings();
          // overrideService：临时指定要用的服务（如卡片级测试），不落盘
          if (message.overrideService)
            settings.service = message.overrideService;
          const translations = await translateTexts(
            message.texts,
            message.from,
            message.to,
            settings,
          );
          sendResponse({ ok: true, translations });
          break;
        }
        default:
          sendResponse({ ok: false, error: "未知消息类型：" + message.type });
      }
    } catch (err) {
      sendResponse({
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  })();
  return true; // 保持消息通道开放以支持异步回复
});

/**
 * 快捷键：切换当前页面的翻译状态
 */
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-translation") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_TRANSLATION" });
    } catch (e) {
      // 页面未注入 content script（如浏览器内置页面）时忽略
    }
  }
});

// ---------------------------------------------------------------------------
// 右键菜单
// ---------------------------------------------------------------------------

// SW 每次启动时重建菜单（先清后建保证幂等）。
// 双重防御：create 的重复 id 错误是同步抛出，用 try/catch 兜底；
// 其余异步错误通过回调显式消费 lastError，避免 Unchecked 报错。
chrome.contextMenus.removeAll(() => {
  try {
    chrome.contextMenus.create(
      { id: "it-toggle-page", title: "翻译网页", contexts: ["page"] },
      () => void chrome.runtime.lastError,
    );
    chrome.contextMenus.create(
      {
        id: "it-translate-selection",
        title: "翻译选中文本",
        contexts: ["selection"],
      },
      () => void chrome.runtime.lastError,
    );
  } catch (e) {
    // 菜单已存在等偶发竞态：忽略，已有菜单功能不受影响
  }
  updateContextMenuTitle();
});

/**
 * 更新右键菜单"翻译网页"项的标题：
 * 未翻译 → "翻译为<目标语言>"（如"翻译为简体中文"）；已翻译/翻译中 → "显示原文"
 * Chrome 无 onShown API，采用事件驱动：安装/切页/页面加载/状态变化/改设置时刷新
 * @param {number|null} tabId 标签页 id（空则自动查询当前活跃页）
 */
async function updateContextMenuTitle(tabId) {
  let translated = false;
  try {
    if (tabId == null) {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      tabId = tab && tab.id;
    }
    if (tabId != null) {
      const resp = await chrome.tabs.sendMessage(tabId, {
        type: "GET_STATUS",
      });
      if (resp && resp.ok) translated = !!(resp.translated || resp.translating);
    }
  } catch (e) {
    // 页面无 content script（浏览器内置页等）：按未翻译处理
  }
  let langName = "";
  try {
    const settings = await getSettings();
    langName = LANG_NAMES[settings.to] || settings.to;
  } catch (e) {
    /* 设置读取失败则退回通用标题 */
  }
  const title = translated
    ? "显示原文"
    : langName
      ? `翻译为${langName}`
      : "翻译网页";
  try {
    chrome.contextMenus.update("it-toggle-page", { title });
  } catch (e) {
    /* 菜单尚未注册时忽略 */
  }
}

// 切换标签页时按新页面状态刷新菜单标题
chrome.tabs.onActivated.addListener(({ tabId }) =>
  updateContextMenuTitle(tabId),
);

// 页面加载完成（含刷新/跳转）时刷新菜单标题（状态已重置为未翻译）
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete") return;
  chrome.tabs
    .query({ active: true, currentWindow: true })
    .then(([tab]) => {
      if (tab && tab.id === tabId) updateContextMenuTitle(tabId);
    })
    .catch(() => {});
});

// 切换浏览器窗口时刷新菜单标题
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) updateContextMenuTitle();
});

// 右键菜单点击：转发指令到当前页面
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || tab.id == null) return;
  const type =
    info.menuItemId === "it-toggle-page"
      ? "TOGGLE_TRANSLATION"
      : info.menuItemId === "it-translate-selection"
        ? "TRANSLATE_SELECTION"
        : null;
  if (!type) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type });
    // 点击后状态翻转，同步刷新菜单标题
    updateContextMenuTitle(tab.id);
  } catch (e) {
    // 页面未注入 content script（如浏览器内置页面）时忽略
  }
});

// ---------------------------------------------------------------------------
// 翻译服务实现
// ---------------------------------------------------------------------------

/**
 * 翻译入口：根据设置选择服务并分发（先查缓存，未命中再请求并写缓存）
 * @param {string[]} texts 待翻译文本数组
 * @param {string} from 源语言代码
 * @param {string} to 目标语言代码
 * @param {Object} settings 插件设置
 * @returns {Promise<string[]>} 与 texts 等长的译文数组
 */
async function translateTexts(texts, from, to, settings) {
  const results = new Array(texts.length);
  const missIdx = []; // 未命中缓存的索引

  // 1. 查缓存（缓存键含服务标识，切换服务不会串缓存）；
  //    同语言文本直接返回原文不占缓存位（逆向自原版 dp 的 Di(源,目标) 比较，
  //    原版逐段做完整语言检测，这里用高置信启发式：目标为中文系时纯 CJK 文本跳过）
  const zhTarget = /^zh/.test(to);
  texts.forEach((t, i) => {
    if (
      zhTarget &&
      /^[\s\u3000\uff01-\uff5e\u4e00-\u9fff\u3001\u3002]+$/.test(t)
    ) {
      results[i] = t;
      return;
    }
    const hit = cacheGet(cacheKey(settings.service, from, to, t));
    if (hit !== undefined) results[i] = hit;
    else missIdx.push(i);
  });

  // 2. 未命中的部分发起真实请求
  if (missIdx.length) {
    const missTexts = missIdx.map((i) => texts[i]);
    const service = settings.service;
    /** 按当前服务分发一批文本（供首轮与修复轮复用） */
    const dispatch = async (arr) => {
      if (service === "baidu") {
        return translateBaidu(arr, from, to, settings.baidu);
      }
      if (service.startsWith("llm:")) {
        // 大模型服务：llm:<id> 路由到对应配置（prompt 全局共用）
        const cfg = (settings.llmConfigs || []).find(
          (c) => c.id === service.slice(4),
        );
        if (!cfg) throw new Error("大模型配置不存在，请到设置页检查");
        if (!cfg.apiKey)
          throw new Error(`${cfg.name} 尚未配置 API Key，请到设置页填写`);
        const prompt =
          (settings.openai && settings.openai.prompt) ||
          DEFAULT_SETTINGS.openai.prompt;
        if (cfg.id === "coze" || /coze\./.test(cfg.baseUrl || "")) {
          // Coze 原生 /v3/chat 协议（model 字段为 Bot ID）
          return translateCoze(arr, from, to, { ...cfg, prompt });
        }
        return translateOpenAI(arr, from, to, { ...cfg, prompt });
      }
      if (service === "free") return translateFree(arr, from, to);
      // google 及其他默认走谷歌
      return translateGoogle(arr, from, to);
    };

    let translated = await dispatch(missTexts);

    // 3. 部分翻译检测与修复（大模型偶发"只翻前半段，后半原样返回"，
    //    条数校验拦不住）：同服务重试一轮 → 仍异常用谷歌兜底
    const badK = [];
    translated.forEach((tr, k) => {
      if (looksPartiallyTranslated(missTexts[k], tr, to)) badK.push(k);
    });
    if (badK.length) {
      const retryTexts = badK.map((k) => missTexts[k]);
      let repaired = null;
      try {
        repaired = await dispatch(retryTexts);
      } catch {
        // 重试失败保留原结果，继续尝试谷歌兜底
      }
      if (repaired) {
        const stillBad = [];
        repaired.forEach((tr, j) => {
          if (looksPartiallyTranslated(retryTexts[j], tr, to)) stillBad.push(j);
        });
        if (stillBad.length && service !== "google") {
          try {
            const g = await translateGoogle(
              stillBad.map((j) => retryTexts[j]),
              from,
              to,
            );
            stillBad.forEach((j, n) => {
              repaired[j] = g[n];
            });
          } catch {
            // 谷歌兜底失败保留重试结果
          }
        }
        badK.forEach((k, j) => {
          translated[k] = repaired[j];
        });
      }
    }

    missIdx.forEach((idx, k) => {
      results[idx] = translated[k];
      cacheSet(cacheKey(settings.service, from, to, texts[idx]), translated[k]);
    });
  }
  return results;
}

/**
 * 部分翻译检测：目标为中文且原文以拉丁字母为主时，
 * 若译文中仍按原样保留过半的原文单词，判定为未翻全
 * （如大模型只翻第一句、其余英文原样返回的场景）
 * @param {string} src 原文
 * @param {string} dst 译文
 * @param {string} to 目标语言代码
 * @returns {boolean} 是否疑似部分翻译
 */
function looksPartiallyTranslated(src, dst, to) {
  if (!/^zh/.test(to)) return false;
  if (!src || !dst || typeof dst !== "string") return false;
  const letters = src.match(/[A-Za-z]/g) || [];
  // 原文拉丁字母占比过半才检测（纯 CJK/混合文本不适用此启发式）
  if (letters.length < src.replace(/\s/g, "").length * 0.5) return false;
  const words = src.toLowerCase().match(/[a-z][a-z'-]+/g) || [];
  if (words.length < 8) return false; // 词太少不足以下结论
  const d = " " + dst.toLowerCase().replace(/[^a-z0-9'-]+/g, " ") + " ";
  let hits = 0;
  for (const w of words) {
    if (d.includes(" " + w + " ")) hits++;
  }
  // 过半原文单词原样残留 → 部分翻译
  return hits / words.length >= 0.5;
}

// ---------------------------------------------------------------------------
// 翻译结果缓存（会话级内存缓存：service worker 存活期间有效）
// ---------------------------------------------------------------------------

/** 缓存存储 */
const translationCache = new Map();
/** 缓存最大条目数（超出后淘汰最早条目） */
const CACHE_MAX = 800;

/**
 * 生成缓存键（服务+语言+文本 唯一确定一条译文）
 * @param {string} service 服务标识
 * @param {string} from 源语言
 * @param {string} to 目标语言
 * @param {string} text 原文
 * @returns {string} 缓存键
 */
function cacheKey(service, from, to, text) {
  return `${service}|${from}|${to}|${text}`;
}

/**
 * 读取缓存（命中时刷新热度，近似 LRU）
 * @param {string} key 缓存键
 * @returns {string|undefined} 译文，未命中返回 undefined
 */
function cacheGet(key) {
  if (!translationCache.has(key)) return undefined;
  const value = translationCache.get(key);
  translationCache.delete(key);
  translationCache.set(key, value);
  return value;
}

/**
 * 写入缓存（超限时淘汰最早条目）
 * @param {string} key 缓存键
 * @param {string} value 译文
 */
function cacheSet(key, value) {
  if (translationCache.size >= CACHE_MAX) {
    const oldest = translationCache.keys().next().value;
    translationCache.delete(oldest);
  }
  translationCache.set(key, value);
}

// ---------------------------------------------------------------------------
// 免费智能翻译（自动降级链：微软 → 谷歌，借鉴 FluentRead）
// ---------------------------------------------------------------------------

/** 微软 Edge 翻译 token 缓存（token 有效期约 10 分钟） */
let msToken = "";
let msTokenTime = 0;

/**
 * 获取微软翻译 token（Edge 免费匿名接口，带缓存）
 * @returns {Promise<string>} Bearer token
 */
async function getMsToken() {
  if (msToken && Date.now() - msTokenTime < 8 * 60 * 1000) return msToken;
  const resp = await fetch("https://edge.microsoft.com/translate/auth");
  if (!resp.ok) throw new Error(`微软 token 获取失败：HTTP ${resp.status}`);
  msToken = (await resp.text()).trim();
  msTokenTime = Date.now();
  return msToken;
}

/**
 * 微软语言代码映射（微软 API 使用 zh-Hans/zh-Hant 表示简繁中文）
 * @param {string} code 通用语言代码
 * @returns {string} 微软语言代码
 */
function msLang(code) {
  const map = { "zh-CN": "zh-Hans", "zh-TW": "zh-Hant", auto: "" };
  return map[code] || code;
}

/**
 * 微软翻译（Edge 免费接口，原生支持批量数组）
 * @param {string[]} texts 待翻译文本数组
 * @param {string} from 源语言
 * @param {string} to 目标语言
 * @returns {Promise<string[]>} 译文数组
 */
async function translateMicrosoft(texts, from, to) {
  const token = await getMsToken();
  const toLang = msLang(to);
  const fromLang = msLang(from);
  const params = new URLSearchParams({
    "api-version": "3.0",
    to: toLang,
  });
  if (fromLang) params.set("from", fromLang);
  const resp = await fetch(
    `https://api.cognitive.microsofttranslator.com/translate?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(texts.map((t) => ({ Text: t }))),
    },
  );
  if (!resp.ok) throw new Error(`微软翻译请求失败：HTTP ${resp.status}`);
  const data = await resp.json();
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error("微软翻译返回格式异常");
  }
  return data.map((d) =>
    d.translations && d.translations[0] ? d.translations[0].text : "",
  );
}

/**
 * 免费智能翻译：微软 → 谷歌 依次尝试，全部失败才抛错（借鉴 FluentRead 降级链）
 * @param {string[]} texts 待翻译文本数组
 * @param {string} from 源语言
 * @param {string} to 目标语言
 * @returns {Promise<string[]>} 译文数组
 */
async function translateFree(texts, from, to) {
  const failures = [];
  // 降级链：微软（批量快） → 谷歌（逐段并发）
  for (const provider of [
    { label: "微软翻译", fn: () => translateMicrosoft(texts, from, to) },
    { label: "谷歌翻译", fn: () => translateGoogle(texts, from, to) },
  ]) {
    try {
      return await provider.fn();
    } catch (err) {
      failures.push(
        `${provider.label}: ${err && err.message ? err.message : err}`,
      );
    }
  }
  throw new Error(`免费翻译服务均不可用：${failures.join("；")}`);
}

/**
 * 谷歌翻译（免费 gtx 接口，无需 API Key）
 * 策略：逐段并发请求（受并发池限制）
 * @param {string[]} texts 待翻译文本数组
 * @param {string} from 源语言代码
 * @param {string} to 目标语言代码
 * @returns {Promise<string[]>} 译文数组
 */
async function translateGoogle(texts, from, to) {
  const CONCURRENCY = 8; // 最大并发数
  const results = new Array(texts.length);
  let cursor = 0;

  /** 单个工作协程：不断从队列取文本并请求 */
  async function worker() {
    while (cursor < texts.length) {
      const i = cursor++;
      results[i] = await translateGoogleOne(texts[i], from, to, 1);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, texts.length) }, worker),
  );
  return results;
}

/**
 * 谷歌翻译：翻译单段文本（带一次重试）
 * @param {string} text 文本
 * @param {string} from 源语言
 * @param {string} to 目标语言
 * @param {number} remainingRetry 剩余重试次数
 * @returns {Promise<string>} 译文
 */
async function translateGoogleOne(text, from, to, remainingRetry) {
  const url = "https://translate.googleapis.com/translate_a/single";
  const params = new URLSearchParams({
    client: "gtx",
    sl: from || "auto",
    tl: to,
    dt: "t",
    q: text,
  });
  try {
    // 短文本用 GET，长文本改用 POST 避免 URL 超长
    const resp =
      text.length < 1000
        ? await fetch(`${url}?${params.toString()}`)
        : await fetch(url, { method: "POST", body: params });
    if (!resp.ok) throw new Error(`谷歌翻译请求失败：HTTP ${resp.status}`);
    const data = await resp.json();
    // 返回结构：[[["译文","原文",null,null,x]...],...]
    if (!Array.isArray(data) || !Array.isArray(data[0])) {
      throw new Error("谷歌翻译返回格式异常");
    }
    return data[0].map((seg) => (Array.isArray(seg) ? seg[0] : "")).join("");
  } catch (err) {
    if (remainingRetry > 0) {
      await new Promise((r) => setTimeout(r, 500));
      return translateGoogleOne(text, from, to, remainingRetry - 1);
    }
    throw err;
  }
}

/**
 * 百度翻译（通用翻译 API，需 appid + 密钥）
 * 策略：多段用 \n 合并请求（按字节分片），行数不匹配时回退逐段
 * @param {string[]} texts 待翻译文本数组
 * @param {string} from 源语言（谷歌代码）
 * @param {string} to 目标语言（谷歌代码）
 * @param {Object} cfg 百度配置 {appid, key}
 * @returns {Promise<string[]>} 译文数组
 */
async function translateBaidu(texts, from, to, cfg) {
  if (!cfg.appid || !cfg.key) {
    throw new Error("百度翻译未配置：请在设置页填写 appid 与密钥");
  }
  const bFrom = BAIDU_LANG_MAP[from] || from;
  const bTo = BAIDU_LANG_MAP[to] || to;

  // 按字节累计分片（百度单次请求限制约 6000 字节，留余量取 4500）
  const chunks = [];
  let cur = [];
  let curBytes = 0;
  for (const t of texts) {
    const bytes = new TextEncoder().encode(t).length;
    if (curBytes + bytes > 4500 && cur.length) {
      chunks.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(t);
    curBytes += bytes;
  }
  if (cur.length) chunks.push(cur);

  // 顺序请求各分片并展开结果
  const out = [];
  for (const chunk of chunks) {
    const part = await translateBaiduChunk(chunk, bFrom, bTo, cfg);
    out.push(...part);
  }
  return out;
}

/**
 * 百度翻译：翻译一个分片（合并请求）
 * @param {string[]} chunk 一组分片文本
 * @param {string} bFrom 百度源语言代码
 * @param {string} bTo 百度目标语言代码
 * @param {Object} cfg 百度配置
 * @returns {Promise<string[]>} 该分片的译文数组
 */
async function translateBaiduChunk(chunk, bFrom, bTo, cfg) {
  // 单段文本内部可能含有换行，会破坏"按行对应"，先替换为空格占位符
  const joined = chunk.map((t) => t.replace(/\r?\n/g, " ⏎ ")).join("\n");
  const salt = Date.now().toString();
  const sign = md5(cfg.appid + joined + salt + cfg.key);

  const body = new URLSearchParams({
    q: joined,
    from: bFrom,
    to: bTo,
    appid: cfg.appid,
    salt,
    sign,
  });
  const resp = await fetch(
    "https://fanyi-api.baidu.com/api/trans/vip/translate",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  if (!resp.ok) throw new Error(`百度翻译请求失败：HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.error_code) {
    throw new Error(
      `百度翻译错误 ${data.error_code}：${data.error_msg || "未知错误"}`,
    );
  }
  const lines = (data.trans_result || []).map((r) => r.dst || "");
  // 行数不匹配时回退为逐段请求，保证结果与输入一一对应
  if (lines.length !== chunk.length) {
    const single = [];
    for (const t of chunk) {
      single.push(await translateBaiduChunk([t], bFrom, bTo, cfg));
    }
    return single.flat();
  }
  return lines.map((l) => l.replace(/ ⏎ /g, "\n"));
}

/**
 * 大模型翻译（OpenAI 兼容 /chat/completions 接口）
 * 策略：整批以 JSON 数组提交，要求模型返回等长 JSON 数组
 * @param {string[]} texts 待翻译文本数组
 * @param {string} from 源语言
 * @param {string} to 目标语言
 * @param {Object} cfg 大模型配置 {baseUrl, apiKey, model, prompt}
 * @returns {Promise<string[]>} 译文数组
 */
async function translateOpenAI(texts, from, to, cfg) {
  if (!cfg.apiKey) {
    throw new Error("大模型翻译未配置：请在设置页填写 API Key");
  }
  // 按 2000 字符分批：控制单次输出长度，避免超过模型默认输出 token 上限被截断
  const MAX_CHARS = 2000;
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const t of texts) {
    if (len + t.length > MAX_CHARS && cur.length) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(t);
    len += t.length;
  }
  if (cur.length) chunks.push(cur);

  const out = [];
  for (const chunk of chunks) {
    out.push(...(await translateOpenAIChunk(chunk, from, to, cfg)));
  }
  return out;
}

/**
 * 大模型翻译：翻译一个分片
 * 带 60 秒超时；火山方舟深度思考模型禁用思维链提速；
 * 单片失败时二分降级重试，只有拆到单条仍失败才抛错
 * @param {string[]} chunk 一组分片文本
 * @param {string} from 源语言
 * @param {string} to 目标语言
 * @param {Object} cfg 大模型配置
 * @returns {Promise<string[]>} 该分片的译文数组
 */
async function translateOpenAIChunk(chunk, from, to, cfg) {
  try {
    return await translateOpenAIChunkOnce(chunk, from, to, cfg);
  } catch (err) {
    // 拆半降级重试：条数不匹配/输出截断时缩小批次通常可以成功
    if (chunk.length > 1) {
      const mid = Math.ceil(chunk.length / 2);
      const left = await translateOpenAIChunk(
        chunk.slice(0, mid),
        from,
        to,
        cfg,
      );
      const right = await translateOpenAIChunk(chunk.slice(mid), from, to, cfg);
      return [...left, ...right];
    }
    throw err;
  }
}

/**
 * 大模型翻译：翻译一个分片（单次请求，无重试）
 * @param {string[]} chunk 一组分片文本
 * @param {string} from 源语言
 * @param {string} to 目标语言
 * @param {Object} cfg 大模型配置
 * @returns {Promise<string[]>} 该分片的译文数组
 */
async function translateOpenAIChunkOnce(chunk, from, to, cfg) {
  const fromName =
    from === "auto" ? "原文语言（自动识别）" : LANG_NAMES[from] || from;
  const toName = LANG_NAMES[to] || to;
  const system = (cfg.prompt || "")
    .replaceAll("{from}", fromName)
    .replaceAll("{to}", toName);

  // 60 秒超时：防止慢请求让页面永远停留在"翻译中"
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60 * 1000);

  const base = (cfg.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  // 支持禁用思维链的推理型服务域名（深度思考模型先输出长思维链，翻译场景极慢）。
  // 采用白名单：OpenAI 等厂商对未知参数会报 400，不能盲目透传
  const NO_THINKING_HOSTS = [/volces\.com/, /bigmodel\.cn/, /deepseek\.com/];
  const disableThinking = NO_THINKING_HOSTS.some((re) => re.test(base));
  let resp;
  try {
    resp = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: cfg.model || "gpt-4o-mini",
        temperature: 0,
        // 禁用思维链后模型直接输出译文，单批耗时从几十秒降到数秒
        ...(disableThinking ? { thinking: { type: "disabled" } } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(chunk) },
        ],
      }),
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error("大模型响应超时（60 秒），已自动重试或降级");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(
      `大模型请求失败：HTTP ${resp.status} ${errText.slice(0, 200)}`,
    );
  }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("大模型返回内容为空");

  const parsed = parseJsonArrayLoose(content);
  if (!parsed || parsed.length !== chunk.length) {
    throw new Error(
      `大模型返回条数不匹配（期望 ${chunk.length} 条），请重试或更换模型`,
    );
  }
  return parsed.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
}

/**
 * Coze（扣子）原生协议翻译
 * Coze 使用 /v3/chat Bot 对话接口（SSE 流式），与 OpenAI 格式不兼容：
 * baseUrl 填 https://api.coze.cn（海外为 https://api.coze.com）
 * apiKey 填个人访问令牌 PAT，model 字段填发布到 API 的 Bot ID
 * @param {string[]} texts 待翻译文本数组
 * @param {string} from 源语言
 * @param {string} to 目标语言
 * @param {Object} cfg Coze 配置 {baseUrl, apiKey, model, prompt}
 * @returns {Promise<string[]>} 译文数组
 */
async function translateCoze(texts, from, to, cfg) {
  if (!cfg.model)
    throw new Error('Coze 未填写 Bot ID（设置页 Coze 卡片的"模型名"栏）');
  const base = (cfg.baseUrl || "https://api.coze.cn").replace(/\/+$/, "");
  const prompt = (cfg.prompt || DEFAULT_SETTINGS.openai.prompt)
    .replaceAll("{from}", from === "auto" ? "源语言（自动检测）" : from)
    .replaceAll("{to}", to);

  const resp = await fetch(base + "/v3/chat", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + cfg.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      bot_id: cfg.model,
      user_id: "immersive-translate",
      stream: true,
      auto_save_history: false,
      additional_messages: [
        {
          role: "user",
          content: prompt + "\n\n" + JSON.stringify(texts),
          content_type: "text",
        },
      ],
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Coze 接口错误 ${resp.status}：${errText.slice(0, 200)}`);
  }

  // 解析 SSE 流：拼接 conversation.chat.delta 事件的增量文本
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop(); // 末行可能不完整，留到下一轮
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let evt;
      try {
        evt = JSON.parse(payload);
      } catch (e) {
        continue; // 非 JSON 行忽略（心跳等）
      }
      if (evt.event === "conversation.chat.delta") {
        full +=
          (evt.event_data &&
            evt.event_data.message &&
            evt.event_data.message.content) ||
          "";
      } else if (
        evt.event === "conversation.chat.failed" ||
        evt.event === "error"
      ) {
        throw new Error("Coze 对话失败：" + payload.slice(0, 200));
      }
    }
  }

  const parsed = parseJsonArrayLoose(full);
  if (!parsed || parsed.length !== texts.length) {
    throw new Error(
      'Coze 返回内容无法解析为翻译结果（建议在 Coze 平台为 Bot 设置"严格按指令输出 JSON 数组"的人设）',
    );
  }
  return parsed.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
}

/**
 * 宽松地从模型输出中解析 JSON 数组（容忍 markdown 代码块等包装）
 * @param {string} content 模型输出文本
 * @returns {string[]|null} 解析出的数组，失败返回 null
 */
function parseJsonArrayLoose(content) {
  try {
    const direct = JSON.parse(content);
    if (Array.isArray(direct)) return direct;
  } catch (e) {
    /* 继续尝试提取 */
  }
  const match = content.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const arr = JSON.parse(match[0]);
      if (Array.isArray(arr)) return arr;
    } catch (e) {
      /* 忽略 */
    }
  }
  return null;
}
