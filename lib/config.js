// 配置的一键导出 / 导入：兴趣、观点、风格样本、公司背景、账号等打包成一个 JSON 文件。
// API Key 默认不导出（勾选才带上）；待回复列表、统计、缓存这类运行数据不在配置里。
import { DEFAULT_SETTINGS, DEFAULT_STYLE, DEFAULT_COMPANY, DEFAULT_LINKING } from './defaults.js';
import { getSettings, saveSettings, getStyle, saveStyle, getCompany, saveCompany, getLinking, saveLinking } from './store.js';

export const KEY_FIELDS = ['apiKey', 'openaiKey', 'deepseekKey'];
// 运行状态，不属于「配置」
const SKIP_SETTINGS = ['version', 'onboarded', 'interestsBackup', 'paused'];
const LIST_FIELDS = ['keywords', 'subreddits', 'hnKeywords', 'negativeKeywords', 'watchlist', 'translateTargets'];

const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function exportConfig({ includeKeys = false } = {}) {
  const [s, st, company, linking, { learn }] = await Promise.all([getSettings(), getStyle(), getCompany(), getLinking(), chrome.storage.local.get('learn')]);
  const settings = { ...s };
  for (const k of SKIP_SETTINGS) delete settings[k];
  if (!includeKeys) for (const k of KEY_FIELDS) delete settings[k];
  const { sinceUpdate, ...style } = st;
  return {
    app: 'reply-copilot',
    format: 1,
    version: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    includesKeys: !!includeKeys && KEY_FIELDS.some((k) => s[k]),
    settings,
    style,
    company,
    linking,
    learnViews: (learn?.views || []).filter((v) => v.status !== 'rejected')
  };
}

export function downloadJson(obj, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function configFileName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `reply-copilot-config-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`;
}

export function parseConfig(text) {
  let cfg;
  try { cfg = JSON.parse(text); } catch { throw new Error('不是有效的 JSON 文件。'); }
  if (!cfg || cfg.app !== 'reply-copilot' || typeof cfg !== 'object') throw new Error('这不是 Reply Copilot 的配置文件。');
  return cfg;
}

const dedupe = (arr, keyOf) => {
  const seen = new Set();
  return arr.filter((x) => { const k = keyOf(x); if (!k || seen.has(k)) return false; seen.add(k); return true; });
};
const textKey = (x) => (x?.text || '').trim().toLowerCase();
const editKey = (x) => ((x?.draft || '') + '\u0000' + (x?.final || '')).trim();

