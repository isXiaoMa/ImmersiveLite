/**
 * 站点规则层（架构对齐原版沉浸式翻译：站点规则 > 通用引擎兜底）
 * 数据来源：原版插件 default_config.json（Firefox 商店 1.32.5 版解包提取），
 * 仅保留网页翻译相关字段（selectors / excludeSelectors / extraBlockSelectors 等），
 * 忽略字幕、PDF、AI 写作等本插件不支持的字段。
 */

/**
 * 通用基线参数（原版 generalRule 关键字段，用于增强通用引擎）
 */
const IT_GENERAL_RULE = {
  /** 无翻译价值文本正则（原版 noTranslateRegexp）：相对时间、阅读时长、单字母、零宽字符等 */
  noTranslateRegexp: [
    "^\\d+.+ago$", // 3 days ago / 2 hours ago
    "^\\d+\\s+MIN\\s+READ$", // 5 MIN READ
    "^[\\u200B\\u200C\\u200D\\u2060\\uFEFF]+$", // 零宽字符
    "^[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]$", // 单个 emoji（代理对）
    "^[a-zA-Z]{1}$", // 单字母
    "^[•↓ · ]$", // 单符号
  ],
  /** 强制视为块级的选择器（原版 extraBlockSelectors：列表项/控件/自定义元素） */
  extraBlockSelectors: ["ul > li", "label", "button", "option", "turbo-frame"],
  /** 强制视为行内的选择器（原版 extraInlineSelectors：命中则非段落边界） */
  extraInlineSelectors: [
    "p a span",
    "article a span",
    "p > span a span",
    'a[data-testid="Link"] span',
  ],
  /** 原子块选择器（原版 atomicBlockSelectors：命中则强制不拆段） */
  atomicBlockSelectors: ["relin-hc", "x-p", "app-keyword-content"],
};

/**
 * 站点规则精选（原版 rules 数组，按使用价值裁剪）
 * 字段说明：
 *   matches               域名/URL 匹配模式（纯域名=含子域；含路径/* =通配）
 *   excludeMatches        命中则整页不翻译
 *   selectors             翻译白名单（命中元素才翻译，覆盖通用引擎全页扫描）
 *   excludeSelectors      排除区域（元素及其子树不翻译）
 *   extraBlockSelectors   追加强制块级选择器
 */
