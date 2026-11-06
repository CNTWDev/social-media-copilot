import { getSettings, saveSettings, getStyle, saveStyle, getStats, getPosts, getDiag, getCompany, saveCompany, mentionInfo,
  getLinking, saveLinking, getLibrary } from '../lib/store.js';
import { valueOf, tierOf, CATEGORIES } from '../lib/value.js';
import { PROVIDERS, providerOf, hasKey } from '../lib/llm.js';
import { PLATFORMS, PLATFORM_KEYS, REPLY_KEYS, platName, who, noAI } from '../lib/platforms.js';
// 同一个页面两种用法：整页工作台（?app=1，在标签页里打开）和浏览时的侧边栏（只看当前页面）
const APP = new URLSearchParams(location.search).has('app');
document.body.classList.add(APP ? 'app' : 'panel');

const $ = (s, r = document) => r.querySelector(s);
const esc = (s = '') => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const send = (msg) => chrome.runtime.sendMessage(msg);

// 用户在草稿框里的修改、补充指令输入框的内容，重新渲染时要保留。
const localEdits = {};
const refineInputs = {};
const expanded = new Set();
const busy = new Set();
const writeOpen = new Set();
const writeInputs = {};
const writeTargets = {};
const LANG_OPTS = [['auto', '同原文'], ['en', '英文'], ['zh', '中文'], ['ja', '日文'], ['ko', '韩文'], ['es', '西班牙文'], ['fr', '法文'], ['de', '德文'], ['pt', '葡萄牙文']];
const langOptions = (sel, withAuto = true) => LANG_OPTS.filter(([k]) => withAuto || k !== 'auto')
  .map(([k, n]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${n}</option>`).join('');
let gate = {};
let company = null;
let libraryIds = new Set();
let tierFilter = 'all';
// 待回复卡片的操作同时用在「待回复」列表和「回复别人的帖子」议题里
const qOn = (ev, fn) => ['#queue', '#cpReplyBox', '#detailBody'].forEach((sel) => document.querySelector(sel).addEventListener(ev, fn));
let myLang = 'zh';
getSettings().then((s) => { myLang = s.myLang || 'zh'; });
let topicFilter = ''; // 从「发帖」议题跳过来时，只看这个议题下帖子的回复
const isMine = (p) => !!(p.replyToMe || p.onMyPost);
let catFilter = 'all';
const fmtNum = (n) => (n >= 10000 ? (n / 1000).toFixed(0) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));

// ---------------- Tabs ----------------
document.querySelectorAll('.tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
    document.querySelectorAll('textarea.auto').forEach(autosize);
    if (!APP) renderPageBar();
  })
);

function notice(msg, ms = 6000) {
  const n = $('#notice');
  n.textContent = msg;
  n.classList.remove('hidden');
  clearTimeout(notice._t);
  notice._t = setTimeout(() => n.classList.add('hidden'), ms);
}

// ---------------- Header ----------------
async function renderHeader() {
  const [s, st] = await Promise.all([getSettings(), getStats()]);
  for (const p of PLATFORM_KEYS) gate[p] = (await send({ type: 'CHECK_GATE', platform: p }))?.result;
  const stat = (p, name) => {
    const w = st.nextAllowed[p] - Date.now();
    const full = st.sent[p] >= s.caps[p];
    return `<span class="stat ${w > 0 || full ? 'cool' : ''}">${name} ${st.sent[p]}/${s.caps[p]}` +
      (full ? ' · 已满' : w > 0 ? ` · 冷却 ${Math.ceil(w / 60000)} 分` : '') + '</span>';
  };
  $('#stats').innerHTML = '<span class="stat-label">今日已发</span>' + REPLY_KEYS.map((p) => stat(p, platName(p))).join('') +
    (hasKey(s) ? '' : '<span class="stat warn">未设置 API Key</span>');
  $('#obBanner').classList.toggle('hidden', hasKey(s));
  renderDiag(s);
  $('#paused').checked = s.paused;
}
$('#paused').addEventListener('change', async (e) => {
  await saveSettings({ paused: e.target.checked });
  if (!e.target.checked) send({ type: 'RESCORE' });
});

// ---------------- 顶部处理进度 ----------------
let plPrev = {};
let readingUntil = 0;
async function renderPipeline() {
  const [{ activity }, d, posts] = await Promise.all([chrome.storage.local.get('activity'), getDiag(), getPosts()]);
  const sum = (k) => PLATFORM_KEYS.reduce((n, p) => n + (d[p]?.[k] || 0), 0);
  const v = { seen: sum('seen'), queued: sum('queued'), scored: sum('high') + sum('low'), high: sum('high') };
  for (const [k, id] of [['seen', 'plSeen'], ['queued', 'plQueued'], ['scored', 'plScored'], ['high', 'plHigh']]) {
    const el = $('#' + id);
    el.textContent = v[k];
    if (plPrev[k] != null && v[k] > plPrev[k]) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); setTimeout(() => el.classList.remove('bump'), 900); }
  }
  if (plPrev.seen != null && v.seen > plPrev.seen) readingUntil = Date.now() + 2500;
  plPrev = v;
  const waiting = Object.values(posts).filter((p) => p.status === 'pending').length;
  const drafting = Object.values(posts).filter((p) => p.drafting).length;
  const a = activity && Date.now() - activity.at < 3 * 60 * 1000 ? activity : { scoring: 0, drafting: 0 };
  // 进度 = 送审的内容里已经打完分的比例；没有排队时就是满的
  const total = v.scored + waiting;
  $('#plFill').style.width = (total ? Math.round((v.scored / total) * 100) : v.seen ? 100 : 0) + '%';
  const s = await getSettings();
  let text;
  const capped = !s.paused && !a.scoring && waiting > 0 && d.scoredToday >= s.maxScoredPerDay;
  if (s.paused) text = '已暂停';
  else if (capped) text = `今日打分已达上限 ${s.maxScoredPerDay} 条，${waiting} 条明天继续 · 点这里调整上限`;
  else if (a.scoring) text = `正在打分 ${a.scoring} 条` + (waiting > a.scoring ? `，还有 ${waiting - a.scoring} 条排队` : '');
  else if (a.drafting || drafting) text = `正在起草 ${Math.max(a.drafting, drafting)} 条回复`;
  else if (Date.now() < readingUntil) text = '正在读取页面内容';
  else if (waiting) text = `${waiting} 条等待打分`;
  else text = v.seen ? `空闲 · 最近读取 ${new Date(Math.max(...PLATFORM_KEYS.map((p) => d[p]?.lastSeenAt || 0))).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '空闲 · 打开 Reddit、X、LinkedIn 或 HN 开始浏览';
  $('#plText').textContent = text;
  const p = $('#pipeline');
  p.classList.toggle('capped', capped);
  p.classList.toggle('busy', !s.paused && !!(a.scoring || a.drafting || drafting));
  p.classList.toggle('reading', !s.paused && Date.now() < readingUntil);
  if (Date.now() < readingUntil) setTimeout(renderPipeline, readingUntil - Date.now() + 50);
}

// 打分撞上每日上限时，点状态栏直接跳到设置里的「每日打分上限」
$('#plStatus').addEventListener('click', () => {
  if (!$('#pipeline').classList.contains('capped')) return;
  document.querySelector('[data-tab="settings"]').click();
  const input = form.elements.maxScoredPerDay;
  for (let el = input.parentElement; el; el = el.parentElement) if (el.tagName === 'DETAILS') el.open = true;
  input.scrollIntoView({ block: 'center' });
  input.focus(); input.select();
});

// ---------------- 运行状态 ----------------
async function renderDiag(s) {
  const d = await getDiag();
  const t = (ts) => (ts ? new Date(ts).toLocaleTimeString() : '无');
  const line = (name, x) => {
    let tip = '';
    if (!x.seen) tip = name === 'Reddit'
      ? '还没读到任何内容：刷新一下 Reddit 页面再往下滑；如果还是 0，说明页面结构变了，请告诉开发者。'
      : '还没读到任何内容：刷新一下 X 页面再往下滑。';
    else if (x.queued === 0) tip = '读到的内容都没命中关键词，可以在设置里加关键词或关注的子版块，或关闭关键词初筛。';
    else if (x.high === 0 && x.low > 0) tip = '内容都低于显示阈值，在「低分」里能看到；可以调低阈值。';
    return `<div><b>${name}</b>：看到 ${x.seen} 条 · 本地过滤 ${x.filtered} · 送去打分 ${x.queued} · 高分 ${x.high} · 低分 ${x.low} · 最近读取 ${t(x.lastSeenAt)}</div>` +
      (tip ? `<div class="hint">↳ ${tip}</div>` : '');
  };
  const f = d.feed;
  $('#diag').innerHTML =
    PLATFORM_KEYS.map((p) => line(platName(p), d[p])).join('') +
    `<div><b>Reddit 订阅源</b>：${s.feedEnabled ? `最近拉取 ${t(f.lastAt)} · 成功 ${f.ok} · 失败 ${f.failed} · 新增 ${f.added}` : '已关闭'}</div>` +
    (f.lastError ? `<div class="err">订阅源出错：${esc(f.lastError)}</div>` : '') +
    (d.lastError ? `<div class="err">${esc(d.lastError)}</div>` : '') +
    `<div><b>今日 Token</b>：打分 ${d.scoredToday}/${s.maxScoredPerDay} 条，${d.tokens.score.calls} 次调用，输入 ${fmtNum(d.tokens.score.in)} · 输出 ${fmtNum(d.tokens.score.out)}；起草 ${d.tokens.draft.calls} 次，输入 ${fmtNum(d.tokens.draft.in)} · 输出 ${fmtNum(d.tokens.draft.out)}</div>` +
    `<div class="hint">「本地过滤」= 本地预筛丢掉的条数，这部分不花 Token。数字每天清零。</div>`;
  const problems = (!d.reddit.seen ? 1 : 0) + (f.lastError ? 1 : 0) + (d.lastError ? 1 : 0);
  $('#diagSummary').textContent = problems ? '有需要注意的地方' : `今日看到 ${PLATFORM_KEYS.map((p) => `${platName(p)} ${d[p].seen}`).join(' / ')} 条`;
  $('#diagToggle').classList.toggle('warn', !!problems);
  $('#diagToggle').textContent = problems ? '状态 ⚠' : '状态';
}

// ---------------- Queue ----------------
const ago = (t) => {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`;
};

function tierBadge(p) {
  const v = valueOf(p);
  if (v == null) return '…';
  return `<span class="tier t${tierOf(v)}">${tierOf(v)}</span> ${v}`;
}

function engagementText(p) {
  const e = p.engagement || {};
  const parts = [];
  if (e.up != null) parts.push('▲ ' + fmtNum(e.up));
  if (e.comments != null) parts.push('💬 ' + fmtNum(e.comments));
  if (e.views != null) parts.push('👁 ' + fmtNum(e.views));
  return parts.length ? `<span>${parts.join(' · ')}</span>` : '';
}

function relatedBadge(dr) {
  if (!dr.related) return '';
  const name = esc(who(dr.related.platform, dr.related.author));
  return `<span class="tag" title="${esc(dr.related.title || dr.related.url)}">🔗 关联了 ${name} 的帖子</span>`;
}

function mentionBadge(text) {
  if (!company?.enabled) return '';
  const m = mentionInfo(company, text);
  if (!m.mentions) return '';
  return m.disclosed || !company.disclose
    ? '<span class="tag">提到公司 · 已声明</span>'
    : '<span class="tag warn">⚠️ 提到公司但没写利益相关</span>';
}

// Reddit / X 上的高质量回复 → LinkedIn 长帖草稿（只生成，发布由你自己来）
function longPostBlock(p) {
  if (busy.has(p.id + ':lp')) return `<div class="spinner">正在改写成 LinkedIn 长帖…</div>`;
  if (!p.longPost) return `<div class="actions"><button class="ghost small" data-act="longpost" title="把这条回复扩写成一篇 LinkedIn 原创帖子">改写成 LinkedIn 长帖</button></div>`;
  const key = `${p.id}:lp`;
  const text = localEdits[key] ?? p.longPost.text;
  return `
    <div class="draft longpost">
      <div class="draft-head"><span class="angle">LinkedIn 长帖</span><span class="badges"><span class="mb">${mentionBadge(text)}</span></span><span class="chars">${[...text].length} 字</span></div>
      <textarea data-key="${key}" rows="1" class="auto">${esc(text)}</textarea>
      <div class="actions">
        <button class="small" data-act="lpcopy">复制并打开 LinkedIn</button>
        <button class="ghost small" data-act="lpcopyonly">复制</button>
      </div>
    </div>
    <div class="refine">
      <input data-refine="${p.id}:lp" placeholder="补充要求：更短 / 加一个开放问题 / 用英文…" value="${esc(refineInputs[p.id + ':lp'] || '')}" />
      <button class="small" data-act="lprefine">重写</button>
    </div>`;
}

// 我来写：自己写 → 翻译成目标语种（保持你的风格）→ 填入回复框
function writeBlock(p, defTarget) {
  if (!writeOpen.has(p.id)) return '';
  const tr = p.translation;
  const key = `${p.id}:tr`;
  const out = tr ? localEdits[key] ?? tr.out : '';
  const blocked = gate[p.platform];
  let html = `
    <div class="write">
      <textarea data-write="${p.id}" rows="3" placeholder="用你习惯的语言写回复…">${esc(writeInputs[p.id] ?? tr?.src ?? '')}</textarea>
      <div class="actions">
        <select data-wtarget="${p.id}">${langOptions(writeTargets[p.id] || defTarget)}</select>
        <button class="small" data-act="translate">${busy.has(p.id + ':tr') ? '翻译中…' : '翻译'}</button>
      </div>`;
  if (tr) html += `
      <div class="draft">
        <div class="draft-head"><span class="angle">译文 · ${esc((LANG_OPTS.find(([k]) => k === tr.lang) || [, tr.lang])[1])}</span><span class="badges"><span class="mb">${mentionBadge(out)}</span></span><span class="chars">${[...out].length} 字</span></div>
        <textarea data-key="${key}" rows="1" class="auto">${esc(out)}</textarea>
        <div class="actions">
          <button class="small" data-act="fill" data-i="tr" ${blocked ? 'disabled title="' + esc(blocked) + '"' : ''}>填入回复框</button>
          <button class="ghost small" data-act="copy" data-i="tr">复制</button>
          <button class="ghost small" data-act="marksent" data-i="tr" title="如果你是手动粘贴发送的，点这里计数并学习">已手动发送</button>
        </div>
      </div>`;
  return html + '</div>';
}

// full=false：列表里的紧凑卡片（不展开草稿，列表不会被拉长）；full=true：详情页 / 发帖页里的完整卡片
function itemCard(p, full = false) {
  const d = document.createElement('div');
  d.className = 'card item' + (full ? ' full' : ' compact') + (!full && APP && detailId === p.id ? ' sel' : '');
  d.dataset.id = p.id;
  const ctx = p.kind === 'comment' && p.context
    ? [
        p.context.rootTitle || p.context.rootText ? `原帖 ${p.context.rootAuthor || ''}：${(p.context.rootTitle || p.context.rootText).slice(0, 160)}` : p.context.replyingTo || '',
        ...(p.context.parents || []).slice(-2).map((x) => `↳ ${x.author}：${x.text.slice(0, 200)}`)
      ].filter(Boolean).join('\n')
    : '';
  const blocked = gate[p.platform];
  let html = `
    <div class="head">
      <span class="badge ${p.platform}">${platName(p.platform)}</span>
      <span class="kind">${p.kind === 'comment' ? '评论' : '原帖'}</span>
      <span class="score" title="价值分（相关度 ${p.score ?? '…'}）">${tierBadge(p)}</span>
    </div>
    <div class="meta">
      ${p.community ? `<span class="community">${esc(p.community)}</span>` : ''}
      <span title="${esc(p.authorHeadline || '')}">${esc(who(p.platform, p.author || ''))}</span>
      <span>${ago(p.createdAt || p.seenAt)}</span>
      ${engagementText(p)}
    </div>
    ${ctx ? `<div class="ctx">${esc(ctx)}</div>` : ''}
    ${p.kind === 'post' && p.title ? `<div class="title">${esc(p.title)}</div>` : ''}
    <div class="body ${expanded.has(p.id) ? 'open' : ''}" data-act="expand">${esc(p.text || '')}</div>
    ${p.reason ? `<div class="reason">${p.category ? '[' + esc(p.category) + '] ' : ''}${p.topic ? '#' + esc(p.topic) + ' · ' : ''}${esc(p.reason)}</div>` : ''}
    ${p.hook ? `<div class="reason">🎯 切入点：${esc(p.hook)}</div>` : ''}`;

  if (p.manual) html = html.replace('<span class="score"', '<span class="tag">手动添加</span><span class="score"');
  if (p.onMyPost) html = html.replace('<span class="score"', `<span class="tag">${p.replyToMe && p.context?.parents?.length ? '回复了你' : '回复我的帖子'}</span><span class="score"`);
  else if (p.replyToMe) html = html.replace('<span class="score"', '<span class="tag">回复了你</span><span class="score"');
  if (p.watched) html = html.replace('<span class="score"', '<span class="tag watch">★ 重点关注</span><span class="score"');
  if (!full) return compactTail(d, p, html);
  if (noAI(p.platform)) html += digestBlock(p);
  if (p.drafts?.length && p.status !== 'sent') {
    if (p.suggestion) html += `<div class="suggest">💡 ${esc(p.suggestion)}</div>`;
    p.drafts.forEach((dr, i) => {
      const key = `${p.id}:${i}`;
      const text = localEdits[key] ?? dr.text;
      html += `
        <div class="draft">
          <div class="draft-head">
            <span class="angle">${esc(dr.angle)}</span>
            <span class="badges"><span class="mb">${mentionBadge(text)}</span>${relatedBadge(dr)}</span>
            <span class="chars">${[...text].length} 字</span>
          </div>
          <textarea data-key="${key}" rows="1" class="auto">${esc(text)}</textarea>
          ${dr.gloss ? `<div class="gloss"><span>${esc(langName(myLang))}意思${localEdits[key] != null ? '（AI 原稿）' : ''}：</span>${esc(dr.gloss)}</div>` : ''}
          <div class="actions">
            ${PLATFORMS[p.platform] ? `<button class="small" data-act="fill" data-i="${i}" ${blocked ? 'disabled title="' + esc(blocked) + '"' : ''}>填入回复框</button>
            <button class="ghost small" data-act="copy" data-i="${i}">复制</button>` : `<button class="small" data-act="copy" data-i="${i}">复制回复</button>`}
            <button class="ghost small" data-act="marksent" data-i="${i}" title="如果你是手动粘贴发送的，点这里计数并学习">已手动发送</button>
          </div>
        </div>`;
    });
    html += `
      <div class="refine">
        <select class="rlang" data-rlang="${p.id}" title="回复用什么语言写；换了会重新起草">${langOptions(p.replyLangPref || 'auto')}</select>
        <input data-refine="${p.id}" placeholder="${p.ext ? '写下你的观点或想法，我按它重新生成几种回复…' : isMine(p) ? '补充你想深入的角度：追问他的依据 / 用上我们讨论过的论据 / 承认他说得对的部分…' : '补充要求：更口语 / 加上功耗观点 / 反驳他…'}" value="${esc(refineInputs[p.id] || '')}" />
        <button class="small" data-act="refine">重写</button>
      </div>`;
    if (blocked) html += `<div class="hint">${esc(blocked)}</div>`;
  }
  if (p.status === 'sent') {
    html += `<div class="suggest">✅ 已发送${p.sentVia === 'detected' ? '（检测到你的回复）' : ''}：${esc(p.finalText || '')}</div>`;
    if (p.platform !== 'linkedin' && p.finalText) html += longPostBlock(p);
  }
  else if (p.filledText) html += `
    <div class="confirm">
      <span>已填入回复框，发出去了吗？</span>
      <button class="small" data-act="confirmsent">已发送</button>
      <button class="ghost small" data-act="skip">不回了</button>
    </div>`;
  if (p.drafting || busy.has(p.id)) html += `<div class="spinner">正在起草…</div>`;
  if (p.error) html += `<div class="err">${esc(p.error)}</div>`;

  html += footHtml(p, false);
  d.innerHTML = html;
  return d;
}
function digestBlock(p) {
  let h = `<div class="noai">${esc(platName(p.platform))} 不允许 AI 生成或改写的评论。我只帮你读懂和想清楚，回复请你打开原帖自己写。</div>`;
  if (busy.has(p.id + ':dg')) h += '<div class="spinner">正在解读…</div>';
  const g = p.digest;
  if (g) h += `<div class="digest">
      <div class="dg-sum">${esc(g.summary)}</div>
      ${g.points?.length ? `<div class="fp-label">${g.comments ? `评论区要点（读了 ${g.comments} 条）` : '关键论点'}</div><ul>${g.points.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${g.angles?.length ? `<div class="fp-label">你可以从这些角度参与</div><ul>${g.angles.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    </div>`;
  return h;
}
function footHtml(p, compact) {
  let html = `<div class="foot">`;
  const busyNow = p.drafting || busy.has(p.id) || busy.has(p.id + ':dg');
  if (noAI(p.platform)) {
    if (compact && (p.digest || busyNow)) html += `<button class="small" data-act="open">查看解读 →</button>`;
    else if (!busyNow) html += `<button class="small" data-act="digest">${p.digest ? '重新解读' : '中文解读'}</button>`;
    html += `<button class="ghost small" data-act="discuss">和我讨论</button>`;
  } else
  if (compact && (p.drafts?.length || p.status === 'sent' || p.filledText || busyNow)) html += `<button class="small" data-act="open">${p.status === 'sent' ? '查看' : '处理 →'}</button>`;
  else if (!p.drafts?.length && p.status !== 'sent' && !busyNow) html += `<button class="small" data-act="draft">起草回复</button>`;
  html += `<span class="spacer"></span>`;
  html += `<a href="${esc(p.url)}" target="_blank" class="ghost small">原文</a>`;
  html += libraryIds.has(p.id)
    ? `<button class="ghost small on" data-act="unsave" title="从关联库移除">★ 已收藏</button>`
    : `<button class="ghost small" data-act="save" title="收藏到关联库，之后回复相关话题时可以引用">☆ 收藏</button>`;
  if (p.status === 'skipped' || p.status === 'low') html += `<button class="ghost small" data-act="restore">移回待处理</button>`;
  else if (p.status !== 'sent') html += `<button class="ghost small" data-act="skip">跳过</button>`;
  return html + `</div>`;
}
// 紧凑卡片：草稿 / 重写 / 已发送内容都不在列表里展开，只给一行状态，点「处理」进详情页
function compactTail(d, p, html) {
  let st = '';
  if (busy.has(p.id + ':dg')) st = '<span class="spinner">正在解读…</span>';
  else if (noAI(p.platform)) st = p.digest ? '📖 ' + esc(p.digest.summary.slice(0, 50)) + '…' : '';
  else if (p.drafting || busy.has(p.id)) st = '<span class="spinner">正在起草…</span>';
  else if (p.status === 'sent') st = `✅ 已发送：${esc((p.finalText || '').slice(0, 60))}${(p.finalText || '').length > 60 ? '…' : ''}`;
  else if (p.filledText) st = '📝 已填入回复框，等你确认是否发出';
  else if (p.drafts?.length) st = `✎ 已有 ${p.drafts.length} 条回复草稿`;
  if (st) html += `<div class="status-line" data-act="open">${st}</div>`;
  if (p.error) html += `<div class="err">${esc(p.error)}</div>`;
  d.innerHTML = html + footHtml(p, true);
  return d;
}

// 列表渲染：不整体重绘。已在屏幕上的卡片原地更新；新内容不插进来，而是在顶部提示「有 N 条新内容」。
const cardSig = new Map();
let pendingNew = 0;

function sigOf(p) {
  return JSON.stringify([p.status, p.score, p.drafting, busy.has(p.id), p.error, p.drafts, p.suggestion, p.filledText,
    p.engagement, p.hook, p.category, libraryIds.has(p.id), gate[p.platform], company?.enabled, company?.disclose,
    p.watched, p.longPost?.at, busy.has(p.id + ':lp'), p.digest?.at, busy.has(p.id + ':dg'), detailId === p.id, p.translation?.at, writeOpen.has(p.id), busy.has(p.id + ':tr')]);
}

async function computeList() {
  const posts = Object.values(await getPosts());
  const fp = panelPlat() || $('#filterPlatform').value;
  const fk = $('#filterKind').value;
  const fs = $('#filterStatus').value;
  const want = { todo: ['scored', 'pending'], low: ['low'], skipped: ['skipped'], sent: ['sent'] }[fs];
  libraryIds = new Set(Object.keys(await getLibrary()));
  const sortBy = $('#sortBy').value;
  const base = posts.filter((p) => !p.ext && want.includes(p.status) && (fp === 'all' || p.platform === fp) && (fk === 'all' || p.kind === fk));
  base.forEach((p) => (p._v = valueOf(p)));
  const sorters = {
    value: (a, b) => (b._v ?? 101) - (a._v ?? 101),
    score: (a, b) => (b.score ?? 101) - (a.score ?? 101),
    new: (a, b) => (b.createdAt || b.seenAt) - (a.createdAt || a.seenAt)
  };
  const list = base
    .filter((p) => (tierFilter === 'all' || (tierFilter === 'M' ? isMine(p) && (!topicFilter || p.tid === topicFilter) : tierFilter === 'W' ? p.watched : tierOf(p._v) === tierFilter || (tierFilter === 'SA' && /[SA]/.test(tierOf(p._v))))) &&
      (catFilter === 'all' || p.category === catFilter))
    // 回复你的帖子 / 评论的内容置顶
    .sort(fs === 'sent' ? (a, b) => (b.sentAt || 0) - (a.sentAt || 0) : (a, b) => (isMine(b) - isMine(a)) || sorters[sortBy](a, b))
    .slice(0, 80);
  $('#queueCount').textContent = posts.filter((p) => p.status === 'scored' && !p.ext).length || '';
  return { base, list, fs, byId: Object.fromEntries(posts.map((p) => [p.id, p])) };
}

async function renderQueue(force = false) {
  renderCpReply();
  const { base, list, fs, byId } = await computeList();
  lastListIds = list.map((p) => p.id);
  renderDetail(byId);
  renderChips(base);
  renderFilterSummary(list.length);
  renderMineBar(base, fs);
  const box = $('#queue');
  const shown = [...box.querySelectorAll(':scope > .item')];
  const atTop = scrollTopNow() < 40;

  if (force || atTop || !shown.length) {
    pendingNew = 0;
    $('#newBar').classList.add('hidden');
    cardSig.clear();
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = `<div class="empty">${fs === 'todo'
        ? '暂时没有待回复的内容。<br/>正常刷 Reddit / X / LinkedIn 就行，看到的相关内容会自动出现在这里。'
        : '这里是空的。'}</div>`;
      return;
    }
    list.forEach((p) => {
      box.appendChild(itemCard(p));
      cardSig.set(p.id, sigOf(p));
    });
    box.querySelectorAll('textarea.auto').forEach(autosize);
    return;
  }

  // 你正在往下看：只原地更新已显示的卡片，处理完的卡片移走（浏览器的滚动锚定会保持可视位置）。
  const listIds = new Set(list.map((p) => p.id));
  for (const el of shown) {
    const p = byId[el.dataset.id];
    if (!p || !listIds.has(p.id)) {
      el.remove();
      cardSig.delete(el.dataset.id);
      continue;
    }
    const sig = sigOf(p);
    if (cardSig.get(p.id) !== sig) {
      const card = itemCard(p);
      el.replaceWith(card);
      cardSig.set(p.id, sig);
      card.querySelectorAll('textarea.auto').forEach(autosize);
    }
  }
  pendingNew = list.filter((p) => !cardSig.has(p.id)).length;
  $('#newBar').textContent = `↑ 有 ${pendingNew} 条新内容，点击查看`;
  $('#newBar').classList.toggle('hidden', !pendingNew);
}

function autosize(t) {
  if (!t.offsetParent) return; // 标签页隐藏时量不到高度，切回来再算
  t.style.height = 'auto';
  t.style.height = t.scrollHeight + 2 + 'px';
}

// ---------- 筛选区：默认收起，只显示一行摘要 ----------
const LS = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }
};
function setFilterOpen(open) {
  $('#filterPanel').classList.toggle('hidden', !open);
  $('#filterToggle').setAttribute('aria-expanded', String(open));
  LS.set('rc.filterOpen', open ? '1' : '0');
}
function setDiagOpen(open) {
  $('#diagBox').classList.toggle('hidden', !open);
  $('#diagToggle').classList.toggle('on', open);
  LS.set('rc.diagOpen', open ? '1' : '0');
}
$('#filterToggle').addEventListener('click', () => setFilterOpen($('#filterPanel').classList.contains('hidden')));
$('#closeFilters').addEventListener('click', () => setFilterOpen(false));
$('#diagToggle').addEventListener('click', () => setDiagOpen($('#diagBox').classList.contains('hidden')));
$('#resetFilters').addEventListener('click', () => {
  $('#filterPlatform').value = 'all';
  $('#filterKind').value = 'all';
  $('#filterStatus').value = 'todo';
  $('#sortBy').value = 'value';
  tierFilter = 'all';
  catFilter = 'all';
  renderQueue(true);
});
setFilterOpen(LS.get('rc.filterOpen') === '1');
setDiagOpen(LS.get('rc.diagOpen') === '1');

function renderFilterSummary(count) {
  const label = (id) => $(id).selectedOptions[0].textContent;
  const tierName = { all: '', S: 'S 级', SA: 'S+A', A: 'A 级', B: 'B 级', W: '重点关注', M: '回复我的' }[tierFilter];
  const parts = [label('#filterStatus')];
  if ($('#filterPlatform').value !== 'all') parts.push(label('#filterPlatform'));
  if ($('#filterKind').value !== 'all') parts.push(label('#filterKind'));
  if (tierName) parts.push(tierName);
  if (catFilter !== 'all') parts.push(catFilter);
  parts.push(label('#sortBy').replace('排序', ''));
  $('#filterSummary').textContent = `${parts.join(' · ')} · ${count} 条`;
  const active = $('#filterPlatform').value !== 'all' || $('#filterKind').value !== 'all' || tierFilter !== 'all' || catFilter !== 'all';
  $('#filterToggle').classList.toggle('active', active);
}

function renderChips(base) {
  const tc = { S: 0, A: 0, B: 0 };
  base.forEach((p) => p._v != null && tc[tierOf(p._v)]++);
  const wc = base.filter((p) => p.watched).length;
  const tiers = [['all', `全部 ${base.length}`], ['S', `S 级 ${tc.S}`], ['SA', `S+A ${tc.S + tc.A}`], ['A', `A 级 ${tc.A}`], ['B', `B 级 ${tc.B}`], ['W', `★ 关注 ${wc}`], ['M', `💬 回复我的 ${base.filter(isMine).length}`]];
  $('#tierChips').innerHTML = tiers.map(([k, l]) => `<button class="chip ${tierFilter === k ? 'on' : ''}" data-tier="${k}">${l}</button>`).join('');
  const cc = {};
  base.forEach((p) => p.category && (cc[p.category] = (cc[p.category] || 0) + 1));
  // 分类按钮固定全部显示（没有内容的变灰），这样新内容进来时高度不会变化。
  $('#catChips').innerHTML = [['all', '全部话题', 1]].concat(CATEGORIES.map((c) => [c, `${c} ${cc[c] || 0}`, cc[c]]))
    .map(([k, l, n]) => `<button class="chip ${catFilter === k ? 'on' : ''} ${n ? '' : 'zero'}" data-cat="${esc(k)}">${esc(l)}</button>`).join('');
}
$('#tierChips').addEventListener('click', (e) => { const t = e.target.dataset.tier; if (t) { tierFilter = t; topicFilter = ''; renderQueue(true); } });

// 列表顶部的提示条：有人回复了你的帖子 / 评论时一键只看这些
function renderMineBar(base, fs) {
  const bar = $('#mineBar');
  const n = base.filter(isMine).length;
  if (tierFilter === 'M') {
    const t = topicFilter && cpTopics[topicFilter];
    bar.innerHTML = `<span title="${esc(t?.title || '')}">💬 只看回复我的${t ? `：${esc((t.title || '未命名').slice(0, 18))}${(t.title || '').length > 18 ? '…' : ''}` : ''}</span><button class="ghost small" data-mine="all">显示全部</button>`;
  } else if (n && fs === 'todo') {
    bar.innerHTML = `<span>💬 有 ${n} 条在回复你的帖子或评论</span><button class="small" data-mine="only">只看这些</button>`;
  } else bar.innerHTML = '';
  bar.classList.toggle('hidden', !bar.innerHTML);
}
$('#mineBar').addEventListener('click', (e) => {
  const m = e.target.dataset.mine;
  if (!m) return;
  tierFilter = m === 'only' ? 'M' : 'all';
  topicFilter = '';
  renderQueue(true);
});
// ---------- 详情页：在列表上面打开一条，处理完返回，列表不动 ----------
let lastListIds = [];
let detailId = null;
let detailSig = '';
function neighborOf(id, dir) {
  const i = lastListIds.indexOf(id);
  if (i < 0) return null;
  return lastListIds[i + dir] || null;
}
function openDetail(id) {
  detailId = id;
  detailSig = '';
  $('#detail').classList.remove('hidden');
  document.body.classList.add('detail-open');
  $('#detailBody').scrollTop = 0;
  getPosts().then((byId) => renderDetail(byId, true));
  if (APP) renderQueue();
}
function closeDetail() {
  detailId = null;
  if (APP) {
    $('#detailBody').innerHTML = '<div class="empty">在左边选一条，这里显示原文、讨论和回复草稿。</div>';
    $('#detailPos').textContent = '';
  } else {
    $('#detail').classList.add('hidden');
    document.body.classList.remove('detail-open');
    $('#detailBody').innerHTML = '';
  }
  scheduleRender();
}
function renderDetail(byId, force = false) {
  if (!detailId) return;
  const p = byId[detailId];
  const box = $('#detailBody');
  if (!p) { box.innerHTML = '<div class="empty">这条已经不在了。</div>'; return; }
  const a = document.activeElement;
  if (!force && a && box.contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) return;
  if (force) expanded.add(p.id); // 刚打开时正文直接展开
  const sig = sigOf(p) + expanded.has(p.id);
  if (!force && sig === detailSig) return;
  detailSig = sig;
  box.replaceChildren(itemCard(p, true));
  box.querySelectorAll('textarea.auto').forEach(autosize);
  const i = lastListIds.indexOf(detailId);
  $('#detailPos').textContent = i >= 0 ? `${i + 1} / ${lastListIds.length}` : '';
  $('#detailPrev').disabled = !neighborOf(detailId, -1);
  $('#detailNext').disabled = !neighborOf(detailId, 1);
}
$('#detailBack').addEventListener('click', closeDetail);

// ---------- 工作台（整页）与侧边栏（当前页面）的布局 ----------
const listScroller = () => (APP ? $('#qList') : window);
const scrollTopNow = () => (APP ? $('#qList').scrollTop : window.scrollY);
let pagePlat = '';      // 侧边栏：当前标签页所在的平台
let pageAll = false;    // 侧边栏：临时看全部平台
if (APP) {
  // 列表和详情并排：把待回复页原有内容装进左列，详情放到右列
  const tab = $('#tab-queue');
  const col = document.createElement('div');
  col.id = 'qList';
  col.className = 'q-list';
  while (tab.firstChild) col.appendChild(tab.firstChild);
  tab.appendChild(col);
  tab.appendChild($('#detail'));
  $('#detail').classList.remove('hidden');
  $('#detailBack').textContent = '关闭';
  $('#detailBody').innerHTML = '<div class="empty">在左边选一条，这里显示原文、讨论和回复草稿。</div>';
  // 左侧导航里的来源：就是平台筛选
  $('#navSources').addEventListener('click', (e) => {
    const src = e.target.closest('[data-src]')?.dataset.src;
    if (!src) return;
    $('#navSources').querySelectorAll('[data-src]').forEach((b) => b.classList.toggle('on', b.dataset.src === src));
    document.querySelector('[data-tab="queue"]').click();
    tierFilter = src === 'mine' ? 'M' : 'all';
    topicFilter = '';
    $('#filterPlatform').value = src === 'mine' ? 'all' : src;
    renderQueue(true);
  });
  // 工作台里点卡片空白处就打开详情
  $('#queue').addEventListener('click', (e) => {
    if (e.target.closest('[data-act]:not([data-act="expand"]), a, button, input, select, textarea')) return;
    const id = e.target.closest('.item')?.dataset.id;
    if (id) openDetail(id);
  });
} else {
  $('#openApp').addEventListener('click', openApp);
  const watchTab = async () => {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    const u = t?.url || '';
    const p = /reddit\.com/.test(u) ? 'reddit' : /(^|\/\/|\.)(x|twitter)\.com/.test(u) ? 'x' : /linkedin\.com/.test(u) ? 'linkedin' : /news\.ycombinator\.com/.test(u) ? 'hn' : '';
    if (p !== pagePlat) { pagePlat = p; pageAll = false; renderPageBar(); renderQueue(true); }
  };
  chrome.tabs.onActivated.addListener(watchTab);
  chrome.tabs.onUpdated.addListener((_id, ch) => ch.url && watchTab());
  chrome.windows?.onFocusChanged.addListener(watchTab);
  watchTab();
  $('#pageBar').addEventListener('click', (e) => {
    const a = e.target.closest('[data-pb]')?.dataset.pb;
    if (a === 'all') { pageAll = !pageAll; renderPageBar(); renderQueue(true); }
    if (a === 'back') document.querySelector('[data-tab="queue"]').click();
  });
}
function renderPageBar() {
  if (APP) return;
  if (!document.querySelector('[data-tab="queue"]').classList.contains('active')) {
    $('#pageBar').innerHTML = '<button class="ghost small" data-pb="back">← 回到当前页面</button><span>完整功能在「工作台 ↗」</span>';
    return;
  }
  const name = pagePlat ? platName(pagePlat) : '';
  $('#pageBar').innerHTML = pagePlat
    ? `<span>当前页面：<b>${esc(name)}</b>${pageAll ? ' · 显示全部平台' : ' · 只看这个平台'}</span><button class="ghost small" data-pb="all">${pageAll ? '只看 ' + esc(name) : '看全部'}</button>`
    : '<span>当前页面不是 Reddit / X / LinkedIn / HN，显示全部平台</span>';
}
renderPageBar();
// 侧边栏里列表的平台：跟着你正在看的网站走
const panelPlat = () => (APP || pageAll || !pagePlat ? null : pagePlat);
async function openApp() {
  const url = chrome.runtime.getURL('sidepanel/sidepanel.html?app=1');
  const [t] = await chrome.tabs.query({ url });
  if (t) { await chrome.tabs.update(t.id, { active: true }); await chrome.windows.update(t.windowId, { focused: true }); }
  else await chrome.tabs.create({ url });
}
$('#detailPrev').addEventListener('click', () => { const n = neighborOf(detailId, -1); if (n) openDetail(n); });
$('#detailNext').addEventListener('click', () => { const n = neighborOf(detailId, 1); if (n) openDetail(n); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && detailId) closeDetail(); });
// 把一条内容带进「发帖 → 回复别人的帖子」，用母语讨论（HN 这类平台只讨论，不组织成回复）
async function discussItem(id) {
  const p = (await getPosts())[id];
  if (!p) return;
  const ctx = p.kind === 'comment' && p.context?.rootTitle ? `（所在帖子：${p.context.rootTitle}）\n\n` : '';
  const text = ctx + (p.kind === 'post' && p.title ? p.title + '\n\n' : '') + (p.text || '') + (p.digest ? `\n\n[中文解读] ${p.digest.summary}` : '');
  const old = Object.values(cpTopics).find((t) => t.source?.itemId === id);
  const t = old || { ...newTopic(cp), kind: 'reply', source: { text, author: p.author || '', url: p.url || '', platform: p.platform, itemId: id } };
  closeDetail();
  document.querySelector('[data-tab="compose"]').click();
  cpOpen(t);
  cpSave(t);
  $('#cpInput').focus();
  notice(noAI(p.platform) ? '说说你怎么看，我们用中文讨论。HN 不允许 AI 代写，想清楚后请打开原帖自己写。' : '说说你怎么看，讨论完可以点「组织回复」。', 8000);
}
// 跳到「待回复」里的某一条，必要时顺手开始起草
async function jumpToReply(tid, id, startDraft) {
  showTopicReplies(tid);
  if (startDraft) send({ type: 'DRAFT', id });
  setTimeout(() => openDetail(id), 300);
}
// 右键带进来的回复：侧边栏打开后直接定位过去
async function consumePanelJump() {
  const { panelJump } = await chrome.storage.local.get('panelJump');
  if (!panelJump || Date.now() - panelJump.at > 60000) return;
  await chrome.storage.local.remove('panelJump');
  if (panelJump.helpReply) {
    const h = panelJump.helpReply;
    closeDetail();
    const t = { ...newTopic(cp), kind: 'reply', quick: true, replyLang: 'en', source: { text: h.text, author: '', url: h.url, platform: h.platform, title: h.title || '' } };
    document.querySelector('[data-tab="compose"]').click();
    cpOpen(t);
    cpSave(t);
    $('#cpReplyGo').click(); // 立刻生成回复建议
    setTimeout(() => $('#cpReplyCard').scrollIntoView({ block: 'start', behavior: 'smooth' }), 150);
    return notice(h.platform === 'web'
      ? '正在根据你选中的内容生成回复建议（默认英文，可换语言）。在建议下面写下你的观点可以重新生成；这个网站不能自动填入，选好后复制粘贴。'
      : '正在根据你选中的内容生成回复建议（默认英文，可换语言）。在建议下面写下你的观点可以重新生成。', 10000);
  }
  if (panelJump.newReply) {
    const t = { ...newTopic(cp), kind: 'reply', source: { text: panelJump.newReply.text, author: '', url: panelJump.newReply.url, platform: panelJump.newReply.platform } };
    document.querySelector('[data-tab="compose"]').click();
    cpOpen(t);
    cpSave(t);
    $('#cpInput').focus();
    return notice('已把选中的内容带进来。说说你怎么看，我们先讨论，再组织成回复。', 8000);
  }
  jumpToReply(panelJump.tid, panelJump.id, false);
  notice('已把选中的回复带进来，正在起草回复建议。可以在下面补充你想深入的角度再重写。', 9000);
}
function showTopicReplies(tid) {
  $('#filterStatus').value = 'todo';
  tierFilter = 'M';
  topicFilter = tid;
  document.querySelector('[data-tab="queue"]').click();
  renderQueue(true);
}
$('#catChips').addEventListener('click', (e) => { const c = e.target.dataset.cat; if (c) { catFilter = c; renderQueue(true); } });

// 草稿框正在编辑时不重绘，避免打断输入。
let renderPending = false;
function scheduleRender() {
  const a = document.activeElement;
  if (a && ($('#queue').contains(a) || $('#detailBody').contains(a)) && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) {
    renderPending = true;
    return;
  }
  renderHeader().then(renderQueue);
}
['#queue', '#detailBody'].forEach((sel) => $(sel).addEventListener('focusout', () => setTimeout(() => renderPending && ((renderPending = false), scheduleRender()), 200)));
['#filterPlatform', '#filterKind', '#filterStatus', '#sortBy'].forEach((s) => $(s).addEventListener('change', () => renderQueue(true)));
$('#newBar').addEventListener('click', () => {
  listScroller().scrollTo({ top: 0 });
  renderQueue(true);
});
// 滚回顶部时，自动把新内容放进来。
let topTimer;
(APP ? $('#qList') : window).addEventListener('scroll', () => {
  clearTimeout(topTimer);
  topTimer = setTimeout(() => scrollTopNow() < 40 && pendingNew && renderQueue(true), 300);
});

qOn('input', (e) => {
  const key = e.target.dataset.key;
  if (key) {
    localEdits[key] = e.target.value;
    const d = e.target.closest('.draft');
    d.querySelector('.chars').textContent = [...e.target.value].length + ' 字';
    d.querySelector('.mb').innerHTML = mentionBadge(e.target.value);
    autosize(e.target);
  }
  if (e.target.dataset.refine) refineInputs[e.target.dataset.refine] = e.target.value;
  if (e.target.dataset.write) writeInputs[e.target.dataset.write] = e.target.value;
});
qOn('change', (e) => {
  if (e.target.dataset.wtarget) writeTargets[e.target.dataset.wtarget] = e.target.value;
});

qOn('keydown', (e) => {
  if (e.key === 'Enter' && e.target.dataset.refine) e.target.closest('.item').querySelector(e.target.dataset.refine.endsWith(':lp') ? '[data-act="lprefine"]' : '[data-act="refine"]')?.click();
});

// 换回复语言：按新语言重新起草（讨论、对照仍用你的母语）
qOn('change', async (e) => {
  const id = e.target.dataset.rlang;
  if (!id) return;
  busy.add(id);
  renderQueue();
  const res = await send({ type: 'DRAFT', id, instruction: (refineInputs[id] || '').trim(), lang: e.target.value });
  busy.delete(id);
  if (res?.ok) { Object.keys(localEdits).filter((k) => k.startsWith(id + ':')).forEach((k) => delete localEdits[k]); delete refineInputs[id]; }
  else notice(res?.error || '起草失败');
  scheduleRender();
});

qOn('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const card = el.closest('.item');
  const id = card.dataset.id;
  const act = el.dataset.act;
  const draftText = () => card.querySelector(`textarea[data-key="${id}:${el.dataset.i}"]`).value.trim();

  if (act === 'expand') {
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    el.classList.toggle('open');
    return;
  }
  if (act === 'open') return openDetail(id);
  if (act === 'digest') {
    if (card.classList.contains('compact')) openDetail(id);
    busy.add(id + ':dg');
    renderQueue();
    const res = await send({ type: 'DIGEST', id });
    busy.delete(id + ':dg');
    if (!res?.ok) notice(res?.error || '解读失败', 8000);
    return scheduleRender();
  }
  if (act === 'discuss') return discussItem(id);
  if (act === 'draft' && card.classList.contains('compact')) openDetail(id);
  if (act === 'draft' || act === 'refine') {
    const instruction = act === 'refine' ? (refineInputs[id] || '').trim() : '';
    if (act === 'refine' && !instruction) return notice('先在输入框里写下你想怎么调整。');
    busy.add(id);
    renderQueue();
    const res = await send({ type: 'DRAFT', id, instruction });
    busy.delete(id);
    if (res?.ok) {
      Object.keys(localEdits).filter((k) => k.startsWith(id + ':')).forEach((k) => delete localEdits[k]);
      delete refineInputs[id];
    } else notice(res?.error || '起草失败');
    return scheduleRender();
  }
  if (act === 'copy') {
    await navigator.clipboard.writeText(draftText());
    return notice('已复制到剪贴板。');
  }
  if (act === 'fill') {
    const text = draftText();
    await navigator.clipboard.writeText(text).catch(() => {});
    el.disabled = true;
    el.textContent = '正在打开…';
    const res = await send({ type: 'FILL', id, text, via: el.dataset.i === 'tr' ? 'translate' : 'draft' });
    el.disabled = false;
    el.textContent = '填入回复框';
    const r = res?.result;
    const msgs = {
      auto: '已填入回复框。检查无误后，请在页面上自己点发送。',
      focus: '已切到对应页面。如果回复框没自动填上，点一下回复框就会填入（草稿也已复制，可直接粘贴）。',
      opening: '正在打开页面，加载好后会自动填入草稿；如果没填上，点一下回复框即可（草稿也已复制）。'
    };
    if (res?.ok && r?.ok) notice(msgs[r.mode] || msgs.auto, 9000);
    else notice((r?.error || res?.error || '填入失败') + '', 10000);
    return;
  }
  if (act === 'confirmsent') {
    const p = (await getPosts())[id];
    await send({ type: 'MARK_SENT', id, text: p?.filledText || '' });
    return scheduleRender();
  }
  if (act === 'marksent') {
    if (!confirm('确认这条已经由你手动发出？会计入今日次数并用于风格学习。')) return;
    await send({ type: 'MARK_SENT', id, text: draftText(), via: el.dataset.i === 'tr' ? 'translate' : 'draft' });
    return scheduleRender();
  }
  if (act === 'write') {
    writeOpen.has(id) ? writeOpen.delete(id) : writeOpen.add(id);
    renderQueue();
    if (writeOpen.has(id)) setTimeout(() => card.querySelector(`textarea[data-write="${id}"]`)?.focus(), 50);
    return;
  }
  if (act === 'translate') {
    const text = (writeInputs[id] ?? card.querySelector(`textarea[data-write="${id}"]`)?.value ?? '').trim();
    if (!text) return notice('先写下你想说的话。');
    busy.add(id + ':tr');
    renderQueue();
    const res = await send({ type: 'TRANSLATE', id, text, target: writeTargets[id] || translateDefault });
    busy.delete(id + ':tr');
    if (res?.ok) delete localEdits[id + ':tr']; else notice(res?.error || '翻译失败');
    return scheduleRender();
  }
  if (act === 'longpost' || act === 'lprefine') {
    const instruction = act === 'lprefine' ? (refineInputs[id + ':lp'] || '').trim() : '';
    if (act === 'lprefine' && !instruction) return notice('先在输入框里写下你想怎么调整。');
    busy.add(id + ':lp');
    renderQueue();
    const res = await send({ type: 'LONG_POST', id, instruction });
    busy.delete(id + ':lp');
    if (res?.ok) { delete localEdits[id + ':lp']; delete refineInputs[id + ':lp']; } else notice(res?.error || '改写失败');
    return scheduleRender();
  }
  if (act === 'lpcopy' || act === 'lpcopyonly') {
    await navigator.clipboard.writeText(card.querySelector(`textarea[data-key="${id}:lp"]`).value.trim());
    if (act === 'lpcopy') {
      chrome.tabs.create({ url: 'https://www.linkedin.com/feed/?shareActive=true' });
      return notice('长帖已复制。在 LinkedIn 的发帖框里粘贴，检查后自己点「发布」。', 9000);
    }
    return notice('已复制到剪贴板。');
  }
  if (act === 'save') { await send({ type: 'SAVE_TO_LIBRARY', id }); notice('已收藏到关联库。'); }
  if (act === 'unsave') await send({ type: 'REMOVE_FROM_LIBRARY', id });
  if (act === 'skip') {
    const next = card.closest('#detailBody') ? neighborOf(id, 1) : null;
    await send({ type: 'SKIP', id });
    if (card.closest('#detailBody')) { next ? openDetail(next) : closeDetail(); }
  }
  if (act === 'restore') await send({ type: 'RESTORE', id });
  scheduleRender();
});

$('#probeLinkedin').addEventListener('click', async () => {
  const res = await send({ type: 'PROBE' });
  if (!res?.ok) return notice(res?.error || '诊断失败');
  await navigator.clipboard.writeText(res.result);
  notice('诊断已复制（只有页面结构，不含帖子正文），直接粘贴发给我就行。', 8000);
});
$('#fetchFeed').addEventListener('click', async (e) => {
  e.target.disabled = true;
  const [res, hn] = await Promise.all([send({ type: 'FETCH_FEED' }), send({ type: 'FETCH_HN' })]);
  e.target.disabled = false;
  notice(res?.ok ? `拉取完成，新增 ${res.result + (hn?.result || 0)} 条候选（其中 HN ${hn?.result || 0} 条），正在打分…` : res?.error || '拉取失败（检查是否填写了 API Key、是否开启了订阅源）');
});

// ---------------- 发帖：讨论观点 → 各平台原创帖 → 你自己点发布 ----------------
const CP_PLATS = [['x', 'X'], ['linkedin', 'LinkedIn'], ['reddit', 'Reddit']];
// 同一平台两条原创帖之间的建议间隔（小时）：发太密会被限流，也显得刷屏
const CP_GAP_H = { x: 3, linkedin: 20, reddit: 12 };
// 每个议题单独保存（topics），打开侧边栏默认是一个新议题；讨论过的放进「历史议题」，点开可以接着聊
const MAX_TOPICS = 100;
const newTopic = (prev) => ({ id: 't_' + Date.now(), title: '', manualTitle: false, thread: [], plats: prev?.plats || ['x', 'linkedin', 'reddit'], lang: prev?.lang || 'en', out: null, createdAt: Date.now(), updatedAt: Date.now() });
let cp = newTopic();
let cpTopics = {};
const cpBusyOf = {}; // 议题 id → 'discuss' | 'gen'
let cpBusy = false;
const autoTitle = (t) => ((t.kind === 'reply' ? `回复${t.source?.author ? ' ' + t.source.author : ''}：` : '') +
  (t.out?.thesis || t.thread.find((m) => m.role === 'user')?.text || t.source?.text || '')).replace(/\s+/g, ' ').trim().slice(0, 48);
let cpSaveT;
function cpSave(t = cp) {
  if (!t.thread.length && !t.out && !t.source?.text?.trim()) return;
  t.updatedAt = Date.now();
  if (!t.manualTitle) t.title = autoTitle(t);
  cpTopics[t.id] = t;
  clearTimeout(cpSaveT);
  cpSaveT = setTimeout(() => {
    const keep = Object.values(cpTopics).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_TOPICS);
    cpTopics = Object.fromEntries(keep.map((x) => [x.id, x]));
    chrome.storage.local.set({ topics: cpTopics });
  }, 300);
  renderCpBar();
}
const cpSetBusy = (t, v) => { if (v) cpBusyOf[t.id] = v; else delete cpBusyOf[t.id]; cpBusy = cpBusyOf[cp.id] || false; };
const mdLite = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
const xLen = (t) => [...(t || '').replace(/https?:\/\/\S+/g, 'x'.repeat(23))].length;

function renderCpThread() {
  $('#cpThread').innerHTML = cp.thread.map((m) => `<div class="msg ${m.role}">${m.role === 'ai' ? mdLite(m.text) : esc(m.text)}</div>`).join('') +
    (cpBusy === 'discuss' ? '<div class="msg ai"><span class="spinner">思考中…</span></div>' : '');
  const box = $('#cpThread');
  box.scrollTop = box.scrollHeight;
  $('#cpSend').disabled = !!cpBusy;
  $('#cpGen').disabled = !!cpBusy;
  $('#cpPlats').innerHTML = CP_PLATS.map(([k, n]) => `<button class="chip ${cp.plats.includes(k) ? 'on' : ''}" data-plat="${k}">${n}</button>`).join('');
  $('#cpLang').innerHTML = langOptions(cp.lang, false);
}

async function cpFreq(platform) {
  const [s, stats, { ownPosts = [] }] = await Promise.all([getSettings(), getStats(), chrome.storage.local.get('ownPosts')]);
  const last = ownPosts.filter((p) => p.platform === platform).at(-1);
  const h = last ? (Date.now() - last.at) / 3600000 : Infinity;
  const parts = [`今天 ${platName(platform)} 已发 ${stats.sent[platform] || 0}/${s.caps[platform]}（回复和发帖合计）`];
  if (last) parts.push(`上一条原创帖 ${h < 1 ? Math.max(1, Math.round(h * 60)) + ' 分钟' : Math.round(h) + ' 小时'}前`);
  const warn = h < CP_GAP_H[platform];
  if (warn) parts.push(`建议隔 ${CP_GAP_H[platform]} 小时以上再发`);
  return { text: parts.join(' · '), warn, posted: new Set(ownPosts.map((p) => p.cid)) };
}

// 当前议题发出去的帖子。旧版本发的没记议题（或议题搬家后换了 id）：按这个议题里生成过的版本认回来
async function cpOwnPosts() {
  const { ownPosts = [] } = await chrome.storage.local.get('ownPosts');
  const cids = new Set(CP_PLATS.map(([k]) => cp.out?.[k]?.cid).filter(Boolean));
  const orphans = ownPosts.filter((o) => cids.has(o.cid) && o.tid !== cp.id);
  if (orphans.length) {
    orphans.forEach((o) => (o.tid = cp.id));
    await chrome.storage.local.set({ ownPosts });
  }
  return { all: ownPosts, mine: ownPosts.filter((o) => o.tid === cp.id).sort((a, b) => b.at - a.at) };
}

// 已发布的版本：只读，显示你实际发出去的内容；想再发就「再写一版」
const pubGloss = {};

async function renderCpOut() {
  const { mine: pubs } = await cpOwnPosts();
  const o = cp.out || {};
  const posted = new Set(pubs.map((x) => x.cid));
  if (!cp.out) { $('#cpOut').innerHTML = cpBusy === 'gen' ? '<div class="card"><span class="spinner">正在写…</span></div>' : ''; return; }
  const freq = Object.fromEntries(await Promise.all(CP_PLATS.map(async ([k]) => [k, await cpFreq(k)])));
  const head = (k, extra = '') => `<div class="draft-head"><span class="badge ${k}">${platName(k)}</span>${extra}</div>`;
  const acts = (k) => {
    const done = freq[k].posted.has(o[k].cid);
    return `<div class="actions">
      <button class="small" data-cpact="publish" ${done ? 'disabled' : ''} title="打开${platName(k)}的发帖页并填好内容，由你自己点发布">${done ? '已发布 ✓' : '去发布'}</button>
      <button class="ghost small" data-cpact="copy">复制</button>
      <button class="ghost small" data-cpact="gloss" title="翻成${esc(langName(myLang))}看看意思，不会改动草稿">${esc(langName(myLang))}对照</button>
      ${done ? '<button class="ghost small" data-cpact="addreply" title="把别人在这条帖子下的回复贴进来，起草回复建议">＋ 添加回复</button>'
        : '<button class="ghost small" data-cpact="done" title="平台上没自动识别到你点了发布时，手动记一下">我已发布</button>'}
    </div>
    ${o[k].gloss && o[k].glossFor === cpText(k) ? `<div class="gloss"><span>${esc(langName(myLang))}意思：</span>${esc(o[k].gloss)}</div>` : ''}
    <div class="cp-freq ${freq[k].warn ? 'warn' : ''}">${esc(freq[k].text)}</div>
    <div class="refine"><input data-cpins="${k}" placeholder="对这一版的修改意见：更短 / 加个例子 / 语气更锋利…" /><button class="small ghost" data-cpact="redo">重写</button></div>`;
  };
  const cards = [];
  const draftOf = (k) => o[k] && !posted.has(o[k].cid);
  if (draftOf('x')) {
    const mode = o.x.mode || 'single';
    const hasThread = o.x.thread?.length > 1;
    const tw = mode === 'thread' && hasThread ? o.x.thread : [o.x.single];
    cards.push(`<div class="card cp-card" data-p="x">
      ${head('x', hasThread ? `<span class="spacer"></span><button class="chip ${mode === 'single' ? 'on' : ''}" data-xmode="single">单条</button><button class="chip ${mode === 'thread' ? 'on' : ''}" data-xmode="thread">串（${o.x.thread.length} 条）</button>` : '')}
      ${tw.map((t, i) => `<div class="draft"><div class="draft-head"><span class="angle">${tw.length > 1 ? `第 ${i + 1} 条` : ''}</span><span class="chars ${xLen(t) > 280 ? 'over' : ''}">${xLen(t)}/280</span>${tw.length > 1 && i ? `<button class="ghost small" data-cpcopy="${i}">复制</button>` : ''}</div>
        <textarea class="auto" data-cpx="${i}" rows="1">${esc(t)}</textarea></div>`).join('')}
      ${tw.length > 1 ? '<p class="hint hint-after">「去发布」会填好第 1 条；发出后在它下面回复自己，依次贴上后面几条。</p>' : ''}
      ${acts('x')}
    </div>`);
  }
  if (draftOf('linkedin')) {
    cards.push(`<div class="card cp-card" data-p="linkedin">${head('linkedin')}
      <div class="draft"><div class="draft-head"><span class="chars">${[...o.linkedin.text].length} 字符</span></div><textarea class="auto" data-cpf="text" rows="1">${esc(o.linkedin.text)}</textarea></div>
      ${acts('linkedin')}</div>`);
  }
  if (draftOf('reddit')) {
    const subs = o.reddit.subreddits || [];
    cards.push(`<div class="card cp-card" data-p="reddit">${head('reddit')}
      <div class="row"><label class="inline">发到 r/<input data-cpf="sub" list="cpSubs" value="${esc(o.reddit.sub ?? subs[0] ?? '')}" placeholder="子版块" /></label></div>
      <datalist id="cpSubs">${subs.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
      ${subs.length > 1 ? `<p class="hint hint-after">也适合：${subs.slice(1).map((x) => 'r/' + esc(x)).join('、')}。发之前看一眼版规，有的版块不允许新账号或讨论帖。</p>` : '<p class="hint hint-after">发之前看一眼版规，有的版块不允许新账号或讨论帖。</p>'}
      <input class="cp-title" data-cpf="title" value="${esc(o.reddit.title)}" placeholder="标题" />
      <div class="draft"><textarea class="auto" data-cpf="body" rows="1">${esc(o.reddit.body)}</textarea></div>
      ${acts('reddit')}</div>`);
  }
  // 新生成只替换这次选中的平台，之前生成 / 发过的其他平台版本保留
  $('#cpOut').innerHTML = (cpBusy === 'gen' ? '<div class="card"><span class="spinner">正在写…</span></div>' : '') +
    (cards.length && o.thesis ? `<div class="cp-thesis">核心观点：<b>${esc(o.thesis)}</b></div>` : '') + cards.join('');
  $('#cpOut').querySelectorAll('textarea.auto').forEach(autosize);
}

// 这个议题发出去的帖子，以及帖子下面别人的回复
const mpAddOpen = new Set();
async function openAddReply(cid) {
  mpAddOpen.add(cid);
  await renderCpMine();
  const box = document.querySelector(`#cpMine .mypost[data-cid="${CSS.escape(cid)}"]`);
  box?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  box?.querySelector('[data-mpf="text"]').focus();
}
async function renderCpMine() {
  const [{ mine }, posts] = await Promise.all([cpOwnPosts(), getPosts()]);
  if (!mine.length || cp.kind === 'reply') { $('#cpMine').innerHTML = ''; return; }
  const replies = Object.values(posts).filter((p) => p.tid === cp.id);
  // 每条已发布的帖子一张卡：内容（只读）+ 别人的回复 + 操作
  $('#cpMine').innerHTML = `<div class="cp-section">已发布 · ${mine.length}</div>` + mine.map((o) => {
    const k = o.platform;
    const rs = replies.filter((p) => p.ownCid === o.cid).sort((a, b) => (b.createdAt || b.seenAt) - (a.createdAt || a.seenAt));
    const todo = rs.filter((p) => p.status === 'scored' || p.status === 'pending').length;
    const draft = o.draft || (cp.out?.[k]?.cid === o.cid ? cp.out[k].orig : '');
    const changed = draft && draft.replace(/\s+/g, ' ').trim() !== o.text.replace(/\s+/g, ' ').trim();
    return `<div class="card cp-card locked mypost" data-p="${k}" data-pub="${o.cid}" data-cid="${o.cid}">
      <div class="draft-head"><span class="badge ${k}">${platName(k)}</span><span class="mp-when">${topicAgo(o.at)}发布 · ${rs.length} 条回复${todo ? `，<b>${todo} 条待回</b>` : ''}</span></div>
      ${o.title ? `<div class="pub-title">${esc(o.title)}</div>` : ''}
      <div class="pub-text ${pubOpen.has(o.cid) ? 'open' : 'clamp'}" data-pub-act="expand" title="点击展开 / 收起">${esc(o.text)}</div>
      ${pubGloss[o.cid] ? `<div class="gloss"><span>${esc(langName(myLang))}意思：</span>${esc(pubGloss[o.cid])}</div>` : ''}
      ${changed ? `<details class="pub-orig"><summary>查看 AI 原稿</summary><div class="pub-text">${esc(draft)}</div></details>` : ''}
      ${rs.length ? `<div class="mypost-replies">${rs.slice(0, 5).map((p) => `<div class="mp-reply"><span class="mp-st ${p.status === 'sent' || p.status === 'skipped' ? '' : 'todo'}">${p.status === 'sent' ? '已回' : p.status === 'skipped' ? '跳过' : '待回'}</span><b>${esc(who(p.platform, p.author || ''))}</b>：${esc((p.text || '').replace(/\s+/g, ' ').slice(0, 90))}${(p.text || '').length > 90 ? '…' : ''}</div>`).join('')}</div>` : ''}
      ${o.url ? '' : `<div class="refine"><input data-mplink placeholder="贴上帖子链接，用来自动收集回复" /><button class="small ghost" data-mp="link">关联</button></div>`}
      <div class="mp-add ${mpAddOpen.has(o.cid) ? '' : 'hidden'}">
        <textarea data-mpf="text" rows="3" placeholder="粘贴对方的回复（插件没抓到的都可以贴进来）"></textarea>
        <div class="row"><input data-mpf="author" placeholder="对方名字（可选）" /><input data-mpf="url" placeholder="回复链接（可选）" /></div>
        <div class="row"><button class="small" data-mp="addgo">添加并起草回复</button></div>
        <p class="hint hint-after">也可以在网页上选中对方的回复，右键带进来。</p>
      </div>
      <div class="mp-acts">
        ${todo ? `<button class="small" data-mp="go">去回复（${todo}）</button>` : ''}
        <button class="ghost small" data-mp="add" title="抓不到的回复：把对方的回复粘贴进来">＋ 添加回复</button>
        ${o.url ? '<button class="ghost small" data-mp="open" title="打开帖子页，插件会读出下面的新回复">看帖子</button>' : ''}
        ${k === 'reddit' && o.url ? '<button class="ghost small" data-mp="check" title="Reddit 每 30 分钟也会自动检查一次">检查回复</button>' : ''}
        <button class="ghost small" data-pub-act="copy">复制</button>
        <button class="ghost small" data-pub-act="gloss">${esc(langName(myLang))}对照</button>
        <button class="ghost small" data-pub-act="fork" title="以这条为底稿开一个新草稿（已发布的这条不会变）">再写一版</button>
      </div>
    </div>`;
  }).join('');
}
const pubOpen = new Set();
async function onPubAct(e) {
  const card = e.target.closest('.cp-card.locked');
  if (!card) return;
  const pa = e.target.dataset.pubAct;
  if (!pa) return;
  const { all } = await cpOwnPosts();
  const pub = all.find((x) => x.cid === card.dataset.pub);
  if (!pub) return;
  if (pa === 'copy') { await navigator.clipboard.writeText((pub.title ? pub.title + '\n\n' : '') + pub.text).catch(() => {}); return notice('已复制。'); }
  if (pa === 'addreply') return openAddReply(pub.cid);
  if (pa === 'expand') { pubOpen.has(pub.cid) ? pubOpen.delete(pub.cid) : pubOpen.add(pub.cid); return renderCpMine(); }
  if (pa === 'gloss') {
    e.target.disabled = true;
    const res = await send({ type: 'TRANSLATE', text: (pub.title ? pub.title + '\n\n' : '') + pub.text, target: myLang });
    e.target.disabled = false;
    if (!res?.ok) return notice(res?.error || '翻译失败');
    pubGloss[pub.cid] = res.result.text;
    return renderCpMine();
  }
  if (pa === 'fork') {
    const k = pub.platform;
    cp.out = cp.out || {};
    const prev = cp.out[k] || {};
    cp.out[k] = k === 'x' ? { single: pub.text, thread: [], mode: 'single' } : k === 'linkedin' ? { text: pub.text } : { subreddits: prev.subreddits || [], sub: prev.sub, title: pub.title || '', body: pub.text };
    cp.out[k].cid = newCid(k);
    cp.out[k].orig = pub.text;
    cpSave();
    await renderCpOut();
    document.querySelector(`#cpOut .cp-card[data-p="${k}"]:not(.locked)`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return notice('已开一个新草稿，已发布的那条保持不变。');
  }
}
$('#cpMine').addEventListener('click', async (e) => {
  if (e.target.dataset.pubAct) return onPubAct(e);
  const act = e.target.dataset.mp;
  const box = e.target.closest('.mypost');
  if (!act || !box) return;
  const { ownPosts = [] } = await chrome.storage.local.get('ownPosts');
  const o = ownPosts.find((x) => x.cid === box.dataset.cid);
  if (!o) return;
  if (act === 'open') return chrome.tabs.create({ url: o.url, active: true });
  if (act === 'go') return showTopicReplies(cp.id);
  if (act === 'add') {
    mpAddOpen.has(o.cid) ? mpAddOpen.delete(o.cid) : mpAddOpen.add(o.cid);
    box.querySelector('.mp-add').classList.toggle('hidden', !mpAddOpen.has(o.cid));
    return box.querySelector('[data-mpf="text"]').focus();
  }
  if (act === 'addgo') {
    const v = (k) => box.querySelector(`[data-mpf="${k}"]`).value;
    const res = await send({ type: 'ADD_MANUAL_REPLY', cid: o.cid, text: v('text'), author: v('author'), url: v('url') });
    if (!res?.ok) return notice(res?.error || '添加失败');
    mpAddOpen.delete(o.cid);
    return jumpToReply(cp.id, res.result.id, true);
  }
  if (act === 'check') {
    e.target.disabled = true;
    const res = await send({ type: 'CHECK_MY_POSTS' });
    e.target.disabled = false;
    return notice(res?.ok ? (res.result ? `新增 ${res.result} 条回复。` : '暂时没有新回复。') : res?.error || '检查失败');
  }
  if (act === 'link') {
    const res = await send({ type: 'LINK_OWN_POST', cid: o.cid, url: box.querySelector('[data-mplink]').value });
    notice(res?.ok ? '已关联。' : res?.error || '关联失败');
  }
});

const cpText = (k) => {
  const o = cp.out[k];
  if (k === 'x') return ((o.mode === 'thread' && o.thread?.length > 1 ? o.thread[0] : o.single) || '').trim();
  if (k === 'linkedin') return o.text.trim();
  return o.body.trim();
};
const cpOrig = (k) => cp.out[k].orig || '';
const newCid = (k) => `c_${k}_${Date.now()}`;
function cpAdopt(t, res, platforms, keep = {}) {
  t.out = t.out || {};
  if (res.thesis) t.out.thesis = res.thesis;
  for (const k of platforms) {
    if (!res[k]) continue;
    const v = { ...res[k], cid: newCid(k) };
    if (k === 'x') { v.mode = keep.x?.mode && v.thread?.length > 1 ? keep.x.mode : 'single'; v.orig = v.single; }
    if (k === 'linkedin') v.orig = v.text;
    if (k === 'reddit') v.orig = v.body;
    t.out[k] = v;
  }
}

async function cpDiscuss() {
  const text = $('#cpInput').value.trim();
  if (!text) return notice('先说说你的想法。');
  const t = cp; // 等回复期间你可能切到别的议题，结果要回到发起的那个议题里
  t.thread.push({ role: 'user', text });
  $('#cpInput').value = '';
  cpSetBusy(t, 'discuss'); renderCpThread(); cpSave(t);
  const res = await send({ type: 'DISCUSS', thread: t.thread, source: t.kind === 'reply' ? t.source : null });
  cpSetBusy(t, false);
  if (res?.ok) t.thread.push({ role: 'ai', text: res.result });
  else { notice(res?.error || '讨论失败', 8000); const back = t.thread.pop().text; if (cp === t) $('#cpInput').value = back; }
  cpSave(t);
  if (cp === t) renderCpThread();
}

// ---- 「回复别人的帖子」议题 ----
function renderCpMode() {
  const reply = cp.kind === 'reply';
  $('#cpMode').querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === (reply ? 'reply' : 'post')));
  $('#cpSrc').classList.toggle('hidden', !reply);
  $('#cpPostCard').classList.toggle('hidden', reply);
  $('#cpOut').classList.toggle('hidden', reply);
  $('#cpMine').classList.toggle('hidden', reply);
  const noai = reply && noAI(cp.source?.platform);
  $('#cpReplyCard').classList.toggle('hidden', !reply || noai);
  $('#cpReplyBox').classList.toggle('hidden', !reply || noai);
  $('#cpNoAI').classList.toggle('hidden', !noai);
  $('#cpReplyBox').classList.toggle('hidden', !reply);
  $('#cpDiscTitle').textContent = reply ? '讨论怎么回复' : '讨论观点';
  $('#cpDiscHint').textContent = reply
    ? '用你习惯的语言说说你怎么看这条帖子：认同什么、反对什么、想补充什么。我会帮你分析对方的观点、找到值得回应的角度。'
    : '用中文或英文说说你的想法，我会帮你提炼观点、补论据、找反方视角并追问。想清楚了就在下面生成帖子。';
  $('#cpInput').placeholder = reply ? '比如：他说端侧模型没前途，我不同意，因为…（Ctrl/⌘ + Enter 发送）' : '比如：我觉得 AI 原生公司的核心竞争力不是模型，而是…（Ctrl/⌘ + Enter 发送）';
  const src = cp.source || {};
  if (document.activeElement !== $('#cpSrcText')) $('#cpSrcText').value = src.text || '';
  if (document.activeElement !== $('#cpSrcAuthor')) $('#cpSrcAuthor').value = src.author || '';
  if (document.activeElement !== $('#cpSrcUrl')) $('#cpSrcUrl').value = src.url || '';
  $('#cpReplyLang').innerHTML = langOptions(cp.replyLang || 'en');
  // 右键「帮我回复」进来的：先直接给回复建议，讨论区收起，需要时再展开
  const quick = !!(reply && cp.quick && !cp.thread.length && !cpDiscShown.has(cp.id));
  $('#cpQuick').classList.toggle('hidden', !quick);
  $('#cpDiscWrap').classList.toggle('hidden', quick);
}
const cpDiscShown = new Set();
$('#cpDiscOpen').addEventListener('click', () => { cpDiscShown.add(cp.id); renderCpMode(); $('#cpInput').focus(); });
$('#cpMode').addEventListener('click', (e) => {
  const m = e.target.dataset.mode;
  if (!m) return;
  cp.kind = m === 'reply' ? 'reply' : 'post';
  renderCpMode(); renderCpReply(); cpSave();
});
[['#cpSrcText', 'text'], ['#cpSrcAuthor', 'author'], ['#cpSrcUrl', 'url']].forEach(([sel, k]) =>
  $(sel).addEventListener('input', (e) => { cp.source = { ...(cp.source || {}), [k]: e.target.value }; cpSave(); }));
$('#cpReplyLang').addEventListener('change', (e) => { cp.replyLang = e.target.value; cpSave(); });
const cpFlush = () => { clearTimeout(cpSaveT); return chrome.storage.local.set({ topics: cpTopics }); };
async function renderCpReply() {
  if (cp.kind !== 'reply') return;
  const box = $('#cpReplyBox');
  const a = document.activeElement;
  if (a && box.contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) return;
  const p = (await getPosts())['ext_' + cp.id];
  if (!p) { box.innerHTML = cpBusyOf[cp.id] === 'reply' ? '<div class="card"><span class="spinner">正在组织回复…</span></div>' : ''; return; }
  box.replaceChildren(itemCard(p, true));
  box.querySelectorAll('textarea.auto').forEach(autosize);
}
$('#cpReplyGo').addEventListener('click', async () => {
  const t = cp;
  const src = t.source || {};
  if (!src.text?.trim()) return notice('先把对方的帖子内容粘贴进来。');
  const pending = $('#cpInput').value.trim();
  if (pending) { t.thread.push({ role: 'user', text: pending }); $('#cpInput').value = ''; renderCpThread(); }
  cpSave(t);
  await cpFlush();
  cpSetBusy(t, 'reply');
  $('#cpReplyGo').disabled = true;
  renderCpReply();
  const res = await send({ type: 'TOPIC_REPLY', tid: t.id, source: src, lang: t.replyLang || 'en' });
  cpSetBusy(t, false);
  $('#cpReplyGo').disabled = false;
  if (!res?.ok) notice(res?.error || '组织回复失败', 8000);
  if (cp === t) renderCpReply();
});

async function cpGenerate(platforms = cp.plats, instruction = '') {
  const t = cp;
  const pending = $('#cpInput').value.trim();
  if (pending && !instruction) { t.thread.push({ role: 'user', text: pending }); $('#cpInput').value = ''; }
  if (!t.thread.length) return notice('先在上面写下你想表达的观点。');
  if (!platforms.length) return notice('至少选一个平台。');
  const previous = instruction && t.out ? Object.fromEntries(platforms.filter((k) => t.out[k]).map((k) => [k, t.out[k]])) : null;
  const before = t.out;
  cpSetBusy(t, 'gen');
  renderCpThread(); renderCpOut();
  const res = await send({ type: 'COMPOSE', thread: t.thread, platforms, lang: t.lang, instruction, previous });
  cpSetBusy(t, false);
  if (res?.ok) cpAdopt(t, res.result, platforms, before || {});
  else { notice(res?.error || '生成失败', 8000); t.out = t.out || before; }
  cpSave(t);
  if (cp === t) { renderCpThread(); renderCpOut(); }
}

$('#cpSend').addEventListener('click', cpDiscuss);
$('#cpInput').addEventListener('keydown', (e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && $('#cpSend').click());

// ---- 议题：新建 / 历史列表 / 打开 / 改名 / 删除 ----
function cpOpen(t) {
  cp = t;
  cpBusy = cpBusyOf[t.id] || false;
  $('#cpInput').value = '';
  $('#cpHist').classList.add('hidden');
  renderCpBar(); renderCpMode(); renderCpThread(); renderCpOut(); renderCpMine(); renderCpReply();
}
const topicAgo = (ts) => (Date.now() - ts < 60000 ? '刚刚' : Date.now() - ts > 7 * 86400000 ? new Date(ts).toLocaleDateString() : ago(ts));
async function renderCpBar() {
  const list = Object.values(cpTopics).filter((t) => t.id !== cp.id || cp.thread.length);
  $('#cpHistCount').textContent = list.length || '';
  $('#cpCur').textContent = cp.thread.length || cp.out || cp.source?.text ? cp.title || autoTitle(cp) || '未命名' : '新议题';
  $('#cpCur').title = $('#cpCur').textContent;
  if (!$('#cpHist').classList.contains('hidden')) renderCpList();
}
async function renderCpList() {
  const q = $('#cpSearch').value.trim().toLowerCase();
  const { ownPosts = [] } = await chrome.storage.local.get('ownPosts');
  const posted = {};
  ownPosts.forEach((p) => p.tid && (posted[p.tid] = posted[p.tid] || new Set()).add(p.platform));
  const list = Object.values(cpTopics)
    .filter((t) => !q || [t.title, t.out?.thesis, ...t.thread.map((m) => m.text)].join('\n').toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  $('#cpList').innerHTML = list.length ? list.map((t) => `
    <div class="cp-item ${t.id === cp.id ? 'cur' : ''}" data-tid="${t.id}">
      <div class="cp-item-main">
        <div class="cp-item-title">${esc(t.title || '（未命名）')}</div>
        <div class="cp-item-meta">${t.kind === 'reply' ? '<span class="tag">回复</span>' : ''}${topicAgo(t.updatedAt)} · ${t.thread.filter((m) => m.role === 'user').length} 轮讨论${t.out ? ' · 已写帖子' : ''}
          ${[...(posted[t.id] || [])].map((k) => `<span class="badge ${k}">${platName(k)} 已发</span>`).join(' ')}${cpBusyOf[t.id] ? ' · <span class="spinner">处理中</span>' : ''}</div>
      </div>
      <button class="ghost small icon" data-tact="rename" title="改名">✎</button>
      <button class="ghost small icon danger" data-tact="del" title="删除">✕</button>
    </div>`).join('') : `<div class="empty">${q ? '没有匹配的议题。' : '还没有讨论过的议题。'}</div>`;
  // 所有发出去的帖子（包括议题已被删掉的），点开回到议题，议题没了就重建一个
  const pubs = ownPosts.filter((o) => !q || [o.title, o.text].join('\n').toLowerCase().includes(q)).sort((a, b) => b.at - a.at).slice(0, 50);
  if (pubs.length) $('#cpList').innerHTML += `<div class="cp-section">已发布的帖子</div>` + pubs.map((o) => `
    <div class="cp-item cp-pub" data-cid="${o.cid}">
      <div class="cp-item-main">
        <div class="cp-item-title">${esc((o.title ? o.title + ' · ' : '') + o.text)}</div>
        <div class="cp-item-meta"><span class="badge ${o.platform}">${platName(o.platform)}</span>${topicAgo(o.at)}发布 · ${o.tid && cpTopics[o.tid] ? '议题：' + esc(cpTopics[o.tid].title || '未命名') : '议题已删除，点开可找回'}</div>
      </div>
    </div>`).join('');
}
// 从一条已发布的帖子重建议题（议题被删掉时找回内容）
function restoreTopicFrom(o, ownPosts) {
  const t = { ...newTopic(cp), id: o.tid && !cpTopics[o.tid] ? o.tid : 't_' + Date.now(), title: ((o.title || o.text) || '').slice(0, 48), manualTitle: true, out: {} };
  for (const p of ownPosts.filter((x) => x.tid === o.tid || x.cid === o.cid)) {
    p.tid = t.id;
    const k = p.platform;
    t.out[k] = k === 'x' ? { single: p.text, thread: [], mode: 'single' } : k === 'linkedin' ? { text: p.text } : { subreddits: [], title: p.title || '', body: p.text };
    Object.assign(t.out[k], { cid: p.cid, orig: p.draft || p.text });
  }
  return t;
}
$('#cpNew').addEventListener('click', () => {
  if (!cp.thread.length && !cp.out && !cp.source?.text) { $('#cpHist').classList.add('hidden'); return $('#cpInput').focus(); }
  cpOpen(newTopic(cp));
  $('#cpInput').focus();
});
$('#cpHistBtn').addEventListener('click', () => {
  const box = $('#cpHist');
  box.classList.toggle('hidden');
  if (!box.classList.contains('hidden')) { renderCpList(); $('#cpSearch').focus(); }
});
$('#cpSearch').addEventListener('input', renderCpList);
$('#cpList').addEventListener('click', async (e) => {
  const pubEl = e.target.closest('.cp-pub');
  if (pubEl) {
    const { ownPosts = [] } = await chrome.storage.local.get('ownPosts');
    const o = ownPosts.find((x) => x.cid === pubEl.dataset.cid);
    if (!o) return;
    if (o.tid && cpTopics[o.tid]) return cpOpen(cpTopics[o.tid]);
    const t = restoreTopicFrom(o, ownPosts);
    await chrome.storage.local.set({ ownPosts });
    cpSave(t);
    cpOpen(t);
    return notice('议题已找回：已发布的帖子内容都在下面，讨论记录删掉了就找不回了。', 8000);
  }
  const item = e.target.closest('.cp-item');
  if (!item) return;
  const t = cpTopics[item.dataset.tid];
  if (!t) return;
  const act = e.target.dataset.tact;
  if (act === 'rename') {
    const name = prompt('议题名称', t.title)?.trim();
    if (!name) return;
    t.title = name; t.manualTitle = true;
    return cpSave(t);
  }
  if (act === 'del') {
    const { ownPosts = [] } = await chrome.storage.local.get('ownPosts');
    const n = ownPosts.filter((o) => o.tid === t.id).length;
    if (!confirm(`删除议题「${t.title || '未命名'}」？讨论记录和没发出的草稿会删掉。` + (n ? `\n\n这个议题下已发布的 ${n} 条帖子不会丢：内容仍保存在「历史议题 → 已发布的帖子」里，点开可以找回。` : ''))) return;
    delete cpTopics[t.id];
    chrome.storage.local.set({ topics: cpTopics });
    if (cp.id === t.id) cpOpen(newTopic(t));
    $('#cpHist').classList.remove('hidden');
    renderCpBar(); renderCpList();
    return;
  }
  cpOpen(t);
});
$('#cpGen').addEventListener('click', () => cpGenerate());
$('#cpLang').addEventListener('change', (e) => { cp.lang = e.target.value; cpSave(); });
$('#cpPlats').addEventListener('click', (e) => {
  const k = e.target.dataset.plat;
  if (!k) return;
  cp.plats = cp.plats.includes(k) ? cp.plats.filter((x) => x !== k) : CP_PLATS.map(([x]) => x).filter((x) => x === k || cp.plats.includes(x));
  renderCpThread(); cpSave();
});
$('#cpOut').addEventListener('input', (e) => {
  const card = e.target.closest('.cp-card');
  if (!card) return;
  const k = card.dataset.p;
  const o = cp.out[k];
  const t = e.target;
  if (t.dataset.cpx != null) {
    const i = +t.dataset.cpx;
    if (o.mode === 'thread' && o.thread?.length > 1) o.thread[i] = t.value; else o.single = t.value;
    const c = t.closest('.draft').querySelector('.chars');
    c.textContent = xLen(t.value) + '/280';
    c.classList.toggle('over', xLen(t.value) > 280);
  } else if (t.dataset.cpf) {
    o[t.dataset.cpf] = t.value;
    if (k === 'linkedin') t.closest('.draft').querySelector('.chars').textContent = [...t.value].length + ' 字符';
  }
  if (t.tagName === 'TEXTAREA') autosize(t);
  cpSave();
});
$('#cpOut').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.dataset.cpins) e.target.closest('.cp-card').querySelector('[data-cpact="redo"]').click();
});
$('#cpOut').addEventListener('click', async (e) => {
  const card = e.target.closest('.cp-card');
  if (!card) return;
  const k = card.dataset.p;
  const o = cp.out[k];
  if (e.target.dataset.xmode) { o.mode = e.target.dataset.xmode; cpSave(); return renderCpOut(); }
  if (e.target.dataset.cpcopy != null) {
    await navigator.clipboard.writeText(o.thread[+e.target.dataset.cpcopy].trim()).catch(() => {});
    return notice('已复制这一条。');
  }
  const act = e.target.dataset.cpact;
  if (!act) return;
  const text = cpText(k);
  if (act === 'redo') {
    const ins = card.querySelector('[data-cpins]').value.trim();
    if (!ins) return notice('先写下你想怎么改。');
    return cpGenerate([k], ins);
  }
  if (act === 'gloss') {
    const src = (k === 'reddit' && o.title ? o.title + '\n\n' : '') + text;
    e.target.disabled = true;
    const res = await send({ type: 'TRANSLATE', text: src, target: myLang });
    e.target.disabled = false;
    if (!res?.ok) return notice(res?.error || '翻译失败');
    o.gloss = res.result.text; o.glossFor = text;
    cpSave();
    return renderCpOut();
  }
  const full = k === 'reddit' ? `${o.title.trim()}\n\n${text}` : k === 'x' && o.mode === 'thread' && o.thread?.length > 1 ? o.thread.map((t) => t.trim()).join('\n\n') : text;
  await navigator.clipboard.writeText(full).catch(() => {});
  if (act === 'copy') return notice('已复制。');
  if (act === 'done') {
    const res = await send({ type: 'COMPOSE_SENT', platform: k, text, title: k === 'reddit' ? o.title : '', draftText: cpOrig(k), cid: o.cid, tid: cp.id });
    notice(res?.ok ? '已记下，这条帖子会用来学习你的风格。' : res?.error || '记录失败');
    return renderCpOut();
  }
  if (k === 'x' && xLen(text) > 280) return notice('这条超过 280 字符了，先删短一点（或者切换成「串」）。');
  if (k === 'reddit' && !(o.sub || o.subreddits?.[0])) return notice('先填要发到哪个子版块。');
  const f = await cpFreq(k);
  if (f.warn && !confirm(`${f.text}。\n\n还是现在发吗？`)) return;
  const res = await send({ type: 'COMPOSE_PUBLISH', platform: k, text, title: o.title, subreddit: o.sub ?? o.subreddits?.[0], cid: o.cid, tid: cp.id, draftText: cpOrig(k) });
  notice(res?.ok ? `已打开 ${platName(k)} 发帖页并填好内容（也已复制）。检查后请你自己点发布。` : res?.error || '打开失败', 8000);
});

chrome.storage.local.get(['topics', 'compose']).then(async ({ topics, compose }) => {
  cpTopics = topics || {};
  // v0.7.0 只存了一条讨论：搬进历史议题
  if (compose?.thread?.length) {
    const t = { ...newTopic(compose), ...compose, id: 't_' + (Date.now() - 1), manualTitle: false, createdAt: Date.now() - 1, updatedAt: Date.now() - 1 };
    t.title = autoTitle(t);
    cpTopics[t.id] = t;
    await chrome.storage.local.set({ topics: cpTopics });
  }
  if (compose) await chrome.storage.local.remove('compose');
  renderCpBar(); renderCpMode(); renderCpThread(); renderCpOut(); renderCpMine(); renderCpReply();
  consumePanelJump();
});

// ---------------- 翻译（独立入口，可多选语种） ----------------
let translateDefault = 'en';
let wrTargets = ['en'];
let wrPolish = true;
try { wrPolish = localStorage.getItem('wrPolish') !== '0'; } catch {}
let wrResults = []; // [{ lang, src, out, text, sent }]
const langName = (k) => (LANG_OPTS.find(([x]) => x === k) || [, k])[1];
async function renderWrite() {
  const [s, st] = await Promise.all([getSettings(), getStyle()]);
  translateDefault = s.translateTarget || 'en';
  wrTargets = (s.translateTargets?.length ? s.translateTargets : [translateDefault]).filter((k) => k !== 'auto');
  $('#wrLangs').innerHTML = LANG_OPTS.filter(([k]) => k !== 'auto')
    .map(([k, n]) => `<button class="chip ${wrTargets.includes(k) ? 'on' : ''}" data-lang="${k}">${n}</button>`).join('');
  const n = (st.translations || []).filter((t) => t.final).length;
  $('#wrMeta').textContent = n ? `已学习 ${n} 组你的翻译定稿` : '';
}
$('#wrLangs').addEventListener('click', async (e) => {
  const k = e.target.dataset.lang;
  if (!k) return;
  const next = wrTargets.includes(k) ? wrTargets.filter((x) => x !== k) : [...wrTargets, k];
  if (!next.length) return notice('至少选一个语种。');
  // 第一个选中的语种也作为卡片上「我来写」的默认语种
  await saveSettings({ translateTargets: next, translateTarget: next[0] });
});
function renderWrResults() {
  $('#wrResults').innerHTML = wrResults.map((r, i) => `
    <div class="card draft wr-result" data-i="${i}">
      <div class="draft-head"><span class="angle">${esc(langName(r.lang))}</span><span class="chars">${r.loading ? '' : [...r.text].length + ' 字'}</span></div>
      ${r.loading ? '<div class="spinner">翻译中…</div>' : r.error ? `<div class="err">${esc(r.error)}</div>` : `
      <textarea class="auto" data-wr="${i}" rows="1">${esc(r.text)}</textarea>
      <div class="actions">
        <button class="small" data-wract="fill" title="填进你当前正在回复的输入框（Reddit / X / LinkedIn 任意页面）">填入当前页面</button>
        <button class="ghost small" data-wract="copy">复制</button>
      </div>`}
    </div>`).join('');
  $('#wrResults').querySelectorAll('textarea.auto').forEach(autosize);
  $('#wrRefine').classList.toggle('hidden', !wrResults.length || wrResults.some((r) => r.loading));
}
async function runTranslate(instruction = '') {
  const src = $('#wrSrc').value.trim();
  if (!src) return notice('先写下你想说的话。');
  const prev = Object.fromEntries(wrResults.map((r) => [r.lang, r.text]));
  wrResults = wrTargets.map((lang) => ({ lang, src, loading: true }));
  renderWrResults();
  $('#wrGo').disabled = true;
  await Promise.all(wrResults.map(async (r) => {
    const res = await send({ type: 'TRANSLATE', text: src, target: r.lang, instruction, previous: instruction ? prev[r.lang] || '' : '', polish: wrPolish });
    r.loading = false;
    if (res?.ok) { r.out = res.result.text; r.text = res.result.text; } else r.error = res?.error || '翻译失败';
    renderWrResults();
  }));
  $('#wrGo').disabled = false;
}
// 你确认用这条译文（复制或填入）时，把定稿记下来学习
const learnWr = (r) => r.out && send({ type: 'TRANSLATION_FINAL', src: r.src, out: r.out, final: r.text.trim(), lang: r.lang });
$('#wrResults').addEventListener('input', (e) => {
  const i = e.target.dataset.wr;
  if (i == null) return;
  wrResults[i].text = e.target.value;
  e.target.closest('.draft').querySelector('.chars').textContent = [...e.target.value].length + ' 字';
  autosize(e.target);
});
$('#wrResults').addEventListener('click', async (e) => {
  const act = e.target.dataset.wract;
  if (!act) return;
  const r = wrResults[e.target.closest('.wr-result').dataset.i];
  await navigator.clipboard.writeText(r.text.trim()).catch(() => {});
  learnWr(r);
  if (act === 'copy') return notice('已复制。粘贴到回复框里检查后，自己点发送。');
  const res = await send({ type: 'FILL_ACTIVE', text: r.text.trim() });
  notice(res?.ok ? res.result : res?.error || '填入失败（译文已复制，可以直接粘贴）', 8000);
});
$('#wrGo').addEventListener('click', () => runTranslate());
const renderWrMode = () => $('#wrMode').querySelectorAll('[data-wrmode]').forEach((b) => b.classList.toggle('on', (b.dataset.wrmode === 'polish') === wrPolish));
renderWrMode();
$('#wrMode').addEventListener('click', (e) => {
  const m = e.target.dataset.wrmode;
  if (!m) return;
  wrPolish = m === 'polish';
  try { localStorage.setItem('wrPolish', wrPolish ? '1' : '0'); } catch {}
  renderWrMode();
});
$('#wrRedo').addEventListener('click', () => {
  const ins = $('#wrInstr').value.trim();
  if (!ins) return notice('先写下你想怎么调整译文。');
  runTranslate(ins).then(() => ($('#wrInstr').value = ''));
});
$('#wrInstr').addEventListener('keydown', (e) => e.key === 'Enter' && $('#wrRedo').click());
$('#wrSrc').addEventListener('keydown', (e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && $('#wrGo').click());

// ---------------- 越用越懂你 ----------------
async function renderLearn() {
  const [{ learn }, s] = await Promise.all([chrome.storage.local.get('learn'), getSettings()]);
  const l = { inputs: [], views: [], ...(learn || {}) };
  const pending = l.views.filter((v) => v.status === 'pending');
  const waiting = l.inputs.filter((x) => !x.done).length;
  $('#learnCount').textContent = pending.length || '';
  $('#learnOn').checked = s.learnViews !== false;
  if ($('#learnList').contains(document.activeElement)) return;
  $('#learnList').innerHTML = (pending.length ? pending.map((v) => `
    <div class="learn-item" data-vid="${v.id}">
      <div class="learn-kind"><span class="tag">${v.kind === 'interest' ? '兴趣' : '观点'}</span>${v.kind === 'interest' && v.keywords?.length ? `<span class="hint">关键词：${esc(v.keywords.join(', '))}</span>` : ''}</div>
      <input class="learn-text" value="${esc(v.text)}" title="可以先改一改再采纳" />
      ${v.quote ? `<div class="learn-quote">你说过：${esc(v.quote)}</div>` : ''}
      <div class="actions"><button class="small" data-lv="accept">采纳</button><button class="ghost small" data-lv="reject">${v.kind === 'interest' ? '不感兴趣' : '不是我的观点'}</button></div>
    </div>`).join('') : '<p class="hint">暂时没有新的候选观点。</p>') +
    `<p class="hint">已攒下 ${waiting} 条新输入${waiting >= 8 ? '' : '，满 8 条会自动学习一次'}；已采纳 ${l.views.filter((v) => v.status === 'accepted').length} 条。</p>`;
}
$('#learnList').addEventListener('click', async (e) => {
  const act = e.target.dataset.lv;
  const item = e.target.closest('.learn-item');
  if (!act || !item) return;
  e.target.disabled = true;
  const res = act === 'accept'
    ? await send({ type: 'ACCEPT_VIEW', id: item.dataset.vid, text: item.querySelector('.learn-text').value })
    : await send({ type: 'REJECT_VIEW', id: item.dataset.vid });
  if (!res?.ok) { e.target.disabled = false; return notice(res?.error || '操作失败'); }
  item.remove();
  const kind = item.querySelector('.learn-kind .tag')?.textContent;
  notice(act === 'accept' ? (kind === '兴趣' ? '已加到「设置 → 兴趣」，关键词也并进了打分预筛。' : '已加到「观点与立场」，以后起草会参考。') : '好的，以后不会再提这条。');
  renderLearn();
});
$('#learnOn').addEventListener('change', (e) => saveSettings({ learnViews: e.target.checked }));
$('#learnNow').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = '学习中…';
  const res = await send({ type: 'LEARN_VIEWS' });
  e.target.disabled = false;
  e.target.textContent = '立即学习';
  notice(res?.ok ? (res.result?.added ? `提炼出 ${res.result.added} 条候选观点，确认一下吧。` : '这次没有提炼出新的观点（输入太少，或都和已有观点重复）。') : res?.error || '学习失败');
  renderLearn();
});
renderLearn();

// ---------------- Style ----------------
async function renderStyle() {
  const st = await getStyle();
  if (document.activeElement !== $('#profile')) $('#profile').value = st.profile;
  if (document.activeElement !== $('#viewpoints')) $('#viewpoints').value = st.viewpoints;
  if (document.activeElement !== $('#toneLinkedin')) $('#toneLinkedin').value = st.platformTone?.linkedin || '';
  $('#profileMeta').textContent = st.profileUpdatedAt ? `上次更新：${new Date(st.profileUpdatedAt).toLocaleString()} · 之后新增 ${st.sinceUpdate} 条定稿` : '';
  const by = (src) => st.samples.filter((x) => x.source === src).length;
  $('#sampleMeta').textContent =
    `已有样本 ${st.samples.length} 条（导入 ${by('import')} · 浏览时采集 ${by('observed')} · 手动 ${by('manual')} · 发送定稿 ${by('sent')}），修改记录 ${st.edits.length} 条。`;
  const list = $('#sampleList');
  list.innerHTML = '';
  st.samples.slice(-30).reverse().forEach((x) => {
    const row = document.createElement('div');
    row.className = 'sample';
    row.innerHTML = `<span>[${esc(x.platform)}/${esc(x.lang)}] ${esc(x.text.slice(0, 240))}</span><button class="ghost" data-del="${esc(x.id)}">删</button>`;
    list.appendChild(row);
  });
}
$('#sampleList').addEventListener('click', async (e) => {
  const id = e.target.dataset.del;
  if (!id) return;
  const st = await getStyle();
  st.samples = st.samples.filter((x) => x.id !== id);
  await saveStyle(st);
});
$('#saveProfile').addEventListener('click', async () => {
  const st = await getStyle();
  st.profile = $('#profile').value.trim();
  await saveStyle(st);
  notice('风格档案已保存。');
});
$('#saveViewpoints').addEventListener('click', async () => {
  const st = await getStyle();
  st.viewpoints = $('#viewpoints').value.trim();
  await saveStyle(st);
  notice('观点与立场已保存。');
});
$('#saveTone').addEventListener('click', async () => {
  const st = await getStyle();
  st.platformTone = { ...st.platformTone, linkedin: $('#toneLinkedin').value.trim() };
  await saveStyle(st);
  notice('LinkedIn 语气已保存。');
});
$('#buildProfile').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = '分析中…';
  const res = await send({ type: 'BUILD_PROFILE' });
  e.target.disabled = false;
  e.target.textContent = '生成 / 更新风格档案';
  if (res?.ok) { $('#profile').value = res.result; notice('风格档案已更新，可以继续手动微调。'); }
  else notice(res?.error || '生成失败');
});
$('#importReddit').addEventListener('click', async (e) => {
  e.target.disabled = true;
  const res = await send({ type: 'IMPORT_REDDIT', username: $('#redditUser').value });
  e.target.disabled = false;
  notice(res?.ok ? `导入了 ${res.result} 条评论。接着点「生成 / 更新风格档案」。` : res?.error);
});
$('#openXReplies').addEventListener('click', async () => {
  const s = await getSettings();
  if (!s.xHandle) return notice('请先在「设置」里填写你的 X 账号。');
  chrome.tabs.create({ url: `https://x.com/${s.xHandle.replace(/^@/, '')}/with_replies` });
});
$('#addSamples').addEventListener('click', async () => {
  const texts = $('#manualSamples').value.split(/\n-{3,}\n/);
  const res = await send({ type: 'ADD_SAMPLES', texts });
  if (res?.ok) { $('#manualSamples').value = ''; notice(`添加了 ${res.result} 条样本。`); }
});

