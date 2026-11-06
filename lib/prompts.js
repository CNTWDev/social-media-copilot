import { detectLang, normLang } from './util.js';
import { categoriesOf } from './value.js';

// ---------- 兴趣打分 ----------
export const scoreSchema = (cats) => ({
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'score', 'category', 'topic', 'reason', 'hook'],
        properties: {
          id: { type: 'string' },
          score: { type: 'integer' },
          category: { type: 'string', enum: cats },
          topic: { type: 'string' },
          reason: { type: 'string' },
          hook: { type: 'string' }
        }
      }
    }
  }
});

export function scorePrompt(settings, items, style = {}, company = null) {
  const system =
    '你在帮一位用户筛选 Reddit、X、LinkedIn 和 Hacker News 上值得他参与讨论的内容。\n' +
    '他的兴趣领域：\n' + settings.interests + '\n\n' +
    (style.viewpoints ? '他的核心观点（用来判断他能不能贡献独到的看法）：\n' + style.viewpoints + '\n\n' : '') +
    (company?.enabled && company.background ? '他所在公司的背景（判断他能否以从业者身份给出有价值的信息）：\n' + company.background.slice(0, 600) + '\n\n' : '') +
    '对每条内容打 0-100 分，表示「他值得花时间回复这一条」的程度：\n' +
    '- 与兴趣领域直接相关、有实质技术或产品讨论、他能补充观点或经验的，给高分（70+）。\n' +
    '- 讨论正好触及他的核心观点，他能给出有区分度的看法的，额外加分（80+）。\n' +
    '- 评论/回复楼层同样评估：如果某条评论本身观点有意思、值得接话，也可以给高分，不必看原帖高低。\n' +
    '- 纯梗图、求职广告、低信息量吐槽、与兴趣无关、已经吵成一团的，给低分；LinkedIn 上的纯招聘、纯晋升 / 入职祝贺、纯活动广告也给低分。\n' +
    'category 从这些分类里选最贴切的一个：' + categoriesOf(settings.interests).join('、') + '；topic 用中文写 2-6 个字的具体话题标签，reason 用中文一句话说明理由（不超过 30 字）。\n' +
    'hook 用中文一句话写出他可以从哪个观点切入（不超过 30 字）；没有合适切入点就留空字符串。';
  const lines = items.map((it) => {
    const ctx = it.kind === 'comment' && it.context
      ? `\n  [所在讨论] ${it.context.rootTitle || ''} ${(it.context.rootText || '').slice(0, 300)}` +
        (it.context.parents?.length ? `\n  [上一层] ${it.context.parents.at(-1).text.slice(0, 300)}` : '')
      : '';
    return `<item id="${it.id}" platform="${it.platform}" kind="${it.kind}" community="${it.community || ''}"${it.authorHeadline ? ` author_headline="${it.authorHeadline.replace(/"/g, "'")}"` : ''}>\n` +
      `${it.title ? '标题：' + it.title + '\n' : ''}${(it.text || '').slice(0, 1200)}${ctx}\n</item>`;
  });
  return { system, user: '请为以下每条内容打分，results 里对每个 id 都要给出结果：\n\n' + lines.join('\n\n') };
}

// ---------- 起草回复 ----------
export const LANGS = { en: 'English', zh: '中文', ja: '日本語', ko: '한국어', es: 'Español', fr: 'Français', de: 'Deutsch', pt: 'Português' };

export const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestion', 'language', 'drafts'],
  properties: {
    suggestion: { type: 'string' },
    language: { type: 'string' },
    drafts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['angle', 'text', 'related_id', 'gloss'],
        properties: { angle: { type: 'string' }, text: { type: 'string' }, related_id: { type: 'string' }, gloss: { type: 'string' } }
      }
    }
  }
};

function pickExamples(style, item) {
  const lang = normLang(item.lang) || detectLang(item.text);
  const scored = style.samples.map((s, i) => ({
    s,
    w: (s.lang === lang ? 4 : 0) + (s.platform === item.platform ? 2 : 0) + (s.source === 'sent' ? 1 : 0) + i / 1000
  }));
  return scored.sort((a, b) => b.w - a.w).slice(0, 8).map((x) => x.s);
}

