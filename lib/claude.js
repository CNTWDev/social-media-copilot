// 直接从扩展调用 Claude Messages API。
// 扩展不经过打包工具，所以这里用 fetch 调 REST 接口，而不是官方 SDK。
const API_URL = 'https://api.anthropic.com/v1/messages';
const FALLBACK_MODELS = /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-1)$/;

export class ClaudeError extends Error {}

export async function callClaude({ apiKey, model, system, user, schema, effort = 'low', maxTokens = 16000, onUsage }) {
  if (!apiKey) throw new ClaudeError('还没有填写 Anthropic API Key（侧边栏 → 设置）。');
  const body = {
    model,
    max_tokens: maxTokens,
    // 固定的系统提示词放在最前面并标记缓存；够长时重复调用按缓存价计费。
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
    output_config: { effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) }
  };
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  };
  // 遇到安全分类器拒答时，由服务端自动切换到备用模型重试。
  const useFallback = FALLBACK_MODELS.test(model);
  if (useFallback) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }

  let res = await fetchWithRetry(headers, body);
  if (res.status === 400 && useFallback) {
    const txt = await res.clone().text();
    if (/fallback/i.test(txt)) {
      delete headers['anthropic-beta'];
      delete body.fallbacks;
      res = await fetchWithRetry(headers, body);
    }
  }
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const j = await res.json();
      msg += ' ' + (j.error?.message || JSON.stringify(j));
    } catch {}
    if (res.status === 401) msg = 'API Key 无效（401），请在设置里检查。';
    throw new ClaudeError('Claude API 出错：' + msg);
  }
  const data = await res.json();
  if (onUsage && data.usage) onUsage(data.usage);
  if (data.stop_reason === 'refusal') {
    throw new ClaudeError('模型拒绝处理这条内容' + (data.stop_details?.explanation ? '：' + data.stop_details.explanation : '。'));
  }
  if (data.stop_reason === 'max_tokens') throw new ClaudeError('输出被截断（max_tokens），请重试。');
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (!schema) return text.trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new ClaudeError('模型返回的 JSON 无法解析。');
  }
}

async function fetchWithRetry(headers, body, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body) });
      if (res.status === 429 || res.status >= 500) {
        last = res;
        const wait = Number(res.headers.get('retry-after')) * 1000 || 2000 * 2 ** i;
        await new Promise((r) => setTimeout(r, wait));
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