// ---------------- 关联库 ----------------
const lform = $('#linkingForm');
async function renderLinking() {
  const l = await getLinking();
  const f = lform.elements;
  ['enabled', 'includeLink', 'includeQuote', 'includeMention'].forEach((k) => (f[k].checked = l[k]));
  ['autoSaveValue', 'maxUsesPerPost', 'mentionCooldownDays'].forEach((k) => (f[k].value = l[k]));
}
lform.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = lform.elements;
  await saveLinking({
    enabled: f.enabled.checked,
    includeLink: f.includeLink.checked,
    includeQuote: f.includeQuote.checked,
    includeMention: f.includeMention.checked,
    autoSaveValue: +f.autoSaveValue.value || 85,
    maxUsesPerPost: Math.max(1, +f.maxUsesPerPost.value || 2),
    mentionCooldownDays: Math.max(1, +f.mentionCooldownDays.value || 7)
  });
  notice('关联引用设置已保存。');
});
async function renderLibrary() {
  const lib = Object.values(await getLibrary()).sort((a, b) => b.savedAt - a.savedAt);
  $('#libCount').textContent = lib.length || '';
  const box = $('#libraryList');
  if (!lib.length) {
    box.innerHTML = '<div class="empty">关联库还是空的。开启关联引用后，S 级帖子会自动收藏；也可以在帖子卡片上点「☆ 收藏」。</div>';
    return;
  }
  box.innerHTML = lib.map((e) => `
    <div class="card item">
      <div class="meta">
        <span class="badge ${e.platform}">${platName(e.platform)}</span>
        <span>${esc(who(e.platform, e.author || ''))}</span>
        ${e.category ? `<span class="kind">${esc(e.category)}</span>` : ''}
        <span>已引用 ${e.usedCount} 次</span>
      </div>
      ${e.title ? `<div class="title">${esc(e.title)}</div>` : ''}
      <div class="body">${esc(e.text)}</div>
      <div class="row"><a href="${esc(e.url)}" target="_blank" class="ghost">打开原文</a><button class="ghost" data-unlib="${esc(e.id)}">移除</button></div>
    </div>`).join('');
}
$('#libraryList').addEventListener('click', async (e) => {
  const id = e.target.dataset.unlib;
  if (id) await send({ type: 'REMOVE_FROM_LIBRARY', id });
});