export function styleBlock(style, item) {
  const parts = [];
  if (style.profile) parts.push('<style_profile>\n' + style.profile + '\n</style_profile>');
  if (style.viewpoints) parts.push('<viewpoints>\n他的观点、立场与背景（回复时与之保持一致，但不要生硬地硬塞进去）：\n' + style.viewpoints + '\n</viewpoints>');
  const ex = pickExamples(style, item);
  if (ex.length) {
    parts.push('<past_replies>\n他过去亲自写的回复（模仿语气、长度、用词习惯，不要照抄内容）：\n' +
      ex.map((s) => `- [${s.platform}${s.context ? ' · ' + s.context.slice(0, 60) : ''}] ${s.text.slice(0, 500)}`).join('\n') +
      '\n</past_replies>');
  }
  const edits = style.edits.slice(-5);
  if (edits.length) {
    parts.push('<edits>\n他曾把 AI 草稿改成下面的样子，说明了他的偏好：\n' +
      edits.map((e) => `草稿：${e.draft.slice(0, 300)}\n他的定稿：${e.final.slice(0, 300)}`).join('\n---\n') +
      '\n</edits>');
  }
  return parts.join('\n\n');
}

function companyBlock(company, allowMention) {
  if (!company?.enabled || !company.background) return '';
  return '<company>\n他在 ' + company.name + (company.role ? ' 担任' + company.role : ' 工作') + '。公司背景：\n' + company.background + '\n</company>\n' +
    '公司背景的用法：\n' +
    '- 主要用来塑造他的视角和专业判断，像一个懂行的从业者在聊行业，而不是在推销。\n' +
    (allowMention
      ? '- 只有当讨论直接相关（比如有人正在找这类方案、讨论的问题正好是公司产品解决的）时，才可以在「其中一个」草稿里提到公司或产品，并给出具体事实；其余草稿不提公司。\n'
      : '- 他最近已经提过公司好几次了，这一条的所有草稿都不要提公司名或产品名，只输出观点（除非他在补充要求里明确要求提）。\n') +
    (company.disclose
      ? '- 只要提到 ' + company.name + ' 或其产品，必须在同一条回复里自然地写明利益相关，用回复的语言写，例如 "(disclosure: I work at ' + company.name + ')"、「（利益相关：我在 ' + company.name + ' 工作）」。这是平台规则要求，不能省略。\n'
      : '') +
    '- 不要贬低竞争对手，不要编造公司没有公开的数据。\n';
}

function relatedBlock(linking, related, item) {
  if (!linking?.enabled || !related?.length) return '';
  const fmt = item.platform === 'x'
    ? '在 X 上：贴链接即可（X 会自动显示成引用卡片），不要再粘贴原文；'
    : item.platform === 'linkedin'
      ? '在 LinkedIn 上：用一句话转述对方观点并贴链接，不要大段粘贴原文；'
      : '在 Reddit 上：可以用 > 引用原文中最关键的一句（不超过 40 个词），并注明出处；';
  return '<related_posts>\n他之前收藏的相关讨论（候选）：\n' +
    related.map((r) =>
      `<post id="${r.id}" platform="${r.platform}" author="${r.author}" url="${r.url}" can_mention="${r.canMention}">\n${r.title ? r.title + '\n' : ''}${r.text.slice(0, 500)}\n</post>`
    ).join('\n') + '\n</related_posts>\n' +
    '关联引用规则：\n' +
    '- 只有当某条候选和当前讨论「真正相关、能给读者增加信息」时才引用；不相关就不引用，宁缺毋滥。\n' +
    '- 最多只在 1 个草稿里引用 1 条，并在该草稿的 related_id 填上它的 id；其他草稿 related_id 填空字符串。\n' +
    (linking.includeLink ? '- 引用时附上原帖链接（url）。\n' : '- 不要贴链接。\n') +
    (linking.includeQuote ? '- ' + fmt + '\n' : '- 不要粘贴原文，用一句话概括对方的观点。\n') +
    (linking.includeMention
      ? '- 只有 can_mention="true" 的候选可以点名作者（X 用 @用户名，Reddit 用 u/用户名），而且要像自然地把人拉进讨论（「@xx 之前也聊过这个」），不要为了引流点名。\n'
      : '- 不要 @ 或 u/ 点名任何作者，可以说「之前有人讨论过」。\n') +
    '- 引用时要用自己的话把它和当前话题连起来，说明为什么相关。\n';
}

function toneBlock(style, item) {
  const tone = style.platformTone?.[item.platform];
  return tone ? `   这条在 ${item.platform === 'linkedin' ? 'LinkedIn' : item.platform} 上，语气要求：${tone}\n` : '';
}

