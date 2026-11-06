// 本地预筛：不花 Token 的规则打分，只把真正可能有价值的内容交给模型。
export function localScore(s, it) {
  const hay = (x) => (x || '').toLowerCase();
  const title = hay(it.title || it.context?.rootTitle);
  const body = hay(it.text);
  const all = title + ' ' + body;

  // 1. 排除词：命中直接丢弃
  if (s.negativeKeywords.some((k) => k && all.includes(k.toLowerCase()))) return { pass: false, why: 'negative' };

  // 2. 太短 / 太旧
  const len = (it.title || '').length + (it.text || '').length;
  if (len < (it.kind === 'comment' ? 30 : 40)) return { pass: false, why: 'short' };
  if (it.kind === 'post' && it.createdAt && Date.now() - it.createdAt > s.maxAgeHours * 3.6e6) return { pass: false, why: 'old' };

  // 3. 关键词加权：标题命中 2 分，正文命中 1 分（同一个词只算一次）
  let score = 0;
  for (const k of s.keywords) {
    const kk = k.toLowerCase();
    if (!kk) continue;
    if (title.includes(kk)) score += 2;
    else if (body.includes(kk)) score += 1;
  }
  score = Math.min(score, 8);
  // 4. 来自关注的子版块 +1；有人互动 +1；已经几百条评论的大楼 -1（回了也很难被看到）
  const sub = (it.community || '').replace(/^r\//i, '').toLowerCase();
  if (it.platform === 'reddit' && s.subreddits.some((x) => x.toLowerCase() === sub)) score += 1;
  const e = it.engagement || {};
  if ((e.up || 0) >= 20 || (e.views || 0) >= 5000) score += 1;
  if ((e.comments || 0) > 300) score -= 1;

  if (!s.keywordPrefilter) return { pass: true, score };
  return score >= s.minLocalScore ? { pass: true, score } : { pass: false, why: 'lowLocal', score };
}
