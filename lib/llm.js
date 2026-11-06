// 多模型商入口：按模型名自动判断用 Claude、OpenAI 还是 DeepSeek。
import { callClaude, ClaudeError } from './claude.js';

// 整个插件只用一个模型商：打分用便宜快速的模型，起草用更强的模型。
export const PROVIDERS = {
  anthropic: { name: 'Claude', keyField: 'apiKey', keyHint: 'sk-ant-...', score: 'claude-haiku-5-5', draft: 'claude-opus-5-5' },
  openai: { name: 'OpenAI', keyField: 'openaiKey', keyHint: 'sk-...', score: 'gpt-6-luna', draft: 'gpt-6.1-sol', url: 'https://api.openai.com/v1/chat/completions' },
  deepseek: { name: 'DeepSeek', keyField: 'deepseekKey', keyHint: 'sk-...', score: 'deepseek-flash', draft: 'deepseek-v4-pro', url: 'https://api.deepseek.com/chat/completions' }
};

export const providerOf = (s) => (PROVIDERS[s.provider] ? s.provider : 'anthropic');
export const keyOf = (s) => s[PROVIDERS[providerOf(s)].keyField] || '';
export const hasKey = (s) => !!keyOf(s);

// role: 'score' 或 'draft'
export function modelOf(s, role) {
  const p = providerOf(s);
  return s.models?.[p]?.[role] || PROVIDERS[p][role];
}

export async function callLLM(s, role, opts) {
  const p = providerOf(s);
  const apiKey = keyOf(s);
  const model = modelOf(s, role);
  if (!apiKey) throw new ClaudeError(`还没有填写 ${PROVIDERS[p].name} API Key（侧边栏 → 设置）。`);
  if (p === 'anthropic') return callClaude({ ...opts, apiKey, model });
  return callOpenAICompatible(p, { ...opts, apiKey, model });
}

// OpenAI 和 DeepSeek 都是 Chat Completions 格式。
async function callOpenAICompatible(p, { apiKey, model, system, user, schema, effort, maxTokens = 16000, onUsage }) {
  // JSON 格式要求也写进提示词：DeepSeek 只支持 json_object，需要靠提示词约束字段。
  const sys = schema ? `${system}\n\n只输出一个 JSON 对象（json），不要输出其他内容，结构必须符合这个 JSON Schema：\n${JSON.stringify(schema)}` : system;
  const body = { model, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] };
  if (p === 'openai') body.max_completion_tokens = maxTokens;
  else body.max_tokens = Math.min(maxTokens, 8000);
  const formats = !schema ? [null]
    : p === 'openai' ? [{ type: 'json_schema', json_schema: { name: 'output', schema, strict: false } }, { type: 'json_object' }, null]
    : [{ type: 'json_object' }, null];
  if (p === 'openai' && effort) body.reasoning_effort = effort;
  return sendAndParse(p, body, { apiKey, user, schema, onUsage, formats }, false);
}

async function sendAndParse(p, body, { apiKey, user, schema, onUsage, formats }, retried) {
  const name = PROVIDERS[p].name;
  let res;
  if (retried) formats = [body.response_format || null];
  for (const fmt of formats) {
    if (fmt) body.response_format = fmt; else delete body.response_format;
    res = await fetchWithRetry(PROVIDERS[p].url, apiKey, body);
    if (res.status !== 400) break;
    const txt = await res.clone().text();
    // 模型不支持 reasoning_effort 时去掉再试
    if (/reasoning_effort/i.test(txt) && body.reasoning_effort) {
      delete body.reasoning_effort;
      res = await fetchWithRetry(PROVIDERS[p].url, apiKey, body);
      if (res.status !== 400) break;
    }
    if (!/response_format|json_schema|json_object/i.test(await res.clone().text())) break;
  }
  if (!res.ok) {
    let msg = `${res.status}`;
    try { const j = await res.json(); msg += ' ' + (j.error?.message || JSON.stringify(j)); } catch {}
    if (res.status === 401) msg = 'API Key 无效（401），请在设置里检查。';
    if (res.status === 402) msg = '账户余额不足（402）。';
    throw new ClaudeError(`${name} API 出错：` + msg);
  }
  const data = await res.json();
  if (onUsage && data.usage) onUsage({ input_tokens: data.usage.prompt_tokens || 0, output_tokens: data.usage.completion_tokens || 0 });
  const choice = data.choices?.[0] || {};
  if (choice.message?.refusal) throw new ClaudeError('模型拒绝处理这条内容：' + choice.message.refusal);
  if (choice.finish_reason === 'length') throw new ClaudeError('输出被截断（长度上限），请重试。');
  const text = (choice.message?.content || '').trim();
  if (!schema) return text;
  const parsed = parseLoose(text);
  if (parsed) return parsed;
  // 偶尔会返回空内容或不合法的 JSON（比如字符串里直接换行），自动重试一次
  if (!retried) {
    body.messages = [body.messages[0], { role: 'user', content: user + '\n\n（注意：只输出一个合法的 JSON 对象，字符串里的换行写成 \\n。）' }];
    return sendAndParse(p, body, { apiKey, user, schema, onUsage }, true);
  }
  throw new ClaudeError(`${name} 返回的 JSON 无法解析` + (text ? `（开头：${text.slice(0, 60)}…）` : '（返回了空内容）') + '，请点「起草回复」重试。');
}

// 宽松解析：去掉思考过程和代码块标记，截取最外层 {}，修复字符串里没转义的换行。
export function parseLoose(text) {
  if (!text) return null;
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim();
  const tryParse = (x) => { try { const v = JSON.parse(x); return v && typeof v === 'object' ? v : null; } catch { return null; } };
  let v = tryParse(t);
  if (v) return v;
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  t = t.slice(a, b + 1);
  if ((v = tryParse(t))) return v;
  let out = '', inStr = false, esc = false;
  for (const ch of t) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      else if (ch === '\n') { out += '\\n'; continue; }
      else if (ch === '\r') continue;
      else if (ch === '\t') { out += '\\t'; continue; }
    } else if (ch === '"') inStr = true;
    out += ch;
  }
  return tryParse(out.replace(/,\s*([}\]])/g, '$1'));
}

async function fetchWithRetry(url, apiKey, body, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) });
      if (res.status === 429 || res.status >= 500) {
        last = res;
        await new Promise((r) => setTimeout(r, Number(res.headers.get('retry-after')) * 1000 || 2000 * 2 ** i));
        continue;
      }
      return res;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
    }
  }
  if (last instanceof Response) return last;
  throw new ClaudeError('网络错误：' + (last?.message || last));
}