const IT_SITE_RULES = [
  {
    id: "github",
    matches: ["github.com"],
    excludeMatches: [
      "https://github.com/*/*/settings",
      "https://github.com/*/*/settings/*",
      "https://github.com/settings/*",
      "https://github.com/sponsors/*",
      "https://github.com/readme/*",
      "https://github.com/readme/",
      "https://github.com/features/*",
      "https://github.com/codespaces",
      "https://github.com/customer-stories/*",
      "https://github.com/signup",
      "https://github.com/login",
      "https://github.com/marketplace",
      "https://github.com/github-copilot*",
      "https://github.com/collections*",
      "https://github.com/resources/events*",
      "https://github.com/pricing*",
    ],
    selectors: [
      "h1",
      "[aria-label=Issues] .markdown-title",
      "[aria-labelledby=discussions-list] .markdown-title",
      "h3 .markdown-title",
      ".markdown-body",
      ".Layout-sidebar p",
      "div > span.search-match",
      "li.repo-list-item p",
      "#responsive-meta-container p",
      "article p",
      "feed-container article ul li a span",
      "feed-container article .FormControl-caption",
      "div.repo-description p",
      "[itemprop=description]",
      ".integrations-auth-wrapper",
      ".new-feed-onboarding-notice",
      "article section[aria-label='card content'] > div > div > div > div:nth-child(2)",
      ".js-notice h2, .js-notice p",
      ".TimelineItem-body a span, .TimelineItem-body a div, .TimelineItem-body form span, .TimelineItem-body form div",
      '[role="navigation"] p',
      '[data-testid="commit-row-item"] h4',
      ".font-mktg",
      ".search-title,.search-match",
      ".pinned-item-desc",
      "#repo-content-turbo-frame .markdown-title",
      "[app-name='blackbird-search'] [data-hpc='true']",
      ".topic-box > a > p:nth-of-type(2)",
      '[data-testid="listitem-title-link"]',
      "#repo-content-turbo-frame p",
      "#repo-content-turbo-frame h4",
      '[aria-label="card content"] .flex-column > div:nth-child(2)',
      "[class*=TitleHeader]",
      ".discussion-title",
      ".heading-element",
      ".js-feed-item-component h3 a[data-hovercard-type=pull_request]",
      "[aria-labelledby=outline-id] nav",
      "[data-testid='issue-pr-title-link']",
      "div.user-profile-bio",
      "div.news > div.js-notice",
      "[id^=pullrequestreview]",
      "a[data-hovercard-type='issue']",
      "[data-testid='beginners-playlist-section']",
      "[data-testid='getting-started-checklist-section']",
      "[data-testid='docs-section']",
      "[data-testid='recommendations-section']",
      ".feed-item-content section[data-view-component] [class='flex-1 d-flex flex-column'] div:nth-child(2)",
      "dialog-helper",
      ".blankslate-heading",
      ".activity-overview-box",
      "#spaces-list",
      ".BannerDescription",
      "article [class='f6 color-fg-muted mt-1']",
    ],
    excludeSelectors: [
      "[data-test-selector='commit-tease-commit-message']",
      "[data-test-selector='create-branch.developmentForm']",
      "div.Box-header.position-relative",
      "div.blob-wrapper-embedded",
      "div.Box.Box--condensed.my-2",
      "div.jp-CodeCell",
      '[aria-label="Account"] .markdown-title',
      ".js-repos-container .markdown-title",
      "a.anchor",
      "div.file-navigation + div.Box",
      "[data-testid^='breadcrumbs']",
      "[data-ga-click*=Star]",
      ".markdown-body h3",
      "div.vcard-names-container",
      "div.js-disable-context-menu",
      ".BorderGrid-cell a[role='link']",
      ".BorderGrid-cell .topic-tag-link",
      "table[class*='Table-module__Box']",
      ".author,.assignee",
      ".blob-code",
      ".timeline-comment-header",
      ".review-thread-reply",
      ".codeRepository",
      "a[data-hovercard-type]",
      "[title='Label: Private']",
      "[aria-label*='language']",
      ".js-suggested-changes-blob.diff-view",
      "h1[data-component=PH_Title] span[class*='issueNumberText']",
    ],
    extraBlockSelectors: ["bdi"],
    /** 原版 globalStyles：解开时间线的 line-clamp 截断，防译文被折叠 */
    globalStyles: {
      ".TimelineItem-body .Link--primary": "-webkit-line-clamp: unset;",
    },
  },
  {
    id: "github-gist",
    matches: ["gist.github.com"],
    selectors: [".markdown-body", ".readme"],
  },
  {
    id: "stackoverflow",
    matches: [
      "stackoverflow.com",
      "*.stackexchange.com",
      "superuser.com",
      "askubuntu.com",
      "serverfault.com",
    ],
    excludeSelectors: [
      ".votecell",
      "header",
      "#footer",
      "#question-header + div",
      "div.postcell div.mb0",
      "div[id^=comments-link-]",
      "#answers-header",
      ".new-post-login",
      ".form-submit",
      "a[href='/questions/ask']",
      "#left-sidebar",
      "a.comment-user",
      "span.comment-date",
      "div.s-prose.js-post-body + div",
      ".bottom-notice",
      "div[data-campaign-name=stk]",
      ".s-post-summary--stats",
      ".s-post-summary--meta",
    ],
    extraBlockSelectors: ["span.comment-copy"],
    /** 原版 globalStyles：解开问题列表摘要的 line-clamp 截断 */
    globalStyles: {
      ".s-post-summary--content-excerpt": "-webkit-line-clamp:unset;",
    },
  },
  {
    id: "wikipedia",
    matches: ["*.wikipedia.org"],
    excludeSelectors: [
      ".mw-editsection",
      ".mw-cite-backlink",
      "#p-lang-btn",
      "#right-navigation",
      "#p-associated-pages",
      ".vector-header",
      ".lazy-image-placeholder",
    ],
  },
  {
    id: "hackernews",
    matches: ["news.ycombinator.com"],
    excludeMatches: [
      "https://news.ycombinator.com/submit",
      "https://news.ycombinator.com/newsfaq.html",
      "https://news.ycombinator.com/newsguidelines.html",
      "https://news.ycombinator.com/security.html",
    ],
    selectors: [
      ".titleline > a",
      ".comment > .commtext",
      ".toptext",
      "a.hn-item-title",
      ".hn-comment-text",
      ".hn-story-title",
    ],
    excludeSelectors: [".reply", ".comhead", ".subtext"],
  },
  {
    id: "reddit",
    matches: ["www.reddit.com"],
    excludeMatches: [
      "https://www.reddit.com/r/*/wiki/*",
      "https://www.reddit.com/settings/*",
      "https://www.reddit.com/message/sent/*",
    ],
    selectors: [
      "#search-results-tab-slot",
      "h1",
      ".PostHeader__post-title-line",
      "[data-click-id=body] h3",
      "[data-click-id=background] h3",
      "[data-testid=comment]",
      "[data-adclicklocation='title'] h3",
      "[data-testid='post-title-text']",
      "[data-testid=search-subreddit-desc-text]",
      "[slot=comment]",
      "[data-adclicklocation=media]",
      ".PostContent",
      ".post-content",
      ".Comment__body",
      "faceplate-batch .md",
      "[slot=text-body]",
      "p.title > a",
      "[role=main] .md-container",
      "#-post-rtjson-content",
      ".RichTextJSON-root",
      "[slot='title']",
      ".room-message-text",
      "#response-container",
      "#streaming-response",
      "[noun='recommendation']",
      "#subgrid-container h1, #subgrid-container h2",
      ".i18n-subreddit-description",
      "#response-container_streaming",
      "search-telemetry-tracker > a.text-neutral-content-strong",
      "span[data-testid='guides-title']",
      ".rendererd-rtjson > p",
      "community-recommendation p",
    ],
    excludeSelectors: [".text-neutral-content-weak"],
  },
  {
    id: "npmjs",
    matches: ["https://www.npmjs.com/package/*"],
    selectors: ["#tabpanel-readme > div:first-child"],
  },
  {
    id: "substack",
    matches: ["*.substack.com", "newsletter.rootsofprogress.org"],
    excludeSelectors: [
      ".publication-footer",
      ".subscribe-footer",
      ".main-menu",
      ".navbar-title-link",
      "[data-testid='navbar']",
      ".navbar-title",
      ".captioned-button-wrap",
      ".subscription-widget-wrap",
      ".tweet-header",
      ".tweet-link-bottom",
      ".expanded-link",
      ".meta-subheader",
      ".comment-meta",
      ".comment-actions",
    ],
    extraBlockSelectors: [
      ".reader2-post-title",
      ".tweet-link-top",
      ".tweet-link-bottom",
      ".expanded-link",
    ],
  },
  {
    id: "quora",
    matches: ["*.quora.com", "quora.com"],
    excludeSelectors: [
      ".dom_annotate_multifeed_bundle_AskQuestionPromptBundle",
      ".dom_annotate_feed_switcher",
      "[class='q-box qu-py--small qu-color--gray_light']",
      "[class='q-box spacing_log_answer_header']",
      "[class='q-box qu-flex--auto']",
      "[class='q-text qu-dynamicFontSize--small qu-mt--small qu-color--gray_light qu-passColorToLinks']",
      ".AnswerFooter___StyledFlex-sc-2xbo88-0",
      "[class='q-box qu-mb--small']",
      "button.q-click-wrapper",
      "[class='q-text qu-dynamicFontSize--tiny qu-pb--tiny qu-mt--small qu-color--gray_light qu-passColorToLinks']",
      "[class='q-text qu-dynamicFontSize--tiny qu-mt--small qu-color--gray_light qu-passColorToLinks']",
      ".qt_read_more",
      "[class='q-flex qu-alignItems--flex-start']",
      "[class='q-box qu-pl--tiny']",
      ".qu-zIndex--action_bar",
    ],
  },
  {
    id: "producthunt",
    matches: ["www.producthunt.com"],
    excludeMatches: ["https://www.producthunt.com/stories/*"],
    excludeSelectors: [
      ".styles_extraInfo__Xs_5Y",
      '[data-test="show-more-shoutouts-button"]',
      ".styles_buttons__kKy_S",
      ".styles_count___6_8F",
    ],
  },
];

