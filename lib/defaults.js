// 默认设置。所有值都可以在侧边栏「设置」里修改。
export const DEFAULT_SETTINGS = {
  apiKey: '',
  // 只选一个模型商，全套都用它；models 里是可选的自定义模型名（留空用默认）
  provider: 'anthropic',
  openaiKey: '',
  deepseekKey: '',
  models: {},
  interests:
    '1. Personal Assistant（最关注）：个人助理 / AI 助手产品、垂直行业的专业助理、用户上下文（context）构建、长期记忆、个性化、数字分身\n' +
    '2. 端侧感知与隐私：语音 / 视觉 / 操作行为的持续感知、用户习惯与兴趣建模、数据不出端、隐私保护、低功耗长待机\n' +
    '3. AI 产品与商业模式：C 端 AI 产品方向、AI 原生的新场景 / 新功能、数据与用户理解形成的护城河、AI 产品的溢价与付费意愿\n' +
    '4. AI Agent：智能体、工具调用、MCP、多智能体协作、Agent 框架、手机 / 电脑上的操作型 Agent（GUI Agent）\n' +
    '5. Edge Device：端侧 AI、本地运行大模型、手机端推理、AI 手机 / AI PC、可穿戴设备（AI 眼镜、耳机、手表）\n' +
    '6. Chipset AI：NPU、AI 芯片与 SoC、推理加速、量化与模型压缩、能效比\n' +
    '7. Audio：语音识别 ASR、TTS 语音合成、语音翻译 / 同传、语音交互、全双工语音对话\n' +
    '8. AI 与组织管理：AI 原生公司、小团队 / 一人公司、人机协作、人如何驾驭和指导 AI、未来工作方式、人才能力模型的变化\n' +
    '不感兴趣：纯融资八卦、股价讨论、AI 绘画 / 视频生成、求职帖',
  keywords: [
    'assistant', 'personal ai', 'agent', 'agentic', 'mcp', 'tool use', 'computer use', 'context', 'memory',
    'personalization', 'personalized', 'digital twin', 'privacy', 'on-device', 'on device', 'edge ai', 'local llm',
    'llama.cpp', 'gguf', 'ollama', 'mlx', 'npu', 'chipset', 'soc', 'snapdragon', 'qualcomm', 'mediatek',
    'apple silicon', 'quantiz', 'low power', 'battery', 'wearable', 'smart glasses', 'earbuds', 'ai phone', 'ai pc',
    'asr', 'speech', 'whisper', 'tts', 'voice', 'realtime', 'translation', 'interpreter',
    'moat', 'business model', 'consumer ai', 'killer app', 'wrapper', 'pmf', 'product-market fit', 'user data',
    '个人助理', '助手', '智能体', '记忆', '个性化', '数字分身', '隐私', '端侧', '本地部署', '芯片', '量化', '功耗',
    '可穿戴', '语音', '同传', '翻译', '护城河', '商业模式', 'c端', '产品形态',
    'ai native', 'ai-native', 'small team', 'future of work', 'one-person company', '一人公司', '人机协作', 'ai 原生'
  ],
  subreddits: [
    'AI_Agents', 'LocalLLaMA', 'LocalLLM', 'LLMDevs', 'MachineLearning', 'artificial', 'ArtificialInteligence',
    'singularity', 'speechtech', 'OpenAI', 'ClaudeAI', 'startups'
  ],
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
  hnKeywords: ['on-device AI', 'local LLM', 'AI agent', 'personal assistant', 'speech recognition', 'text-to-speech', 'voice AI', 'NPU', 'edge AI', 'llama.cpp', 'AI wearable', 'AI native company']
};

export const SETTINGS_VERSION = 7;

