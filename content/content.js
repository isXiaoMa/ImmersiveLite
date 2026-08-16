/**
 * Content Script：页面内容翻译核心逻辑
 * 职责：
 * 1. 识别页面正文块（段落/标题/列表/表格/按钮等）
 * 2. 渐进式发送翻译请求，边翻边显示（加载态为转圈 Spinner）
 * 3. 译文 DOM 结构与原版沉浸式翻译保持一致：
 *    <font class="notranslate immersive-translate-target-wrapper" lang="xx">
 *      <font class="notranslate">&nbsp;&nbsp;</font> 或 <br>
 *      <font class="...inline-wrapper">
 *        <font class="...target-inner">译文</font>
 *      </font>
 *    </font>
 * 4. 响应 popup / 快捷键的开关指令
 */
(() => {
  if (window.__IT_CONTENT_LOADED__) return; // 防止重复注入
  window.__IT_CONTENT_LOADED__ = true;

  /** 不需要翻译的标签（原版 excludeTags 完整对齐，default_config.json 实证） */
  const SKIP_TAGS = new Set([
    "TITLE",
    "LINK",
    "SCRIPT",
    "STYLE",
    "TEXTAREA",
    "SVG",
    "G",
    "NOSCRIPT",
    "BASE",
    "PRE",
    "KBD",
    "WBR",
    "RT",
    "RP",
    "META",
    "MATH",
    "DATETIME",
    "TTS-SENTENCE",
    "AIO-CODE",
    "RELIN-TARGET",
    // 跨 frame 文档不进遍历（原版 uR：非同源 IFRAME 直接拒绝）
    "IFRAME",
  ]);

  /**
   * 保留原文标签（原版 stayOriginalTags，default_config.json 实证）：
   * 不排除出文本流，而是作为"变量占位"参与段落文本（@0# 格式，逆向自 Jc/Au），
   * 翻译后占位符还原为原文——代码片段/上标/等宽体不被翻译破坏
   */
  const STAY_ORIGINAL_TAGS = new Set([
    "CODE",
    "TT",
    "IMG",
    "SUP",
    "SUB",
    "SAMP",
  ]);

  /** 变量占位符分隔符（原版 Au=["@","#"]：@0# 格式） */
  const VAR_DELIMITERS = ["@", "#"];

  /**
   * 行内 display 列表（原版 qee 完整还原）：命中则不是段落边界。
   * 注意 display:contents 原版判定为块（不在列表内）
   */
  const INLINE_DISPLAYS = new Set([
    "inline",
    "inline-block",
    "inline-flex",
    "inline-grid",
    "inline-table",
    "ruby",
    "ruby-base",
    "ruby-base-container",
    "ruby-text",
    "ruby-text-container",
    "math",
    "inline-math",
  ]);

  /** 原版段落首字母阈值（paragraphFirstLetterFontSize）：Drop-cap 大写首字母不单独成段 */
  const DROP_CAP_FONT_SIZE = 35;

  /** 浮动大元素影响后续段落数（原版 floatBlockEffectParagraphs=4）+ 尺寸阈值 140×140 */
  const FLOAT_BLOCK_EFFECT_PARAGRAPHS = 4;
  const FLOAT_ELEMENT_MIN_SIZE = 140;

  // -----------------------------------------------------------------------
  // 站点规则层（架构对齐原版：站点规则 > 通用引擎兜底，数据提取自原版 1.32.5）
  // -----------------------------------------------------------------------

  /** 当前页面命中的站点规则（未命中为 null，走通用引擎） */
  const SITE_RULE =
    typeof itMatchSiteRule === "function"
      ? itMatchSiteRule(location.href)
      : null;

  /** 无翻译价值文本正则（原版 noTranslateRegexp：相对时间、阅读时长、单字符等） */
  const NO_TRANSLATE_REGEXPS = (
    typeof IT_GENERAL_RULE !== "undefined"
      ? IT_GENERAL_RULE.noTranslateRegexp
      : []
  )
    .map((s) => {
      try {
        return new RegExp(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  /** 强制块级选择器（通用 + 站点追加，原版 extraBlockSelectors） */
  const EXTRA_BLOCK_SELECTORS = [
    ...((typeof IT_GENERAL_RULE !== "undefined"
      ? IT_GENERAL_RULE.extraBlockSelectors
      : []) || []),
    ...((SITE_RULE && SITE_RULE.extraBlockSelectors) || []),
  ];

  /** 强制行内选择器（通用 + 站点追加，原版 extraInlineSelectors：命中则非段落边界） */
  const EXTRA_INLINE_SELECTORS = [
    ...((typeof IT_GENERAL_RULE !== "undefined"
      ? IT_GENERAL_RULE.extraInlineSelectors
      : []) || []),
    ...((SITE_RULE && SITE_RULE.extraInlineSelectors) || []),
  ];

  /** 原子块选择器（原版 atomicBlockSelectors：命中则强制视为行内，不拆段） */
  const ATOMIC_BLOCK_SELECTORS = [
    ...((typeof IT_GENERAL_RULE !== "undefined"
      ? IT_GENERAL_RULE.atomicBlockSelectors
      : []) || []),
    ...((SITE_RULE && SITE_RULE.atomicBlockSelectors) || []),
  ];

  /** 站点排除选择器（原版 excludeSelectors：命中区域整体不翻译） */
  const SITE_EXCLUDE_SELECTORS =
    SITE_RULE && Array.isArray(SITE_RULE.excludeSelectors)
      ? SITE_RULE.excludeSelectors
      : [];

  /**
   * 判断元素是否命中任一选择器（容错单条选择器语法错误）
   * @param {Element} el 目标元素
   * @param {string[]} sels 选择器数组
   * @param {boolean} useClosest 是否检查祖先（排除区域语义）
   * @returns {boolean} 是否命中
   */
  function matchesAnySelector(el, sels, useClosest) {
    for (const sel of sels) {
      try {
        if (useClosest ? el.closest(sel) : el.matches(sel)) return true;
      } catch {
        // 忽略非法选择器
      }
    }
    return false;
  }

  /** 组件内部状态 */
  const state = {
    translating: false,
    translated: false,
    total: 0,
    done: 0,
    error: "",
  };

  /** 翻译会话（视口懒翻译 + 并发调度 + 动态内容监听，借鉴 FluentRead） */
  const session = {
    active: false,
    from: "auto",
    to: "zh-CN",
    display: "dual", // 显示模式：dual 双语 | single 仅译文
    style: {}, // 译文样式设置（display 模式切换时同步 imt-state 属性用）
    queue: [], // 待翻译块队列
    allBlocks: [], // 全部已调度块（还原时恢复仅译文模式的原文快照）
    inflight: 0, // 在飞批次数
    observer: null, // IntersectionObserver：视口懒翻译
    mutationObserver: null, // MutationObserver：动态内容
    debounceTimer: null, // 动态内容收集防抖定时器
  };

  /** 调度参数 */
  const MAX_CONCURRENT = 3; // 最大并发批次数（滑动窗口）
  const BATCH_SIZE = 3; // 每批翻译段数
  const VIEWPORT_PRELOAD = 600; // 视口预加载距离（px）
  const DYNAMIC_DEBOUNCE = 200; // 动态内容收集防抖（ms）

  // -----------------------------------------------------------------------
  // 消息处理
  // -----------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case "TOGGLE_TRANSLATION":
        toggleTranslation();
        sendResponse({ ok: true, ...getStatus() });
        break;
      case "GET_STATUS":
        // 状态以顶层 frame 为准（all_frames 注入后避免 iframe 响应竞争）
        if (window.self === window.top) {
          sendResponse({ ok: true, ...getStatus() });
        }
        break;
      case "SETTINGS_CHANGED": {
        // 设置变化：刷新 UI 组件（悬浮球/划词开关）
        initUIComponents();
        // 异步分流（保持 listener 同步，不破坏 sendResponse 通道）
        (async () => {
          if (state.translated || state.translating) {
            // 原版 ple 状态机：仅显示模式变化时即时切换（复用已翻译 DOM，不重翻）
            const data = await chrome.storage.sync.get("it_settings");
            const newDisplay =
              (data.it_settings || {}).display === "single" ? "single" : "dual";
            const onlyDisplayChanged =
              newDisplay !== session.display &&
              session.active &&
              session.allBlocks.some((b) => b.wrapper && b.wrapper.isConnected);
            if (onlyDisplayChanged) {
              applyDisplayMode(newDisplay);
            } else {
              restore().then(() => translatePage());
            }
          }
        })();
        sendResponse({ ok: true });
        break;
      }
      case "TRANSLATE_SELECTION": {
        // 右键菜单"翻译选中文本"：仅顶层 frame 响应（划词卡只挂顶层）
        if (window.self !== window.top) break;
        const sel = window.getSelection();
        const text = sel ? sel.toString().trim() : "";
        if (text && sel && !sel.isCollapsed) {
          const rect = sel.getRangeAt(0).getBoundingClientRect();
          if (rect && (rect.width || rect.height)) {
            showSelectionPopup(rect, text);
          }
        }
        sendResponse({ ok: true });
        break;
      }
      default:
        break;
    }
    return false;
  });

  /**
   * 获取当前翻译状态（供 popup 展示）
   * @returns {Object} 状态快照
   */
  function getStatus() {
    return {
      translating: state.translating,
      translated: state.translated,
      total: state.total,
      done: state.done,
      error: state.error,
    };
  }

  /** 标题分隔符（原版 Xm）：译文 + " --- " + 原标题，兼作已翻译标记 */
  const TITLE_SEP = " --- ";

  /** 原标题备份（原版 J0）：还原与重翻时的原文来源 */
  let originTitle = "";

  /** 标题观察器（原版 rR）：SPA 路由 title 变化时自动重翻 */
  let titleObserver = null;

  /**
   * 翻译页面标题（原版 dx 移植，@1307434）：
   * 已含分隔符跳过 → 备份原标题 → 翻译 → 译文 + " --- " + 原标题
   * 译文与原文相同（已是目标语言）不修改
   */
  async function translateTitle() {
    const t = document.title;
    if (!t || t.includes(TITLE_SEP)) return; // 已翻译
    originTitle = t;
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "TRANSLATE_BATCH",
        texts: [t],
        from: session.from,
        to: session.to,
      });
      const translated = resp && resp.ok && resp.translations[0];
      if (
        translated &&
        session.active &&
        translated.trim() !== t.trim() &&
        !document.title.includes(TITLE_SEP)
      ) {
        document.title = translated + TITLE_SEP + originTitle;
      }
    } catch {
      // 标题翻译失败静默（正文翻译不受影响）
    }
  }

  /**
   * 还原标题（原版 iR 移植）：仅在确实被翻译过时还原
   */
  function restoreTitle() {
    if (originTitle && document.title.includes(TITLE_SEP)) {
      document.title = originTitle;
    }
  }

  /**
   * 启动标题变化监听（原版 rR 移植）：
   * SPA 路由切换会改写 title → 无分隔符时重新翻译
   */
  function watchTitle() {
    const el = document.querySelector("title");
    if (!el || titleObserver) return;
    titleObserver = new MutationObserver(() => {
      // 延迟让 title 改写落定；还原流程后 session.active=false 不会误触发
      setTimeout(() => {
        if (
          session.active &&
          document.title &&
          !document.title.includes(TITLE_SEP)
        ) {
          translateTitle();
        }
      }, 50);
    });
    titleObserver.observe(el, {
      subtree: true,
      characterData: true,
      childList: true,
    });
  }

  /**
   * 通知后台当前页面翻译状态变化（用于右键菜单标题切换：
   * 未翻译 → "翻译为xx"，已翻译 → "显示原文"）
   */
  function notifyStatus() {
    // iframe 场景只由顶层 frame 上报（all_frames 注入后防止子 frame 状态互相覆盖）
    if (window.self !== window.top) return;
    chrome.runtime
      .sendMessage({
        type: "STATUS_NOTIFY",
        translated: !!(state.translated || state.translating),
      })
      .catch(() => {});
  }

  // -----------------------------------------------------------------------
  // 翻译主流程
  // -----------------------------------------------------------------------

  /**
   * 切换翻译状态：已翻译（含懒翻译推进中）则立即还原，否则开始翻译
   * （还原会终止整个会话，包括在飞的请求与未进入视口的懒加载块）
   */
  async function toggleTranslation() {
    if (state.translated) {
      await restore();
    } else if (!state.translating) {
      await translatePage();
    }
  }

  /**
   * 翻译整个页面主流程（懒翻译模型，借鉴 FluentRead）
   * 1. 收集正文块并标记
   * 2. 视口内（含预加载区）的块立即插入 Spinner 并入队
   * 3. 视口外的块注册 IntersectionObserver，滚动进入视口时再入队
   * 4. 开启动态内容监听（SPA 路由/无限滚动的新内容自动翻译）
   * 5. drain() 以滑动窗口并发（最多 MAX_CONCURRENT 批在飞）持续推进
   */
  async function translatePage() {
    if (state.translating) return;
    state.translating = true;
    state.error = "";

    try {
      const settings = await chrome.storage.sync.get("it_settings");
      const cfg = settings.it_settings || {};
      session.from = cfg.from || "auto";
      session.to = cfg.to || "zh-CN";
      session.display = cfg.display === "single" ? "single" : "dual";
      session.style = cfg.style || {};
      applyStyleVars(cfg.style || {}, session.to);

      // 1. 站点规则全局样式修正（原版 Hh：解开 line-clamp 等截断，防译文被折叠）
      applyGlobalStyles();
      // 标题翻译（原版 isTranslateTitle 默认 true）：译文 + " --- " + 原标题
      // 标题观察器先挂（原版 rR）：SPA 路由 title 改写时自动重翻
      watchTitle();
      translateTitle();
      // 2. 收集正文块并标记已处理（增量翻译的身份凭证）
      const blocks = await collectBlocks();
      state.total = blocks.length;
      state.done = 0;

      if (!blocks.length) {
        state.translated = true;
        updateFloatBall();
        notifyStatus();
        return;
      }

      // 3. 开启会话：创建视口观察器（rootMargin 提前预加载）
      session.active = true;
      session.queue = [];
      session.allBlocks = [];
      session.inflight = 0;
      session.observer = new IntersectionObserver(
        (entries) => {
          if (!session.active) return;
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const b = entry.target.__itBlock;
            session.observer.unobserve(entry.target);
            if (b) scheduleBlock(b);
          }
        },
        { rootMargin: `${VIEWPORT_PRELOAD}px 0px` },
      );

      // 3. 视口内立即调度；视口外注册懒加载
      const vh = window.innerHeight;
      for (const b of blocks) {
        b.el.dataset.itDone = "1";
        if (isNearViewport(b.el, vh)) {
          scheduleBlock(b);
        } else {
          b.el.__itBlock = b;
          session.observer.observe(b.el);
        }
      }

      // 4. 动态内容监听（SPA 站点新加载的内容自动翻译）
      startDynamicWatch();

      state.translated = true;
      notifyStatus();
      drain();
    } catch (err) {
      state.error = err && err.message ? err.message : String(err);
      document
        .querySelectorAll(".immersive-translate-target-inner[data-pending]")
        .forEach((el) => setTranslationError(el, state.error));
    } finally {
      state.translating = false;
      drain(); // 由 drain 根据队列真实状态刷新 translating 标志
    }
  }

  /**
   * 判断元素是否在视口附近（含预加载距离）
   * @param {Element} el 目标元素
   * @param {number} vh 视口高度
   * @returns {boolean} 是否在视口附近
   */
  function isNearViewport(el, vh) {
    const rect = el.getBoundingClientRect();
    return rect.top < vh + VIEWPORT_PRELOAD && rect.bottom > -VIEWPORT_PRELOAD;
  }

  /**
   * 调度单个块：插入带 Spinner 的加载占位并入队，随后尝试排水
   * 插入语义完整对齐原版（逆向自 Yl/pd/za 三件套）：
   *   锚点 = 最后一个原文节点的 nextSibling，译文 insertBefore(锚点)——
   *   即译文紧跟最后一个原文节点（与文本节点同级，最精确位置）
   * 仅译文模式：对可安全替换的块（纯文本叶子/控件）快照原文子节点
   * @param {Object} b 翻译单元（collectBlocks 产出的块描述）
   */
  function scheduleBlock(b) {
    if (b.wrapper) return; // 已调度过
    // 仅译文模式适用条件：锚为纯文本宿主（无子元素）或按钮控件，替换安全
    b.singleMode =
      session.display === "single" &&
      (b.el.childElementCount === 0 || b.el.tagName === "BUTTON");
    // 原版 ple 状态机：块初始均为 dual 态（原文+译文），
    // singleMode 的块在译文回填后经 transitionBlock 转为 translation 态
    b.mode = "dual";
    // 仅译文模式不插入分隔符；双语模式按分隔符类型
    const separator = b.singleMode ? "none" : b.inlineSeparator ? "nbsp" : "br";
    b.wrapper = buildTranslationWrapper(separator, session.to, true);
    b.inner = b.wrapper.querySelector(".immersive-translate-target-inner");
    // 锚点插入（原版 pd/Yl：锚点=lastTargetNode.nextSibling，
    // 插入容器=lastTargetNode.parentNode——译文与原文节点同级，位置最精确）
    const lastNode = b.targetNodes[b.targetNodes.length - 1];
    const parent = (lastNode && lastNode.parentNode) || b.el;
    parent.insertBefore(b.wrapper, lastNode ? lastNode.nextSibling : null);
    // 原版 r8：浮动大元素旁的段落译文行内化（防 block wrapper 挤开浮动图）
    if (b.hasFloatElement) b.wrapper.style.display = "inline";
    session.allBlocks.push(b);
    session.queue.push(b);
    drain();
  }

  /**
   * 排水：滑动窗口并发控制
   * 始终保持最多 MAX_CONCURRENT 批请求在飞，完成一批立即补位
   */
  function drain() {
    if (!session.active) {
      state.translating = false;
      return;
    }
    while (session.inflight < MAX_CONCURRENT && session.queue.length > 0) {
      const batch = session.queue.splice(0, BATCH_SIZE);
      session.inflight += 1;
      doTranslateBatch(batch)
        .catch(() => {})
        .finally(() => {
          session.inflight -= 1;
          drain();
        });
    }
    state.translating = session.inflight > 0 || session.queue.length > 0;
    updateFloatBall();
  }

  /**
   * 翻译一批并回填结果
   * 译文与原文相同时（原文已是目标语言）移除占位不显示，避免冗余
   * 仅译文模式的块在回填后移除原文子节点，只保留译文
   * @param {Object[]} batch 一批翻译单元
   */
  async function doTranslateBatch(batch) {
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "TRANSLATE_BATCH",
        texts: batch.map((b) => b.text),
        from: session.from,
        to: session.to,
      });
      if (!session.active) return; // 会话已被还原终止，丢弃过期结果
      if (resp && resp.ok) {
        batch.forEach((b, i) => {
          // 原版 Eoe：@i# 占位符还原为 stayOriginal 原文（代码/上标等）
          const text = restoreVariables(
            resp.translations[i] || "",
            b.variables,
          );
          if (normalizeText(text) === normalizeText(b.text)) {
            b.wrapper && b.wrapper.remove(); // 译文=原文：不显示
            return;
          }
          fillTranslation(b.inner, text);
          if (b.singleMode) transitionBlock(b, "translation");
        });
      } else {
        batch.forEach((b) =>
          setTranslationError(
            b.inner,
            resp && resp.error ? resp.error : "翻译失败",
            b,
          ),
        );
      }
    } catch (err) {
      if (!session.active) return;
      batch.forEach((b) =>
        setTranslationError(
          b.inner,
          err && err.message ? err.message : "翻译异常",
          b,
        ),
      );
    }
    state.done += batch.length;
  }

  /**
   * 显示模式状态机（原版 ple 完整移植，@1574875）：
   * 复用已翻译的 wrapper DOM 即时切换显示模式，无需重新翻译。
   * 转换语义：
   *   dual → translation：快照原文节点并摘除，隐藏分隔符（原版 h4+Po 降级路径）
   *   translation → dual：恢复原文快照，显示分隔符（原版 Qh 备份还原）
   * @param {Object} b 翻译单元
   * @param {"dual"|"translation"} target 目标显示状态
   */
  function transitionBlock(b, target) {
    if (!b.wrapper || !b.wrapper.isConnected || !b.el.isConnected) return;
    if (b.mode === target) return;
    if (target === "translation") {
      // 快照原文子节点（排除译文 wrapper 自身）后从 DOM 摘除
      if (!b.originalChildren) {
        b.originalChildren = Array.from(b.el.childNodes).filter(
          (n) => n !== b.wrapper,
        );
      }
      b.originalChildren.forEach((n) => {
        if (n.parentNode) n.parentNode.removeChild(n);
      });
      setSeparatorHidden(b, true);
      b.mode = "translation";
    } else {
      // 按原顺序恢复原文快照（插回 wrapper 之前）
      if (b.originalChildren) {
        b.originalChildren.forEach((n) => {
          if (!n.isConnected && b.el.isConnected) {
            b.el.insertBefore(n, b.wrapper);
          }
        });
        b.originalChildren = null;
      }
      setSeparatorHidden(b, false);
      b.mode = "dual";
    }
  }

  /**
   * 显示/隐藏译文分隔符（仅译文模式下无原文，分隔符无意义）
   * @param {Object} b 翻译单元
   * @param {boolean} hidden 是否隐藏
   */
  function setSeparatorHidden(b, hidden) {
    const sep = b.wrapper && b.wrapper.querySelector("[data-it-sep]");
    if (sep) sep.style.display = hidden ? "none" : "";
  }

  /**
   * 应用显示模式切换（原版 ple 状态机入口）：
   * 遍历已翻译的块逐个转换显示状态，并同步根元素 imt-state 属性
   * @param {"dual"|"single"} mode 目标显示模式
   */
  function applyDisplayMode(mode) {
    session.display = mode === "single" ? "single" : "dual";
    const target = session.display === "single" ? "translation" : "dual";
    for (const b of session.allBlocks) {
      transitionBlock(b, target);
    }
    applyStyleVars(session.style || {}, session.to);
  }

  /**
   * 文本归一化（去除所有空白后比较，用于"译文=原文"判定）
   * @param {string} t 文本
   * @returns {string} 归一化结果
   */
  function normalizeText(t) {
    return String(t || "")
      .replace(/[\s\u3000]+/g, "")
      .trim();
  }

  /**
   * 动态内容监听：MutationObserver + 防抖
   * SPA 路由切换/无限滚动加载的新内容在防抖后统一收集，
   * 视口内立即调度，视口外注册懒加载（与初始流程一致）
   */
  function startDynamicWatch() {
    session.mutationObserver = new MutationObserver((mutations) => {
      if (!session.active) return;
      let hasNew = false;
      for (const m of mutations) {
        if (m.type !== "childList") continue;
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          // 忽略插件自身插入的译文元素
          if (node.classList.contains("immersive-translate-target-wrapper")) {
            continue;
          }
          if (node.closest(".immersive-translate-target-wrapper")) continue;
          hasNew = true;
        }
      }
      if (!hasNew) return;
      clearTimeout(session.debounceTimer);
      session.debounceTimer = setTimeout(async () => {
        if (!session.active) return;
        // 增量收集：已标记 data-it-done 的块不会重复进入
        const newBlocks = await collectBlocks();
        state.total += newBlocks.length;
        const vh = window.innerHeight;
        for (const b of newBlocks) {
          b.el.dataset.itDone = "1";
          if (isNearViewport(b.el, vh)) {
            scheduleBlock(b);
          } else {
            b.el.__itBlock = b;
            session.observer.observe(b.el);
          }
        }
      }, DYNAMIC_DEBOUNCE);
    });
    session.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  /**
   * 还原页面：终止翻译会话（含懒加载与动态监听）、移除全部译文并清除标记
   */
  async function restore() {
    // 1. 终止会话：在飞请求的结果会因 active=false 被丢弃
    session.active = false;
    if (session.observer) session.observer.disconnect();
    if (session.mutationObserver) session.mutationObserver.disconnect();
    clearTimeout(session.debounceTimer);
    session.queue = [];
    session.inflight = 0;
    // 2. 恢复仅译文模式块的原文（用快照替换当前内容，译文 wrapper 一并清除）
    for (const b of session.allBlocks) {
      if (b.originalChildren && b.el && b.el.isConnected) {
        b.el.replaceChildren(...b.originalChildren);
      }
    }
    session.allBlocks = [];
    // 3. 移除全部译文并清理标记
    document
      .querySelectorAll(".immersive-translate-target-wrapper")
      .forEach((el) => el.remove());
    document.querySelectorAll("[data-it-done]").forEach((el) => {
      delete el.dataset.itDone;
      delete el.__itBlock;
    });
    // 清理根元素上的状态属性（与原版行为一致）
    const root = document.documentElement;
    root.removeAttribute("imt-state");
    root.removeAttribute("imt-translation-dir");
    root.removeAttribute("imt-trans-position");
    // 还原标题（原版 iR）
    restoreTitle();
    state.translated = false;
    state.translating = false;
    state.total = 0;
    state.done = 0;
    updateFloatBall();
    notifyStatus();
  }

  // -----------------------------------------------------------------------
  // 正文块识别
  // -----------------------------------------------------------------------

  /** computedStyle 缓存（原版 ac：el.immersiveTranslateComputedStyle expando） */
  const styleCache = new WeakMap();

  /**
   * 获取带缓存的 computedStyle（原版 ac 函数语义）
   * @param {Element} el 目标元素
   * @returns {CSSStyleDeclaration|null} 样式（脱离文档时为 null）
   */
  function getStyle(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    let s = styleCache.get(el);
    if (!s) {
      try {
        s = getComputedStyle(el);
      } catch {
        return null;
      }
      styleCache.set(el, s);
    }
    return s;
  }

  /** 遍历标记（原版 nn 标记系统的 WeakMap 等价实现：el[kr][y7]=ctxId） */
  const walkMarks = new WeakMap();

  /** 翻译会话序号（原版 ctxId）：增量收集时跳过本会话已遍历的元素 */
  let walkCtxId = 0;

  /**
   * 段落边界判定（原版 ra 完整还原，@828522）：
   *   extraInlineSelectors 命中 → 非块；
   *   extraBlockSelectors 命中或 br/input → 块；
   *   父 display:inline-flex → 非块（行内流合并）；
   *   display 不在 qee 行内列表 → 块（contents 视为块）；
   *   atomicBlockSelectors 命中 → 强制非块（不拆段）
   * @param {Element} el 目标元素
   * @returns {boolean} true = 段落边界
   */
  function itIsBlock(el) {
    const name = el.tagName.toLowerCase();
    if (
      EXTRA_INLINE_SELECTORS.length > 0 &&
      matchesAnySelector(el, EXTRA_INLINE_SELECTORS, false)
    ) {
      return false;
    }
    if (name === "br" || name === "input") return true;
    if (
      EXTRA_BLOCK_SELECTORS.length > 0 &&
      matchesAnySelector(el, EXTRA_BLOCK_SELECTORS, false)
    ) {
      return true;
    }
    const ps = el.parentElement ? getStyle(el.parentElement) : null;
    if (ps && ps.display === "inline-flex") return false;
    const s = getStyle(el);
    const d = (s && s.display) || "";
    if (!d || INLINE_DISPLAYS.has(d)) return false;
    if (
      ATOMIC_BLOCK_SELECTORS.length > 0 &&
      matchesAnySelector(el, ATOMIC_BLOCK_SELECTORS, false)
    ) {
      return false;
    }
    return true;
  }

  /**
   * 沿祖先链找块级锚（原版 lR，@1315101：BR 场景的锚重设）
   * @param {Element} el 起点元素（通常为 BR）
   * @returns {Element|null} 块级祖先（最多上溯 5 层）
   */
  function findBlockAncestor(el) {
    let n = el.parentElement;
    for (let i = 0; i < 5; i++) {
      if (!n) return el.parentElement || null;
      if (n.__itIsBlock === true || itIsBlock(n)) return n;
      n = n.parentElement;
    }
    return el.parentElement || null;
  }

  /**
   * 计算文本节点流的共同祖先（原版 w1，@837491：所有节点父链交集的首个元素）
   * p>a>span 混排的段落锚自动回到真实宿主，而非触发边界的元素
   * @param {Node[]} nodes 文本节点列表
   * @param {Element} stopAt 上溯终点（当前锚）
   * @returns {Element|null} 共同祖先
   */
  function commonAncestorOf(nodes, stopAt) {
    if (!nodes.length) return null;
    const chains = nodes.map((n) => {
      const set = new Set();
      let cur = n;
      while ((cur = cur.parentNode)) {
        set.add(cur);
        if (cur === stopAt) break;
      }
      return set;
    });
    for (const el of chains[0]) {
      if (
        el.nodeType === Node.ELEMENT_NODE &&
        !(
          ATOMIC_BLOCK_SELECTORS.length > 0 &&
          matchesAnySelector(el, ATOMIC_BLOCK_SELECTORS, false)
        ) &&
        chains.every((s) => s.has(el))
      ) {
        return el;
      }
    }
    return null;
  }

  /**
   * 追加片段并做单空格补偿（原版 Jc 的 vs/u0 前后空白归一语义）
   * @param {string[]} parts 片段数组
   * @param {string} s 新片段
   */
  function pushPart(parts, s) {
    if (parts.length) {
      const prev = parts[parts.length - 1];
      if (!/\s$/.test(prev) && !/^\s/.test(s)) parts.push(" ");
    }
    parts.push(s);
  }

  /**
   * 段落文本组装 + 变量占位（原版 Jc，@1373690 简化移植）：
   * stayOriginal 元素（CODE/TT/SUP/SUB/SAMP）的独占文本提升为父元素，
   * 替换为 @i# 占位符（原版 Au=["@","#"]），翻译后还原——
   * 代码片段/上标等原文不进翻译请求，防止被翻译破坏
   * @param {Node[]} nodes 段落文本节点流
   * @returns {{text: string, variables: Object}} 段落文本 + 变量表
   */
  function composeParagraphText(nodes) {
    const parts = [];
    const variables = {};
    for (const node of nodes) {
      const parent = node.parentElement;
      const txt = (node.textContent || "").replace(/\s+/g, " ");
      // 原版 Jc：文本独占父元素时提升为父元素，参与 stayOriginal 变量判定
      const host =
        parent && txt.trim() && node.textContent === parent.textContent
          ? parent
          : null;
      if (host && STAY_ORIGINAL_TAGS.has(host.tagName)) {
        const idx = Object.keys(variables).length;
        variables[idx] = txt.trim();
        pushPart(parts, VAR_DELIMITERS[0] + idx + VAR_DELIMITERS[1]);
      } else {
        pushPart(parts, txt);
      }
    }
    return {
      text: parts.join("").replace(/\s+/g, " ").trim(),
      variables,
    };
  }

  /**
   * 译文中的变量占位符还原（原版 Eoe 的 variables replace 语义）
   * @param {string} text 译文
   * @param {Object} variables 变量表
   * @returns {string} 还原后的译文
   */
  function restoreVariables(text, variables) {
    if (!variables || !Object.keys(variables).length) return text;
    return String(text || "").replace(/@\s*(\d+)\s*#/g, (m, i) =>
      Object.prototype.hasOwnProperty.call(variables, i) ? variables[i] : m,
    );
  }

  /**
   * 判断元素尺寸是否达到浮动影响阈值（原版 D：h1(L) 宽高 ≥140×140）
   * @param {Element} el 目标元素
   * @returns {boolean} 是否达到阈值
   */
  function floatEffectRelatedSize(el) {
    try {
      const r = el.getBoundingClientRect();
      return (
        r.width >= FLOAT_ELEMENT_MIN_SIZE && r.height >= FLOAT_ELEMENT_MIN_SIZE
      );
    } catch {
      return false;
    }
  }

  /** content.css 文本缓存（shadow DOM 注入用，仅首次 fetch） */
  let shadowCssText = null;

  /**
   * 向 open ShadowRoot 注入译文样式副本（原版 v 递归 shadow 时的样式处理）
   * manifest 静态 CSS 无法穿透 shadow 边界，需 JS 注入；
   * CSS 变量（--it-color 等）为继承属性，可从 documentElement 穿透进 shadow
   * @param {ShadowRoot} sr 目标 ShadowRoot
   */
  async function injectShadowStyle(sr) {
    if (sr.querySelector("style[data-it-shadow]")) return;
    if (shadowCssText === null) {
      try {
        const res = await fetch(chrome.runtime.getURL("content/content.css"));
        shadowCssText = res.ok ? await res.text() : "";
      } catch {
        shadowCssText = "";
      }
    }
    if (!shadowCssText) return;
    const style = document.createElement("style");
    style.textContent = shadowCssText;
    style.setAttribute("data-it-shadow", "1");
    sr.appendChild(style);
  }

  /**
   * 应用站点规则的全局样式修正（原版 Hh，@1322805）：
   * 对命中选择器的元素追加 cssText（如解开 -webkit-line-clamp 截断，
   * 防止译文插入后被折叠隐藏）。原版 634 条规则中 72 条使用此机制
   */
  function applyGlobalStyles() {
    const gs = SITE_RULE && SITE_RULE.globalStyles;
    if (!gs || typeof gs !== "object") return;
    for (const [selector, cssText] of Object.entries(gs)) {
      let targets = [];
      try {
        targets = document.querySelectorAll(selector);
      } catch {
        continue; // 非法选择器
      }
      targets.forEach((el) => {
        el.style.cssText += `;${cssText}`;
      });
    }
  }

  /**
   * 收集页面中需要翻译的正文块——原版"文本流模型"完整移植
   * （逆向自原版 content_main.js 的 Fl/v/D/x/C/y 管线）
   * 核心思想：以"文本节点流"为翻译单元，块级元素只是段落边界的触发器：
   *   TreeWalker 混合遍历（文本+元素）→ 文本节点进 flatNodes →
   *   遇块级元素结算当前段落（flush）并以该块为新锚 → 末尾统一结算
   * 与旧"元素模型"的差异：p>a>span 混排自然归为同一段落（锚=p），
   * "标题+链接"同行混排天然分段（各自块级锚），无需任何下钻/拆分特判
   * @returns {Promise<{el: Element, text: string, targetNodes: Node[], inlineSeparator: boolean}[]>}
   */
  async function collectBlocks() {
    const result = [];
    /** 本次收集会话 id（原版 ctxId：walkMarks 防增量重复遍历） */
    const ctxId = ++walkCtxId;

    /** 当前段落的文本节点流（原版 flatNodes） */
    let flatNodes = [];
    /** BR 范围过滤前的全集（原版 flatNodes.original 回退用） */
    let flatOriginal = null;
    /** 段落锚元素（原版 commonAncestorContainer）：itDone 标记宿主 + 插入容器 */
    let anchorEl = null;
    /** 是否 pre 空白上下文（原版 T：white-space 以 pre 开头或 break-spaces） */
    let isPreWs = false;
    /** 浮动大元素剩余影响段落数（原版 hx 计数器） */
    let floatEffect = 0;

    /**
     * 开启新段落上下文（原版 C）：记录锚并检测 pre 空白上下文
     * @param {Element} el 新锚元素
     */
    function newParagraph(el) {
      anchorEl = el;
      isPreWs = false;
      try {
        const ws = getComputedStyle(el).whiteSpace;
        isPreWs = ws.startsWith("pre") || ws === "break-spaces";
      } catch {
        // 脱离文档时忽略
      }
    }

    /**
     * 结算当前段落（原版 y + Jae 完整移植）：
     *   BR 场景锚重设（lR）与范围过滤 → 尾部装饰剔除 → 全空回退 original →
     *   w1 共同祖先 → Jc 变量组装 → 有效性验证 → 产出翻译单元
     * @param {Element} [brEl] 触发结算的 BR 元素（原版 y(S) 的 S 参数）
     */
    function flush(brEl) {
      if (!flatNodes.length || !anchorEl) {
        flatNodes = [];
        flatOriginal = null;
        return;
      }
      // 原版 y：BR 触发时锚重设为块级祖先，flatNodes 收窄到 BR 父容器范围内
      if (brEl && brEl.nodeName === "BR") {
        anchorEl = findBlockAncestor(brEl) || anchorEl;
        const scoped = flatNodes.filter(
          (n) => brEl.parentNode && brEl.parentNode.contains(n),
        );
        if (scoped.length > 0 && scoped.length !== flatNodes.length) {
          flatOriginal = flatNodes;
          flatNodes = scoped;
        }
      }
      // 尾部剔除无有效文本的节点（原版 skipTrailTextRegex 为 null → 仅空白剔除）
      while (
        flatNodes.length &&
        !(flatNodes[flatNodes.length - 1].textContent || "").trim()
      ) {
        flatNodes.pop();
      }
      // 原版 Jae：收窄段无任何有效文本但过滤前全集有内容 → 回退全集
      if (
        !flatNodes.some((n) => (n.textContent || "").trim()) &&
        flatOriginal &&
        flatOriginal.length
      ) {
        flatNodes = flatOriginal.slice();
      }
      // 动态 DOM 可能已移位：仅保留已连接且仍在锚内的节点
      const nodes = flatNodes.filter(
        (n) => n.isConnected && anchorEl.contains(n),
      );
      flatNodes = [];
      flatOriginal = null;
      if (!nodes.length) return;
      // 原版 Jae→w1：共同祖先（锚回收到文本真实宿主，p>a>span 混排归位 p）
      const host = commonAncestorOf(nodes, anchorEl) || anchorEl;
      if (!host.contains(nodes[nodes.length - 1])) return;
      if (host.dataset && host.dataset.itDone === "1") return; // 已翻译过的锚
      // 原版 Jc：stayOriginal 元素变量化 + 空白归一组装
      const { text, variables } = composeParagraphText(nodes);
      if (!isValidText(text) || isMainlyNumeric(text)) return;
      const block = {
        el: host,
        text,
        variables,
        targetNodes: nodes, // 原文节点序列：插入锚点 = 最后节点的 nextSibling
        inlineSeparator: shouldInlineSeparator(text, host),
      };
      // 原版 Jae：浮动大元素后的段落消耗计数并标记（译文行内化）
      if (floatEffect > 0) {
        floatEffect--;
        block.hasFloatElement = true;
      }
      result.push(block);
    }

    /**
     * 收集节点进当前段落（原版 x）：节点不在锚内时先结算再开新锚
     * @param {Node} node 文本节点
     */
    function collect(node) {
      if (!anchorEl || !anchorEl.contains(node)) {
        flush();
        const parent = node.parentElement;
        if (parent) newParagraph(parent);
      }
      if (anchorEl) flatNodes.push(node);
    }

    /**
     * 元素级拒绝判定（原版 D 的元素分支完整移植，@1323244）：
     * 剪枝标签/插件 UI/译文自身/同会话已遍历/已处理/隐藏(gx)/排除区/微元素装饰
     * @param {Element} el 目标元素
     * @returns {boolean} true = 整棵子树跳过
     */
    function shouldRejectElement(el) {
      if (SKIP_TAGS.has(el.tagName)) return true;
      if (el.dataset && el.dataset.itUi === "1") return true;
      if (el.closest(".immersive-translate-target-wrapper")) return true;
      // 原版 D：nn.isMarked 同 ctxId 已遍历 → 拒绝（增量收集防重复）
      if (walkMarks.get(el) === ctxId) return true;
      if (el.dataset.itDone === "1") return true;
      // 原版 gx（uR 内判定）：display:none / opacity:0 隐藏；
      // hidden 属性为 demo2 实证补充（自定义样式覆盖 display 的隐藏徽章）
      if (el.hidden) return true;
      const s = getStyle(el);
      if (s && (s.display === "none" || s.opacity === "0")) return true;
      if (isNoTranslate(el)) return true;
      // 微元素装饰（原版 D：<4px 且文本 <2 字符 → 拒绝）
      if (el.childNodes.length > 0 && !isPreWs) {
        try {
          const r = el.getBoundingClientRect();
          if (
            ((r.width > 0 && r.width < 4) || (r.height > 0 && r.height < 4)) &&
            (el.textContent || "").trim().length < 2
          ) {
            return true;
          }
        } catch {
          // 忽略
        }
      }
      return false;
    }

    /**
     * 文本节点过滤（原版 D 的文本分支完整移植）：
     * 空文本仅 nbsp 排版/pre 场景接受；父容器在剪枝/排除/隐藏/微容器时拒绝
     * @param {Node} node 文本节点
     * @returns {number} NodeFilter 常量
     */
    function filterTextNode(node) {
      const raw = node.textContent || "";
      const t = raw.trim();
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (!t) {
        // 原版 D：纯 nbsp 排版 / pre 空白场景接受（保留排版空白）
        if (
          isPreWs ||
          /^\u00A0+$/.test(raw) ||
          /^(&nbsp;)+$/.test((parent.innerHTML || "").trim())
        ) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_REJECT;
      }
      if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.closest(".immersive-translate-target-wrapper")) {
        return NodeFilter.FILTER_REJECT;
      }
      if (parent.dataset && parent.dataset.itUi === "1") {
        return NodeFilter.FILTER_REJECT;
      }
      // 原版 gx：display:none / opacity:0 隐藏容器（hidden 属性为 demo2 实证补充）
      if (parent.hidden) return NodeFilter.FILTER_REJECT;
      const s = getStyle(parent);
      if (s && (s.display === "none" || s.opacity === "0")) {
        return NodeFilter.FILTER_REJECT;
      }
      if (isNoTranslate(parent)) return NodeFilter.FILTER_REJECT;
      // 原版 D：父容器 <4px 宽/高 → 装饰性微容器拒绝
      try {
        const r = parent.getBoundingClientRect();
        if ((r.width > 0 && r.width < 4) || (r.height > 0 && r.height < 4)) {
          return NodeFilter.FILTER_REJECT;
        }
      } catch {
        // 忽略
      }
      return NodeFilter.FILTER_ACCEPT;
    }

    /**
     * 对根元素执行文本流遍历（原版 v 主循环完整移植，@1321306）：
     *   根拒绝直接返回 → TreeWalker 混合遍历（filter=D+sR+mark）→
     *   FONT 残留译文清理 → 块边界结算（BR 场景传参）→ open shadow 递归 →
     *   50 节点时间分片
     * @param {Element|ShadowRoot} root 遍历根（ShadowRoot 递归时为 DocumentFragment）
     */
    async function walk(root) {
      // ShadowRoot（DocumentFragment）无 closest/dataset，原版 D 直接 ACCEPT
      const isFrag = root.nodeType === Node.DOCUMENT_FRAGMENT_NODE;
      // 原版 v：根节点先过 D，REJECT 整根放弃
      if (!isFrag && shouldRejectElement(root)) return;
      if (!isFrag) walkMarks.set(root, ctxId); // 原版 nn.mark(根)
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
        {
          acceptNode(node) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // 原版 D：浮动大元素（float≠none 且 ≥140×140）重置影响计数，
              // 其后 4 个段落标记 hasFloatElement（译文行内化防挤开浮动图）
              const fst = getStyle(node);
              if (
                fst &&
                fst.float &&
                fst.float !== "none" &&
                floatEffectRelatedSize(node)
              ) {
                floatEffect = FLOAT_BLOCK_EFFECT_PARAGRAPHS;
              }
              if (shouldRejectElement(node)) {
                // 原版 sR：拒绝的块元素含嵌套子树 → 结算前文段落
                //（防止排除块前后的文本错误连成一段）
                if (
                  node.childNodes.length >= 1 &&
                  node.childNodes[0] &&
                  node.childNodes[0].childNodes &&
                  node.childNodes[0].childNodes.length >= 1 &&
                  itIsBlock(node)
                ) {
                  flush();
                }
                return NodeFilter.FILTER_REJECT;
              }
              walkMarks.set(node, ctxId); // 原版 nn.mark
              return NodeFilter.FILTER_ACCEPT;
            }
            return filterTextNode(node);
          },
        },
      );
      let count = 0;
      let cur = walker.nextNode();
      while (cur) {
        // 时间分片（原版 v：每 50 节点 checkpoint，不冻结 UI）
        if (++count % 50 === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
        if (cur.nodeType === Node.ELEMENT_NODE) {
          // 原版 v：残留译文 FONT 清理（还原不彻底/外部修改场景）
          if (
            cur.tagName === "FONT" &&
            String(cur.className).includes("immersive-translate-target-wrapper")
          ) {
            cur.remove();
            cur = walker.nextSibling();
            continue;
          }
          // 原版 v + xs：open shadowRoot 递归遍历（组件库文档等场景，
          // manifest 静态 CSS 不穿透 shadow 边界，需 JS 注入样式副本）
          if (cur.shadowRoot && cur.shadowRoot.mode === "open") {
            injectShadowStyle(cur.shadowRoot);
            await walk(cur.shadowRoot);
          }
          let boundary = itIsBlock(cur);
          cur.__itIsBlock = boundary; // 原版 L.isBlock=q（lR 沿用此缓存）
          // 原版 v：Drop-cap 例外——单字母首字且字号 ≥35px 不单独成段
          if (
            boundary &&
            cur.childNodes.length === 1 &&
            cur.childNodes[0].nodeType === Node.TEXT_NODE &&
            (cur.innerText || "").length === 1
          ) {
            const fs = parseFloat(getStyle(cur)?.fontSize) || 0;
            if (fs >= DROP_CAP_FONT_SIZE) boundary = false;
          }
          if (boundary) {
            // 原版 y(F)+C：结算前文段落（BR 场景传参触发锚重设）并以该块为新锚
            flush(cur.tagName === "BR" ? cur : undefined);
            newParagraph(cur);
          }
          // 行内/容器元素不结算：walker 继续深入，其文本节点由 collect 收集
        } else {
          collect(cur);
        }
        cur = walker.nextNode();
      }
      flush();
    }

    // 站点规则白名单模式（原版 selectors 语义）：只翻译规则命中的元素子树，
    // 避免通用引擎全页扫描误伤站点 UI（计数徽章、用户名、面包屑等）
    if (
      SITE_RULE &&
      Array.isArray(SITE_RULE.selectors) &&
      SITE_RULE.selectors.length
    ) {
      const hits = new Set();
      for (const sel of SITE_RULE.selectors) {
        let els;
        try {
          els = document.querySelectorAll(sel);
        } catch {
          continue; // 非法选择器跳过
        }
        els.forEach((el) => {
          if (!el.isConnected) return;
          hits.add(el);
        });
      }
      // 祖先去重：命中元素若已有祖先在集合中，由祖先统一处理
      const roots = [...hits].filter(
        (el) => ![...hits].some((o) => o !== el && o.contains(el)),
      );
      for (const root of roots) await walk(root);
      return result;
    }

    await walk(document.body);
    return result;
  }

  /**
   * 判断元素是否声明了"不翻译"（借鉴 FluentRead：尊重页面标记）
   * @param {Element} el 目标元素
   * @returns {boolean} 是否禁止翻译
   */
  function isNoTranslate(el) {
    return (
      el.classList.contains("notranslate") ||
      el.getAttribute("translate") === "no" ||
      el.getAttribute("data-notranslate") === "true" ||
      // 原版自定义标记：react.dev 页脚用 default-translate="no"（demo1 实证）
      el.getAttribute("default-translate") === "no" ||
      // 编程语言名标记（GitHub 语言标签，demo1 实证原版不翻 "TypeScript"/"Python"）
      el.getAttribute("itemprop") === "programmingLanguage" ||
      // 装饰性文本（demo1 实证硬约束）：视觉隐藏类 + kbd 快捷键不翻
      isDecorative(el) ||
      // 站点规则排除区域（原版 excludeSelectors：含祖先匹配，命中即整块不翻）
      (SITE_EXCLUDE_SELECTORS.length > 0 &&
        matchesAnySelector(el, SITE_EXCLUDE_SELECTORS, true))
    );
  }

  /**
   * 判断文本是否主要为数字/符号/用户名格式（无翻译价值，借鉴 FluentRead）
   * @param {string} text 文本
   * @returns {boolean} 是否主要为数字类内容
   */
  function isMainlyNumeric(text) {
    // 纯数字、价格、日期、百分号等组合
    if (/^[\d\s.,:;/\-+%$€£¥₹()]+$/.test(text)) return true;
    // 数字 + 数量级后缀（124k / 3.9k / 2M）：星标计数类，无翻译价值
    if (/^\d+(\.\d+)?\s*[kmb]$/i.test(text)) return true;
    // 社交媒体用户名（@xxx）
    if (/^@\w+/.test(text)) return true;
    return false;
  }

  /**
   * 译文分隔符判定：是否用同行 nbsp（否则 br 换行）
   * 逆向自原版 content_main.js 的 qh 函数（wrapperPrefix="smart" 实现）：
   *   词数 ≤ blockMinWordCount(4) 且 字符 ≤ blockMinTextCount(24) 且 单行 → 行内；
   *   宿主 display 含 flex → 强制行内
   * 与"看容器形态"的旧启发式不同，原版是纯文本量驱动，天然适应任意站点
   * @param {string} text 段落文本
   * @param {Element} target 插入宿主元素
   * @returns {boolean} true = nbsp 同行；false = br 换行
   */
  function shouldInlineSeparator(text, target) {
    if (target) {
      try {
        const d = getComputedStyle(target).display;
        if (d && d.includes("flex")) return true;
      } catch {
        // 脱离文档时忽略，按文本量判定
      }
    }
    const t = text.trim();
    const words = t.split(/\s+/).filter(Boolean).length;
    return words <= 4 && t.length <= 24 && !/\n/.test(t);
  }

  /**
   * 判断元素是否为装饰性元素（其文本不应参与翻译）
   * 规则（demo1 实证原版行为）：kbd 快捷键不翻；视觉隐藏文本不翻
   * 视觉隐藏类名覆盖主流约定：Tailwind(sr-only)、WordPress(screen-reader-text)、
   * 常见手写(visualy-hidden/visuallyhidden/offscreen 等)
   * @param {Element} el 目标元素
   * @returns {boolean} 是否装饰性元素
   */
  function isDecorative(el) {
    if (el.tagName === "KBD") return true;
    const cls = el.className;
    if (typeof cls !== "string" || !cls) return false;
    return (
      /\bsr-only\b/.test(cls) ||
      /\bvisually-?hidden\b/.test(cls) ||
      /\bscreen-reader(-text)?\b/.test(cls) ||
      /\boffscreen\b/.test(cls) ||
      /\bhidden-visually\b/.test(cls)
    );
  }

  /**
   * 判断文本是否有翻译价值（长度达标且非纯符号/数字）
   * @param {string} text 文本
   * @returns {boolean} 是否有效
   */
  function isValidText(text) {
    if (!text) return false;
    const min = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text) ? 2 : 3;
    if (text.length < min) return false;
    // 原版 noTranslateRegexp：相对时间、阅读时长、单字母等无翻译价值文本
    if (NO_TRANSLATE_REGEXPS.some((re) => re.test(text))) return false;
    return /[a-zA-Z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u0400-\u04ff\u0600-\u06ff]/.test(
      text,
    );
  }

  // -----------------------------------------------------------------------
  // 译文渲染（DOM 结构与原版沉浸式翻译一致）
  // -----------------------------------------------------------------------

  /**
   * 构建原版结构的译文包装元素（DOM 结构与类名均对齐 demo1 实证）
   * 换行场景：
   *   <font class="notranslate immersive-translate-target-wrapper" lang="to">
   *     <br>
   *     <font class="notranslate pre-whitespace ...-block-wrapper">
   *       <font class="notranslate ...target-inner">(Spinner/译文)</font>
   *     </font>
   *   </font>
   * 同行场景（标题/菜单/按钮）：
   *   <font class="notranslate immersive-translate-target-wrapper" lang="to">
   *     <font class="notranslate">&nbsp;&nbsp;</font>
   *     <font class="notranslate ...-inline-wrapper">
   *       <font class="notranslate ...target-inner">(Spinner/译文)</font>
   *     </font>
   *   </font>
   * @param {string} separator 分隔符类型：'nbsp'（同行双空格）| 'br'（换行）| 'none'（仅译文模式无分隔）
   * @param {string} to 目标语言代码（写入 lang）
   * @param {boolean} loading 初始是否为加载态（Spinner）
   * @returns {HTMLElement} wrapper 根元素
   */
  function buildTranslationWrapper(separator, to, loading) {
    const wrapper = document.createElement("font");
    wrapper.className = "notranslate immersive-translate-target-wrapper";
    wrapper.lang = to;
    wrapper.setAttribute(
      "data-immersive-translate-translation-element-mark",
      "1",
    );

    // 分隔符：与原版一致（标题/行内 → 双空格；段落/列表 → 换行；仅译文 → 无）
    // data-it-sep 标记供显示模式状态机识别（仅译文模式下隐藏分隔符）
    if (separator === "nbsp") {
      const gap = document.createElement("font");
      gap.className = "notranslate";
      gap.setAttribute("data-it-sep", "1");
      gap.setAttribute(
        "data-immersive-translate-translation-element-mark",
        "1",
      );
      gap.innerHTML = "&nbsp;&nbsp;";
      wrapper.appendChild(gap);
    } else if (separator === "br") {
      const br = document.createElement("br");
      br.setAttribute("data-it-sep", "1");
      wrapper.appendChild(br);
    }

    // 译文行内容器：换行场景用 block-wrapper（原版 CSS：margin 8px 0 + inline-block），
    // 同行场景用 inline-wrapper；block 场景附加 pre-whitespace 保留译文空白
    const isBlock = separator === "br";
    const secondLayer = document.createElement("font");
    secondLayer.className =
      "notranslate" +
      (isBlock
        ? " immersive-translate-target-translation-pre-whitespace" +
          " immersive-translate-target-translation-theme-none" +
          " immersive-translate-target-translation-block-wrapper-theme-none" +
          " immersive-translate-target-translation-block-wrapper"
        : " immersive-translate-target-translation-theme-none" +
          " immersive-translate-target-translation-inline-wrapper-theme-none" +
          " immersive-translate-target-translation-inline-wrapper");
    secondLayer.setAttribute(
      "data-immersive-translate-translation-element-mark",
      "1",
    );

    // 译文最内层元素（loading 态显示 Spinner，样式纯继承原文）
    const inner = document.createElement("font");
    inner.className =
      "notranslate" +
      " immersive-translate-target-inner" +
      " immersive-translate-target-translation-theme-none-inner";
    inner.setAttribute(
      "data-immersive-translate-translation-element-mark",
      "1",
    );
    if (loading) {
      inner.setAttribute("data-pending", "1");
      inner.className += " immersive-translate-target-translation-loading";
      const spinner = document.createElement("span");
      spinner.className = "immersive-translate-loading-spinner";
      inner.appendChild(spinner);
    }

    secondLayer.appendChild(inner);
    wrapper.appendChild(secondLayer);
    return wrapper;
  }

  /**
   * 填充译文内容并解除加载态（转义 + 换行转 <br>）
   * @param {HTMLElement} inner 译文最内层 font 元素
   * @param {string} text 译文文本
   */
  function fillTranslation(inner, text) {
    const safe = String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    inner.className = inner.className.replace(
      /\s*immersive-translate-target-translation-loading/g,
      "",
    );
    inner.innerHTML = safe.replace(/\r?\n/g, "<br>");
    inner.removeAttribute("data-pending");
  }

  /**
   * 设置错误提示（替换加载态），可附带"重试"按钮
   * @param {HTMLElement} inner 译文最内层 font 元素
   * @param {string} msg 错误信息
   * @param {Object} [b] 翻译单元（提供时显示重试按钮）
   */
  function setTranslationError(inner, msg, b) {
    inner.className = inner.className.replace(
      /\s*immersive-translate-target-translation-loading/g,
      "",
    );
    inner.classList.add("immersive-translate-target-translation-error");
    inner.textContent = "⚠ " + msg;
    inner.removeAttribute("data-pending");
    if (b) {
      const retry = document.createElement("a");
      retry.className = "it-retry-link";
      retry.textContent = "重试";
      retry.href = "javascript:void(0)";
      retry.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        resetToLoading(b);
        doTranslateBatch([b]).catch(() => {});
      });
      inner.appendChild(document.createTextNode(" "));
      inner.appendChild(retry);
    }
  }

  /**
   * 将翻译单元重置回加载态（用于失败重试）
   * @param {Object} b 翻译单元
   */
  function resetToLoading(b) {
    if (!b.inner) return;
    b.inner.className =
      "notranslate" +
      " immersive-translate-target-inner" +
      " immersive-translate-target-translation-theme-none-inner" +
      " immersive-translate-target-translation-loading";
    b.inner.setAttribute("data-pending", "1");
    b.inner.textContent = "";
    const spinner = document.createElement("span");
    spinner.className = "immersive-translate-loading-spinner";
    b.inner.appendChild(spinner);
  }

  /**
   * 将用户设置的样式变量写入页面根元素（变量名与原版一致）
   * 颜色策略：默认/勾选"跟随原文"时移除 --it-color，译文继承原文颜色；
   * 仅当用户明确选择了自定义颜色时才生效（旧默认紫色 #6a5cff 视为未设置）
   * @param {Object} style 样式设置 {color, followColor, bold, fontSize}
   * @param {string} to 目标语言（写入根元素状态属性）
   */
  function applyStyleVars(style, to) {
    const root = document.documentElement;
    const customColor =
      !style.followColor && style.color && style.color !== "#6a5cff"
        ? style.color
        : "";
    if (customColor) {
      root.style.setProperty("--it-color", customColor);
    } else {
      root.style.removeProperty("--it-color");
    }
    root.style.setProperty("--it-font-size", style.fontSize || "inherit");
    root.style.setProperty("--it-weight", style.bold ? "600" : "inherit");
    // 根元素状态属性与原版一致（dual：双语模式；after：译文在原文后）
    root.setAttribute(
      "imt-state",
      session.display === "single" ? "translation" : "dual",
    );
    root.setAttribute("imt-translation-dir", "ltr");
    root.setAttribute("imt-trans-position", "after");
  }

  // -----------------------------------------------------------------------
  // 页面 UI 组件：悬浮球 + 划词翻译
  // -----------------------------------------------------------------------

  /** 悬浮球元素引用 */
  let floatBall = null;
  /** 划词翻译是否启用 */
  let selectionEnabled = false;
  /** 划词译文卡片元素引用 */
  let selectionPopup = null;
  /** 划词防抖定时器 */
  let selectionTimer = null;

  /**
   * 初始化页面 UI 组件（读取设置决定悬浮球与划词翻译的启用状态）
   */
  async function initUIComponents() {
    // iframe 场景不挂页面级 UI（悬浮球/划词卡只出现在顶层 frame）
    if (window.self !== window.top) {
      selectionEnabled = false;
      return;
    }
    const data = await chrome.storage.sync.get("it_settings");
    const cfg = data.it_settings || {};
    if (cfg.showFloatBall !== false) {
      mountFloatBall();
    } else {
      unmountFloatBall();
    }
    selectionEnabled = cfg.selectionTranslate !== false;
  }

  /**
   * 挂载悬浮球（点击切换翻译，可垂直拖动，位置记忆到 localStorage）
   */
  function mountFloatBall() {
    if (floatBall) return;
    floatBall = document.createElement("div");
    floatBall.className = "it-float-ball";
    floatBall.dataset.itUi = "1";
    floatBall.title = "点击翻译 / 还原（可拖动）";
    floatBall.textContent = "译";
    // 恢复上次拖动位置（仅垂直方向，水平固定在右侧）
    const savedTop = localStorage.getItem("it-ball-top");
    floatBall.style.top = savedTop || "45%";
    document.body.appendChild(floatBall);

    // 拖动 + 点击判定（位移小于 4px 视为点击）
    floatBall.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startTop = floatBall.getBoundingClientRect().top;
      let moved = false;
      const onMove = (ev) => {
        const dy = ev.clientY - startY;
        if (Math.abs(dy) > 4) moved = true;
        if (moved) {
          const top = Math.max(
            8,
            Math.min(window.innerHeight - 56, startTop + dy),
          );
          floatBall.style.top = top + "px";
        }
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (moved) {
          localStorage.setItem("it-ball-top", floatBall.style.top);
        } else {
          toggleTranslation(); // 视为点击：切换翻译
        }
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    updateFloatBall();
  }

  /**
   * 卸载悬浮球
   */
  function unmountFloatBall() {
    if (floatBall) {
      floatBall.remove();
      floatBall = null;
    }
  }

  /**
   * 同步悬浮球外观（翻译中转圈 / 已翻译高亮 / 未翻译默认）
   */
  function updateFloatBall() {
    if (!floatBall) return;
    floatBall.classList.toggle("it-active", state.translated);
    floatBall.classList.toggle("it-loading", state.translating);
  }

  /**
   * 初始化划词翻译的全局事件监听
   */
  function initSelectionListeners() {
    // 鼠标抬起：防抖后处理选区
    document.addEventListener("mouseup", (e) => {
      if (!selectionEnabled) return;
      if (e.target.closest && e.target.closest("[data-it-ui]")) return;
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(handleSelection, 180);
    });
    // 鼠标按下：点击卡片外部时关闭卡片
    document.addEventListener("mousedown", (e) => {
      if (selectionPopup && !selectionPopup.contains(e.target)) {
        hideSelectionPopup();
      }
    });
  }

  /**
   * 处理当前选区：有效则弹出译文卡片
   */
  function handleSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return hideSelectionPopup();
    const text = sel.toString().trim();
    if (!text || text.length < 2 || text.length > 2000) {
      return hideSelectionPopup();
    }
    // 输入框内的选择不处理
    const anchor = sel.anchorNode && sel.anchorNode.parentElement;
    if (
      anchor &&
      (anchor.tagName === "INPUT" || anchor.tagName === "TEXTAREA")
    ) {
      return;
    }
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;
    showSelectionPopup(rect, text);
  }

  /**
   * 在选区附近弹出译文卡片（先显示加载态，翻译完成后填充）
   * @param {DOMRect} rect 选区的页面坐标矩形
   * @param {string} text 待翻译文本
   */
  function showSelectionPopup(rect, text) {
    hideSelectionPopup();
    selectionPopup = document.createElement("div");
    selectionPopup.className = "it-selection-popup";
    selectionPopup.dataset.itUi = "1";
    // 右上角关闭按钮（点击即关卡片）
    const close = document.createElement("button");
    close.className = "it-selection-close";
    close.title = "关闭";
    close.textContent = "×";
    close.addEventListener("click", hideSelectionPopup);
    selectionPopup.appendChild(close);
    const loading = document.createElement("div");
    loading.className = "it-selection-loading";
    const spinner = document.createElement("span");
    spinner.className = "immersive-translate-loading-spinner";
    loading.appendChild(spinner);
    selectionPopup.appendChild(loading);
    document.body.appendChild(selectionPopup);

    // 定位：优先选区下方，空间不足则放上方；水平居中于选区并夹在视口内
    const POPUP_W = 320;
    let left = rect.left + rect.width / 2 - POPUP_W / 2;
    left = Math.max(8, Math.min(window.innerWidth - POPUP_W - 8, left));
    let top = rect.bottom + 8;
    if (top + 96 > window.innerHeight) top = rect.top - 96 - 8;
    selectionPopup.style.left = left + "px";
    selectionPopup.style.top = Math.max(8, top) + "px";

    // 使用当前设置的翻译服务翻译选中文本
    (async () => {
      try {
        const data = await chrome.storage.sync.get("it_settings");
        const cfg = data.it_settings || {};
        const resp = await chrome.runtime.sendMessage({
          type: "TRANSLATE_BATCH",
          texts: [text],
          from: cfg.from || "auto",
          to: cfg.to || "zh-CN",
        });
        if (!selectionPopup) return;
        selectionPopup.textContent = "";
        if (resp && resp.ok) {
          const result = document.createElement("div");
          result.className = "it-selection-result";
          result.textContent = resp.translations[0] || text;
          const copy = document.createElement("button");
          copy.className = "it-selection-copy";
          copy.textContent = "复制";
          copy.addEventListener("click", () => {
            navigator.clipboard
              .writeText(result.textContent)
              .then(() => {
                copy.textContent = "已复制";
              })
              .catch(() => {});
          });
          selectionPopup.appendChild(result);
          selectionPopup.appendChild(copy);
        } else {
          const errBox = document.createElement("div");
          errBox.className = "it-selection-error";
          errBox.textContent = "⚠ " + ((resp && resp.error) || "翻译失败");
          selectionPopup.appendChild(errBox);
        }
        selectionPopup.appendChild(close);
      } catch (err) {
        if (selectionPopup) {
          selectionPopup.textContent = "";
          const errBox = document.createElement("div");
          errBox.className = "it-selection-error";
          errBox.textContent = "⚠ " + (err.message || "翻译异常");
          selectionPopup.appendChild(errBox);
          selectionPopup.appendChild(close);
        }
      }
    })();
  }

  /**
   * 关闭划词译文卡片
   */
  function hideSelectionPopup() {
    if (selectionPopup) {
      selectionPopup.remove();
      selectionPopup = null;
    }
  }

  // 启动：初始化悬浮球与划词翻译
  initUIComponents();
  initSelectionListeners();
})();
