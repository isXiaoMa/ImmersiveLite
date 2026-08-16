/**
 * 自定义下拉组件（popup / options 共用）
 * 原理：将页面上的 <select> 包进 .dd 容器，生成按钮 + 浮层菜单替换原生展开列表；
 *       原生 select 隐藏保留，值仍由现有代码正常读写（零侵入）。
 * 值同步通道（保证程序赋值后按钮文本同步）：
 *   1. value setter hook —— 覆盖实例的 value 属性赋值
 *   2. change 事件 —— 用户交互
 *   3. childList MutationObserver —— innerHTML 重建 options 的场景
 */
(function () {
  "use strict";

  /** 已挂载实例的容器列表，用于"点击外部/ESC 关闭" */
  const instances = [];

  /**
   * 关闭所有下拉菜单
   * @param {HTMLElement} except 需要保持展开的实例（可空）
   */
  function closeAll(except) {
    for (const w of instances) {
      if (w !== except) w.classList.remove("open");
    }
  }

  /**
   * 同步按钮文本与菜单选中态
   * @param {HTMLSelectElement} select 被包装的原生 select
   */
  function syncLabel(select) {
    const wrap = select.closest(".dd");
    if (!wrap) return;
    const opt = select.selectedOptions[0];
    const label = wrap.querySelector(".dd-label");
    if (label) label.textContent = opt ? opt.textContent : "";
    wrap.querySelectorAll(".dd-item").forEach((li) => {
      li.classList.toggle("selected", li.dataset.value === select.value);
    });
  }

  /**
   * 重建菜单选项列表（每次展开时从 select 重新生成，保证与数据源一致）
   * @param {HTMLElement} wrap .dd 容器
   * @param {HTMLSelectElement} select 被包装的原生 select
   */
  function buildMenu(wrap, select) {
    const menu = wrap.querySelector(".dd-menu");
    menu.innerHTML = "";
    Array.from(select.options).forEach((opt) => {
      const li = document.createElement("li");
      li.className = "dd-item";
      li.dataset.value = opt.value;
      li.textContent = opt.textContent;
      li.addEventListener("click", () => {
        if (select.value !== opt.value) {
          select.value = opt.value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
        closeAll();
      });
      menu.appendChild(li);
    });
    syncLabel(select);
  }

  /**
   * 将单个 select 包装为自定义下拉
   * @param {HTMLSelectElement} select 目标 select
   */
  function mountDropdown(select) {
    if (select.closest(".dd")) return; // 防重复挂载

    // 构建容器并移入 select
    const wrap = document.createElement("div");
    wrap.className = "dd";
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);

    // 触发按钮（含自绘箭头）
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dd-btn";
    btn.innerHTML =
      '<span class="dd-label"></span>' +
      '<span class="dd-arrow" aria-hidden="true">' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="6" viewBox="0 0 10 6" fill="none">' +
      '<path d="M1 1l4 4 4-4" stroke="#888bd0" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
    wrap.appendChild(btn);

    // 浮层菜单
    const menu = document.createElement("ul");
    menu.className = "dd-menu";
    wrap.appendChild(menu);

    // 展开时重建列表，并根据底部空间决定向上/向下弹出
    btn.addEventListener("click", () => {
      const willOpen = !wrap.classList.contains("open");
      closeAll();
      if (!willOpen) return;
      buildMenu(wrap, select);
      const rect = btn.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      wrap.classList.toggle("up", spaceBelow < 260 && rect.top > spaceBelow);
      wrap.classList.add("open");
    });

    // 值同步通道 1：hook value setter（程序赋值）
    const desc = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value"
    );
    Object.defineProperty(select, "value", {
      get: desc.get,
      set: function (v) {
        desc.set.call(this, v);
        syncLabel(this);
      },
      configurable: true,
    });

    // 值同步通道 2：change 事件
    select.addEventListener("change", () => syncLabel(select));

    // 值同步通道 3：innerHTML 重建 options（childList 变化）
    new MutationObserver(() => syncLabel(select)).observe(select, {
      childList: true,
    });

    syncLabel(select);
    instances.push(wrap);
  }

  // 全局：点击组件外部时关闭所有菜单
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".dd")) closeAll();
  });

  // 全局：ESC 关闭所有菜单
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAll();
  });

  /**
   * 挂载页面全部 select 为自定义下拉
   */
  window.mountAllDropdowns = function () {
    document.querySelectorAll("select").forEach(mountDropdown);
  };
})();
