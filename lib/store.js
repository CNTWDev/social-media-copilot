import { PLATFORM_KEYS } from './platforms.js';
import { DEFAULT_SETTINGS, DEFAULT_STYLE, DEFAULT_COMPANY, DEFAULT_LINKING, SETTINGS_VERSION } from './defaults.js';
import { today } from './util.js';

const MAX_POSTS = 600;
const MAX_SAMPLES = 400;
const MAX_EDITS = 100;

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return {
    ...DEFAULT_SETTINGS,
    ...(settings || {}),
    caps: { ...DEFAULT_SETTINGS.caps, ...(settings?.caps || {}) },
    retention: { ...DEFAULT_SETTINGS.retention, ...(settings?.retention || {}) }
  };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  await chrome.storage.local.set({ settings: { ...cur, ...patch } });
}

export async function getStyle() {
  const { style } = await chrome.storage.local.get('style');
  return { ...DEFAULT_STYLE, ...(style || {}), platformTone: { ...DEFAULT_STYLE.platformTone, ...(style?.platformTone || {}) } };
}

export async function saveStyle(style) {
  style.samples = style.samples.slice(-MAX_SAMPLES);
  style.edits = style.edits.slice(-MAX_EDITS);
  await chrome.storage.local.set({ style });
}

export async function getStats() {
  const { stats } = await chrome.storage.local.get('stats');
  const zero = Object.fromEntries(PLATFORM_KEYS.map((k) => [k, 0]));
  const nextAllowed = { ...zero, ...(stats?.nextAllowed || {}) };
  if (!stats || stats.day !== today()) {
    return { day: today(), sent: { ...zero }, drafts: 0, nextAllowed, lastSentAt: stats?.lastSentAt || 0 };
  }
  return { ...stats, sent: { ...zero, ...(stats.sent || {}) }, nextAllowed };
}

export async function saveStats(stats) {
  await chrome.storage.local.set({ stats });
}

// 运行状态计数（每天清零），用于侧边栏「运行状态」诊断。
const emptyDiag = () => ({
  day: today(),
  ...Object.fromEntries(PLATFORM_KEYS.map((k) => [k, { seen: 0, filtered: 0, queued: 0, high: 0, low: 0, lastSeenAt: 0 }])),
  feed: { lastAt: 0, ok: 0, failed: 0, lastError: '', added: 0 },
  tokens: { score: { in: 0, out: 0, calls: 0 }, draft: { in: 0, out: 0, calls: 0 } },
  scoredToday: 0,
  lastError: ''
});
export async function getDiag() {
  const { diag } = await chrome.storage.local.get('diag');
  if (!diag || diag.day !== today()) return emptyDiag();
  const e = emptyDiag();
  const out = { ...e, ...diag, tokens: { ...e.tokens, ...(diag.tokens || {}) } };
  for (const k of PLATFORM_KEYS) out[k] = { ...e[k], ...(diag[k] || {}) };
  return out;
}
let diagChain = Promise.resolve();
export function updateDiag(fn) {
  const run = diagChain.then(async () => {
    const d = await getDiag();
    fn(d);
    await chrome.storage.local.set({ diag: d });
  });
  diagChain = run.catch(() => {});
  return run;
}

export async function getPosts() {
  const { posts } = await chrome.storage.local.get('posts');
  return posts || {};
}

// storage 读改写不是原子的，所有对 posts 的修改都排队执行，避免并发覆盖。
let chain = Promise.resolve();
export function updatePosts(fn) {
  const run = chain.then(async () => {
    const posts = await getPosts();
    const result = await fn(posts);
    const ids = Object.keys(posts);
    if (ids.length > MAX_POSTS) {
      ids
        .sort((a, b) => (posts[a].seenAt || 0) - (posts[b].seenAt || 0))
        .slice(0, ids.length - MAX_POSTS)
        .forEach((id) => {
          if (posts[id].status !== 'sent') delete posts[id];
        });
    }
    await chrome.storage.local.set({ posts });
    return result;
  });
  chain = run.catch(() => {});
  return run;
}

