// 平台登记表：加一个平台只需要在这里加一项，再写一个内容脚本适配器。
export const PLATFORMS = {
  reddit: { name: 'Reddit', prefix: 'u/', selfKey: 'redditUsername' },
  x: { name: 'X', prefix: '@', selfKey: 'xHandle' },
  linkedin: { name: 'LinkedIn', prefix: '', selfKey: 'linkedinName' },
  // Hacker News 规则禁止 AI 生成或 AI 改写的评论：只发现、解读、讨论，不起草、不填入
  hn: { name: 'Hacker News', short: 'HN', prefix: '', selfKey: 'hnUser', noAI: true }
};
// 可以起草、填入、计入每日上限的平台
export const REPLY_KEYS = Object.keys(PLATFORMS).filter((k) => !PLATFORMS[k].noAI);
export const noAI = (p) => !!PLATFORMS[p]?.noAI;
export const PLATFORM_KEYS = Object.keys(PLATFORMS);
export const platName = (p) => PLATFORMS[p]?.name || (p === 'web' ? '网页' : p);
export const who = (p, author) => (author ? (PLATFORMS[p]?.prefix || '') + author : '');
export const platformOfId = (id) => (id.startsWith('x_') ? 'x' : id.startsWith('li_') ? 'linkedin' : id.startsWith('hn_') ? 'hn' : 'reddit');

// 名字比较：忽略大小写、前缀和多余空格
export const normName = (s = '') => s.toLowerCase().replace(/^(u\/|@)/, '').replace(/\s+/g, ' ').trim();

// 是不是你自己：LinkedIn 同时比对显示名和个人主页地址里的 id
export function isSelf(s, it) {
  const me = normName(s[PLATFORMS[it.platform]?.selfKey] || '');
  if (!me) return false;
  return normName(it.author) === me || (!!it.authorId && normName(it.authorId) === me);
}

// 重点关注名单：每行一个人，可以写名字、@账号、u/用户名或主页链接
export function watchKeys(list = []) {
  return list.map((x) => {
    const t = x.trim();
    const m = t.match(/linkedin\.com\/(?:in|company)\/([^/?#]+)/i) || t.match(/(?:x|twitter)\.com\/([^/?#]+)/i) || t.match(/reddit\.com\/u(?:ser)?\/([^/?#]+)/i);
    return normName(m ? decodeURIComponent(m[1]) : t);
  }).filter(Boolean);
}
export function isWatched(s, it) {
  const keys = watchKeys(s.watchlist);
  if (!keys.length) return false;
  const a = normName(it.author), b = normName(it.authorId || '');
  return keys.some((k) => k === a || (b && k === b));
}
