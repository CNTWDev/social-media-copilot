import { getSettings, saveSettings, getStyle, saveStyle, getStats, saveStats, getPosts, updatePosts, updateDiag, getDiag, migrate, getCompany, mentionInfo,
  getLinking, getLibrary, updateLibrary, libraryEntry, getMentionLog } from './lib/store.js';
import { valueOf, categoriesOf } from './lib/value.js';
import { localScore } from './lib/prefilter.js';
import { callLLM, hasKey } from './lib/llm.js';
import { PLATFORMS, PLATFORM_KEYS, platName, platformOfId, isSelf, isWatched, noAI } from './lib/platforms.js';
import { scoreSchema, DRAFT_SCHEMA, scorePrompt, draftPrompt, profilePrompt, LONGPOST_SCHEMA, longPostPrompt, translatePrompt,
  LANGS, quickPrompt, DIGEST_SCHEMA, digestPrompt, INTRO_SCHEMA, introPrompt, discussPrompt, composePrompt, composeSchema, VIEWS_SCHEMA, viewsPrompt } from './lib/prompts.js';
import { detectLang, normLang, randBetween, sleep } from './lib/util.js';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(async (details) => {
  await migrate();
  // 第一次安装：打开设置引导
  if (details?.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') }).catch(() => {});
  await setupFeedAlarm();
  chrome.alarms.create('cleanup', { delayInMinutes: 2, periodInMinutes: 360 });
  chrome.alarms.create('myposts', { delayInMinutes: 3, periodInMinutes: 30 });
  const pages = ['https://*.reddit.com/*', 'https://x.com/*', 'https://twitter.com/*', 'https://www.linkedin.com/*'];
  chrome.contextMenus?.removeAll(() => {
    // 回复和翻译分成两项，各自只做自己的事，不会先跑一遍回复再切翻译（省 token）。
    // 注意：Chrome 规定扩展有两项以上时会收进以扩展名命名的子菜单。
    chrome.contextMenus.create({ id: 'rc-help-reply', title: '帮我回复', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'rc-translate', title: '帮我翻译', contexts: ['selection'] });
  });
  await injectIntoOpenTabs();
  await purgeOwn();
});

// Chrome 不会给装插件之前就打开的页面注入脚本：安装 / 升级后主动补注入，免得要手动刷新。
async function injectIntoOpenTabs() {
  for (const cs of chrome.runtime.getManifest().content_scripts) {
    const tabs = await chrome.tabs.query({ url: cs.matches });
    for (const t of tabs) {
      chrome.scripting.executeScript({ target: { tabId: t.id }, files: cs.js }).catch(() => {});
    }
  }
}
chrome.runtime.onStartup.addListener(setupFeedAlarm);

async function setupFeedAlarm() {
  const s = await getSettings();
  await chrome.alarms.clear('feed');
  if (s.feedEnabled) chrome.alarms.create('feed', { delayInMinutes: 1, periodInMinutes: Math.max(15, s.feedIntervalMin) });
}

// ================= 采集与筛选 =================

// 和你最近发出的回复内容几乎一样 → 也视为你自己写的（账号没填或没识别出来时的兜底）。
const norm = (t) => (t || '').toLowerCase().replace(/\s+/g, ' ').trim();
function matchesSent(posts, it) {
  const t = norm(it.text);
  if (t.length < 30) return false;
  const head = t.slice(0, 80);
  return Object.values(posts).some((p) => {
    if (p.status !== 'sent' || !p.finalText) return false;
    const f = norm(p.finalText);
    return f.includes(head) || (f.length >= 30 && t.includes(f.slice(0, 80)));
  });
}

const isOwn = isSelf;

// ---- 你从「发帖」发出去的帖子（ownPosts）：认出它在平台上的链接，并把下面的评论挂回议题 ----
const words = (t) => new Set((norm(t).match(/[a-z0-9][a-z0-9'’-]{2,}|[\u4e00-\u9fff]/g) || []).slice(0, 60));
function sameText(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na.slice(0, 60) === nb.slice(0, 60) || na.includes(nb.slice(0, 80)) || nb.includes(na.slice(0, 80))) return true;
  const wa = words(a), wb = words(b);
  const small = Math.min(wa.size, wb.size);
  if (small < 4) return false;
  let hit = 0;
  wa.forEach((w) => wb.has(w) && hit++);
  return hit / small >= 0.7;
}
const recentOwn = (ownPosts, platform) => ownPosts.filter((o) => o.platform === platform && Date.now() - o.at < 30 * 864e5);
// 你自己的这条内容是不是某条 ownPost（发出后第一次在页面上看到它）
function ownPostOf(ownPosts, it) {
  return recentOwn(ownPosts, it.platform).find((o) => (o.itemId && o.itemId === it.id) ||
    (!o.itemId && it.kind === 'post' && (sameText(o.text, it.text) || (o.title && sameText(o.title, it.title)))));
}
// 别人的评论是不是在你某条 ownPost 下面
function ownRootOf(ownPosts, it) {
  if (it.kind !== 'comment') return null;
  const c = it.context || {};
  const pid = it.platform === 'reddit' && (it.url || '').match(/\/comments\/([a-z0-9]+)/i)?.[1];
  return recentOwn(ownPosts, it.platform).find((o) =>
    (pid && o.itemId === 't3_' + pid) ||
    (o.itemId && it.parentId === o.itemId) ||
    ((c.rootText || c.rootTitle) && (sameText(o.text, c.rootText) || (o.title && sameText(o.title, c.rootTitle || it.title)))));
}

async function ingest(items) {
  const s = await getSettings();
  const style = await getStyle();
  let styleChanged = false;
  const fresh = [];
  const watchedNew = [];
  const count = Object.fromEntries(PLATFORM_KEYS.map((k) => [k, { seen: 0, filtered: 0, queued: 0 }]));
  const weekAgo = Date.now() - 7 * 864e5;
  const { ownPosts = [] } = await chrome.storage.local.get('ownPosts');
  let ownChanged = false;
  await updatePosts((posts) => {
    for (const it of items) {
      if (!it?.id || !it.text && !it.title) continue;
      if (it.platform === 'reddit' && /^automoderator$/i.test(it.author || '')) continue; // 版块机器人的例行回复
      const c = count[it.platform] || count.reddit;
      c.seen++;
      // 你自己写的内容：不当作待回复对象，而是悄悄记成风格样本；
      // 如果它是对列表里某条内容的回复，说明你已经回过了，把那条标记为已发送。
      if (isOwn(s, it) || matchesSent(posts, it)) {
        const op = isOwn(s, it) && ownPostOf(ownPosts, it);
        if (op && !op.itemId) { op.itemId = it.id; op.url = it.url; ownChanged = true; }
        const target = it.parentId && posts[it.parentId];
        if (target && target.status !== 'sent') {
          target.status = 'sent';
          target.sentAt = Date.now();
          target.finalText = it.text;
          target.sentVia = 'detected';
        }
        if (it.text && !style.samples.some((x) => x.id === it.id)) {
          style.samples.push({ id: it.id, platform: it.platform, text: it.text, lang: normLang(it.lang) || detectLang(it.text), context: it.title || '', source: 'observed', at: Date.now() });
          styleChanged = true;
        }
        continue;
      }
      const root = ownRootOf(ownPosts, it);
      if (root) {
        it.tid = root.tid; it.ownCid = root.cid; it.onMyPost = true;
        if (!root.itemId && it.parentId && !it.context?.parents?.length) { root.itemId = it.parentId; ownChanged = true; }
        if (!root.url && it.url && !it.context?.parents?.length) { root.url = it.platform === 'reddit' ? (it.url.match(/\/comments\/([a-z0-9]+)/i) ? `https://www.reddit.com/comments/${it.url.match(/\/comments\/([a-z0-9]+)/i)[1]}/` : '') : it.platform === 'x' && it.parentId ? `https://x.com/i/status/${it.parentId.replace(/^x_/, '')}` : ''; ownChanged = !!root.url || ownChanged; }
      }
      const existing = posts[it.id];
      if (existing) {
        if (root && !existing.onMyPost) Object.assign(existing, { tid: root.tid, ownCid: root.cid, onMyPost: true });
        if (it.engagement) existing.engagement = it.engagement;
        // 之前从时间线上看到的，现在在对话页看到了更完整的上下文：补上。
        if ((it.context?.parents?.length || 0) > (existing.context?.parents?.length || 0) || (!existing.context?.rootText && it.context?.rootText)) {
          existing.context = it.context;
          existing.kind = it.kind;
        }
        continue;
      }
      if (it.kind === 'post' && it.createdAt && it.createdAt < weekAgo) continue;
      // 别人回复了你：不管关键词，直接进列表并优先展示。
      const lastParent = it.context?.parents?.at(-1)?.author || (it.context?.parents?.length ? '' : it.context?.rootAuthor) || '';
      const replyToMe = !!lastParent && isOwn(s, { platform: it.platform, author: lastParent.replace(/^@/, '') });
      // 重点关注名单里的人：同样跳过关键词初筛，优先打分和展示。
      const watched = !replyToMe && isWatched(s, it);
      const ls = replyToMe || it.onMyPost ? { pass: true, score: 9 } : watched ? { pass: true, score: 8 } : localScore(s, it);
      if (!ls.pass) { c.filtered++; continue; }
      if (replyToMe) it.replyToMe = true;
      if (watched) { it.watched = true; if (it.kind === 'post') watchedNew.push(it); }
      c.queued++;
      posts[it.id] = { ...it, localScore: ls.score, lang: normLang(it.lang) || detectLang((it.title || '') + ' ' + it.text), status: 'pending', seenAt: Date.now() };
      fresh.push(it.id);
    }
  });
  if (styleChanged) await saveStyle(style);
  if (ownChanged) {
    const { ownPosts: cur = [] } = await chrome.storage.local.get('ownPosts');
    const byCid = Object.fromEntries(ownPosts.map((o) => [o.cid, o]));
    await chrome.storage.local.set({ ownPosts: cur.map((o) => (byCid[o.cid] ? { ...o, itemId: o.itemId || byCid[o.cid].itemId, url: o.url || byCid[o.cid].url } : o)) });
  }
  await updateDiag((d) => {
    for (const p of PLATFORM_KEYS) {
      if (!count[p].seen) continue;
      d[p].seen += count[p].seen; d[p].filtered += count[p].filtered; d[p].queued += count[p].queued;
      d[p].lastSeenAt = Date.now();
    }
  });
  if (fresh.length) scheduleScoring();
  if (watchedNew.length && s.watchNotify) notifyWatched(watchedNew);
  return fresh.length;
}

function trackUsage(kind) {
  return (u) => updateDiag((d) => {
    const t = d.tokens[kind];
    t.in += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    t.out += u.output_tokens || 0;
    t.calls++;
  });
}

// 把列表里你自己写的内容移出去（并记成风格样本）。
async function purgeOwn() {
  const s = await getSettings();
  const style = await getStyle();
  let n = 0;
  await updatePosts((ps) => {
    for (const [id, p] of Object.entries(ps)) {
      if (p.status === 'sent' || !(isOwn(s, p) || matchesSent(ps, p))) continue;
      if (!style.samples.some((x) => x.id === id)) {
        style.samples.push({ id, platform: p.platform, text: p.text, lang: p.lang || detectLang(p.text), context: p.title || '', source: 'observed', at: Date.now() });
      }
      delete ps[id];
      n++;
    }
  });
  if (n) await saveStyle(style);
  return n;
}

// ================= 过期清理 =================

async function cleanup() {
  const s = await getSettings();
  const r = s.retention;
  const now = Date.now();
  await updatePosts((ps) => {
    for (const [id, p] of Object.entries(ps)) {
      const old = p.status === 'sent'
        ? now - (p.sentAt || p.seenAt) > r.sentDays * 864e5
        : now - p.seenAt > r.pendingDays * 864e5;
      if (old) delete ps[id];
    }
  });
  await updateLibrary((lib) => {
    for (const [id, e] of Object.entries(lib)) {
      if (now - Math.max(e.savedAt || 0, e.lastUsedAt || 0) > r.libraryDays * 864e5) delete lib[id];
    }
  });
  const log = await getMentionLog();
  for (const k of Object.keys(log)) if (now - log[k] > 30 * 864e5) delete log[k];
  await chrome.storage.local.set({ mentionLog: log });
}

// ================= 兴趣打分 =================

let scoreTimer = null;
// 后台正在做什么：给侧边栏的进度条和工具栏图标用。
const act = { scoring: 0, drafting: 0 };
function setActivity() {
  const busy = act.scoring + act.drafting > 0;
  chrome.storage.local.set({ activity: { ...act, at: Date.now() } }).catch(() => {});
  chrome.action.setBadgeText({ text: busy ? '…' : '' }).catch(() => {});
}
async function busy(kind, n, fn) {
  act[kind] += n;
  setActivity();
  try {
    return await fn();
  } finally {
    act[kind] = Math.max(0, act[kind] - n);
    setActivity();
  }
}
chrome.action.setBadgeBackgroundColor({ color: '#2f6fed' }).catch(() => {});
setActivity();

let scoring = false;
function scheduleScoring(delay = 3000) {
  clearTimeout(scoreTimer);
  scoreTimer = setTimeout(runScoring, delay);
}

async function runScoring() {
  if (scoring) return scheduleScoring(5000);
  const s = await getSettings();
  if (!hasKey(s) || s.paused) return;
  scoring = true;
  let round = 0;
  try {
    for (; round < 10; round++) {
      const left = s.maxScoredPerDay - (await getDiag()).scoredToday;
      if (left <= 0) {
        await updateDiag((d) => (d.lastError = `今天送去打分的条数已达上限（${s.maxScoredPerDay}），剩下的明天再说（可在设置里调整）。`));
        break;
      }
      const posts = await getPosts();
      // 本地分高的优先送去打分；同分时新的优先。
      const batch = Object.values(posts)
        .filter((p) => p.status === 'pending')
        .sort((a, b) => (b.localScore || 0) - (a.localScore || 0) || b.seenAt - a.seenAt)
        .slice(0, Math.min(12, left));
      if (!batch.length) break;
      const { system, user } = scorePrompt(s, batch, await getStyle(), await getCompany());
      let results = [];
      try {
        ({ results = [] } = await busy('scoring', batch.length, () => callLLM(s, 'score', { system, user, schema: scoreSchema(categoriesOf(s.interests)), effort: 'low', maxTokens: 4000, onUsage: trackUsage('score') })));
      } catch (err) {
        await updatePosts((ps) => batch.forEach((b) => ps[b.id] && (ps[b.id].error = String(err.message || err))));
        await updateDiag((d) => (d.lastError = '打分失败：' + String(err.message || err)));
        break;
      }
      const byId = Object.fromEntries(results.map((r) => [r.id, r]));
      await updatePosts((ps) => {
        for (const b of batch) {
          const p = ps[b.id];
          if (!p) continue;
          const r = byId[b.id];
          p.score = r ? Math.max(0, Math.min(100, r.score)) : 0;
          p.topic = r?.topic || '';
          p.category = r?.category || '其他';
          p.reason = r?.reason || '';
          p.hook = r?.hook || '';
          p.status = p.score >= s.scoreThreshold || p.watched || p.replyToMe || p.onMyPost ? 'scored' : 'low';
          delete p.error;
        }
      });
      await updateDiag((d) => {
        for (const b of batch) {
          const sc = byId[b.id]?.score ?? 0;
          const k = sc >= s.scoreThreshold || b.watched || b.replyToMe || b.onMyPost ? 'high' : 'low';
          (d[b.platform] || d.reddit)[k]++;
        }
        d.lastError = '';
        d.scoredToday += batch.length;
      });
      const linking = await getLinking();
      if (linking.enabled) {
        const fresh = await getPosts();
        const keep = batch.map((b) => fresh[b.id]).filter((p) => p && valueOf(p) >= linking.autoSaveValue);
        if (keep.length) await updateLibrary((lib) => keep.forEach((p) => { if (!lib[p.id]) lib[p.id] = libraryEntry(p); }));
      }
    }
  } finally {
    scoring = false;
  }
  // 一次最多跑 10 批；还有排队的就稍后接着打，不用等下一次刷页面
  if (round >= 10) scheduleScoring(2000);
}

// ================= 起草 / 按要求重写 =================

async function draft(id, instruction = '', lang) {
  const s = await getSettings();
  const style = await getStyle();
  const post = (await getPosts())[id];
  if (!post) throw new Error('找不到这条内容');
  if (noAI(post.platform)) throw new Error(`${platName(post.platform)} 不允许 AI 生成或改写的评论。可以点「中文解读」或「和我讨论」，想清楚后自己写。`);
  if (lang !== undefined) post.replyLangPref = lang;
  if (instruction) logInput(instruction, 'refine', '要回复的内容：' + (post.text || '').slice(0, 300));
  await updatePosts((ps) => { ps[id].drafting = true; delete ps[id].error; if (lang !== undefined) ps[id].replyLangPref = lang; });
  try {
    const previous = instruction ? post.drafts : null;
    const company = await getCompany();
    const sentList = Object.values(await getPosts())
      .filter((p) => p.status === 'sent' && p.finalText)
      .sort((a, b) => b.sentAt - a.sentAt);
    const recent = sentList.slice(0, 6).map((p) => p.finalText);
    // 频率控制：最近 N 条里已经提过公司，就这条不提。
    const window = sentList.filter((p) => p.platform === post.platform).slice(0, Math.max(1, company.mentionEvery) - 1);
    const allowMention = !window.some((p) => mentionInfo(company, p.finalText).mentions);
    const linking = await getLinking();
    const related = linking.enabled ? await pickRelated(post, linking) : [];
    const topic = post.tid ? (await chrome.storage.local.get('topics')).topics?.[post.tid] : null;
    const own = post.ownCid ? (await chrome.storage.local.get('ownPosts')).ownPosts?.find((o) => o.cid === post.ownCid) : null;
    const { system, user } = draftPrompt(s, style, post, { instruction, previous, recent, company, allowMention, linking, related, topic, own, lang: post.replyLangPref && post.replyLangPref !== 'auto' ? post.replyLangPref : '' });
    const out = await busy('drafting', 1, () => callLLM(s, 'draft', { system, user, schema: DRAFT_SCHEMA, effort: 'medium', onUsage: trackUsage('draft') }));
    // 非 Claude 模型不一定严格按字段返回，这里兜底整理
    const drafts = (Array.isArray(out.drafts) ? out.drafts : Array.isArray(out.replies) ? out.replies : [])
      .map((d) => (typeof d === 'string' ? { angle: '', text: d } : { ...d, angle: d.angle || '', text: d.text || d.reply || d.content || '', gloss: d.gloss || '' }))
      .filter((d) => d.text.trim());
    if (!drafts.length) throw new Error('模型没有返回可用的草稿，请重试。');
    await updatePosts((ps) => {
      const p = ps[id];
      if (!p) return;
      if (p.drafts) (p.history = p.history || []).push({ drafts: p.drafts, instruction: p.lastInstruction || '', at: Date.now() });
      p.drafts = drafts.slice(0, 3).map((d) => {
        const r = related.find((x) => x.id === d.related_id);
        return r ? { ...d, related: { id: r.id, url: r.url, author: r.author, platform: r.platform, title: r.title } } : { angle: d.angle, text: d.text, gloss: d.gloss };
      });
      p.suggestion = out.suggestion;
      p.replyLang = out.language;
      p.lastInstruction = instruction;
      if (p.status === 'low' || p.status === 'pending') p.status = 'scored';
      p.drafting = false;
    });
    const stats = await getStats();
    stats.drafts++;
    await saveStats(stats);
  } catch (err) {
    await updatePosts((ps) => { if (ps[id]) { ps[id].drafting = false; ps[id].error = String(err.message || err); } });
    throw err;
  }
}

// ================= 关联库：挑选候选 =================

const tokens = (t = '') => {
  const s = t.toLowerCase();
  const words = s.match(/[a-z][a-z0-9.+-]{3,}/g) || [];
  const cjk = s.match(/[\u4e00-\u9fff]{2}/g) || [];
  const stop = new Set(['this', 'that', 'with', 'have', 'from', 'what', 'about', 'they', 'there', 'will', 'just', 'like', 'would', 'your', 'more']);
  return new Set([...words, ...cjk].filter((w) => !stop.has(w)));
};

async function pickRelated(post, linking) {
  const lib = Object.values(await getLibrary());
  const log = await getMentionLog();
  const mine = tokens([post.title, post.text, post.context?.rootTitle].join(' '));
  const rootKey = (post.context?.rootTitle || post.title || '').slice(0, 80);
  return lib
    .filter((e) => e.id !== post.id && e.usedCount < linking.maxUsesPerPost && (!rootKey || e.title.slice(0, 80) !== rootKey))
    .map((e) => {
      const overlap = [...tokens(e.title + ' ' + e.text)].filter((w) => mine.has(w)).length;
      const w = overlap + (e.category && e.category === post.category ? 3 : 0) + (e.platform === post.platform ? 1 : 0);
      const key = e.platform + ':' + (e.author || '').toLowerCase();
      const canMention = linking.includeMention && e.platform === post.platform && !!e.author &&
        e.author.toLowerCase() !== (post.author || '').toLowerCase() &&
        Date.now() - (log[key] || 0) > linking.mentionCooldownDays * 864e5;
      return { ...e, w, overlap, canMention };
    })
    .filter((e) => e.overlap >= 2 || (e.overlap >= 1 && e.category === post.category))
    .sort((a, b) => b.w - a.w)
    .slice(0, 4);
}

async function recordLinkUsage(finalText) {
  const lib = await getLibrary();
  const t = finalText.toLowerCase();
  const used = Object.values(lib).filter((e) => {
    const sid = e.platform === 'x' ? e.id.replace(/^x_/, '') : null;
    return (sid && t.includes('/status/' + sid)) || (e.url && t.includes(e.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').toLowerCase()));
  });
  if (!used.length) return;
  await updateLibrary((l) => used.forEach((e) => { if (l[e.id]) { l[e.id].usedCount++; l[e.id].lastUsedAt = Date.now(); } }));
  const log = await getMentionLog();
  for (const e of used) {
    const handle = (e.author || '').toLowerCase();
    if (handle && (t.includes('@' + handle) || t.includes('u/' + handle))) log[e.platform + ':' + handle] = Date.now();
  }
  await chrome.storage.local.set({ mentionLog: log });
}

// ================= 填入回复框（发送前的安全闸） =================

async function checkGate(platform) {
  const s = await getSettings();
  const stats = await getStats();
  if (!PLATFORMS[platform]) return null;
  if (noAI(platform)) return `${platName(platform)} 不允许 AI 生成或改写的评论，请打开原帖自己写。`;
  if (stats.sent[platform] >= s.caps[platform]) {
    return `今天 ${platName(platform)} 已达到 ${s.caps[platform]} 条的上限，明天再来（可在设置里调整）。`;
  }
  const wait = stats.nextAllowed[platform] - Date.now();
  if (wait > 0) return `${platName(platform)} 冷却中，还需等待 ${Math.ceil(wait / 60000)} 分钟再发下一条（随机间隔，降低风控风险）。`;
  return null;
}

// LinkedIn 帖子地址里的 activity id（评论则取它所属帖子的 id）
const liActivity = (post) => (post.url.match(/urn:li:activity:(\d+)/) || post.id.match(/(\d{10,})/) || [])[1] || '##';

// 重点关注的人发了新帖：系统通知，点通知打开侧边栏所在窗口的原帖
function notifyWatched(items) {
  const it = items[0];
  const more = items.length > 1 ? `（另有 ${items.length - 1} 条）` : '';
  chrome.notifications?.create('watch_' + it.id, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `重点关注：${it.authorName || it.author} 发了新内容${more}`,
    message: ((it.title ? it.title + ' · ' : '') + (it.text || '')).slice(0, 140),
    priority: 1
  }).catch?.(() => {});
}
chrome.notifications?.onClicked.addListener(async (nid) => {
  if (!nid.startsWith('watch_')) return;
  const p = (await getPosts())[nid.slice(6)];
  if (p?.url) chrome.tabs.create({ url: p.url, active: true });
  chrome.notifications.clear(nid);
});

function tabMatches(tab, post) {
  if (!tab.url) return false;
  if (post.platform === 'x') return /(^https:\/\/(x|twitter)\.com\/)/.test(tab.url) && tab.url.includes('/status/' + post.id.replace(/^x_/, ''));
  if (post.platform === 'linkedin') return /linkedin\.com/.test(tab.url) && tab.url.includes(liActivity(post));
  const u = new URL(post.url);
  return /reddit\.com/.test(tab.url) && new URL(tab.url).pathname.replace(/\/$/, '') === u.pathname.replace(/\/$/, '');
}

async function fill(id, text, via = 'draft') {
  const post = (await getPosts())[id];
  if (!post) return { ok: false, error: '找不到这条内容' };
  if (!post.url) return { ok: false, error: '这条回复没有链接，没法自动打开。草稿已复制，到平台上点对方的回复框粘贴即可。' };
  if (!PLATFORMS[post.platform]) return { ok: false, error: '这个网站不支持自动填入。回复已复制到剪贴板，回到原网页，在回复框里粘贴，检查后自己点发送。' };
  await updatePosts((ps) => { if (ps[id]) ps[id].fillVia = via; });
  const blocked = await checkGate(post.platform);
  if (blocked) return { ok: false, error: blocked };

  // 先把草稿存起来：新打开的页面加载完会自己取走并填入，不依赖后台去「追」页面加载时机。
  await chrome.storage.local.set({ pendingFill: { item: post, text, at: Date.now() } });
  const tabs = await chrome.tabs.query({});
  // 优先用已经打开着这条内容的标签页；评论则也可以用打开着同一讨论串的标签页。
  let tab = tabs.find((t) => tabMatches(t, post)) || (post.kind === 'comment' && tabs.find((t) => sameThread(t, post) && t.active));
  // 没有专门打开它的页面：问问同平台的其他标签页（比如信息流）里有没有这条
  if (!tab) {
    for (const t of tabs.filter((x) => sameThread(x, post) || sameSite(x, post)).sort((a, c) => (c.active ? 1 : 0) - (a.active ? 1 : 0))) {
      const r = await chrome.tabs.sendMessage(t.id, { type: 'HAS_ITEM', item: post }).catch(() => null);
      if (r?.ok) { tab = t; break; }
    }
  }
  if (!tab && post.kind === 'comment') tab = tabs.find((t) => sameThread(t, post));
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'FILL_REPLY', item: post, text });
      if (res?.ok) return { ok: true, mode: res.mode };
    } catch {}
  }
  await chrome.tabs.create({ url: post.url, active: true });
  return { ok: true, mode: 'opening' };
}

async function markFilled(id, text) {
  await updatePosts((ps) => ps[id] && (ps[id].filledText = text));
  return { ok: true };
}

const SITES = { reddit: /reddit\.com/, x: /(x|twitter)\.com/, linkedin: /linkedin\.com/ };
const sameSite = (tab, post) => !!tab.url && SITES[post.platform]?.test(new URL(tab.url).hostname);

function sameThread(tab, post) {
  if (!tab.url) return false;
  if (post.platform === 'x') return /^https:\/\/(x|twitter)\.com\/[^/]+\/status\//.test(tab.url);
  // LinkedIn 的评论就在信息流 / 帖子页里，任何一个打开着的 LinkedIn 页面都可能有它
  if (post.platform === 'linkedin') return /linkedin\.com\/(feed|posts)/.test(tab.url);
  const pid = post.url.match(/\/comments\/([a-z0-9]+)/i)?.[1];
  return !!pid && /reddit\.com/.test(tab.url) && tab.url.includes('/comments/' + pid);
}

// ================= 发送后：计数 + 风格学习 =================

async function recordSent(id, finalText, draftText) {
  const s = await getSettings();
  const post = (await getPosts())[id];
  const platform = post?.platform || platformOfId(id);
  const stats = await getStats();
  if (PLATFORMS[platform]) stats.sent[platform]++; // 普通网页不计入平台每日上限
  stats.lastSentAt = Date.now();
  const [lo, hi] = platform === 'linkedin' ? [s.linkedinCooldownMinMin, s.linkedinCooldownMaxMin] : [s.cooldownMinMin, s.cooldownMaxMin];
  if (PLATFORMS[platform]) stats.nextAllowed[platform] = Date.now() + randBetween(lo, hi) * 60000;
  await saveStats(stats);
  await updatePosts((ps) => { if (ps[id]) { ps[id].status = 'sent'; ps[id].finalText = finalText; ps[id].sentAt = Date.now(); } });

  await recordLinkUsage(finalText).catch(() => {});
  // 这条是用「我来写」翻译后发的：把原文和你的定稿一起记下来
  const tr = post?.translation;
  if (tr && finalText && post.fillVia === 'translate') {
    await recordTranslation({ ...tr, final: finalText });
  }
  const style = await getStyle();
  logInput(finalText, 'sent', post?.text ? '他回复的内容：' + post.text.slice(0, 300) : '');
  style.samples.push({ id: 'sent_' + id, platform, text: finalText, lang: detectLang(finalText), context: post?.title || '', source: 'sent', at: Date.now() });
  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const base = draftText || post?.filledText;
  if (base && norm(base) !== norm(finalText)) style.edits.push({ draft: base, final: finalText, at: Date.now() });
  style.sinceUpdate = (style.sinceUpdate || 0) + 1;
  await saveStyle(style);
  if (style.sinceUpdate >= 8 && hasKey(s)) buildProfile().catch(() => {});
}

// ================= 我来写：翻译你自己写的回复 =================

async function translate({ text, target, id, instruction, previous, polish }) {
  if (!text?.trim()) throw new Error('先写点内容。');
  if (target !== ((await getSettings()).myLang || 'zh')) logInput(text, 'translate');
  const s = await getSettings();
  const post = id ? (await getPosts())[id] : null;
  const lang = target === 'auto' ? (normLang(post?.lang) || 'en') : target || s.translateTarget || 'en';
  const { system, user } = translatePrompt(await getStyle(), { text: text.trim(), target: lang, item: post, previous, instruction, polish: !!polish });
  const out = await busy('drafting', 1, () => callLLM(s, 'draft', { system, user, effort: 'low', maxTokens: 4000, onUsage: trackUsage('draft') }));
  const clean = String(out || '').trim().replace(/^["“](.*)["”]$/s, '$1');
  if (!clean) throw new Error('模型没有返回译文，请重试。');
  if (post) await updatePosts((ps) => { if (ps[id]) ps[id].translation = { src: text.trim(), out: clean, lang, at: Date.now() }; });
  return { text: clean, lang };
}

// 记下一组「原文 → 译文 → 你的定稿」；定稿本身也是你用这个语种写作的样本
async function recordTranslation({ src, out, final, lang }) {
  if (!src || !final) return;
  const style = await getStyle();
  const list = (style.translations || []).filter((t) => t.src !== src);
  list.push({ src: src.slice(0, 1500), out: (out || '').slice(0, 2000), final: final.slice(0, 2000), lang, at: Date.now() });
  style.translations = list.slice(-80);
  if (!style.samples.some((x) => x.text === final)) {
    style.samples.push({ id: 'tr_' + Date.now(), platform: 'translate', text: final, lang: lang || detectLang(final), context: '', source: 'translated', at: Date.now() });
  }
  await saveStyle(style);
}

// 把一条已发送的 Reddit / X 回复改写成 LinkedIn 长帖草稿（只生成，发布由你自己来）
async function longPost(id, instruction = '') {
  const s = await getSettings();
  const post = (await getPosts())[id];
  if (!post?.finalText) throw new Error('只有已发送、并且记录了你的回复内容的条目才能改写。');
  const { system, user } = longPostPrompt(s, await getStyle(), post, { company: await getCompany(), instruction });
  const out = await busy('drafting', 1, () => callLLM(s, 'draft', { system, user, schema: LONGPOST_SCHEMA, effort: 'medium', onUsage: trackUsage('draft') }));
  const text = (out.text || '').trim();
  if (!text) throw new Error('模型没有返回内容，请重试。');
  await updatePosts((ps) => { if (ps[id]) ps[id].longPost = { text, hook: out.hook || '', lang: out.language || '', at: Date.now() }; });
  return { text };
}

// ================= 越用越懂你：从使用中学习你的观点 =================
// 你在讨论、补充要求、翻译原文、发出的内容里表达的观点 → 定期提炼成候选 → 你在「我的风格」里确认后写进「观点与立场」

const getLearn = async () => ({ inputs: [], views: [], lastRun: 0, ...((await chrome.storage.local.get('learn')).learn || {}) });
let learnChain = Promise.resolve();
const updateLearn = (fn) => (learnChain = learnChain.then(async () => { const l = await getLearn(); await fn(l); await chrome.storage.local.set({ learn: l }); return l; }).catch(() => {}));

function logInput(text, source, ctx = '') {
  const t = (text || '').trim();
  if (t.length < 8) return;
  updateLearn((l) => {
    if (l.inputs.some((x) => x.text === t)) return;
    l.inputs.push({ text: t.slice(0, 2000), source, ctx: (ctx || '').slice(0, 800), at: Date.now(), done: false });
    l.inputs = l.inputs.slice(-200);
  }).then(maybeLearn);
}

async function maybeLearn() {
  const s = await getSettings();
  if (s.learnViews === false || !hasKey(s)) return;
  const l = await getLearn();
  const fresh = l.inputs.filter((x) => !x.done).length;
  if (fresh >= 8 && Date.now() - (l.lastRun || 0) > 30 * 60000) learnViews().catch(() => {});
}

let learning = false;
async function learnViews() {
  if (learning) return { added: 0 };
  learning = true;
  try {
    const s = await getSettings();
    const l = await getLearn();
    const batch = l.inputs.filter((x) => !x.done).slice(-30);
    if (!batch.length) return { added: 0 };
    const style = await getStyle();
    const known = [...(style.viewpoints || '').split('\n').map((x) => x.replace(/^[-•\d.、\s]+/, '').trim()).filter((x) => x.length > 6), ...l.views.filter((v) => v.status === 'pending').map((v) => v.text)].slice(-80);
    const rejected = l.views.filter((v) => v.status === 'rejected').map((v) => v.text).slice(-40);
    const { system, user } = viewsPrompt(s, style, batch, { known, rejected, knownInterests: s.interests + '\n' + l.views.filter((v) => v.kind === 'interest' && v.status === 'pending').map((v) => v.text).join('\n') });
    const out = await busy('drafting', 1, () => callLLM(s, 'score', { system, user, schema: VIEWS_SCHEMA, effort: 'low', maxTokens: 3000, onUsage: trackUsage('score') }));
    const done = new Set(batch.map((b) => b.text));
    const views = [
      ...(out.views || []).filter((v) => v.text?.trim() && (v.confidence ?? 1) >= 0.6).map((v) => ({ ...v, kind: 'view' })),
      ...(out.interests || []).filter((v) => v.text?.trim() && (v.confidence ?? 1) >= 0.6).map((v) => ({ ...v, kind: 'interest' }))
    ];
    let added = 0;
    await updateLearn((cur) => {
      cur.inputs.forEach((x) => done.has(x.text) && (x.done = true));
      cur.lastRun = Date.now();
      for (const v of views) {
        const text = v.text.trim();
        if (cur.views.some((x) => sameText(x.text, text))) continue;
        cur.views.push({ id: 'v_' + Date.now() + '_' + added, kind: v.kind, text, quote: (v.quote || '').slice(0, 300), keywords: (v.keywords || []).map((k) => String(k).toLowerCase().trim()).filter(Boolean).slice(0, 5), confidence: v.confidence ?? 0.7, status: 'pending', at: Date.now() });
        added++;
      }
      cur.views = cur.views.slice(-200);
    });
    return { added };
  } finally {
    learning = false;
  }
}

// 采纳：写进「观点与立场」最后的「使用中学到的观点」一节
async function acceptView({ id, text }) {
  const l = await getLearn();
  const v = l.views.find((x) => x.id === id);
  if (v?.kind === 'interest') {
    // 兴趣：加到「兴趣领域描述」（放在「不感兴趣」那行之前），关键词并进打分预筛
    const s = await getSettings();
    const parts = (s.interests || '').split('\n');
    const i = parts.findIndex((x) => x.startsWith('不感兴趣'));
    const line = `- ${text.trim()}（使用中学到）`;
    if (i >= 0) parts.splice(i, 0, line); else parts.push(line);
    const has = new Set((s.keywords || []).map((k) => k.toLowerCase()));
    await saveSettings({ interests: parts.join('\n'), keywords: [...(s.keywords || []), ...(v.keywords || []).filter((k) => !has.has(k))] });
    await updateLearn((cur) => { const x = cur.views.find((y) => y.id === id); if (x) { x.status = 'accepted'; x.text = text.trim(); } });
    return { ok: true };
  }
  const style = await getStyle();
  const HEAD = '【使用中学到的观点】';
  const line = '- ' + text.trim();
  let vp = (style.viewpoints || '').trimEnd();
  if (!vp.includes(HEAD)) vp += (vp ? '\n\n' : '') + HEAD;
  style.viewpoints = vp + '\n' + line;
  await saveStyle(style);
  await updateLearn((l) => { const v = l.views.find((x) => x.id === id); if (v) { v.status = 'accepted'; v.text = text.trim(); } });
  return { ok: true };
}

// ================= 发帖：讨论观点 → 写成各平台原创帖 → 打开发帖页填好，由你点发布 =================

async function discuss(thread, source) {
  if (!thread?.length) throw new Error('先说说你的想法。');
  const s = await getSettings();
  const last = thread.at(-1);
  if (last?.role === 'user' && last.text.length >= 30) {
    const st = await getStyle();
    if (!st.samples.some((x) => x.text === last.text)) {
      st.samples.push({ id: 'in_' + Date.now(), platform: 'discuss', text: last.text, lang: detectLang(last.text), context: '', source: 'input', at: Date.now() });
      await saveStyle(st);
    }
  }
  if (last?.role === 'user') logInput(last.text, 'discuss', thread.at(-2)?.role === 'ai' ? thread.at(-2).text : (source?.text ? '对方的帖子：' + source.text : ''));
  const { system, user } = discussPrompt(s, await getStyle(), thread.slice(-16), source?.text?.trim() ? source : null);
  const out = await busy('drafting', 1, () => callLLM(s, 'draft', { system, user, effort: 'medium', maxTokens: 4000, onUsage: trackUsage('draft') }));
  const text = String(out || '').trim();
  if (!text) throw new Error('模型没有返回内容，请重试。');
  return text;
}

async function compose({ thread, platforms, lang = 'en', instruction, previous }) {
  if (!thread?.length) throw new Error('先写下你想表达的观点。');
  const plats = (platforms || []).filter((p) => ['x', 'linkedin', 'reddit'].includes(p));
  if (!plats.length) throw new Error('至少选一个平台。');
  if (instruction) logInput(instruction, 'refine');
  const s = await getSettings();
  const { system, user } = composePrompt(s, await getStyle(), {
    thread: thread.slice(-16), platforms: plats, lang: LANGS[lang] || 'English', company: await getCompany(), instruction, previous
  });
  const out = await busy('drafting', 1, () => callLLM(s, 'draft', { system, user, schema: composeSchema(plats), effort: 'medium', onUsage: trackUsage('draft') }));
  const res = { thesis: out.thesis || '' };
  if (plats.includes('x') && out.x) res.x = { single: (out.x.single || '').trim(), thread: (out.x.thread || []).map((t) => String(t).trim()).filter(Boolean) };
  if (plats.includes('linkedin') && out.linkedin) res.linkedin = { text: (out.linkedin.text || '').trim() };
  if (plats.includes('reddit') && out.reddit) {
    res.reddit = { subreddits: (out.reddit.subreddits || []).map((x) => String(x).replace(/^\/?r\//i, '').trim()).filter(Boolean).slice(0, 3), title: (out.reddit.title || '').trim(), body: (out.reddit.body || '').trim() };
  }
  if (!res.x && !res.linkedin && !res.reddit) throw new Error('模型没有返回内容，请重试。');
  return res;
}

function composeUrl({ platform, text, title, subreddit }) {
  const q = encodeURIComponent;
  if (platform === 'x') return `https://x.com/intent/post?text=${q(text)}`;
  if (platform === 'linkedin') return `https://www.linkedin.com/feed/?shareActive=true&text=${q(text)}`;
  const sub = (subreddit || '').replace(/^\/?r\//i, '').trim();
  return `https://www.reddit.com/${sub ? 'r/' + q(sub) + '/' : ''}submit?type=TEXT&title=${q(title || '')}&text=${q(text)}`;
}

// 只打开发帖页并填好内容；发布按钮永远由你自己点
async function composePublish({ platform, text, title, subreddit, cid, tid, draftText }) {
  if (!text?.trim()) throw new Error('内容是空的。');
  if (platform === 'reddit' && !title?.trim()) throw new Error('Reddit 帖子需要标题。');
  const s = await getSettings();
  const stats = await getStats();
  if (stats.sent[platform] >= s.caps[platform]) throw new Error(`今天 ${platName(platform)} 已达到 ${s.caps[platform]} 条的上限（回复和发帖合计），可在设置里调整。`);
  await chrome.storage.local.set({ pendingCompose: { platform, text, title: title || '', cid, tid, draftText: draftText || '', at: Date.now() } });
  await chrome.tabs.create({ url: composeUrl({ platform, text, title, subreddit }), active: true });
  return { ok: true };
}

// 你点了平台上的「发布」（或在侧边栏点了「我已发布」）：计数、记录、学习风格
async function composeSent({ platform, text, title, draftText, cid, tid }) {
  if (!text?.trim() || !PLATFORMS[platform]) return { ok: false };
  const { ownPosts = [] } = await chrome.storage.local.get('ownPosts');
  if (cid && ownPosts.some((p) => p.cid === cid)) return { ok: true, dup: true };
  ownPosts.push({ cid: cid || 'c_' + Date.now(), tid: tid || '', platform, title: title || '', text: text.slice(0, 3000), draft: (draftText || '').slice(0, 3000), at: Date.now() });
  await chrome.storage.local.set({ ownPosts: ownPosts.slice(-200) });
  const stats = await getStats();
  if (PLATFORMS[platform]) stats.sent[platform]++; // 普通网页不计入平台每日上限
  stats.lastSentAt = Date.now();
  await saveStats(stats);
  const style = await getStyle();
  logInput(text, 'post');
  style.samples.push({ id: 'orig_' + Date.now(), platform, text, lang: detectLang(text), context: '', source: 'original', at: Date.now() });
  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
  if (draftText && norm(draftText) !== norm(text)) style.edits.push({ draft: draftText, final: text, at: Date.now() });
  style.sinceUpdate = (style.sinceUpdate || 0) + 1;
  await saveStyle(style);
  const s = await getSettings();
  if (style.sinceUpdate >= 8 && hasKey(s)) buildProfile().catch(() => {});
  return { ok: true };
}

async function buildProfile() {
  const s = await getSettings();
  const style = await getStyle();
  if (style.samples.length < 3) throw new Error('样本太少：至少需要 3 条你亲自写的回复。');
  const { system, user } = profilePrompt(style);
  const profile = await callLLM(s, 'draft', { system, user, effort: 'medium' });
  const latest = await getStyle();
  latest.profile = profile;
  latest.profileUpdatedAt = Date.now();
  latest.sinceUpdate = 0;
  await saveStyle(latest);
  return profile;
}

// ================= 风格样本导入 =================

async function importRedditHistory(username) {
  const u = username.replace(/^\/?u\//, '').trim();
  if (!u) throw new Error('请填写 Reddit 用户名');
  const style = await getStyle();
  const have = new Set(style.samples.map((x) => x.id));
  let after = '';
  let added = 0;
  for (let page = 0; page < 3; page++) {
    let j;
    try {
      j = await fetchRedditJson(`https://www.reddit.com/user/${encodeURIComponent(u)}/comments.json?limit=100&raw_json=1${after ? '&after=' + after : ''}`);
    } catch (err) {
      if (added) break;
      throw new Error(`Reddit 拒绝了请求（${err.message}），稍后再试，或改用「粘贴样本」。`);
    }
    for (const c of j.data?.children || []) {
      const d = c.data;
      if (!d?.body || d.body.length < 15 || have.has(d.name)) continue;
      style.samples.push({ id: d.name, platform: 'reddit', text: d.body.slice(0, 1500), lang: detectLang(d.body), context: d.link_title || '', source: 'import', at: d.created_utc * 1000 });
      added++;
    }
    after = j.data?.after;
    if (!after) break;
    await sleep(randBetween(1500, 3000));
  }
  await saveStyle(style);
  return added;
}

async function addManualSamples(texts, platform) {
  const style = await getStyle();
  let n = 0;
  for (const t of texts) {
    const text = t.trim();
    if (text.length < 5) continue;
    style.samples.push({ id: 'manual_' + Date.now() + '_' + n, platform: platform || 'manual', text, lang: detectLang(text), context: '', source: 'manual', at: Date.now() });
    n++;
  }
  await saveStyle(style);
  return n;
}

// ================= 你在 Reddit 发的帖子：低频检查新评论（公开 JSON，只读） =================

async function checkMyRedditPosts({ notify = true } = {}) {
  const s = await getSettings();
  const { ownPosts = [] } = await chrome.storage.local.get('ownPosts');
  const mine = ownPosts.filter((o) => o.platform === 'reddit' && o.url && Date.now() - o.at < 14 * 864e5);
  const me = (s.redditUsername || '').toLowerCase();
  let added = 0;
  for (const o of mine) {
    let data;
    try { data = await fetchRedditJson(o.url.replace(/\/?(\?.*)?$/, '') + '/.json?limit=200&sort=new&raw_json=1'); } catch { continue; }
    const post = data?.[0]?.data?.children?.[0]?.data;
    if (!post) continue;
    const root = { title: post.title || '', text: post.selftext || '', author: post.author || '' };
    const items = [];
    const walk = (children, parents) => {
      for (const c of children || []) {
        if (c.kind !== 't1' || !c.data?.body) continue;
        const d = c.data;
        const isMe = me && d.author?.toLowerCase() === me;
        const parentAuthor = parents.at(-1)?.author || root.author;
        // 只收直接回你帖子的评论，以及回复你的评论；你自己的评论不收
        if (!isMe && !/^automoderator$/i.test(d.author || '') && (parents.length === 0 || (me && parentAuthor.toLowerCase() === me))) {
          items.push({
            id: d.name, parentId: d.parent_id, platform: 'reddit', kind: 'comment',
            url: 'https://www.reddit.com' + d.permalink, title: root.title, text: String(d.body).slice(0, 1500),
            author: d.author, community: 'r/' + post.subreddit, createdAt: (d.created_utc || 0) * 1000,
            engagement: { up: d.score || 0, comments: 0 },
            context: { rootTitle: root.title, rootText: root.text.slice(0, 2500), rootAuthor: root.author, parents: parents.slice(-6) }
          });
        }
        walk(d.replies?.data?.children, [...parents, { author: d.author, text: String(d.body).slice(0, 800) }]);
      }
    };
    walk(data?.[1]?.data?.children, []);
    if (!o.itemId && post.name) {
      const { ownPosts: cur = [] } = await chrome.storage.local.get('ownPosts');
      await chrome.storage.local.set({ ownPosts: cur.map((x) => (x.cid === o.cid ? { ...x, itemId: post.name } : x)) });
    }
    if (items.length) added += await ingest(items);
    await sleep(1500);
  }
  if (added && notify) {
    chrome.notifications?.create('myposts_' + Date.now(), {
      type: 'basic', iconUrl: 'icons/icon128.png',
      title: `你在 Reddit 的帖子有 ${added} 条新回复`,
      message: '打开侧边栏「待回复」→「回复我的」查看并起草回复。', priority: 1
    }).catch?.(() => {});
  }
  return added;
}

// 「回复别人的帖子」议题：把对方的帖子做成一条待回复内容（只在议题里显示），按讨论起草
const platformOfUrl = (u) => (/reddit\.com/.test(u) ? 'reddit' : /(^|\/\/|\.)(x|twitter)\.com/.test(u) ? 'x' : /linkedin\.com/.test(u) ? 'linkedin' : /news\.ycombinator\.com/.test(u) ? 'hn' : '');
async function topicReply({ tid, source, lang }) {
  const text = (source?.text || '').trim();
  if (!text) throw new Error('先把对方的帖子内容粘贴进来。');
  const url = (source.url || '').trim();
  const platform = source.platform || platformOfUrl(url) || 'web';
  if (noAI(platform)) throw new Error(`${platName(platform)} 不允许 AI 生成或改写的评论：在这里讨论清楚后，请自己写。`);
  const id = 'ext_' + tid;
  logInput(text, 'pasted');
  await updatePosts((ps) => {
    const old = ps[id] || {};
    ps[id] = {
      ...old, id, platform, kind: 'post', url, title: '', text: text.slice(0, 4000),
      author: (source.author || '').trim().replace(/^@|^u\//, '') || '对方', community: '', lang: detectLang(text),
      createdAt: old.createdAt || Date.now(), seenAt: old.seenAt || Date.now(), engagement: {}, parentId: '', context: null,
      tid, ext: true, status: old.status === 'sent' ? 'sent' : 'scored', score: 90, reason: '', pageTitle: (source.title || '').slice(0, 200)
    };
  });
  await draft(id, '', lang || 'en');
  return { id };
}

// 抓不到的回复：你手动贴进来（或在网页上选中后右键带进来），挂到对应的帖子和议题下
async function addManualReply({ cid, text, author, url }) {
  const body = (text || '').trim();
  if (!body) throw new Error('先粘贴对方的回复内容。');
  const s = await getSettings();
  const { ownPosts = [] } = await chrome.storage.local.get('ownPosts');
  const o = ownPosts.find((x) => x.cid === cid);
  if (!o) throw new Error('找不到这条帖子记录。');
  const id = 'manual_' + o.platform + '_' + Date.now();
  logInput(body, 'pasted');
  const me = s[PLATFORMS[o.platform].selfKey] || '我';
  await updatePosts((ps) => {
    ps[id] = {
      id, platform: o.platform, kind: 'comment', url: (url || '').trim() || o.url || '', title: o.title || '', text: body.slice(0, 3000),
      author: (author || '').trim().replace(/^[@]|^u\//, '') || '对方', community: '', lang: detectLang(body), createdAt: Date.now(), seenAt: Date.now(),
      engagement: {}, parentId: o.itemId || '',
      context: { rootTitle: o.title || '', rootText: o.text, rootAuthor: me, parents: [] },
      tid: o.tid, ownCid: o.cid, onMyPost: true, replyToMe: true, manual: true,
      status: 'scored', score: 90, reason: '你手动添加的回复'
    };
  });
  return { id };
}

async function addFromSelection(info, tab) {
  const url = info.pageUrl || tab?.url || '';
  const platform = /reddit\.com/.test(url) ? 'reddit' : /(x|twitter)\.com/.test(url) ? 'x' : 'linkedin';
  const { ownPosts = [] } = await chrome.storage.local.get('ownPosts');
  const key = platform === 'reddit' ? url.match(/\/comments\/([a-z0-9]+)/i)?.[1] : platform === 'x' ? url.match(/\/status\/(\d+)/)?.[1] : url.match(/activity[:-](\d{10,})/)?.[1];
  const cands = ownPosts.filter((o) => o.platform === platform).sort((a, b) => b.at - a.at);
  // 优先：当前页面就是你那条帖子；否则挂到这个平台上你最近发的一条（在侧边栏可以看到并修改）
  const o = (key && cands.find((x) => (x.url || '').includes(key) || (x.itemId || '').includes(key))) || cands[0];
  if (!o) {
    chrome.notifications?.create('rc_noown_' + Date.now(), { type: 'basic', iconUrl: 'icons/icon128.png', title: '还没有可以挂靠的帖子', message: `在「发帖」里发过 ${platName(platform)} 帖子之后，才能把回复带进来。`, priority: 1 }).catch?.(() => {});
    return { none: true };
  }
  const { id } = await addManualReply({ cid: o.cid, text: info.selectionText, url: key ? url : '' });
  await chrome.storage.local.set({ panelJump: { tid: o.tid, id, at: Date.now() } });
  draft(id).catch(() => {});
}
chrome.contextMenus?.onClicked.addListener((info, tab) => {
  const mode = { 'rc-help-reply': 'reply', 'rc-translate': 'translate' }[info.menuItemId];
  if (mode) openQuick({ text: (info.selectionText || '').trim(), url: info.pageUrl || tab?.url || '', title: tab?.title || '', mode }).catch(() => {});
});
// 全局快捷键：在桌面聊天软件里先复制，再按快捷键，弹出同一个小窗（小窗自己读剪贴板）
chrome.commands?.onCommand.addListener((cmd) => {
  if (cmd === 'quick-reply') openQuick({ text: '', fromClipboard: true, mode: 'reply' }).catch(() => {});
  if (cmd === 'quick-translate') openQuick({ text: '', fromClipboard: true, mode: 'translate' }).catch(() => {});
});

// ================= 轻量「帮我回复」小窗 =================
async function openQuick(req) {
  await chrome.storage.local.set({ quickReq: { ...req, platform: platformOfUrl(req.url || ''), at: Date.now() } });
  const { quickWin } = await chrome.storage.session.get('quickWin');
  if (quickWin) {
    const w = await chrome.windows.get(quickWin).catch(() => null);
    if (w) return chrome.windows.update(quickWin, { focused: true, drawAttention: true });
  }
  const W = 420, H = 640;
  let left, top;
  try {
    const f = await chrome.windows.getLastFocused();
    left = Math.max(0, f.left + f.width - W - 24);
    top = Math.max(0, f.top + 80);
  } catch {}
  const w = await chrome.windows.create({ url: chrome.runtime.getURL('quick/quick.html'), type: 'popup', width: W, height: H, focused: true, ...(left != null ? { left, top } : {}) });
  await chrome.storage.session.set({ quickWin: w.id });
}
chrome.windows?.onRemoved.addListener(async (id) => {
  const { quickWin } = await chrome.storage.session.get('quickWin');
  if (quickWin === id) chrome.storage.session.remove('quickWin');
});

async function quickReply({ text, title, url, lang, view, previous }) {
  if (noAI(platformOfUrl(url || ''))) throw new Error('Hacker News 不允许 AI 生成或改写的评论，这里不生成回复。可以在工作台里看中文解读、和我讨论，想清楚后自己写。');
  const body = (text || '').trim();
  if (!body) throw new Error('先把要回复的内容放进来。');
  const s = await getSettings();
  if (!hasKey(s)) throw new Error('还没有设置模型 API Key：打开侧边栏 → 设置。');
  const style = await getStyle();
  logInput(body, 'pasted');
  if (view) logInput(view, 'refine', '要回复的内容：' + body.slice(0, 300));
  const { system, user } = quickPrompt(s, style, { text: body, title, lang: lang === 'auto' ? '' : lang, view: (view || '').trim(), previous });
  const out = await busy('drafting', 1, () => callLLM(s, 'draft', { system, user, schema: DRAFT_SCHEMA, effort: 'low', onUsage: trackUsage('draft') }));
  const drafts = (Array.isArray(out.drafts) ? out.drafts : Array.isArray(out.replies) ? out.replies : [])
    .map((d) => (typeof d === 'string' ? { angle: '', text: d, gloss: '' } : { angle: d.angle || '', text: d.text || d.reply || d.content || '', gloss: d.gloss || '' }))
    .filter((d) => d.text.trim()).slice(0, 3);
  if (!drafts.length) throw new Error('模型没有返回可用的回复，请重试。');
  const stats = await getStats();
  stats.drafts++;
  await saveStats(stats);
  return { drafts, suggestion: out.suggestion || '', language: out.language || '' };
}

// 你复制走的那条：当作你写过的话，用来学语气；改过的话也记下你的修改
async function quickUsed({ text, draft, context }) {
  const final = (text || '').trim();
  if (!final) return;
  const style = await getStyle();
  style.samples.push({ id: 'chat_' + Date.now(), platform: 'chat', text: final, lang: detectLang(final), context: (context || '').slice(0, 120), source: 'chat', at: Date.now() });
  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
  if (draft && norm(draft) !== norm(final)) style.edits.push({ draft, final, at: Date.now() });
  style.sinceUpdate = (style.sinceUpdate || 0) + 1;
  await saveStyle(style);
  const s = await getSettings();
  if (style.sinceUpdate >= 8 && hasKey(s)) buildProfile().catch(() => {});
}

// 「发帖」里没自动识别到帖子链接时，你可以手动贴上
async function linkOwnPost({ cid, url }) {
  const u = (url || '').trim();
  const platform = /reddit\.com/.test(u) ? 'reddit' : /(x|twitter)\.com/.test(u) ? 'x' : /linkedin\.com/.test(u) ? 'linkedin' : '';
  if (!platform) throw new Error('链接看起来不是 Reddit / X / LinkedIn 的帖子。');
  const { ownPosts = [] } = await chrome.storage.local.get('ownPosts');
  const o = ownPosts.find((x) => x.cid === cid);
  if (!o) throw new Error('找不到这条帖子记录。');
  if (o.platform !== platform) throw new Error(`这是一条 ${platName(o.platform)} 帖子，链接却是 ${platName(platform)} 的。`);
  o.url = u;
  const m = platform === 'reddit' ? u.match(/\/comments\/([a-z0-9]+)/i) : platform === 'x' ? u.match(/\/status\/(\d+)/) : u.match(/activity[:-](\d{10,})/);
  if (m) o.itemId = platform === 'reddit' ? 't3_' + m[1] : platform === 'x' ? 'x_' + m[1] : o.itemId;
  await chrome.storage.local.set({ ownPosts });
  if (platform === 'reddit') checkMyRedditPosts().catch(() => {});
  return { ok: true };
}

// ================= Reddit 订阅源（只读、低频） =================

async function fetchFeed() {
  const s = await getSettings();
  if (!s.feedEnabled || s.paused || !hasKey(s) || !s.subreddits.length) return 0;
  const { feedCursor = 0 } = await chrome.storage.local.get('feedCursor');
  const subs = [];
  for (let i = 0; i < Math.min(4, s.subreddits.length); i++) subs.push(s.subreddits[(feedCursor + i) % s.subreddits.length]);
  await chrome.storage.local.set({ feedCursor: (feedCursor + subs.length) % s.subreddits.length });
  let total = 0;
  for (const sub of subs) {
    try {
      const j = await fetchRedditJson(`https://www.reddit.com/r/${encodeURIComponent(sub)}/new.json?limit=20&raw_json=1`);
      const items = (j.data?.children || []).map(({ data: d }) => ({
        id: d.name,
        platform: 'reddit',
        kind: 'post',
        url: 'https://www.reddit.com' + d.permalink,
        title: d.title,
        text: (d.selftext || '').slice(0, 1500),
        author: d.author,
        community: 'r/' + d.subreddit,
        createdAt: d.created_utc * 1000,
        engagement: { up: d.score, comments: d.num_comments },
        context: null,
        source: 'feed'
      })).filter((it) => !it.title.toLowerCase().includes('[removed]'));
      total += await ingest(items);
      await updateDiag((d) => { d.feed.ok++; d.feed.lastError = ''; });
    } catch (err) {
      await updateDiag((d) => { d.feed.failed++; d.feed.lastError = `r/${sub}：${err.message || err}`; });
    }
    await sleep(randBetween(4000, 10000));
  }
  await updateDiag((d) => { d.feed.lastAt = Date.now(); d.feed.added += total; });
  return total;
}

// 先匿名读公开数据；被 Reddit 拒绝时，再带上浏览器里的登录 Cookie 重试（只读，频率很低）。
// ================= Hacker News：按关键词拉新帖 + 首页（公开只读接口，不登录） =================
const stripHtml = (h = '') => h.replace(/<p>/g, '\n\n').replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&#x2F;/g, '/').replace(/&amp;/g, '&').trim();
const hnItem = (h) => ({
  id: 'hn_' + h.objectID,
  platform: 'hn',
  kind: 'post',
  url: 'https://news.ycombinator.com/item?id=' + h.objectID,
  title: h.title || '',
  text: stripHtml(h.story_text || '').slice(0, 1500) || (h.url ? `（链接：${h.url.replace(/^https?:\/\//, '').split('/')[0]}）` : ''),
  author: h.author || '',
  community: /^(Show|Ask|Launch) HN/i.test(h.title || '') ? h.title.match(/^(Show|Ask|Launch) HN/i)[0] : '',
  createdAt: (h.created_at_i || 0) * 1000,
  engagement: { up: h.points || 0, comments: h.num_comments || 0 },
  context: null,
  extUrl: h.url || '',
  source: 'feed'
});
async function fetchHN() {
  const s = await getSettings();
  if (!s.hnEnabled || s.paused || !hasKey(s)) return 0;
  const kws = (s.hnKeywords || []).filter(Boolean);
  const { hnCursor = 0 } = await chrome.storage.local.get('hnCursor');
  const pick = [];
  for (let i = 0; i < Math.min(3, kws.length); i++) pick.push(kws[(hnCursor + i) % kws.length]);
  await chrome.storage.local.set({ hnCursor: kws.length ? (hnCursor + pick.length) % kws.length : 0 });
  const since = Math.floor(Date.now() / 1000) - 3 * 86400;
  const urls = [
    'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30',
    ...pick.map((k) => `https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=10&numericFilters=created_at_i>${since}&query=${encodeURIComponent(k)}`)
  ];
  let total = 0;
  for (const u of urls) {
    try {
      const res = await fetch(u, { credentials: 'omit' });
      if (!res.ok) continue;
      const j = await res.json();
      total += await ingest((j.hits || []).filter((h) => h.title).map(hnItem));
    } catch {}
  }
  return total;
}

// 中文解读：帖子 + 评论区要点 + 你可以切入的角度（只给思路，不写回复）
async function digest(id) {
  const s = await getSettings();
  const post = (await getPosts())[id];
  if (!post) throw new Error('找不到这条内容');
  let comments = [];
  if (post.platform === 'hn' && post.kind === 'post') {
    try {
      const res = await fetch('https://hn.algolia.com/api/v1/items/' + id.replace(/^hn_/, ''), { credentials: 'omit' });
      if (res.ok) {
        const j = await res.json();
        if (!post.text && j.text) post.text = stripHtml(j.text).slice(0, 2500);
        comments = (j.children || []).filter((c) => c.text && c.author).slice(0, 15).map((c) => ({ author: c.author, text: stripHtml(c.text) }));
      }
    } catch {}
  }
  const { system, user } = digestPrompt(s, await getStyle(), post, comments);
  const out = await busy('drafting', 1, () => callLLM(s, 'draft', { system, user, schema: DIGEST_SCHEMA, effort: 'low', onUsage: trackUsage('draft') }));
  const d = { summary: out.summary || '', points: out.points || [], angles: out.angles || [], comments: comments.length, at: Date.now() };
  if (!d.summary) throw new Error('模型没有返回解读，请重试。');
  await updatePosts((ps) => { if (ps[id]) ps[id].digest = d; });
  return d;
}

async function fetchRedditJson(url) {
  let lastStatus = '';
  for (const credentials of ['omit', 'include']) {
    try {
      const res = await fetch(url, { credentials, headers: { accept: 'application/json' } });
      const type = res.headers.get('content-type') || '';
      if (res.ok && type.includes('json')) return await res.json();
      lastStatus = `HTTP ${res.status}${type.includes('json') ? '' : '（不是 JSON，可能被拦截）'}`;
    } catch (err) {
      lastStatus = String(err.message || err);
    }
  }
  throw new Error(lastStatus);
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'cleanup') return cleanup().then(purgeOwn);
  if (a.name === 'feed') { fetchFeed(); fetchHN().catch(() => {}); }
  if (a.name === 'myposts') return checkMyRedditPosts().catch(() => {});
  scheduleScoring(1000);
});

// ================= 消息路由 =================

const handlers = {
  ITEMS_SEEN: ({ items }) => ingest(items),
  DRAFT: ({ id, instruction, lang }) => draft(id, instruction, lang),
  SKIP: ({ id }) => updatePosts((ps) => ps[id] && (ps[id].status = 'skipped')),
  RESTORE: ({ id }) => updatePosts((ps) => ps[id] && (ps[id].status = 'scored')),
  FILL: ({ id, text, via }) => fill(id, text, via),
  REPLY_SENT: ({ itemId, finalText, draftText }) => recordSent(itemId, finalText, draftText),
  MARK_SENT: async ({ id, text, via }) => {
    if (via) await updatePosts((ps) => { if (ps[id]) ps[id].fillVia = via; });
    return recordSent(id, text, null);
  },
  BUILD_PROFILE: () => buildProfile(),
  OPEN_ONBOARDING: () => chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') }),
  IMPORT_REDDIT: ({ username }) => importRedditHistory(username),
  ADD_SAMPLES: ({ texts, platform }) => addManualSamples(texts, platform),
  FETCH_FEED: () => fetchFeed(),
  RESCORE: async () => {
    await updatePosts((ps) => Object.values(ps).forEach((p) => p.error && p.status === 'pending' && delete p.error));
    scheduleScoring(100);
  },
  SETTINGS_CHANGED: async () => {
    await setupFeedAlarm();
    return purgeOwn();
  },
  CHECK_GATE: ({ platform }) => checkGate(platform),
  MIGRATE: () => migrate(),
  FILL_RESULT: ({ id, text }) => markFilled(id, text),
  SELF_HANDLE: async ({ platform, handle }) => {
    const s = await getSettings();
    const key = PLATFORMS[platform]?.selfKey;
    if (!key) return;
    if (s[key]?.toLowerCase() === handle.toLowerCase()) return;
    if (!s[key]) await saveSettings({ [key]: handle });
    else return; // 你手动填过的账号优先，不自动覆盖
    await purgeOwn();
  },
  PURGE_OWN: () => purgeOwn(),
  CLEANUP: () => cleanup(),
  SAVE_TO_LIBRARY: async ({ id }) => {
    const p = (await getPosts())[id];
    if (!p) throw new Error('找不到这条内容');
    await updateLibrary((lib) => { lib[id] = lib[id] || libraryEntry(p); });
  },
  REMOVE_FROM_LIBRARY: ({ id }) => updateLibrary((lib) => { delete lib[id]; }),
  LONG_POST: ({ id, instruction }) => longPost(id, instruction),
  TRANSLATE: (msg) => translate(msg),
  DISCUSS: ({ thread, source }) => discuss(thread, source),
  TOPIC_REPLY: (msg) => topicReply(msg),
  QUICK_REPLY: (msg) => quickReply(msg),
  // 引导：测试当前模型商的 Key 是否可用
  TEST_KEY: async () => {
    const s = await getSettings();
    if (!hasKey(s)) throw new Error('还没有填写 API Key。');
    const out = await callLLM(s, 'score', { system: '你是连通性测试。', user: '只回复两个字母：OK', maxTokens: 20, effort: 'low' });
    return String(out || '').slice(0, 40);
  },
  // 引导：从几句自我介绍整理出兴趣、关键词、观点
  INTRO_PROFILE: async ({ intro }) => {
    const s = await getSettings();
    if (!(intro || '').trim()) throw new Error('先用几句话介绍一下你自己。');
    logInput(intro, 'intro');
    const out = await callLLM(s, 'draft', { ...introPrompt(intro, s.myLang), schema: INTRO_SCHEMA, effort: 'medium' });
    return {
      interests: String(out.interests || '').trim(),
      keywords: (out.keywords || []).map((k) => String(k).toLowerCase().trim()).filter(Boolean),
      viewpoints: String(out.viewpoints || '').trim(),
      subreddits: (out.subreddits || []).map((k) => String(k).replace(/^\/?r\//i, '').trim()).filter(Boolean),
      hnKeywords: (out.hnKeywords || []).map((k) => String(k).trim()).filter(Boolean)
    };
  },
  DIGEST: ({ id }) => digest(id),
  FETCH_HN: () => fetchHN(),
  QUICK_USED: (msg) => quickUsed(msg),
  QUICK_TO_PANEL: async ({ text, url }) => {
    const r = await addFromSelection({ selectionText: text, pageUrl: url }, null);
    if (r?.none) throw new Error('你还没在「发帖」里发过这个平台的帖子，没法挂到帖子下面。');
    return true;
  },
  COMPOSE: (msg) => compose(msg),
  COMPOSE_PUBLISH: (msg) => composePublish(msg),
  COMPOSE_SENT: (msg) => composeSent(msg),
  CHECK_MY_POSTS: () => checkMyRedditPosts({ notify: false }),
  LINK_OWN_POST: (msg) => linkOwnPost(msg),
  ADD_MANUAL_REPLY: (msg) => addManualReply(msg),
  LEARN_VIEWS: () => learnViews(),
  ACCEPT_VIEW: (msg) => acceptView(msg),
  REJECT_VIEW: ({ id }) => updateLearn((l) => { const v = l.views.find((x) => x.id === id); if (v) v.status = 'rejected'; }).then(() => ({ ok: true })),
  // 翻译页：填进当前窗口里正在看的 Reddit / X / LinkedIn 页面
  FILL_ACTIVE: async ({ text }) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.url || !/^https:\/\/(www\.|old\.)?(reddit|x|twitter|linkedin)\.com\//.test(tab.url)) {
      throw new Error('当前页面不是 Reddit / X / LinkedIn。译文已复制，可以直接粘贴。');
    }
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'FILL_ACTIVE', text }).catch(() => null);
    if (!r?.ok) throw new Error('页面上的插件脚本没有响应，刷新一下页面再试（译文已复制，可以直接粘贴）。');
    return r.mode === 'filled' ? '已填进你刚才点的输入框，检查后自己点发送。' : '点一下你要回复的输入框，译文就会填进去（也已复制，可以直接粘贴）。';
  },
  TRANSLATION_FINAL: (pair) => recordTranslation(pair),
  // LinkedIn 读不到内容时：从打开着的 LinkedIn 页面取一份结构诊断（不含正文）
  PROBE: async () => {
    const tabs = (await chrome.tabs.query({ url: 'https://www.linkedin.com/*' })).sort((a, c) => (c.active ? 1 : 0) - (a.active ? 1 : 0));
    if (!tabs.length) throw new Error('先打开一个 LinkedIn 信息流页面，往下滑几屏再点。');
    const r = await chrome.tabs.sendMessage(tabs[0].id, { type: 'PROBE' }).catch(() => null);
    if (!r?.text) throw new Error('LinkedIn 页面上的插件脚本没有响应：刷新一下 LinkedIn 页面再试。');
    return r.text;
  }
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const h = handlers[msg?.type];
  if (!h) return;
  Promise.resolve(h(msg))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
  return true;
});