// ---------------- Company ----------------
const cform = $('#companyForm');
async function renderCompany() {
  company = await getCompany();
  const f = cform.elements;
  ['name', 'role', 'aliases', 'background', 'mentionEvery'].forEach((k) => (f[k].value = company[k]));
  f.enabled.checked = company.enabled;
  f.disclose.checked = company.disclose;
}
cform.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = cform.elements;
  if (!f.disclose.checked && !confirm('关闭利益相关声明后，提到公司的回复可能违反平台规则，增加封号风险。确定关闭？')) return;
  await saveCompany({
    enabled: f.enabled.checked,
    name: f.name.value.trim(),
    role: f.role.value.trim(),
    aliases: f.aliases.value.trim(),
    background: f.background.value.trim(),
    disclose: f.disclose.checked,
    mentionEvery: Math.max(1, +f.mentionEvery.value || 5)
  });
  notice('公司背景已保存。');
});

// ---------------- Settings ----------------
const form = $('#settingsForm');
// 表单里暂存每个模型商的 Key 和模型名，切换模型商时不丢
let provDraft = { keys: {}, models: {} };
let curProv = 'anthropic';
function showProvider(p) {
  const f = form.elements;
  const P = PROVIDERS[p];
  curProv = p;
  f.provider.value = p;
  f.providerKey.value = provDraft.keys[p] || '';
  f.providerKey.placeholder = P.keyHint;
  $('#keyLabel').textContent = `${P.name} API Key`;
  f.scoreModel.value = provDraft.models[p]?.score || '';
  f.draftModel.value = provDraft.models[p]?.draft || '';
  f.scoreModel.placeholder = P.score;
  f.draftModel.placeholder = P.draft;
  const host = P.url ? new URL(P.url).host : 'api.anthropic.com';
  $('#providerHint').textContent = `打分和起草都用 ${P.name}（默认 ${P.score} / ${P.draft}）。Key 只存在本机浏览器里，只会发给 ${host}。`;
}
function stashProvider() {
  const f = form.elements;
  const p = curProv;
  provDraft.keys[p] = f.providerKey.value.trim();
  const m = {};
  if (f.scoreModel.value.trim()) m.score = f.scoreModel.value.trim();
  if (f.draftModel.value.trim()) m.draft = f.draftModel.value.trim();
  provDraft.models[p] = m;
}
form.elements.provider.addEventListener('change', (e) => { stashProvider(); showProvider(e.target.value); });
async function renderSettings() {
  const s = await getSettings();
  const f = form.elements;
  provDraft = { keys: Object.fromEntries(Object.entries(PROVIDERS).map(([k, P]) => [k, s[P.keyField] || ''])), models: structuredClone(s.models || {}) };
  showProvider(providerOf(s));
  ['interests', 'scoreThreshold',
    'feedIntervalMin', 'cooldownMinMin', 'cooldownMaxMin', 'redditUsername', 'xHandle', 'linkedinName',
    'linkedinCooldownMinMin', 'linkedinCooldownMaxMin'].forEach((k) => (f[k].value = s[k]));
  f.capLinkedin.value = s.caps.linkedin;
  f.myLang.innerHTML = langOptions(s.myLang || 'zh', false);
  f.watchlist.value = (s.watchlist || []).join('\n');
  f.watchNotify.checked = s.watchNotify;
  f.keywords.value = s.keywords.join(', ');
  f.negativeKeywords.value = s.negativeKeywords.join(', ');
  ['minLocalScore', 'maxAgeHours', 'maxScoredPerDay'].forEach((k) => (f[k].value = s[k]));
  ['pendingDays', 'sentDays', 'libraryDays'].forEach((k) => (f[k].value = s.retention[k]));
  chrome.storage.local.getBytesInUse(null).then((b) => ($('#storageUsage').textContent = `本地存储占用 ${(b / 1024 / 1024).toFixed(2)} MB（上限约 10 MB）`));
  f.subreddits.value = s.subreddits.join(', ');
  f.keywordPrefilter.checked = s.keywordPrefilter;
  f.feedEnabled.checked = s.feedEnabled;
  f.hnEnabled.checked = s.hnEnabled !== false;
  f.hnKeywords.value = (s.hnKeywords || []).join(', ');
  f.hnUser.value = s.hnUser || '';
  f.capReddit.value = s.caps.reddit;
  f.capX.value = s.caps.x;
  if (s.redditUsername && !$('#redditUser').value) $('#redditUser').value = s.redditUsername;
}
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  stashProvider();
  const f = form.elements;
  const list = (v) => v.split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);
  const num = (v, d) => (Number.isFinite(+v) && v !== '' ? +v : d);
  const lo = num(f.cooldownMinMin.value, 3);
  const hi = Math.max(lo, num(f.cooldownMaxMin.value, 9));
  await saveSettings({
    provider: f.provider.value,
    ...Object.fromEntries(Object.entries(PROVIDERS).map(([k, P]) => [P.keyField, provDraft.keys[k] || ''])),
    models: provDraft.models,
    interests: f.interests.value.trim(),
    keywords: list(f.keywords.value),
    subreddits: list(f.subreddits.value).map((x) => x.replace(/^r\//i, '')),
    keywordPrefilter: f.keywordPrefilter.checked,
    negativeKeywords: list(f.negativeKeywords.value),
    minLocalScore: num(f.minLocalScore.value, 2),
    maxAgeHours: Math.max(1, num(f.maxAgeHours.value, 72)),
    maxScoredPerDay: num(f.maxScoredPerDay.value, 300),
    retention: {
      pendingDays: Math.max(1, num(f.pendingDays.value, 7)),
      sentDays: Math.max(1, num(f.sentDays.value, 90)),
      libraryDays: Math.max(1, num(f.libraryDays.value, 30))
    },
    scoreThreshold: num(f.scoreThreshold.value, 60),
    feedEnabled: f.feedEnabled.checked,
    feedIntervalMin: Math.max(15, num(f.feedIntervalMin.value, 45)),
    caps: { reddit: num(f.capReddit.value, 15), x: num(f.capX.value, 20), linkedin: num(f.capLinkedin.value, 15) },
    linkedinCooldownMinMin: num(f.linkedinCooldownMinMin.value, 10),
    linkedinCooldownMaxMin: Math.max(num(f.linkedinCooldownMinMin.value, 10), num(f.linkedinCooldownMaxMin.value, 25)),
    linkedinName: f.linkedinName.value.trim(),
    hnEnabled: f.hnEnabled.checked,
    hnKeywords: list(f.hnKeywords.value),
    hnUser: f.hnUser.value.trim(),
    watchlist: f.watchlist.value.split('\n').map((x) => x.trim()).filter(Boolean),
    watchNotify: f.watchNotify.checked,
    myLang: f.myLang.value || 'zh',
    cooldownMinMin: lo,
    cooldownMaxMin: hi,
    redditUsername: f.redditUsername.value.trim().replace(/^u\//, ''),
    xHandle: f.xHandle.value.trim().replace(/^@/, '')
  });
  await send({ type: 'SETTINGS_CHANGED' });
  send({ type: 'RESCORE' });
  $('#savedHint').textContent = '已保存 ✓';
  setTimeout(() => ($('#savedHint').textContent = ''), 2500);
});
$('#exportData').addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  if (all.settings) all.settings = { ...all.settings, apiKey: '(已隐藏)', openaiKey: '(已隐藏)', deepseekKey: '(已隐藏)' };
  const url = URL.createObjectURL(new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'reply-copilot-export.json' });
  a.click();
  URL.revokeObjectURL(url);
});
$('#cleanupNow').addEventListener('click', async () => {
  await send({ type: 'CLEANUP' });
  renderSettings();
  notice('已清理过期数据。');
});
$('#clearQueue').addEventListener('click', async () => {
  if (!confirm('清空所有待回复、已跳过和低分内容？（已发送记录和风格样本会保留）')) return;
  const posts = await getPosts();
  for (const id of Object.keys(posts)) if (posts[id].status !== 'sent') delete posts[id];
  await chrome.storage.local.set({ posts });
});