export function draftPrompt(settings, style, item, { instruction, previous, recent = [], company, allowMention = true, linking, related, topic, own, lang } = {}) {
  const mine = LANGS[settings.myLang || 'zh'] || '中文';
  const system =
    '你在帮一位用户用他本人的口吻起草社交媒体回复，由他审核修改后亲自发送。\n' +
    '他关注的领域：\n' + settings.interests + '\n\n' +
    (styleBlock(style, item) || '（还没有风格档案：先写得自然、简洁、像一个懂行的真人。）') + '\n\n' +
    companyBlock(company, allowMention) + '\n' +
    relatedBlock(linking, related, item) + '\n' +
    '写作要求：\n' +
    (lang && LANGS[lang]
      ? `1. 回复用 ${LANGS[lang]} 写（他指定的），language 字段填写 ${lang}。\n`
      : '1. 回复语言必须和「要回复的那条内容」的语言一致（中文就用中文，英文就用英文，日文就用日文……），language 字段填写该语言代码。\n') +
    `   他是跨语言工作者，母语是${mine}：每个草稿的 gloss 字段用${mine}写出这条草稿的意思（忠实翻译，方便他判断和修改）；草稿本身就是${mine}时 gloss 填空字符串。他的补充要求可能用${mine}写，照着改草稿即可，草稿语言不变。\n` +
    '2. 像真人在社区里随手写的回复：有具体观点、经验或追问，避免空洞的客套和总结腔；不要用 "Great question"、"As an AI" 之类的套话，不要加话题标签，除非他的风格本来就这样。\n' +
    '3. 遵守平台习惯：X 回复要短（一般不超过 280 字符）；Reddit 可以稍长，但通常 1-4 句话足够；LinkedIn 按下面的 LinkedIn 语气写。\n' +
    toneBlock(style, item) +
    '4. 不编造他没提供过的个人经历、公司内部信息或数据；需要具体经历时用他能补充的方式表达，或改为提问。\n' +
    '5. 给出 3 个角度不同的草稿，angle 用中文 2-6 个字标注角度：\n' +
    '   - 第 1 个「核心观点」：如果话题和他的观点（viewpoints）有关，自然地把他的观点带进来，给出理由或例子，而不是喊口号；话题无关就写一个最有洞察的回复。\n' +
    '   - 第 2、3 个从其他角度（补充技术细节 / 分享经验或案例 / 追问或提出不同看法），让他有不同选择。\n' +
    '   同一个观点不要每次都用同样的句式表达，避免看起来像在刷屏或营销。\n' +
    '6. suggestion 用中文给他 1-2 句建议：这条值不值得回、从哪个角度切入更好、有什么要注意的。';

  let target = '';
  if (item.kind === 'comment' && item.context) {
    const c = item.context;
    target += `<thread platform="${item.platform}" community="${item.community || ''}">\n`;
    if (c.rootTitle || c.rootText) target += `原帖（${c.rootAuthor || '楼主'}）：${c.rootTitle ? c.rootTitle + '\n' : ''}${(c.rootText || '').slice(0, 2000)}\n`;
    if (c.replyingTo) target += `${c.replyingTo}\n`;
    (c.parents || []).forEach((p, i) => (target += `${'  '.repeat(i + 1)}↳ ${p.author}：${p.text}\n`));
    target += `</thread>\n\n<reply_to author="${item.author}">\n${item.text}\n</reply_to>\n\n他要回复的是 <reply_to> 这一条评论，不是原帖；回复要接住这条评论的话头，同时符合整个讨论的上下文。`;
  } else {
    target += `<post platform="${item.platform}" community="${item.community || ''}" author="${item.author}">\n` +
      `${item.title ? '标题：' + item.title + '\n' : ''}${item.text || ''}\n</post>\n\n他要回复的是这条原帖。`;
    if (item.platform === 'web') target += `\n这段文字是他在网页${item.pageTitle ? '「' + item.pageTitle.slice(0, 120) + '」' : ''}上选中的（可能只是片段），作为回复的上下文；他可能要在评论区、论坛、邮件或聊天里回复，写成自然、通用的回复，一般 1-4 句，不要假设具体平台格式。`;
  }
  if (recent.length) {
    target += '\n\n<recent_sent>\n他最近已经发出的回复（不要重复这些说法和句式）：\n' + recent.map((t) => '- ' + t.slice(0, 200)).join('\n') + '\n</recent_sent>';
  }
  if (topic?.kind === 'reply') {
    if (topic.thread?.length) target += '\n\n<his_discussion>\n他回复之前和 AI 讨论过怎么回这条内容，下面是讨论记录（他的输入是最重要的素材）：\n' +
      topic.thread.slice(-12).map((m) => (m.role === 'user' ? '他：' : 'AI：') + m.text.slice(0, 800)).join('\n') + '\n</his_discussion>\n' +
      '把他在讨论中表达的观点、经验和想强调的点组织成回复：以他的立场为准，AI 的建议只在他认可时采用；不要把讨论里的分析原样搬进回复，要写成对对方的自然回应。';
  } else if (own || topic) {
    target += '\n\n<his_post_topic>\n这条评论在他自己发的帖子下面' + (own ? `（他的原帖：${(own.title ? own.title + ' / ' : '') + own.text.slice(0, 1500)}）` : '') + '。\n';
    if (topic?.out?.thesis) target += `他这篇帖子的核心观点：${topic.out.thesis}\n`;
    if (topic?.thread?.length) target += '他发帖前和 AI 讨论这个议题的记录（节选）：\n' + topic.thread.slice(-8).map((m) => (m.role === 'user' ? '他：' : 'AI：') + m.text.slice(0, 600)).join('\n') + '\n';
    target += '</his_post_topic>\n作为楼主回复：感谢可以有但别客套；接住对方的具体观点，用讨论中形成的论据深入展开，或者真诚地回应反驳；对方问的问题直接回答，不清楚的就坦白并反问。和原帖观点保持一致，但不要重复原帖内容。';
  }
  if (item.hook) target += `\n\n可以考虑的切入点：${item.hook}`;
  if (previous?.length) {
    target += '\n\n<previous_drafts>\n' + previous.map((d, i) => `${i + 1}. [${d.angle}] ${d.text}`).join('\n') + '\n</previous_drafts>';
  }
  if (instruction) {
    target += `\n\n他对草稿的补充要求（优先满足，必要时可以改变观点和角度）：\n${instruction}`;
  }
  return { system, user: target };
}

