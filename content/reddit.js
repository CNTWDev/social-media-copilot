// Reddit：读取你看到的帖子和评论；按需把草稿填进回复框。
(() => {
  const RC = window.RC;
  if (!RC || RC.dead || RC.platformReady) return;
  RC.platformReady = true;
  const OLD = location.hostname.startsWith('old.');
  const num = (v) => (v == null || v === '' ? null : Number(String(v).replace(/[^\d.-]/g, '')) || 0);
  const abs = (p) => (p ? new URL(p, location.origin).href.replace('old.reddit.com', 'www.reddit.com') : location.href);

  // ---------- 新版 Reddit（shreddit） ----------
  function rootPostInfo() {
    const p = document.querySelector('shreddit-post');
    if (!p) return null;
    return {
      id: p.getAttribute('id'),
      title: p.getAttribute('post-title') || '',
      text: RC.clip(p.querySelector('[slot="text-body"]')?.innerText || '', 2500),
      author: p.getAttribute('author') || ''
    };
  }

  function extractPost(el) {
    const id = el.getAttribute('id');
    if (!id || el.getAttribute('promoted') !== null) return null;
    return {
      id,
      platform: 'reddit',
      kind: 'post',
      url: abs(el.getAttribute('permalink')),
      title: el.getAttribute('post-title') || '',
      text: RC.clip(el.querySelector('[slot="text-body"]')?.innerText || ''),
      author: el.getAttribute('author') || '',
      community: el.getAttribute('subreddit-prefixed-name') || '',
      createdAt: Date.parse(el.getAttribute('created-timestamp') || '') || 0,
      engagement: { up: num(el.getAttribute('score')), comments: num(el.getAttribute('comment-count')) },
      context: null
    };
  }

  const commentText = (el) => {
    const body = [...el.children].find((c) => c.getAttribute('slot') === 'comment');
    return RC.clip(body?.innerText || '');
  };

  function extractComment(el) {
    const id = el.getAttribute('thingid');
    const text = commentText(el);
    if (!id || !text) return null;
    const parents = [];
    let cur = el.parentElement?.closest('shreddit-comment');
    while (cur && parents.length < 6) {
      parents.unshift({ author: cur.getAttribute('author') || '', text: RC.clip(commentText(cur), 800) });
      cur = cur.parentElement?.closest('shreddit-comment');
    }
    const root = rootPostInfo();
    const sub = document.querySelector('shreddit-post')?.getAttribute('subreddit-prefixed-name') || '';
    const parentEl = el.parentElement?.closest('shreddit-comment');
    return {
      id,
      parentId: el.getAttribute('parentid') || parentEl?.getAttribute('thingid') || root?.id || '',
      platform: 'reddit',
      kind: 'comment',
      url: abs(el.getAttribute('permalink')),
      title: root?.title || '',
      text,
      author: el.getAttribute('author') || '',
      community: sub,
      createdAt: Date.parse(el.querySelector('time')?.getAttribute('datetime') || '') || 0,
      engagement: { up: num(el.getAttribute('score')), comments: el.querySelectorAll('shreddit-comment').length },
      context: { rootTitle: root?.title || '', rootText: root?.text || '', rootAuthor: root?.author || '', parents }
    };
  }

  // ---------- 旧版 Reddit ----------
  function extractOld(el) {
    const id = el.getAttribute('data-fullname');
    if (!id || el.classList.contains('promoted')) return null;
    const isComment = el.classList.contains('comment');
    const body = el.querySelector(':scope > .entry .usertext-body .md');
    const linkThing = document.querySelector('#siteTable .thing.link');
    const base = {
      id,
      platform: 'reddit',
      url: abs(el.getAttribute('data-permalink')),
      author: el.getAttribute('data-author') || '',
      community: 'r/' + (el.getAttribute('data-subreddit') || ''),
      createdAt: Number(el.getAttribute('data-timestamp')) || 0,
      engagement: { up: num(el.getAttribute('data-score')), comments: num(el.getAttribute('data-comments-count')) }
    };
    if (!isComment) {
      return { ...base, kind: 'post', title: el.querySelector('a.title')?.innerText || '', text: RC.clip(body?.innerText || ''), context: null };
    }
    const parents = [];
    let cur = el.parentElement?.closest('.thing.comment');
    while (cur && parents.length < 6) {
      parents.unshift({
        author: cur.getAttribute('data-author') || '',
        text: RC.clip(cur.querySelector(':scope > .entry .usertext-body .md')?.innerText || '', 800)
      });
      cur = cur.parentElement?.closest('.thing.comment');
    }
    const rootTitle = linkThing?.querySelector('a.title')?.innerText || '';
    return {
      ...base,
      parentId: el.parentElement?.closest('.thing')?.getAttribute('data-fullname') || linkThing?.getAttribute('data-fullname') || '',
      kind: 'comment',
      title: rootTitle,
      text: RC.clip(body?.innerText || ''),
      context: {
        rootTitle,
        rootText: RC.clip(linkThing?.querySelector('.usertext-body .md')?.innerText || '', 2500),
        rootAuthor: linkThing?.getAttribute('data-author') || '',
        parents
      }
    };
  }

  // 识别当前登录的 Reddit 账号（新版页面头部 / 旧版右上角）。
  const detectSelf = () => {
    let name = '';
    if (OLD) name = document.querySelector('#header .user a')?.textContent?.trim() || '';
    else {
      const a = RC.deepQueryAll('a[href^="/user/"]').find((x) => /profile|个人资料/i.test(x.getAttribute('aria-label') || x.textContent || ''));
      name = a?.getAttribute('href')?.match(/^\/user\/([^/]+)/)?.[1] || document.querySelector('shreddit-app')?.getAttribute('user-name') || '';
    }
    if (name && !/^(login|register)$/i.test(name)) RC.reportSelf('reddit', name);
    return !!name;
  };
  if (!detectSelf()) RC.waitFor(detectSelf, 15000, 1500);

  if (OLD) {
    RC.observe('.thing.link, .thing.comment', extractOld);
  } else {
    RC.observe('shreddit-post', extractPost);
    RC.observe('shreddit-comment', extractComment);
  }

  // ---------- 填入回复框（不会替你点发送） ----------
  const textOf = (n) => (n.innerText || n.textContent || '').trim().toLowerCase();
  const editableIn = (root) =>
    RC.deepQueryAll('[contenteditable="true"], textarea', root).find((e) => e.offsetParent !== null || e.getClientRects().length);

  async function fillNew(item, text) {
    let scope = document;
    if (item.kind === 'comment') {
      const c = await RC.waitFor(() => document.querySelector(`shreddit-comment[thingid="${item.id}"]`));
      if (!c) throw new Error('页面上没找到这条评论');
      c.scrollIntoView({ block: 'center' });
      const row = [...c.querySelectorAll('shreddit-comment-action-row, [slot="actionRow"]')].find(
        (r) => r.closest('shreddit-comment') === c
      ) || c;
      const btn = RC.deepQueryAll('button', row).find((b) => /^(reply|回复)$/.test(textOf(b)) || /reply/i.test(b.getAttribute('aria-label') || ''));
      btn?.click();
      scope = c;
      const ed = await RC.waitFor(() => {
        const comp = [...c.querySelectorAll('shreddit-composer, comment-composer-host')].find((x) => x.closest('shreddit-comment') === c);
        return comp && editableIn(comp);
      });
      if (!ed) throw new Error('没能打开评论的回复框');
      return finish(item, text, ed, scope);
    }
    const host = await RC.waitFor(() => RC.deepQuery('comment-composer-host') || RC.deepQuery('shreddit-composer'));
    if (!host) throw new Error('没找到评论框');
    host.scrollIntoView({ block: 'center' });
    let ed = editableIn(host);
    if (!ed) {
      const trigger = RC.deepQueryAll('button, faceplate-textarea-input, [placeholder]', host)[0] || host;
      trigger.click();
      ed = await RC.waitFor(() => editableIn(RC.deepQuery('comment-composer-host') || RC.deepQuery('shreddit-composer') || document));
    }
    if (!ed) throw new Error('没能打开评论框');
    return finish(item, text, ed, host);
  }

  async function fillOld(item, text) {
    let ta;
    if (item.kind === 'comment') {
      const c = document.querySelector(`.thing[data-fullname="${item.id}"]`);
      if (!c) throw new Error('页面上没找到这条评论');
      c.scrollIntoView({ block: 'center' });
      [...c.querySelectorAll(':scope > .entry .buttons a')].find((a) => textOf(a) === 'reply')?.click();
      ta = await RC.waitFor(() => c.querySelector(':scope > .child form textarea[name="text"]'));
    } else {
      ta = document.querySelector('.commentarea > form textarea[name="text"]');
    }
    if (!ta) throw new Error('没找到回复框');
    return finish(item, text, ta, document);
  }

  function finish(item, text, ed, scope) {
    RC.fillOnce(ed, text);
    ed.scrollIntoView({ block: 'center' });
    RC.armSubmitWatch({ itemId: item.id, draftText: text, getEditor: () => ed, isSubmit: RC.isSubmit });
    RC.toast('草稿已填入回复框。检查或修改后，请你自己点「Comment / 评论」发送。', 6000);
    return true;
  }

  RC.submitLabel = 'Comment / 评论';
  RC.isSubmit = (n) => {
    if (OLD) return n.matches?.('button.save, .usertext-buttons button[type="submit"]');
    if (!(n.matches?.('button'))) return false;
    const t = textOf(n);
    return n.getAttribute('type') === 'submit' || n.getAttribute('slot') === 'submit-button' || t === 'comment' || t === 'reply' || t === '评论' || t === '回复';
  };

  RC.fill = (item, text) => (OLD ? fillOld(item, text) : fillNew(item, text));

  // ---------- 发帖（侧边栏「发帖」打开的发帖页） ----------
  RC.postButtonLabel = 'Post / 发帖';
  const visible = (e) => e && e.getClientRects().length;
  RC.composeTitle = () => (OLD ? document.querySelector('textarea[name="title"]') : RC.deepQueryAll('textarea[name="title"], faceplate-textarea-input[name="title"] textarea').find(visible)) || null;
  RC.composeEditor = () => (OLD ? document.querySelector('.submit textarea[name="text"], textarea[name="text"]')
    : RC.deepQueryAll('shreddit-composer [contenteditable="true"], [name="body"] [contenteditable="true"], div[contenteditable="true"][role="textbox"]').find(visible)) || null;
  RC.isPostSubmit = (n) => {
    if (OLD) return n.matches?.('.submit button[type="submit"], button[name="submit"]');
    if (!n.matches?.('button')) return false;
    return n.id === 'submit-post-button' || n.id === 'inner-post-submit-button' || /^(post|发帖|发布)$/i.test(textOf(n));
  };
})();
