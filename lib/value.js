// 价值分：在「相关度」之外，再看新鲜度、热度和「现在回复还来得及被看到」的机会。
export const CATEGORIES = ['个人助理', '端侧感知与隐私', 'AI产品与商业', 'AI Agent', '端侧设备', 'AI芯片', '语音', 'AI与组织', '其他'];

export function valueOf(p) {
  if (p.score == null) return null;
  let v = p.score;
  const ageH = (Date.now() - (p.createdAt || p.seenAt || Date.now())) / 3.6e6;
  if (ageH < 3) v += 8;
  else if (ageH < 12) v += 4;
  else if (ageH > 72) v -= 12;
  else if (ageH > 36) v -= 6;
  const e = p.engagement || {};
  if (e.up != null) v += Math.min(10, Math.log10(Math.max(0, e.up) + 1) * 4);
  if (e.views != null) v += Math.min(6, Math.log10(Math.max(0, e.views) + 1) * 1.5);
  // 评论还不多 = 你的回复更容易排在前面被看到；已经几百条就很难被看到了。
  if (e.comments != null) v += e.comments < 10 ? 5 : e.comments > 200 ? -6 : 0;
  if (p.hook) v += 4;
  if (p.replyToMe || p.onMyPost) v += 15;
  if (p.watched) v += 12;
  return Math.max(0, Math.min(100, Math.round(v)));
}

export function tierOf(v) {
  if (v == null) return '';
  return v >= 85 ? 'S' : v >= 70 ? 'A' : 'B';
}
