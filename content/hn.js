// Hacker News：读取你看到的帖子和评论（只用于发现、解读和讨论；HN 规则不允许 AI 代写评论，所以这里不做填入）。
(() => {
  const RC = window.RC;
  if (!RC || RC.dead || RC.platformReady) return;
  RC.platformReady = true;
  const ITEM = (id) => `https://news.ycombinator.com/item?id=${id}`;
  const num = (s) => Number(String(s || '').replace(/[^\d]/g, '')) || 0;
  const ageOf = (el) => {
    const t = el?.getAttribute('title') || '';
    // title 形如 "2026-11-04T05:12:33 1762233153"
    const unix = t.split(' ')[1];
    return unix ? Number(unix) * 1000 : Date.parse(t.split(' ')[0] + 'Z') || 0;
  };

  // 列表页（首页、newest、show、ask）和帖子页顶部的帖子
  function extractStory(row) {
    const id = row.id;
    if (!id) return null;
    const a = row.querySelector('.titleline > a');
    if (!a) return null;
    const sub = row.nextElementSibling?.querySelector('.subtext') || document.querySelector('.fatitem .subtext');
    const fat = row.closest('.fatitem');
    const top = fat ? RC.clip(fat.querySelector('.toptext')?.innerText || '', 2500) : '';
    const site = row.querySelector('.sitestr')?.textContent || '';
    const link = a.getAttribute('href') || '';
    return {
      id: 'hn_' + id,
      platform: 'hn',
      kind: 'post',
      url: ITEM(id),
      title: a.textContent.trim(),
      text: top || (site ? `（链接：${site}）` : '') || (link.startsWith('item?') ? '' : link),
      author: sub?.querySelector('.hnuser')?.textContent || '',
      community: /^(Show|Ask|Launch) HN/i.test(a.textContent) ? a.textContent.match(/^(Show|Ask|Launch) HN/i)[0] : '',
      createdAt: ageOf(sub?.querySelector('.age')),
      engagement: { up: num(sub?.querySelector('.score')?.textContent), comments: num([...(sub?.querySelectorAll('a') || [])].pop()?.textContent) },
      context: null,
      extUrl: link.startsWith('http') ? link : ''
    };
  }

  const rootInfo = () => {
    const fat = document.querySelector('.fatitem');
    if (!fat) return null;
    return {
      id: fat.querySelector('tr.athing')?.id || '',
      title: fat.querySelector('.titleline > a')?.textContent?.trim() || '',
      text: RC.clip(fat.querySelector('.toptext')?.innerText || '', 2000),
      author: fat.querySelector('.hnuser')?.textContent || ''
    };
  };
  const indentOf = (row) => Number(row.querySelector('td.ind')?.getAttribute('indent') || 0);
  const textOf = (row) => RC.clip(row.querySelector('.commtext')?.innerText || '');

  function extractComment(row) {
    const id = row.id;
    const text = textOf(row);
    if (!id || !text) return null;
    // 往上找缩进更小的行，就是楼上的评论
    const parents = [];
    let level = indentOf(row);
    let parentId = '';
    for (let r = row.previousElementSibling; r && level > 0 && parents.length < 6; r = r.previousElementSibling) {
      if (!r.classList.contains('comtr')) continue;
      const lv = indentOf(r);
      if (lv < level) {
        if (!parentId) parentId = 'hn_' + r.id;
        parents.unshift({ author: r.querySelector('.hnuser')?.textContent || '', text: RC.clip(textOf(r), 800) });
        level = lv;
      }
    }
    const root = rootInfo();
    if (!parentId && root?.id) parentId = 'hn_' + root.id;
    return {
      id: 'hn_' + id,
      parentId,
      platform: 'hn',
      kind: 'comment',
      url: ITEM(id),
      title: root?.title || '',
      text,
      author: row.querySelector('.hnuser')?.textContent || '',
      community: '',
      createdAt: ageOf(row.querySelector('.age')),
      engagement: { up: 0, comments: 0 },
      context: { rootTitle: root?.title || '', rootText: root?.text || '', rootAuthor: root?.author || '', parents }
    };
  }

  const me = document.querySelector('a#me')?.textContent?.trim();
  if (me) RC.reportSelf('hn', me);

  RC.observe('tr.athing.submission, .fatitem tr.athing', extractStory);
  RC.observe('tr.athing.comtr', extractComment);

  RC.hasItem = (item) => !!document.getElementById(String(item.id).replace(/^hn_/, ''));
  RC.fill = async () => { throw new Error('Hacker News 不允许 AI 生成或改写的评论，请自己写。'); };
  RC.probe = () => `hn stories=${document.querySelectorAll('tr.athing.submission').length} comments=${document.querySelectorAll('tr.athing.comtr').length} me=${me || '-'}`;
})();