/**
 * 将通配符模式编译为正则（* → 任意串，其余字符转义）
 * @param {string} pattern 匹配模式
 * @returns {RegExp} 编译后的正则
 */
function itPatternToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$");
}

/**
 * 判断单个模式是否命中 URL
 * 纯域名（无 / 无 *）按 hostname 全等或子域后缀匹配（对齐原版语义）；
 * 含路径或 * 的模式补全协议后对完整 URL 通配匹配
 * @param {string} pattern 匹配模式
 * @param {URL} url 解析后的 URL 对象
 * @returns {boolean} 是否命中
 */
function itMatchPattern(pattern, url) {
  if (!pattern.includes("/") && !pattern.includes("*")) {
    return url.hostname === pattern || url.hostname.endsWith("." + pattern);
  }
  let p = pattern;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) p = "https://" + p;
  const full = url.protocol + "//" + url.host + url.pathname + url.search;
  return itPatternToRegExp(p).test(full);
}

/**
 * 匹配当前页面的站点规则（未命中返回 null）
 * @param {string} href 页面 URL
 * @returns {Object|null} 命中的规则对象
 */
function itMatchSiteRule(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  for (const rule of IT_SITE_RULES) {
    const pats = Array.isArray(rule.matches) ? rule.matches : [rule.matches];
    if (!pats.some((p) => itMatchPattern(p, url))) continue;
    // excludeMatches 命中则该页面整体不适配（如设置页/登录页）
    const exPats = rule.excludeMatches
      ? Array.isArray(rule.excludeMatches)
        ? rule.excludeMatches
        : [rule.excludeMatches]
      : [];
    if (exPats.some((p) => itMatchPattern(p, url))) return null;
    return rule;
  }
  return null;
}
