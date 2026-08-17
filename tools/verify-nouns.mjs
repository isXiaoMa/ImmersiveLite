// 临时验证脚本：专有名词保护正则逻辑（与 content.js 实现一致）
const PROPER_NOUNS = [
  "React Native", "Next.js", "Vue.js", "React", "Vue", "Angular",
  "Svelte", "JavaScript", "TypeScript", "Node.js", "GitHub",
  "Chrome", "iOS", "Windows", "macOS", "Linux", "Google",
].sort((a, b) => b.length - a.length);
const VAR_DELIMITERS = ["@", "#"];

function protectProperNouns(text, variables) {
  for (const noun of PROPER_NOUNS) {
    const escaped = noun.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\w@#])${escaped}(?![\\w@#])`, "g");
    text = text.replace(re, (m) => {
      const idx = Object.keys(variables).length;
      variables[idx] = m;
      return `${VAR_DELIMITERS[0]}${idx}${VAR_DELIMITERS[1]}`;
    });
  }
  return text;
}

function restoreVariables(text, variables) {
  return String(text || "").replace(/@\s*(\d+)\s*#/g, (m, i) =>
    Object.prototype.hasOwnProperty.call(variables, i) ? variables[i] : m,
  );
}

const cases = [
  "Learn React",
  "React Native and React",
  "Reacting to Vue",
  "Vuetify is not Vue",
  "Node.js with npm",
  "React, Vue and Angular",
  "GitHub/Chrome on macOS",
  "iOS 18 and Windows 11",
];

for (const t of cases) {
  const vars = {};
  const out = protectProperNouns(t, vars);
  console.log(`${t} => ${out} | 还原: ${restoreVariables("译:" + out, vars)}`);
}

// 与 stayOriginal 变量共存：索引不冲突
const mixed = { 0: "const x = 1;" }; // 假设 CODE 已占 @0#
const out2 = protectProperNouns("React @0# works", mixed);
console.log(`React @0# works => ${out2} | 还原: ${restoreVariables("译 " + out2, mixed)}`);