// ---------------- Live updates ----------------
chrome.storage.onChanged.addListener((changes) => {
  if (changes.posts || changes.stats || changes.settings) scheduleRender();
  if (changes.settings) { renderWrite(); myLang = changes.settings.newValue?.myLang || 'zh'; }
  if (changes.ownPosts && !$('#cpHist').classList.contains('hidden')) renderCpList();
  if ((changes.ownPosts || changes.posts) && !$('#cpMine').contains(document.activeElement)) renderCpMine();
  if (changes.posts) renderCpReply();
  if (changes.panelJump?.newValue) consumePanelJump();
  if ((changes.ownPosts || changes.stats) && cp.out && !(/^(TEXTAREA|INPUT)$/.test(document.activeElement?.tagName) && $('#cpOut').contains(document.activeElement))) renderCpOut();
  if (changes.style) { renderStyle(); renderWrite(); }
  if (changes.learn || changes.settings) renderLearn();
  if (changes.company) renderCompany().then(scheduleRender);
  if (changes.library) { renderLibrary(); scheduleRender(); }
  if (changes.linking) renderLinking();
  if (changes.diag) getSettings().then(renderDiag);
  if (changes.diag || changes.activity || changes.posts || changes.settings) renderPipeline();
});
renderPipeline();
setInterval(renderHeader, 30000);

renderSettings();
renderWrite().then(scheduleRender);
renderStyle();
renderCompany().then(scheduleRender);
renderLinking();
renderLibrary();
scheduleRender();
getSettings().then((s) => {
  if (!hasKey(s)) {
    document.querySelector('[data-tab="settings"]').click();
    $('#savedHint').textContent = '先填写 API Key 并保存';
  }
});

// 设置引导
const openOnboarding = () => chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
$('#openOnboarding').addEventListener('click', openOnboarding);
$('#obBannerGo').addEventListener('click', openOnboarding);