export async function getSeen() {
  const { seen } = await chrome.storage.local.get('seen');
  return seen || {};
}

// 升级时做数据结构迁移；你自己的兴趣、关键词、观点原样保留。
export async function migrate() {
  const { settings, style } = await chrome.storage.local.get(['settings', 'style']);
  if (!settings) {
    await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, version: SETTINGS_VERSION } });
    return;
  }
  const from = settings.version || 1;
  if (from >= SETTINGS_VERSION) return;
  let next = { ...settings };
  let st = { ...DEFAULT_STYLE, ...(style || {}) };
  // v5：模型改成「一个模型商全套用」，旧的自定义 Claude 模型名搬到 models.anthropic
  if (from <= 4 && (settings.scoreModel || settings.draftModel)) {
    const m = {};
    if (settings.scoreModel && settings.scoreModel !== 'claude-haiku-5-5') m.score = settings.scoreModel;
    if (settings.draftModel && settings.draftModel !== 'claude-opus-5-5') m.draft = settings.draftModel;
    next.models = { ...(settings.models || {}), anthropic: m };
    delete next.scoreModel;
    delete next.draftModel;
  }
  // v7：不再自动起草，只打分；起草只由「起草回复」手动触发
  delete next.autoDraft; delete next.autoDraftThreshold; delete next.maxAutoDraftsPerDay;
  next.version = SETTINGS_VERSION;
  // v8：仓库默认值改成通用的，不再往老用户的兴趣 / 关键词 / 观点里合并任何默认内容
  await chrome.storage.local.set({ settings: next, style: st });
}

export async function getCompany() {
  const { company } = await chrome.storage.local.get('company');
  return { ...DEFAULT_COMPANY, ...(company || {}) };
}

export async function saveCompany(company) {
  await chrome.storage.local.set({ company });
}

// 判断一段文字是否提到了公司 / 产品，以及是否带了利益相关声明。
export function mentionInfo(company, text = '') {
  const names = [company.name, ...(company.aliases || '').split(/[,，]/)].map((x) => x.trim()).filter(Boolean);
  const t = text.toLowerCase();
  const mentions = names.some((n) => t.includes(n.toLowerCase()));
  const disclosed = /disclos|i work (at|for)|affiliat|full disclosure|利益相关|我在.{0,20}(工作|任职)|我是.{0,20}的/i.test(text);
  return { mentions, disclosed };
}

// ---------- 关联库 ----------
const MAX_LIBRARY = 300;

export async function getLinking() {
  const { linking } = await chrome.storage.local.get('linking');
  return { ...DEFAULT_LINKING, ...(linking || {}) };
}

export async function saveLinking(linking) {
  await chrome.storage.local.set({ linking });
}

export async function getLibrary() {
  const { library } = await chrome.storage.local.get('library');
  return library || {};
}

let libChain = Promise.resolve();
export function updateLibrary(fn) {
  const run = libChain.then(async () => {
    const lib = await getLibrary();
    const r = await fn(lib);
    const ids = Object.keys(lib);
    if (ids.length > MAX_LIBRARY) {
      ids.sort((a, b) => lib[a].savedAt - lib[b].savedAt).slice(0, ids.length - MAX_LIBRARY).forEach((id) => delete lib[id]);
    }
    await chrome.storage.local.set({ library: lib });
    return r;
  });
  libChain = run.catch(() => {});
  return run;
}

export function libraryEntry(p) {
  return {
    id: p.id,
    platform: p.platform,
    kind: p.kind,
    url: p.url,
    author: p.author,
    title: p.title || p.context?.rootTitle || '',
    text: (p.text || '').slice(0, 800),
    category: p.category || '',
    topic: p.topic || '',
    score: p.score ?? null,
    savedAt: Date.now(),
    usedCount: 0,
    lastUsedAt: 0
  };
}

export async function getMentionLog() {
  const { mentionLog } = await chrome.storage.local.get('mentionLog');
  return mentionLog || {};
}