// ---------- 风格档案 ----------
export function profilePrompt(style) {
  const samples = style.samples.slice(-80);
  const system =
    '你是写作风格分析师。根据一个人亲自写过的社交媒体回复，以及他对 AI 草稿的修改，总结出一份可以直接放进提示词里的「回复风格档案」。\n' +
    '用中文写，Markdown 格式，控制在 400 字以内，包含这些小节：\n' +
    '## 语气与态度\n## 长度与结构\n## 用词与表达习惯（含常用词、口头禅、标点、表情、大小写等）\n## 不同语言下的差异\n## 他会删掉或避免的东西（主要从修改记录里总结）\n' +
    '要具体、可执行，少用「专业」「友好」这类空泛形容词。如果已有档案里有他手动写的内容，保留并融合，不要丢掉。';
  const user =
    (style.profile ? '<current_profile>\n' + style.profile + '\n</current_profile>\n\n' : '') +
    '<samples>\n' + samples.map((s) => `- [${s.platform}/${s.lang}] ${s.text.slice(0, 600)}`).join('\n') + '\n</samples>\n\n' +
    (style.edits.length
      ? '<edits>\n' + style.edits.slice(-20).map((e) => `草稿：${e.draft.slice(0, 400)}\n定稿：${e.final.slice(0, 400)}`).join('\n---\n') + '\n</edits>'
      : '');
  return { system, user };
}

// ---------- Reddit / X 回复改写成 LinkedIn 长帖 ----------
export const LONGPOST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hook', 'text', 'language'],
  properties: { hook: { type: 'string' }, text: { type: 'string' }, language: { type: 'string' } }
};

export function longPostPrompt(settings, style, item, { company, instruction } = {}) {
  const tone = style.platformTone?.linkedin || '';
  const system =
    '你在帮一位用户把他在 Reddit / X 上写过的一条高质量回复，扩写成一篇 LinkedIn 原创帖子草稿，由他审核修改后亲自发布。\n' +
    '他关注的领域：\n' + settings.interests + '\n\n' +
    (styleBlock(style, item) || '') + '\n\n' +
    companyBlock(company, true) + '\n' +
    '写作要求：\n' +
    '1. 保留他回复里的核心观点，扩展成一篇独立成文的帖子：读者没看过原讨论也能看懂。不要写「我在 Reddit 上看到……」，除非讨论本身值得引用。\n' +
    '2. 结构：第一行是一句抓人的观点（hook 字段也填这一句）；接着 2-4 段展开理由、具体经验或例子；最后用一个开放问题邀请讨论。每段 1-3 句，段落之间空一行。\n' +
    '3. 长度 150-300 个英文词或 250-500 个汉字。语言和他原来那条回复保持一致，language 填语言代码。\n' +
    '4. LinkedIn 语气：' + tone + '\n' +
    '5. 不编造他没提供过的经历、客户或数据；需要例子时写成他可以替换的通用描述。\n' +
    '6. 最多 3 个话题标签，放在最后一行；不要 emoji 堆砌。';
  let user = `<original_discussion platform="${item.platform}">\n${item.title ? '标题：' + item.title + '\n' : ''}${(item.context?.rootText || item.text || '').slice(0, 1500)}\n</original_discussion>\n\n` +
    `<his_reply>\n${item.finalText}\n</his_reply>`;
  if (item.longPost?.text && instruction) user += `\n\n<previous_version>\n${item.longPost.text}\n</previous_version>`;
  if (instruction) user += `\n\n他的补充要求（优先满足）：\n${instruction}`;
  return { system, user };
}

// ---------- 我来写：把你自己写的内容翻译成目标语种，保持你的说话风格 ----------

