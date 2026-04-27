'use strict';

// ============================================================
// Random rare-character delimiters (inspired by AnyToolCall)
// Each restart picks a random set to minimize collision
// ============================================================

const DELIMITER_SETS = [
  { open: '\u0F12', close: '\u0F12', mid: '\u0FC7' },  // Tibetan
  { open: '\uA9D9', close: '\uA9D9', mid: '\uA9DF' },  // Javanese
  { open: '\uA4D2', close: '\uA4D2', mid: '\uA4D3' },  // Cherokee supplement
  { open: '\uA188', close: '\uA188', mid: '\uA190' },   // Yi
  { open: '\uA9DC', close: '\uA9DC', mid: '\uA9DE' },   // Javanese alt
  { open: '\uA4F8', close: '\uA4F8', mid: '\uA4F9' },   // Lisu
];

const SUFFIX_POOL = [
  '\u9F98', '\u9750', '\u9F49', '\u9EA4', '\u7228',  // CJK rare: 龘靐齉麤爨
  '\u9A6B', '\u9C7B', '\u7FB4', '\u7287', '\u9A89',  // 驫鱻羴犇骉
  '\u98DD', '\u5375', '\u9747', '\u98CD', '\u99AB',  // 飝厵靇飍馫
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateMarkers() {
  const set = pick(DELIMITER_SETS);
  const suffix1 = pick(SUFFIX_POOL);
  const suffix2 = pick(SUFFIX_POOL);
  const { open, close, mid } = set;

  return {
    TC_START:      `${open}${suffix1}\u1405`,       // ᐅ
    TC_END:        `\u140A${suffix1}${close}`,       // ᐊ
    NAME_START:    `${mid}\u25B8`,                    // ▸
    NAME_END:      `\u25C2${mid}`,                    // ◂
    ARGS_START:    `${mid}\u25B9`,                    // ▹
    ARGS_END:      `\u25C3${mid}`,                    // ◃
    RESULT_START:  `${open}${suffix2}\u27EB`,         // ⟫
    RESULT_END:    `\u27EA${suffix2}${close}`,        // ⟪
  };
}

const markers = generateMarkers();

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { markers, escapeRegex, generateMarkers };
