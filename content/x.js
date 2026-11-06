// X（Twitter）：读取你时间线 / 对话页上看到的推文和回复；按需把草稿填进回复框。
(() => {
  const RC = window.RC;
  if (!RC || RC.dead || RC.platformReady) return;
  RC.platformReady = true;

  function parseArticle(el) {
    const link = [...el.querySelectorAll('a[href*="/status/"]')].find((a) => a.querySelector('time'));
    const m = link?.getAttribute('href')?.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!m) return null;
    const textEl = el.querySelector('[data-testid="tweetText"]');
    return {
      statusId: m[2],
      handle: m[1],
      text: RC.clip(textEl?.innerText || ''),
      lang: textEl?.getAttribute('lang') || '',
      time: Date.parse(link.querySelector('time')?.getAttribute('datetime') || '') || 0,
      engagement: parseEngagement(el),
      isReplyTo: [...el.querySelectorAll('div, span')].find((d) => /^Replying to|^回复/.test(d.innerText || ''))?.innerText || ''
    };
  }

  // 操作栏的 aria-label 形如 "12 replies, 3 reposts, 45 likes, 2345 views"（中文界面：回复 / 喜欢 / 查看）。
  function parseEngagement(el) {
    const label = el.querySelector('[role="group"][aria-label]')?.getAttribute('aria-label') || '';
    const pick = (re) => {
      const m = label.match(re);
      return m ? Number(m[1].replace(/[,，]/g, '')) : null;
    };
    return {
      up: pick(/([\d,]+)\s*(?:likes?|个?喜欢|次喜欢)/i),
      comments: pick(/([\d,]+)\s*(?:repl(?:y|ies)|条?回复)/i),
      views: pick(/([\d,]+)\s*(?:views?|次?查看|次?观看)/i)
    };
  }

  const isAd = (el) => !!el.querySelector('[data-testid="placementTracking"]') ||
    [...el.querySelectorAll('span')].some((s) => /^(Ad|Promoted|广告|推广)$/.test(s.textContent.trim()));

  function focalId() {
    return location.pathname.match(/\/status\/(\d+)/)?.[1] || null;
  }

  function extract(el) {
    if (isAd(el)) return null;
    const t = parseArticle(el);
    if (!t || !t.text) return null;
    const focal = focalId();
    let kind = t.isReplyTo ? 'comment' : 'post';
    let context = null;
    let parentId = '';
    if (focal) {
      // 对话页：页面上在它之前的推文就是它的上文（原帖 → … → 父回复）。
      const arts = [...document.querySelectorAll('article[data-testid="tweet"]')];
      const idx = arts.indexOf(el);
      const before = arts.slice(0, Math.max(idx, 0)).map(parseArticle).filter(Boolean);
      const focalIdx = before.findIndex((b) => b.statusId === focal);
      // 焦点推文下方的回复，其上文 = 焦点推文之前的链 + 焦点推文本身
      const chain = focalIdx >= 0 ? before.slice(0, focalIdx + 1) : before;
      if (chain.length) {
        kind = 'comment';
        parentId = 'x_' + chain[chain.length - 1].statusId;
        const root = chain[0];
        context = {
          rootTitle: '',
          rootText: root.text,
          rootAuthor: '@' + root.handle,
          parents: chain.slice(1).slice(-6).map((c) => ({ author: '@' + c.handle, text: c.text }))
        };
      }
    }
    return {
      id: 'x_' + t.statusId,
      platform: 'x',
      kind,
      url: `https://x.com/${t.handle}/status/${t.statusId}`,
      title: '',
      text: t.text,
      author: t.handle,
      community: '',
      lang: t.lang,
      createdAt: t.time,
      engagement: t.engagement,
      parentId,
      context: context || (t.isReplyTo ? { rootTitle: '', rootText: '', rootAuthor: '', parents: [], replyingTo: t.isReplyTo } : null)
    };
  }

  RC.observe('article[data-testid="tweet"]', extract);

  // 左侧导航栏的「个人资料」链接就是你自己的账号。
  const detectSelf = () => {
    const href = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href');
    const h = href?.match(/^\/([A-Za-z0-9_]{1,15})$/)?.[1];
    if (h) RC.reportSelf('x', h);
    return !!h;
  };
  if (!detectSelf()) RC.waitFor(detectSelf, 15000, 1000);

  RC.submitLabel = 'Reply / 回复';
  RC.isSubmit = (n) => n.matches?.('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]');

  RC.fill = async (item, text) => {
    const statusId = item.id.replace(/^x_/, '');
    const article = await RC.waitFor(() =>
      [...document.querySelectorAll('article[data-testid="tweet"]')].find((a) =>
        [...a.querySelectorAll('a[href*="/status/"]')].some((l) => l.getAttribute('href').endsWith('/status/' + statusId) && l.querySelector('time'))
      )
    );
    let ed = null;
    if (focalId() === statusId) {
      ed = await RC.waitFor(() => document.querySelector('[data-testid="tweetTextarea_0"]'), 4000);
    }
    if (!ed) {
      if (!article) throw new Error('页面上没找到这条推文');
      article.querySelector('[data-testid="reply"]')?.click();
      ed = await RC.waitFor(() => document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"]'));
    }
    if (!ed) throw new Error('没能打开回复框');
    const target = ed.matches('[contenteditable="true"]') ? ed : ed.querySelector('[contenteditable="true"]') || ed;
    RC.fillOnce(target, text);
    RC.armSubmitWatch({ itemId: item.id, draftText: text, getEditor: () => target, isSubmit: RC.isSubmit });
    RC.toast('草稿已填入回复框。检查或修改后，请你自己点「Reply / 回复」发送。', 6000);
    return true;
  };

  // ---------- 发帖（侧边栏「发帖」打开的发帖页） ----------
  RC.postButtonLabel = 'Post / 发帖';
  RC.composeEditor = () => [...document.querySelectorAll('[data-testid="tweetTextarea_0"]')].find((e) => e.isContentEditable && e.getClientRects().length) || null;
  RC.isPostSubmit = (n) => n.matches?.('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
})();
