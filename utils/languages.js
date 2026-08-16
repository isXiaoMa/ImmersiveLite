/**
 * 语言列表与语言代码映射表（公共模块）
 * - 被 popup / options 页面通过 <script src> 引入（挂到 window 上）
 * - 被 background service worker 通过 importScripts 引入（挂到 self 上）
 */

/** 支持的语言列表（code 使用谷歌翻译语言代码作为内部标准） */
const IT_LANGUAGES = [
  { code: 'auto', name: '自动检测' },
  { code: 'zh-CN', name: '简体中文' },
  { code: 'zh-TW', name: '繁体中文' },
  { code: 'en', name: '英语' },
  { code: 'ja', name: '日语' },
  { code: 'ko', name: '韩语' },
  { code: 'fr', name: '法语' },
  { code: 'de', name: '德语' },
  { code: 'es', name: '西班牙语' },
  { code: 'pt', name: '葡萄牙语' },
  { code: 'it', name: '意大利语' },
  { code: 'ru', name: '俄语' },
  { code: 'ar', name: '阿拉伯语' },
  { code: 'hi', name: '印地语' },
  { code: 'th', name: '泰语' },
  { code: 'vi', name: '越南语' },
  { code: 'id', name: '印尼语' },
  { code: 'ms', name: '马来语' },
  { code: 'tr', name: '土耳其语' }
];

/** 谷歌语言代码 -> 百度语言代码 映射表（百度使用自定义语言代码） */
const BAIDU_LANG_MAP = {
  'auto': 'auto',
  'zh-CN': 'zh',
  'zh-TW': 'cht',
  'en': 'en',
  'ja': 'jp',
  'ko': 'kor',
  'fr': 'fra',
  'de': 'de',
  'es': 'spa',
  'pt': 'pt',
  'it': 'it',
  'ru': 'ru',
  'ar': 'ara',
  'hi': 'hi',
  'th': 'th',
  'vi': 'vie',
  'id': 'id',
  'ms': 'may',
  'tr': 'tr'
};

/** 谷歌语言代码 -> 语言中文名（供大模型提示词使用） */
const LANG_NAMES = {
  'auto': '自动检测',
  'zh-CN': '简体中文',
  'zh-TW': '繁体中文',
  'en': '英语',
  'ja': '日语',
  'ko': '韩语',
  'fr': '法语',
  'de': '德语',
  'es': '西班牙语',
  'pt': '葡萄牙语',
  'it': '意大利语',
  'ru': '俄语',
  'ar': '阿拉伯语',
  'hi': '印地语',
  'th': '泰语',
  'vi': '越南语',
  'id': '印尼语',
  'ms': '马来语',
  'tr': '土耳其语'
};

/** 翻译服务定义（供下拉框渲染） */
const IT_SERVICES = [
  { id: 'free', name: '免费智能（微软+谷歌自动降级，推荐）' },
  { id: 'google', name: '谷歌翻译（免费，无需配置）' },
  { id: 'baidu', name: '百度翻译（需 appid + 密钥）' }
  // 大模型服务（GPT-5.2 / DeepSeek 等）由设置中的 llmConfigs 动态注入，标识为 llm:<id>
];

// 挂载为全局变量，兼容 window（HTML 页面）与 self（Service Worker）环境
if (typeof self !== 'undefined') {
  self.IT_LANGUAGES = IT_LANGUAGES;
  self.BAIDU_LANG_MAP = BAIDU_LANG_MAP;
  self.LANG_NAMES = LANG_NAMES;
  self.IT_SERVICES = IT_SERVICES;
}
