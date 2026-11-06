// LinkedIn：读取你在信息流 / 帖子页上看到的帖子和评论；按需把草稿填进评论框。
// LinkedIn 对自动化最敏感：这里只读页面、只填字，从不点赞、评论、加好友或发私信。
(() => {
  const RC = window.RC;
  if (!RC || RC.dead || RC.platformReady) return;
  RC.platformReady = true;

  const POST_SEL = '[data-urn^="urn:li:activity:"], [data-id^="urn:li:activity:"], [data-urn^="urn:li:ugcPost:"], [data-urn^="urn:li:share:"], div.feed-shared-update-v2';
  const COMMENT_SEL = 'article.comments-comment-entity, article.comments-comment-item, [data-id^="urn:li:comment:"]';
  const EDITOR_SEL = '.comments-comment-box__form [contenteditable="true"], .comments-comment-texteditor [contenteditable="true"], .ql-editor[contenteditable="true"], div[role="textbox"][contenteditable="true"], [contenteditable="true"]';

  const textOf = (el) => (el?.innerText || '').replace(/\s+/g, ' ').trim();
  const firstLine = (s) => (s || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
  const decodedUrl = () => { try { return decodeURIComponent(location.href); } catch { return location.href; } };

  // 帖子的 urn：优先读元素自己的属性，其次是外层，最后是地址栏（单帖页）
  function postUrn(el) {
    const own = el.getAttribute('data-urn') || el.getAttribute('data-id') || el.closest('[data-urn^="urn:li:"]')?.getAttribute('data-urn') || '';
    const m = own.match(/urn:li:(activity|ugcPost|share):(\d+)/);
    if (m) return { urn: m[0], num: m[2] };
    const u = decodedUrl().match(/urn:li:(activity|ugcPost|share):(\d+)/) || location.pathname.match(/activity-(\d+)/);
    if (!u) return null;
    return u[2] ? { urn: u[0], num: u[2] } : { urn: 'urn:li:activity:' + u[1], num: u[1] };
  }

  const num = (s) => {
    const m = (s || '').replace(/,/g, '').match(/([\d.]+)\s*([KkMm万]?)/);
    if (!m) return null;
    const mul = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, 万: 1e4 }[m[2]] || 1;
    return Math.round(parseFloat(m[1]) * mul);
  };

  // 「2h •」「3 天 •」这类相对时间
  function relTime(s) {
    const m = (s || '').match(/(\d+)\s*(mo|yr|y|w|d|h|m|s|个?月|年|周|天|小时|分钟|秒)/i);
    if (!m) return 0;
    const unit = { s: 1, 秒: 1, m: 60, 分钟: 60, h: 3600, 小时: 3600, d: 86400, 天: 86400, w: 604800, 周: 604800, mo: 2592000, 月: 2592000, 个月: 2592000, y: 31536000, yr: 31536000, 年: 31536000 }[m[2].toLowerCase()] || 0;
    return unit ? Date.now() - Number(m[1]) * unit * 1000 : 0;
  }

  // 按优先级依次尝试选择器（一次性的选择器列表会按文档顺序返回，拿到的可能是外层元素）
  const pick = (root, sels) => { for (const s of sels) { const e = root.querySelector(s); if (e) return e; } return null; };

  const profileId = (a) => a?.getAttribute('href')?.match(/\/(?:in|company)\/([^/?#]+)/)?.[1] || '';

  function actorOf(el) {
    const nameEl = pick(el, ['.update-components-actor__title span[aria-hidden="true"]', '.update-components-actor__name span[aria-hidden="true"]', '.update-components-actor__title', '.update-components-actor__name', '.feed-shared-actor__name']);
    const link = pick(el, ['a.update-components-actor__meta-link', 'a.update-components-actor__image', '.update-components-actor a[href*="/in/"]', '.update-components-actor a[href*="/company/"]', '.feed-shared-actor a[href*="/in/"]']);
    return {
      name: firstLine(nameEl?.innerText),
      id: profileId(link),
      headline: textOf(el.querySelector('.update-components-actor__description, .feed-shared-actor__description')),
      sub: textOf(el.querySelector('.update-components-actor__sub-description, .feed-shared-actor__sub-description'))
    };
  }

  const postTextEl = (el) => [...el.querySelectorAll('.update-components-text, .feed-shared-update-v2__description, .feed-shared-inline-show-more-text, .feed-shared-text')]
    .find((t) => !t.closest(COMMENT_SEL));

  function parsePost(el) {
    const urn = postUrn(el);
    if (!urn) return null;
    const actor = actorOf(el);
    const textEl = postTextEl(el);
    const text = RC.clip(textEl?.innerText || '', 2500);
    // 「Promoted / 推广」= 广告
    if (/\b(Promoted|Sponsored)\b|推广/.test(actor.headline + ' ' + actor.sub)) return null;
    const reactions = num(textOf(el.querySelector('.social-details-social-counts__reactions-count, [data-test-id="social-actions__reaction-count"]')) ||
      el.querySelector('button[aria-label*="reaction" i]')?.getAttribute('aria-label'));
    const comments = num(textOf(el.querySelector('.social-details-social-counts__comments, [data-test-id="social-actions__comments"]')));
    return { urn, actor, text, lang: textEl?.closest('[lang]')?.getAttribute('lang') || '', time: relTime(actor.sub), engagement: { up: reactions, comments } };
  }

  function extractPost(el) {
    if (el.closest(COMMENT_SEL)) return null;
    const p = parsePost(el);
    if (!p || !p.text) return null;
    return {
      id: 'li_' + p.urn.num,
      platform: 'linkedin',
      kind: 'post',
      url: `https://www.linkedin.com/feed/update/${p.urn.urn}/`,
      title: '',
      text: p.text,
      author: p.actor.name,
      authorId: p.actor.id,
      authorHeadline: p.actor.headline.slice(0, 120),
      community: '',
      lang: p.lang,
      createdAt: p.time,
      engagement: p.engagement,
      parentId: '',
      context: null
    };
  }

  // ---------- 评论 ----------
  function commentIds(el) {
    const raw = el.getAttribute('data-id') || el.closest('[data-id^="urn:li:comment:"]')?.getAttribute('data-id') || '';
    const m = raw.match(/comment:\((?:urn:li:)?(activity|ugcPost|share):(\d+),(\d+)\)/);
    return m ? { postType: m[1], post: m[2], comment: m[3], urn: raw } : null;
  }

  function parseComment(el) {
    const ids = commentIds(el);
    if (!ids) return null;
    const own = (e) => e && e.closest(COMMENT_SEL) === el ? e : null;
    const nameEl = own(pick(el, ['.comments-comment-meta__description-title', '.comments-post-meta__name-text', '.comments-comment-item__post-meta .hoverable-link-text']));
    const link = own(pick(el, ['a.comments-comment-meta__image-link', 'a.comments-post-meta__actor-link', 'a.comments-comment-meta__description-container', 'a[href*="/in/"]', 'a[href*="/company/"]']));
    // 只取这条评论自己的正文，不要把楼中楼的回复读进来
    const textEl = [...el.querySelectorAll('.comments-comment-item__main-content, .comments-comment-entity__content .update-components-text, .comments-highlighted-comment-item-content-body, .update-components-text')]
      .find((t) => t.closest(COMMENT_SEL) === el);
    return {
      ids,
      author: firstLine(nameEl?.innerText),
      authorId: profileId(link),
      text: RC.clip(textEl?.innerText || '', 1500),
      lang: textEl?.closest('[lang]')?.getAttribute('lang') || '',
      time: relTime(textOf(el.querySelector('.comments-comment-meta__data, time, .comments-comment-item__timestamp')))
    };
  }

  function extractComment(el) {
    const c = parseComment(el);
    if (!c || !c.text) return null;
    const postEl = [...document.querySelectorAll(POST_SEL)].find((p) => p.contains(el) && !p.closest(COMMENT_SEL));
    const root = postEl ? parsePost(postEl) : null;
    const parentEl = el.parentElement?.closest(COMMENT_SEL);
    const parent = parentEl ? parseComment(parentEl) : null;
    const postUrnStr = `urn:li:${c.ids.postType}:${c.ids.post}`;
    return {
      id: 'li_c_' + c.ids.comment,
      platform: 'linkedin',
      kind: 'comment',
      url: `https://www.linkedin.com/feed/update/${postUrnStr}/?commentUrn=${encodeURIComponent(c.ids.urn)}`,
      title: '',
      text: c.text,
      author: c.author,
      authorId: c.authorId,
      community: '',
      lang: c.lang,
      createdAt: c.time,
      engagement: {},
      parentId: parent ? 'li_c_' + parent.ids.comment : 'li_' + c.ids.post,
      context: {
        rootTitle: '',
        rootText: root?.text || '',
        rootAuthor: root?.actor.name || '',
        parents: parent ? [{ author: parent.author, text: parent.text }] : []
      }
    };
  }

  // ---------- 兜底识别：不依赖样式名 ----------
  // LinkedIn 会给样式名做混淆、经常改版。找不到上面那些样式名时，按「操作按钮」认出帖子和评论：
  // 帖子 = 含有且只含有一个「评论 / Comment」按钮的最大区块；评论 = 含有且只含有一个「回复 / Reply」按钮的最大区块。
  // 用 textContent 而不是 innerText：不触发页面重排，扫描再多按钮也不卡
  const label = (b) => (b.getAttribute('aria-label') || b.textContent || '').replace(/\s+/g, ' ').trim();
  const seenBtn = new WeakSet();
  // 注意中文后面不能用 \b（中文字符不算「单词字符」，\b 永远匹配不上）
  const RE_COMMENT_BTN = /^(comment|评论|留言)(?![a-z])/i;
  const RE_REPLY_BTN = /^(reply|回复)(?![a-z])/i;
  const RE_REACT_BTN = /^(like|react|repost|send|share|open reactions)|^(赞|点赞|回应|打开回应|转发|重新发布|转帖|发送|分享)/i;
  const btns = (root) => [...root.querySelectorAll('button, [role="button"]')];
  const count = (root, re) => btns(root).filter((b) => re.test(label(b))).length;
  const isClassic = (el) => !!(el.closest(POST_SEL + ',' + COMMENT_SEL) || el.querySelector(POST_SEL));

  function grow(btn, re, stop, preferListItem) {
    let box = null;
    for (let cur = btn.parentElement; cur && cur !== document.body; cur = cur.parentElement) {
      if (stop(cur) || count(cur, re) > 1) break;
      box = cur;
      // 新版信息流里每条帖子是一个 role=listitem，到这一层就够了
      if (preferListItem && cur.getAttribute('role') === 'listitem') break;
    }
    return box;
  }
  function tagHeuristic() {
    if (RC.dead) return;
    // 只看新出现的按钮；没认出来的候选按钮下次再试（帖子可能还没加载完）
    const fresh = btns(document).filter((b) => !seenBtn.has(b));
    for (const b of fresh) {
      const l = label(b);
      if (RE_COMMENT_BTN.test(l)) {
        if (b.closest('[data-rc-post]') || isClassic(b)) { seenBtn.add(b); continue; }
        const box = grow(b, RE_COMMENT_BTN, () => false, true);
        if (box && !isClassic(box) && count(box, RE_REACT_BTN) && box.querySelector('a[href*="/in/"], a[href*="/company/"]') && (box.textContent || '').length > 60) {
          box.setAttribute('data-rc-post', '1');
          seenBtn.add(b);
        }
      } else if (!RE_REPLY_BTN.test(l)) seenBtn.add(b);
    }
    for (const b of fresh) {
      if (!RE_REPLY_BTN.test(label(b))) continue;
      if (b.closest('[data-rc-comment]') || isClassic(b)) { seenBtn.add(b); continue; }
      const box = grow(b, RE_REPLY_BTN, (cur) => cur.hasAttribute('data-rc-post') || count(cur, RE_COMMENT_BTN) > 0);
      if (box && box.querySelector('a[href*="/in/"], a[href*="/company/"]')) {
        box.setAttribute('data-rc-comment', '1');
        seenBtn.add(b);
      }
    }
  }

  // 简单哈希：拿不到 LinkedIn 自己的 id 时，用作者 + 正文生成稳定 id
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i); return (h >>> 0).toString(36); };
  const urnIn = (el) => (el.outerHTML.slice(0, 200000).match(/urn:li:(activity|ugcPost|share):(\d+)/) || null);
  const ownPart = (box, e) => !e.parentElement?.closest('[data-rc-comment]') || e.parentElement.closest('[data-rc-comment]') === box;

  function guessAuthor(box) {
    const a = [...box.querySelectorAll('a[href*="/in/"], a[href*="/company/"]')].find((x) => ownPart(box, x) && textOf(x));
    const name = firstLine(a?.innerText).replace(/\s*[•·].*$/, '').replace(/\s+(1st|2nd|3rd\+?|一度|二度|三度).*$/i, '').trim();
    return { name, id: profileId(a), link: a };
  }
  function guessText(box, skip) {
    let best = null, bestLen = 0;
    for (const e of box.querySelectorAll('span, div, p')) {
      if (!ownPart(box, e) || (skip && skip.contains(e)) || e.closest('[data-rc-comment]') !== box.closest('[data-rc-comment]')) continue;
      if (e.querySelector('a[href*="/in/"], a[href*="/company/"], img, video') || btns(e).some((b) => !/more|更多|展开|…|译文|translation/i.test(label(b)))) continue;
      const len = (e.innerText || '').trim().length;
      if (len > bestLen) { best = e; bestLen = len; }
    }
    return best;
  }
  const guessTime = (box) => relTime((box.innerText || '').split('\n').find((t) => /^\s*\d+\s*(?:(mo|yr|w|d|h|m)(?![a-z])|个?月|年|周|天|小时|分钟)/i.test(t) || /\d+\s*(mo|yr|w|d|h|m|个?月|年|周|天|小时|分钟)\s*•/.test(t)) || '');

  function heuristicPost(box) {
    const author = guessAuthor(box);
    const textEl = guessText(box, author.link);
    const text = RC.clip(textEl?.innerText || '', 2500);
    if (!text || text.length < 20 || /\b(Promoted|Sponsored)\b|推广/.test(textOf(box).slice(0, 300))) return null;
    const u = urnIn(box);
    const id = u ? 'li_' + u[2] : 'li_h_' + hash(author.name + text.slice(0, 200));
    return {
      id, platform: 'linkedin', kind: 'post',
      url: u ? `https://www.linkedin.com/feed/update/${u[0]}/` : (box.querySelector('a[href*="/feed/update/"], a[href*="/posts/"]')?.href || location.href),
      title: '', text, author: author.name, authorId: author.id, authorHeadline: '', community: '', lang: '',
      createdAt: guessTime(box), engagement: {}, parentId: '', context: null
    };
  }
  function heuristicComment(box) {
    const author = guessAuthor(box);
    const textEl = guessText(box, author.link);
    const text = RC.clip(textEl?.innerText || '', 1500);
    if (!text) return null;
    const m = box.outerHTML.slice(0, 100000).match(/comment:\((?:urn:li:)?(activity|ugcPost|share):(\d+),(\d+)\)/);
    const postBox = box.closest('[data-rc-post]') || box.parentElement?.closest('[data-rc-post]');
    const root = postBox ? heuristicPost(postBox) : null;
    const parentBox = box.parentElement?.closest('[data-rc-comment]');
    const parent = parentBox ? guessAuthor(parentBox) : null;
    return {
      id: m ? 'li_c_' + m[3] : 'li_hc_' + hash(author.name + text.slice(0, 200)),
      platform: 'linkedin', kind: 'comment',
      url: root?.url || location.href,
      title: '', text, author: author.name, authorId: author.id, community: '', lang: '',
      createdAt: guessTime(box), engagement: {},
      parentId: parentBox ? '' : root?.id || '',
      context: { rootTitle: '', rootText: root?.text || '', rootAuthor: root?.author || '', parents: parent ? [{ author: parent.name, text: RC.clip(guessText(parentBox, parent.link)?.innerText || '', 400) }] : [] }
    };
  }

  RC.observe(POST_SEL, extractPost);
  RC.observe(COMMENT_SEL, extractComment);
  const rescanPosts = RC.observe('[data-rc-post]', heuristicPost);
  const rescanComments = RC.observe('[data-rc-comment]', heuristicComment);
  const runTag = () => { try { tagHeuristic(); rescanPosts(); rescanComments(); } catch {} };
  runTag();
  const tagTimer = setInterval(() => (RC.dead ? clearInterval(tagTimer) : runTag()), 2500);

  // 诊断：只汇报页面结构（标签、样式名、属性名、按钮文字），不含帖子正文
  RC.probe = () => {
    const skel = (el, depth) => {
      if (!el || depth > 14) return '';
      const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 3).map((c) => c.slice(0, 32)).join('.');
      const attrs = [...el.attributes].map((a) => a.name).filter((n) => /^(data-|aria-|role|componentkey|dir|lang|href)/.test(n))
        .map((n) => n === 'href' ? 'href=' + (el.getAttribute('href') || '').replace(/[?#].*/, '').replace(/\/(in|company)\/[^/]+/, '/$1/*').slice(0, 40)
          : /^(data-urn|data-id|role|data-view-name|aria-label)$/.test(n) ? `${n}=${(el.getAttribute(n) || '').replace(/\d{6,}/g, '#').slice(0, 40)}` : n).join(',');
      const kids = [...el.children].slice(0, 12).map((k) => skel(k, depth + 1)).filter(Boolean);
      return '  '.repeat(depth) + el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (attrs ? `[${attrs}]` : '') + '\n' + kids.join('');
    };
    const sel = { classicPost: POST_SEL, classicComment: COMMENT_SEL, rcPost: '[data-rc-post]', rcComment: '[data-rc-comment]', dataUrn: '[data-urn]', viewName: '[data-view-name]', editors: '[contenteditable="true"]' };
    const counts = Object.fromEntries(Object.entries(sel).map(([k, s]) => [k, document.querySelectorAll(s).length]));
    const views = {};
    document.querySelectorAll('[data-view-name]').forEach((e) => { const v = e.getAttribute('data-view-name'); views[v] = (views[v] || 0) + 1; });
    const labels = {};
    btns(document).forEach((b) => { const v = label(b).slice(0, 24); if (v) labels[v] = (labels[v] || 0) + 1; });
    const sample = document.querySelector('[data-rc-post]') || document.querySelector(POST_SEL) ||
      [...document.querySelectorAll('[role="listitem"]')].find((x) => count(x, RE_COMMENT_BTN)) || document.querySelector('main');
    return `Reply Copilot LinkedIn 诊断 ${new Date().toISOString()} ${location.pathname}\n` +
      JSON.stringify({ counts, views: Object.entries(views).sort((a, b) => b[1] - a[1]).slice(0, 25), buttons: Object.entries(labels).sort((a, b) => b[1] - a[1]).slice(0, 30) }) +
      '\n--- 结构 ---\n' + skel(sample, 0).slice(0, 12000);
  };

  // 顶部导航栏的头像 alt 就是你的名字
  const detectSelf = () => {
    const img = document.querySelector('img.global-nav__me-photo, nav img[alt][class*="me-photo"], header img[alt][class*="me"]') ||
      [...document.querySelectorAll('header button img[alt], nav button img[alt], header a img[alt]')].find((i) => /^(me|我)(?![a-z])/i.test(i.closest('button, a')?.textContent?.trim() || i.closest('button, a')?.getAttribute('aria-label') || ''));
    const alt = img?.getAttribute('alt') || '';
    const name = alt.replace(/^(Photo of|照片：|.*的照片$)/i, '').trim();
    if (name) RC.reportSelf('linkedin', name);
    return !!name;
  };
  if (!detectSelf()) RC.waitFor(detectSelf, 15000, 1000);

  // ---------- 填入 ----------
  RC.submitLabel = 'Post / Comment / 发布';
  // 只认评论框里的提交按钮，避免把「Reply」操作按钮误当成发送
  RC.isSubmit = (n) => n.matches?.('button.comments-comment-box__submit-button, button.comments-comment-box__submit-button--cr, button[class*="comments-comment-box__submit"]') ||
    (n.matches?.('button[type="submit"]') && !!n.closest?.('.comments-comment-box__form, form[class*="comment"]')) ||
    // 样式名被混淆时：表单里文字是「发布 / 评论 / 回复」的提交按钮
    (n.matches?.('button') && !!n.closest?.('form') && /^(post|comment|reply|发布|评论|回复|发表)$/i.test(textOf(n)) && !!n.closest('form').querySelector('[contenteditable="true"]'));

  // 新打开的帖子页：地址里有这条帖子的 id 就接手待填入的草稿
  RC.matchesPending = (item) => {
    const n = item.url.match(/urn:li:(?:activity|ugcPost|share):(\d+)/)?.[1];
    return !!n && (decodedUrl().includes(n) || location.pathname.includes(n));
  };

  // 信息流里经常已经有这条内容：后台会先问一下当前打开的 LinkedIn 页面
  const findPost = (n) => [...document.querySelectorAll(POST_SEL)].find((p) => !p.closest(COMMENT_SEL) && postUrn(p)?.num === n);
  const findComment = (cid) => [...document.querySelectorAll(COMMENT_SEL)].find((c) => commentIds(c)?.comment === cid);
  const findBox = (item) => [...document.querySelectorAll(item.kind === 'comment' ? '[data-rc-comment]' : '[data-rc-post]')]
    .find((b) => (item.kind === 'comment' ? heuristicComment(b) : heuristicPost(b))?.id === item.id);
  const findAny = (item) => (item.kind === 'comment' ? findComment(item.id.replace(/^li_c_/, '')) : findPost(item.id.replace(/^li_/, ''))) || findBox(item);
  RC.hasItem = (item) => !!findAny(item);

  const visibleEditor = (root) => [...root.querySelectorAll(EDITOR_SEL)].filter((e) => e.getClientRects().length).pop() || null;

  // 楼中楼回复时 LinkedIn 会自动在框里放一个「@某人」，保留它，把草稿接在后面
  function appendText(el, text) {
    const cur = RC.readEditor(el);
    if (!cur) return RC.fillOnce(el, text);
    if (cur.replace(/\s+/g, ' ').includes(text.replace(/\s+/g, ' ').slice(0, 40))) return true;
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    return document.execCommand('insertText', false, ' ' + text) || RC.insertText(el, cur + ' ' + text);
  }

  RC.fill = async (item, text) => {
    let ed = null;
    if (item.kind === 'comment') {
      const el = await RC.waitFor(() => findAny(item));
      if (!el) throw new Error('页面上没找到这条评论');
      el.scrollIntoView({ block: 'center' });
      const own = btns(el).filter((b) => (b.closest(COMMENT_SEL) || b.closest('[data-rc-comment]')) === el);
      const reply = own.find((b) => b.matches('.comments-comment-social-bar__reply-action-button, [class*="reply-action"]') || RE_REPLY_BTN.test(label(b)));
      reply?.click();
      ed = await RC.waitFor(() => visibleEditor(el) || visibleEditor(el.parentElement || document));
      if (!ed) return false;
      appendText(ed, text);
    } else {
      const post = await RC.waitFor(() => findAny(item));
      if (!post) throw new Error('页面上没找到这条帖子');
      post.scrollIntoView({ block: 'center' });
      ed = visibleEditor(post);
      if (!ed) {
        btns(post).find((b) => RE_COMMENT_BTN.test(label(b)))?.click();
        ed = await RC.waitFor(() => visibleEditor(post));
      }
      if (!ed) return false;
      RC.fillOnce(ed, text);
    }
    RC.armSubmitWatch({ itemId: item.id, draftText: text, getEditor: () => ed, isSubmit: RC.isSubmit });
    RC.toast('草稿已填入评论框。检查或修改后，请你自己点「发布 / Post」。', 6000);
    return true;
  };

  // ---------- 发帖（侧边栏「发帖」打开的分享框） ----------
  RC.postButtonLabel = 'Post / 发布';
  RC.composeEditor = () => {
    const box = document.querySelector('.share-creation-state__text-editor .ql-editor, .share-box .ql-editor') ||
      [...document.querySelectorAll('[role="dialog"] [contenteditable="true"]')].find((e) => e.getClientRects().length);
    return box || null;
  };
  RC.isPostSubmit = (n) => n.matches?.('button.share-actions__primary-action') ||
    (n.matches?.('button') && !!n.closest?.('[role="dialog"]') && /^(post|发布|发帖)$/i.test(textOf(n)));
})();