export function translatePrompt(style, { text, target, item, previous, instruction, polish }) {
  const langName = LANGS[target] || target;
  // 你过去「原文 → 定稿」的例子，最能说明你希望怎么被翻译
  const pairs = (style.translations || []).filter((t) => t.final && t.lang === target).slice(-8);
  const samples = (style.samples || []).filter((x) => x.lang === target && x.source !== 'translated').slice(-6);
  const tone = item && style.platformTone?.[item.platform];
  const system =
    `你是这位用户的私人译者：他用自己的话写好了一段社交媒体回复，你把它翻译成 ${langName}，读起来要像他本人直接用 ${langName} 写的。\n` +
    '要求：\n' +
    (polish
      ? '1. 这次要「翻译 + 润色」：意思、立场和信息量以他的原文为准，不加新观点、不替他补充事实或数据；但可以调整语序、删掉啰嗦和重复、补上省略的逻辑连接、把含糊的说法说清楚，让它读起来像他状态最好时写的。原文和目标语种相同时，就只做润色。\n' +
        '2. 润色要贴着他本人的风格（参考 style_profile 和他写过的回复）：他平时多口语就别写成书面语，他爱用短句就别拉长，不要加客套话、总结句和营销腔。\n'
      : '1. 忠实于他的意思、立场和信息量，不增删观点，不替他补充事实或数据。\n' +
        '2. 保留他的说话风格：句子长短、语气强弱、是否口语、幽默和反问、常用词。不要翻得比原文更正式、更啰嗦，也不要加客套话。\n') +
    '3. 用目标语种母语者在社交媒体上的自然说法，不要逐字直译；专业术语用业内通用说法，不要硬翻。\n' +
    '4. 保留原文里的 @提及、链接、话题标签、表情和换行。\n' +
    (item ? `5. 这是在 ${item.platform === 'x' ? 'X（一般不超过 280 字符，能短则短）' : item.platform === 'linkedin' ? 'LinkedIn' : 'Reddit'} 上的回复。` + (tone ? `语气参考：${tone}` : '') + '\n' : '') +
    '只输出译文本身，不要解释、不要加引号。\n\n' +
    (style.profile ? '<style_profile>\n' + style.profile + '\n</style_profile>\n\n' : '') +
    (pairs.length ? '<his_translations>\n他之前的原文和他最终发出的版本（照这个习惯翻译）：\n' +
      pairs.map((t) => `原文：${t.src.slice(0, 300)}\n他的定稿：${t.final.slice(0, 400)}`).join('\n---\n') + '\n</his_translations>\n\n' : '') +
    (samples.length ? '<his_writing>\n他亲自用 ' + langName + ' 写过的回复（参考用词和语气）：\n' + samples.map((x) => '- ' + x.text.slice(0, 300)).join('\n') + '\n</his_writing>' : '');
  let user = '';
  if (item) user += `<replying_to platform="${item.platform}" author="${item.author || ''}">\n${(item.title ? item.title + '\n' : '') + (item.text || '').slice(0, 1200)}\n</replying_to>\n\n`;
  user += `<his_text>\n${text}\n</his_text>`;
  if (previous) user += `\n\n<previous_translation>\n${previous}\n</previous_translation>`;
  if (instruction) user += `\n\n他对译文的补充要求（优先满足）：${instruction}`;
  return { system, user };
}

// ---------- 发帖：先讨论观点，再写成各平台的原创帖 ----------
const thoughtsBlock = (style) =>
  (style.profile ? '<style_profile>\n' + style.profile + '\n</style_profile>\n\n' : '') +
  (style.viewpoints ? '<viewpoints>\n他已有的观点、立场与背景：\n' + style.viewpoints + '\n</viewpoints>\n\n' : '');
const transcript = (thread) => thread.map((m) => (m.role === 'user' ? '他：' : '你：') + m.text).join('\n\n');