// mode: 'merge'（只补空的或还是默认值的项，样本合并去重）| 'overwrite'（用文件里的覆盖）
export async function importConfig(cfg, mode = 'merge') {
  const [s, st, company, linking] = await Promise.all([getSettings(), getStyle(), getCompany(), getLinking()]);
  const changed = [];
  const inS = { ...(cfg.settings || {}) };
  for (const k of SKIP_SETTINGS) delete inS[k];
  // 文件里的 Key 只有非空才用，不会把你已有的 Key 清掉
  for (const k of KEY_FIELDS) if (isEmpty(inS[k]) || /已隐藏/.test(inS[k])) delete inS[k];

  // ---- 设置 ----
  const patch = {};
  for (const [k, v] of Object.entries(inS)) {
    if (v === undefined) continue;
    const cur = s[k];
    if (mode === 'overwrite') { if (!same(cur, v)) patch[k] = v; continue; }
    const untouched = isEmpty(cur) || same(cur, DEFAULT_SETTINGS[k]);
    if (LIST_FIELDS.includes(k) && Array.isArray(v)) {
      if (untouched) { if (!same(cur, v)) patch[k] = v; }
      else {
        const has = new Set(cur.map((x) => String(x).toLowerCase()));
        const add = v.filter((x) => !has.has(String(x).toLowerCase()));
        if (add.length) patch[k] = [...cur, ...add];
      }
    } else if (typeof v === 'string' || typeof v === 'object') {
      if (untouched && !isEmpty(v) && !same(cur, v)) patch[k] = v;
    } else if (!(k in s)) patch[k] = v; // 数字 / 开关：合并时保留你现在的
  }
  if (Object.keys(patch).length) {
    await saveSettings(patch);
    changed.push(`设置 ${Object.keys(patch).length} 项`);
  }

  // ---- 风格与观点 ----
  if (cfg.style) {
    const inSt = cfg.style;
    const next = { ...st, platformTone: { ...st.platformTone } };
    const fill = (k) => {
      if (isEmpty(inSt[k])) return;
      if (mode === 'overwrite' || isEmpty(st[k]) || same(st[k], DEFAULT_STYLE[k])) next[k] = inSt[k];
    };
    fill('profile');
    fill('viewpoints');
    if (next.profile !== st.profile && inSt.profileUpdatedAt) next.profileUpdatedAt = inSt.profileUpdatedAt;
    for (const [p, tone] of Object.entries(inSt.platformTone || {})) {
      if (isEmpty(tone)) continue;
      const cur = st.platformTone[p];
      if (mode === 'overwrite' || isEmpty(cur) || cur === DEFAULT_STYLE.platformTone[p]) next.platformTone[p] = tone;
    }
    const mergeArr = (k, keyOf) => {
      const incoming = Array.isArray(inSt[k]) ? inSt[k] : [];
      if (mode === 'overwrite') { if (incoming.length) next[k] = incoming; return; }
      next[k] = dedupe([...(st[k] || []), ...incoming], keyOf);
    };
    mergeArr('samples', textKey);
    mergeArr('translations', (x) => (x?.final || x?.out || x?.src || '').trim());
    mergeArr('edits', editKey);
    const nSamples = next.samples.length - st.samples.length;
    if (!same(next, st)) {
      await saveStyle(next);
      const bits = [];
      if (next.viewpoints !== st.viewpoints) bits.push('观点');
      if (next.profile !== st.profile) bits.push('风格档案');
      if (!same(next.platformTone, st.platformTone)) bits.push('平台语气');
      if (mode === 'overwrite' ? next.samples !== st.samples : nSamples > 0) bits.push(mode === 'overwrite' ? `样本 ${next.samples.length} 条` : `新增样本 ${nSamples} 条`);
      if (bits.length) changed.push(bits.join('、'));
    }
  }

  // ---- 公司背景 ----
  if (cfg.company && (cfg.company.name || cfg.company.background)) {
    const blank = !company.name && !company.background;
    if (mode === 'overwrite' || blank || same(company, DEFAULT_COMPANY)) {
      const next = { ...DEFAULT_COMPANY, ...cfg.company };
      if (!same(next, company)) { await saveCompany(next); changed.push('公司背景'); }
    }
  }

  // ---- 关联引用 ----
  if (cfg.linking && (mode === 'overwrite' || same(linking, DEFAULT_LINKING))) {
    const next = { ...DEFAULT_LINKING, ...cfg.linking };
    if (!same(next, linking)) { await saveLinking(next); changed.push('关联引用设置'); }
  }

  // ---- 观点候选 ----
  if (Array.isArray(cfg.learnViews) && cfg.learnViews.length) {
    const { learn } = await chrome.storage.local.get('learn');
    const l = { inputs: [], views: [], lastRun: 0, ...(learn || {}) };
    const before = l.views.length;
    l.views = dedupe([...l.views, ...cfg.learnViews], textKey);
    if (l.views.length > before) { await chrome.storage.local.set({ learn: l }); changed.push(`观点候选 ${l.views.length - before} 条`); }
  }

  if (KEY_FIELDS.some((k) => patch[k])) changed.push('含 API Key');
  await saveSettings({ onboarded: true });
  await chrome.runtime.sendMessage({ type: 'SETTINGS_CHANGED' }).catch(() => {});
  return changed;
}
