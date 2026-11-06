// 默认设置。所有值都可以在侧边栏「设置」里修改。
export const DEFAULT_SETTINGS = {
  apiKey: '',
  // 只选一个模型商，全套都用它；models 里是可选的自定义模型名（留空用默认）
  provider: 'anthropic',
  openaiKey: '',
  deepseekKey: '',
  models: {},
  // 兴趣、关键词、子版块默认留空或给通用示例：首次安装的引导里用一段自我介绍让 AI 帮你填，
  // 也可以从「设置 → 数据 → 导入配置」导入自己的配置文件。
  // 兴趣描述里「1. xxx：…」这样编号的每一行，会成为一个话题分类。
  interests:
    '1. 示例话题 A：在这里写你关心的领域，越具体越好\n' +
    '2. 示例话题 B：……\n' +
    '不感兴趣：纯融资八卦、股价讨论、求职帖',
  keywords: [],
  subreddits: [],
  keywordPrefilter: true,
  negativeKeywords: [
    'hiring', "we're hiring", 'job opening', 'giveaway', 'airdrop', 'crypto', 'nft', 'memecoin', 'stock price',
    'meme', 'shitpost', 'promo code', 'discount', 'referral', '招聘', '内推', '股价', '抽奖', '优惠码'
  ],
  minLocalScore: 2,
  maxAgeHours: 72,
  maxScoredPerDay: 300,
  scoreThreshold: 60,
  retention: { pendingDays: 7, sentDays: 90, libraryDays: 30 },
  feedEnabled: true,
  feedIntervalMin: 45,
  caps: { reddit: 15, x: 20, linkedin: 15 },
  // LinkedIn 风控最严：间隔单独设置，默认更长
  linkedinCooldownMinMin: 10,
  linkedinCooldownMaxMin: 25,
  // 重点关注名单：这些人发的内容优先推送
  watchlist: [],
  watchNotify: true,
  cooldownMinMin: 3,
  cooldownMaxMin: 9,
  paused: false,
  redditUsername: '',
  xHandle: '',
  linkedinName: '',
  // 「我来写」默认翻译成的语种：en / zh / ja …，auto = 跟原帖一致
  translateTarget: 'en',
  // 翻译页默认勾选的语种（可多选）
  translateTargets: ['en'],
  // 你的母语：和你讨论、给你看对照时用；最终发出去的内容用目标语言
  myLang: 'zh',
  // 从使用中学习你的观点（提炼成候选，你确认后写进「观点与立场」）
  learnViews: true,
  // Hacker News：浏览时读取 + 按关键词拉新帖（只发现、解读和讨论，不代写）
  hnEnabled: true,
  hnUser: '',
  hnKeywords: []
};

export const SETTINGS_VERSION = 8;

export const DEFAULT_VIEWPOINTS = '';

export const DEFAULT_STYLE = {
  profile: '',
  // 各平台单独的语气说明（观点库共用）
  platformTone: {
    linkedin: '专业、真诚，比 X 和 Reddit 写得更完整：一般 3-6 句，结构是「一个明确观点 + 一个具体经验、案例或数据 + 一个开放问题邀请讨论」。用第一人称讲行业判断，少用网络梗和缩写，不堆话题标签（最多 1-2 个），不写空洞的祝贺和客套。'
  },
  viewpoints: DEFAULT_VIEWPOINTS,
  profileUpdatedAt: 0,
  samples: [],
  // 你自己写的原文 → 译文 → 你的定稿，用来学习你希望被怎么翻译
  translations: [],
  edits: [],
  sinceUpdate: 0
};

// 公司背景维度：塑造回复的视角，而不是广告位。默认关闭，在「风格 → 公司背景」里填。
export const DEFAULT_COMPANY = {
  enabled: false,
  name: '',
  aliases: '',
  role: '',
  background: '',
  disclose: true,
  mentionEvery: 5
};

// 关联引用：把之前收藏的相关帖子带进新回复（链接 / 点名作者 / 引用原文）。
export const DEFAULT_LINKING = {
  enabled: false,
  autoSaveValue: 85,
  includeLink: true,
  includeQuote: true,
  includeMention: false,
  maxUsesPerPost: 2,
  mentionCooldownDays: 7
};