export function discussPrompt(settings, style, thread, source) {
  const system =
    (source
      ? '你是这位用户的思考伙伴（sparring partner）。他在网上看到一条别人的帖子 / 观点（见 <their_post>），想回复它，先和你讨论清楚怎么回。先帮他看懂对方真正在说什么、哪里有道理、哪里站不住，再结合他的立场找出最值得回应的角度。\n'
      : '你是这位用户的思考伙伴（sparring partner）。他准备在 X / LinkedIn / Reddit 上发表自己的观点，发之前先和你把观点磨清楚。\n') +
    '他关注的领域：\n' + settings.interests + '\n\n' + thoughtsBlock(style) +
    '回应要求：\n' +
    '1. 用他最近一条消息所用的语言回复（中文就用中文，英文就用英文）。\n' +
    '2. 坦诚、具体，像懂行的同事。观点平庸、空泛或站不住时直接说，并指出怎么改得更有洞见；不要客套和恭维。\n' +
    '3. 结合他已有的观点，前后一致；发现和他以往立场矛盾时提醒他。\n' +
    '4. 按这个结构，总长不超过 300 个英文词或 450 个汉字：\n' +
    '   **核心观点**：一句话提炼出更尖锐的版本\n' +
    '   **可用的论据**：2-3 点；需要他本人经历或数据支撑的，标明「需要你补充」，不要替他编\n' +
    '   **可能的反驳**：1-2 个最强的反方观点，以及怎么回应\n' +
    '   **追问**：1-2 个问题，帮他想得更深\n' +
    '5. 他已经回答过的问题不要重复问，在前面讨论的基础上推进。';
  const src = source ? `<their_post platform="${source.platform || ''}" author="${source.author || ''}">\n${source.text.slice(0, 4000)}\n</their_post>\n\n` : '';
  return { system, user: src + transcript(thread) };
}

const COMPOSE_PARTS = {
  x: {
    type: 'object', additionalProperties: false, required: ['single', 'thread'],
    properties: { single: { type: 'string' }, thread: { type: 'array', items: { type: 'string' } } }
  },
  linkedin: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
  reddit: {
    type: 'object', additionalProperties: false, required: ['subreddits', 'title', 'body'],
    properties: { subreddits: { type: 'array', items: { type: 'string' } }, title: { type: 'string' }, body: { type: 'string' } }
  }
};
export const composeSchema = (platforms) => ({
  type: 'object', additionalProperties: false, required: ['thesis', ...platforms],
  properties: { thesis: { type: 'string' }, ...Object.fromEntries(platforms.map((p) => [p, COMPOSE_PARTS[p]])) }
});

export function composePrompt(settings, style, { thread, platforms, lang = 'English', company, instruction, previous }) {
  const own = (style.samples || []).filter((x) => x.source === 'original').slice(-5);
  const rules = {
    x: '- x：single 是一条独立推文，不超过 270 个字符，开门见山、有态度，最多 1 个话题标签（可以没有）。thread 是 3-6 条推文的串，每条不超过 270 个字符，第一条就是钩子，每条开头写 "1/"、"2/"……；观点简单时 thread 可以给空数组。',
    linkedin: '- linkedin：第一行是一句抓人的观点；接着 2-4 段展开理由、经验或例子，每段 1-3 句，段落间空一行；最后用一个开放问题邀请讨论。120-250 个英文词。最多 3 个话题标签放在最后一行，不堆 emoji。语气：' + (style.platformTone?.linkedin || '专业、真诚、有洞见'),
    reddit: '- reddit：subreddits 按合适程度推荐 1-3 个子版块（不带 r/），优先从他关注的子版块里选：' + (settings.subreddits || []).join(', ') + '。title 是一个引发讨论的标题，不做标题党。body 用 Markdown，像社区成员发起讨论：先讲清背景和他的观点，再给理由，最后抛出问题请大家分享经验。不推销，不放无关链接。'
  };
  const system =
    '你是这位用户的代笔：把他和你讨论出的观点，用他本人的口吻写成可以直接发布的原创帖子，由他审核修改后亲自发布。\n' +
    '他关注的领域：\n' + settings.interests + '\n\n' + thoughtsBlock(style) +
    (own.length ? '<his_posts>\n他以前亲自发过的原创帖（模仿语气和节奏，不要照抄）：\n' + own.map((x) => `- [${x.platform}] ${x.text.slice(0, 500)}`).join('\n') + '\n</his_posts>\n\n' : '') +
    companyBlock(company, true) + '\n' +
    '写作要求：\n' +
    `1. 所有帖子都用 ${lang} 写，不管讨论时用的是什么语言。用母语者在社交媒体上的自然说法，专业术语用业内通用说法。\n` +
    '2. 以讨论里最后形成的观点为准；thesis 用一句话写出这个核心观点（也用 ' + lang + '）。\n' +
    '3. 不编造他没提供过的经历、客户、数据；需要例子时写成他可以替换的通用描述。\n' +
    '4. 三个平台各写各的，不要只是改长短：\n' + platforms.map((p) => rules[p]).join('\n');
  let user = '<discussion>\n' + transcript(thread) + '\n</discussion>';
  if (previous) user += '\n\n<previous_version>\n' + JSON.stringify(previous) + '\n</previous_version>';
  if (instruction) user += '\n\n他对这一版的补充要求（优先满足）：\n' + instruction;
  return { system, user };
}