export const ORG_VIEWPOINTS = `【AI 时代的组织与管理】
- 公司人员规模越大不见得是正向资产，未来的公司会越来越小、越来越精。
- 理论上，所有执行类工作 AI 都有机会做得更好。
- 中长期看，token 的单位成本效率会远高于人力。人与 AI 的关系不再只是「用好 AI」，而是驾驭和指导 AI：人定目标、做判断、做审视，执行交给 AI。
- 这不是岗位之间的简单替换，而是生产关系的调整：角色在变化，人才能力模型在迁移和升级。`;

// v3 的默认观点原文：迁移时用来判断用户有没有改过。
export const V3_VIEWPOINTS = `【个人助理】
- 个人助理会出现在各行各业，每个领域都会有很专业的个人助理；但决定谁胜出的，是谁更懂用户、越用越被喜欢、越来越像用户的「数字分身」。
- 懂用户的底层是用户 context（上下文）的构建：持续积累关于用户的数据和常识。
- 这依赖端侧的持续感知能力：语音感知、视觉感知、操作感知，以及爱好、生活习惯、每天关注的点。我更看重 context、记忆、个性化、端侧感知这条主线，而不是单纯拼模型参数。

【端侧与隐私】
- 端侧更安全：数据不出端，隐私有保障；低功耗、长待机同样关键。

【C 端 AI 产品与商业模式】
- C 端 AI 产品不应该只是替代过去的互联网产品，而是要在数据上做增量、在场景上做增量，做过去做不到的功能，这样才能贴合用户刚需，做出有更高溢价的好产品。
- 真正的护城河可能不在 C 端产品本身，也不在软件开发上，而在各自对用户的理解；理解的底层本质是数据。`;

export const DEFAULT_VIEWPOINTS = `我的核心观点（回复时自然体现，不必每条都提）：

【个人助理与端侧】
- 个人助理会出现在各行各业，每个领域都会有专业的个人助理；但决定谁胜出的，是谁更懂用户、越来越像用户的「数字分身」。
- 懂用户的关键是 context（用户上下文）的构建：持续积累用户的数据和常识。
- 这依赖端侧的持续感知能力：语音感知、视觉感知、操作感知，以及爱好、生活习惯、每天关注的点。
- 端侧更安全：数据不出端，隐私有保障；低功耗、长待机同样关键。
- 我更关注 context、记忆、个性化、端侧感知这条主线，而不是单纯拼模型参数。

【C 端 AI 产品与商业模式】
- C 端 AI 产品不应该只是替代过去的互联网产品，而是要在数据上做增量、在场景上做增量，做过去做不到的功能，这样才能贴合用户刚需，做出有更高溢价的好产品。
- 真正的护城河可能不在 C 端产品本身，也不在软件开发上，而在各自对用户的理解；理解的底层本质是数据。

${ORG_VIEWPOINTS}`;

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

// 公司背景维度：塑造回复的视角，而不是广告位。
// 默认资料来自 VoxNexus 2026-10-23 的公开新闻稿（公司自述数据），请按实际情况修改。
export const DEFAULT_COMPANY = {
  enabled: true,
  name: 'VoxNexus',
  aliases: 'Vox Nexus, VoxSense, VoxEdge',
  role: '',
  background: `VoxNexus（总部新加坡，官网 voxnexus.ai）做端侧语音 AI，提供芯片级低功耗、隐私安全的方案。
- VoxSense：端侧常开（always-on）环境语音感知，连续监听 12 小时约耗电 162 mAh（约为 6500 mAh 手机电池的 2.5%）；音频全部在设备上处理，不上传云端。
- VoxEdge：Android 上的离线语音栈，语音识别 36 种语言、翻译 103 种语言、语音合成 45 种语言，低成本 Android 手机也能跑。
- 语音识别模型最小约 6500 万参数，公司称词错率低于约 10 倍大小的开源模型；本地推理无云端 token 费用、无需流量。
- 2026 年 10 月在联发科天玑 9600 发布会（马德里）上亮相；以 License + SDK 方式提供给开发者和设备厂商。`,
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
