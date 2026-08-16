/**
 * 跨浏览器兼容垫片（Chrome / Edge / Firefox 通用）
 * 背景：Firefox 的 chrome.* 命名空间是回调风格、不返回 Promise，
 *       而项目代码统一使用 await 写法。本垫片在 Firefox 下将相关
 *       API 包装为 Promise 版本；Chrome / Edge 原生支持，自动跳过。
 * 引入位置（需最先加载）：
 *   - popup.html / options.html 的 <script> 首位
 *   - Firefox 版 manifest 的 background.scripts 与 content_scripts.js 首位
 */
(function () {
  "use strict";

  // Chrome / Edge：无 browser 全局对象，chrome.* 原生返回 Promise，无需处理
  if (typeof browser === "undefined") return;

  /** 需要包装为 Promise 风格的 API 清单：[命名空间, 方法名] */
  const targets = [
    [chrome.runtime, "sendMessage"],
    [chrome.storage.sync, "get"],
    [chrome.storage.sync, "set"],
    [chrome.tabs, "query"],
    [chrome.tabs, "sendMessage"],
  ];

  for (const [ns, method] of targets) {
    const orig = ns[method].bind(ns);
    ns[method] = function (...args) {
      return new Promise((resolve, reject) => {
        orig(...args, (result) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(result);
        });
      });
    };
  }
})();