// ---------- 越用越懂你：从他的输入里提炼观点 ----------
export const VIEWS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['views', 'interests'],
  properties: {
    interests: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['text', 'keywords', 'confidence'],
        properties: { text: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } }, confidence: { type: 'number' } }
      }
    },
    views: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['text', 'quote', 'confidence'],
        properties: { text: { type: 'string' }, quote: { type: 'string' }, confidence: { type: 'number' } }
      }
    }
  }
};

export function viewsPrompt(settings, style, inputs, { known = [], rejected = [], knownInterests = '' } = {}) {
  const mine = LANGS[settings.myLang || 'zh'] || '中文';
  const system =
    '你在帮一位用户整理「他本人的观点与立场」，让写作助手越用越懂他。下面是他最近在使用中写下的内容（讨论、对草稿的修改要求、他自己写的原文、他最终发出去的内容）。\n' +
    '提炼规则：\n' +
    '1. 只提炼他本人明确表达、或明确认同的观点。他对 AI 的建议说「对 / 同意 / 就是这个意思」时，被认同的那条建议也算（见 <ai_before>）。AI 单方面说的、他没表态的不算。\n' +
    '2. 必须是可复用的立场或判断（对行业、技术、产品、组织、工作方式等的看法），不要事实陈述、客套话、一次性的写作指令（如「写短一点」「用英文」）。\n' +
    `3. 每条用${mine}写成一句话，概括成以后写作时可以直接参考的立场，不超过 60 个字；quote 填他的原话片段（原语言，尽量短）。\n` +
    '4. 和 <known> 里已有的观点意思相同的不要再提；<rejected> 里他拒绝过的也不要再提。\n' +
    '5. confidence 0-1：他表达得越明确、越反复，越高。最多 5 条；没有就返回空数组。\n' +
    '6. source="pasted" 的是他主动贴进来、想回复或讨论的别人的内容：它们不是他的观点，不要从里面提炼 views，但能说明他关心什么话题。\n' +
    `7. interests：从所有输入（尤其是 pasted 和他反复讨论的话题）里找出他感兴趣、但 <known_interests> 里还没覆盖的话题，每条用${mine}一句话描述（不超过 40 字），keywords 给 2-5 个用来在 Reddit / X / LinkedIn 上找这类内容的英文关键词（小写）。最多 3 条，没有就返回空数组。`;
  const user =
    (known.length ? '<known>\n' + known.map((x) => '- ' + x).join('\n') + '\n</known>\n\n' : '') +
    (knownInterests ? '<known_interests>\n' + knownInterests.slice(0, 2500) + '\n</known_interests>\n\n' : '') +
    (rejected.length ? '<rejected>\n' + rejected.map((x) => '- ' + x).join('\n') + '\n</rejected>\n\n' : '') +
    '<inputs>\n' + inputs.map((i) => `<input source="${i.source}">\n${i.ctx ? '<ai_before>' + i.ctx.slice(0, 500) + '</ai_before>\n' : ''}${i.text.slice(0, 1200)}\n</input>`).join('\n') + '\n</inputs>';
  return { system, user };
}

// 轻量「帮我回复」：聊天消息 / 屏幕上任意一段文字，不按帖子社区的逻辑写
export function quickPrompt(settings, style, { text, title = '', lang = 'en', view = '', previous = null }) {
  const mine = LANGS[settings.myLang || 'zh'] || '中文';
  const item = { text, lang: detectLang(text), platform: 'chat', title };
  const system =
    '你在帮一个人回复一段对话或一段文字（多半是聊天消息：微信、WhatsApp、Slack、邮件、私信，也可能是网页上的一段话），用他本人的口吻写，由他复制后自己发出去。\n\n' +
    (styleBlock(style, item) || '（还没有风格档案：写得自然、简洁、像真人。）') + '\n\n' +
    '要求：\n' +
    (lang && LANGS[lang]
      ? `1. 回复用 ${LANGS[lang]} 写，language 字段填 ${lang}。\n`
      : '1. 回复语言和对方的语言一致，language 字段填该语言代码。\n') +
    `   每条的 gloss 用${mine}写出这条回复的意思（回复本身就是${mine}时填空字符串）。他的观点可能用${mine}写，照着意思写进回复即可。\n` +
    '2. 这是聊天，不是发帖：像真人发消息一样，通常 1-3 句，口语、直接，不写总结腔和客套套话，不加话题标签。\n' +
    '3. 根据上下文判断关系和场合（对老师、长辈、客户要礼貌得体；对熟人可以随意），语气要合适。\n' +
    '4. 如果选中的是好几条消息，回复的是对方最后说的那条，同时照顾前面的上下文。\n' +
    '5. 不编造他没说过的事实、安排或承诺；需要他确认的信息（时间、数字等）用占位或改为提问。\n' +
    '6. 给 3 条不同的回复，angle 用中文 2-4 个字标注（如「简短回应」「展开说」「追问」「委婉拒绝」）。如果他写了自己的观点，3 条都要以他的观点为准，只是表达方式不同。\n' +
    '7. suggestion 用中文一句话提醒要注意什么（没有就填空字符串）。';
  let user = `<selected_text${title ? ` page="${title.replace(/"/g, "'").slice(0, 100)}"` : ''}>\n${text.slice(0, 4000)}\n</selected_text>`;
  if (previous?.length) user += '\n\n<previous_options>\n' + previous.map((d, i) => `${i + 1}. ${d.text}`).join('\n') + '\n</previous_options>';
  if (view) user += `\n\n他想表达的观点 / 意思（优先满足）：\n${view}`;
  return { system, user };
}

// Hacker News 等不允许 AI 代写的平台：用母语解读帖子和评论区，帮他自己形成观点（不写任何可直接发出的回复）
export const DIGEST_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'points', 'angles'],
  properties: {
    summary: { type: 'string' },
    points: { type: 'array', items: { type: 'string' } },
    angles: { type: 'array', items: { type: 'string' } }
  }
};
export function digestPrompt(settings, style, item, comments = []) {
  const mine = LANGS[settings.myLang || 'zh'] || '中文';
  const system =
    `你帮一位用户读 Hacker News 上的讨论，用${mine}给他做解读，帮他自己形成观点。\n` +
    'HN 的规则不允许 AI 生成或 AI 改写的评论，所以你绝对不要替他写任何可以直接发出去的回复、英文句子或模板。\n' +
    '他关注的领域：\n' + settings.interests + '\n\n' +
    (style.viewpoints ? '<viewpoints>\n他的观点与立场：\n' + style.viewpoints + '\n</viewpoints>\n\n' : '') +
    `输出（都用${mine}）：\n` +
    '- summary：2-4 句话说清楚这条内容在讲什么、为什么值得关注。\n' +
    '- points：评论区的主要观点和争议，3-6 条，每条注明是支持、反对还是补充，有代表性的人名可以带上。没有评论就根据内容本身列出关键论点。\n' +
    '- angles：结合他的观点，他可以从哪些角度参与讨论，2-4 条，只写思路（比如「可以用你实际做过的项目数据回应第 2 条的质疑」），不写句子。';
  let user = `<hn_item kind="${item.kind}" author="${item.author || ''}">\n` +
    (item.kind === 'comment' && item.context?.rootTitle ? `所在帖子：${item.context.rootTitle}\n` : '') +
    (item.title && item.kind === 'post' ? `标题：${item.title}\n` : '') + (item.text || '').slice(0, 3000) + '\n</hn_item>';
  if (item.kind === 'comment' && item.context?.parents?.length) user += '\n\n<thread>\n' + item.context.parents.map((p) => `${p.author}：${p.text}`).join('\n') + '\n</thread>';
  if (comments.length) user += '\n\n<comments>\n' + comments.map((c) => `- ${c.author}：${c.text.slice(0, 600)}`).join('\n') + '\n</comments>';
  return { system, user };
}

// 引导：用户用几句话介绍自己 → 整理成兴趣描述、关键词、观点、子版块和 HN 关键词（由他确认后保存）
export const INTRO_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['interests', 'keywords', 'viewpoints', 'subreddits', 'hnKeywords'],
  properties: {
    interests: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
    viewpoints: { type: 'string' },
    subreddits: { type: 'array', items: { type: 'string' } },
    hnKeywords: { type: 'array', items: { type: 'string' } }
  }
};
export function introPrompt(intro, myLang = 'zh') {
  const mine = LANGS[myLang] || '中文';
  const system =
    '你在帮一个新用户配置「社交媒体回复助手」：它会在 Reddit / X / LinkedIn / Hacker News 上帮他找值得回的讨论，用他的口吻起草回复。\n' +
    `根据他的自我介绍，整理出下面这些内容（说明文字用${mine}）：\n` +
    '- interests：他关注的领域，编号列出 4-8 个方向，每行「方向：具体关注点」，最后一行以「不感兴趣：」开头写他明显不关心的内容（介绍里没提就写常见的噪音，如招聘、抽奖、炒币）。\n' +
    '- keywords：20-40 个用于预筛的关键词，中英文都要有，小写，短词或短语（如 on-device、agent、端侧，按他的领域来）。\n' +
    '- viewpoints：他的观点、立场与背景，用「- 」开头的条目，只写介绍里能看出来的，不要编造；看不出观点就写他的身份和关注点。\n' +
    '- subreddits：8-12 个和他兴趣相关、确实存在的活跃子版块名（不带 r/）。\n' +
    '- hnKeywords：6-12 个适合在 Hacker News 上搜索的英文关键词。';
  return { system, user: `<his_intro>\n${intro.slice(0, 3000)}\n</his_intro>` };
}
