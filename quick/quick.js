// 轻量小窗：「帮我回复」（选中文字右键，或复制后 Ctrl/⌘+Shift+9）和「翻译润色」（复制后 Ctrl/⌘+Shift+8）
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: String(e.message || e) }));
const LANG_NAMES = [['en', '英文'], ['zh', '中文'], ['ja', '日文'], ['ko', '韩文'], ['es', '西班牙文'], ['fr', '法文'], ['de', '德文'], ['pt', '葡萄牙文']];
const PLAT_PAGES = /reddit\.com|(^|\/\/|\.)x\.com|twitter\.com|linkedin\.com/;
const isHN = (u) => /news\.ycombinator\.com/.test(u || '');

let mode = 'reply';    // reply | translate
let req = {};          // 当前这次的来源（文字、网页）
let drafts = [];       // 回复模式：选项；翻译模式：[{ text, out }]
let lang = { reply: 'en', translate: 'en' };
let busy = false;
let myLang = 'zh';
let autoTr = null;     // 这次翻译自动选的目标：别人的外文 → 翻成你的母语看懂；你自己写的 → 翻成上次选的语言并润色
// 粗略判断一段文字是不是你的母语（中日韩看文字，其他语言看是否有大量非拉丁字符时就不算）
const scriptOf = (t) => {
  const s = t.replace(/\s+/g, '');
  if (!s) return '';
  const han = (s.match(/[\u4e00-\u9fff]/g) || []).length, kana = (s.match(/[\u3040-\u30ff]/g) || []).length, hang = (s.match(/[\uac00-\ud7af]/g) || []).length;
  if (kana / s.length > 0.1) return 'ja';
  if (hang / s.length > 0.2) return 'ko';
  if (han / s.length > 0.2) return 'zh';
  return 'latin';
};
const inMyLang = (t) => (['zh', 'ja', 'ko'].includes(myLang) ? scriptOf(t) === myLang : scriptOf(t) !== 'latin' ? false : null);

const autosize = (t) => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 2 + 'px'; };

async function init() {
  const { quickLang, quickTrLang, settings } = await chrome.storage.local.get(['quickLang', 'quickTrLang', 'settings']);
  lang = { reply: quickLang || 'en', translate: quickTrLang || 'en' };
  myLang = settings?.myLang || 'zh';
  try { $('#qPolish').checked = localStorage.getItem('qPolish') !== '0'; } catch {}
  await load();
}

function setMode(m) {
  mode = m;
  try { localStorage.setItem('qMode', m); } catch {}
  $('#qModes').querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  const opts = m === 'reply' ? [['auto', '对方的语言'], ...LANG_NAMES] : LANG_NAMES;
  $('#qLang').innerHTML = opts.map(([k, n]) => `<option value="${k}" ${k === lang[m] ? 'selected' : ''}>${n}</option>`).join('');
  $('#qLangPre').textContent = m === 'reply' ? '用' : '翻成';
  $('#qLangPost').textContent = m === 'reply' ? '回复' : '';
  $('#qCtxLabel').textContent = m === 'reply' ? '要回复的内容' : '你写的内容（用你习惯的语言）';
  $('#qText').placeholder = m === 'reply'
    ? '在网页上选中文字后右键「帮我回复」；或者在任何聊天软件里复制对方的话，按 Ctrl/⌘+Shift+9（也可以直接粘贴到这里）'
    : '写下你想说的话，或者复制后按 Ctrl/⌘+Shift+8 打开这里';
  $('#qView').placeholder = m === 'reply' ? '写下你的观点，Enter 重新生成' : '补充要求（更口语 / 更短 / 保留某个词），Enter 重新生成';
  $('#qPolishRow').classList.toggle('hidden', m !== 'translate');
  document.title = m === 'reply' ? '帮我回复' : '翻译润色';
  drafts = [];
  $('#qSuggest').textContent = '';
  showErr('');
  render();
}

// 读取最新的请求：右键带来的文字，或者（快捷键打开时）剪贴板里的文字
async function load() {
  const { quickReq } = await chrome.storage.local.get('quickReq');
  req = quickReq || {};
  autoTr = null;
  // 从哪个入口打开就只做哪件事：「帮我翻译」只翻译，「帮我回复」只回复
  let last = '';
  try { last = localStorage.getItem('qMode') || ''; } catch {}
  setMode((req.mode || last) === 'translate' ? 'translate' : 'reply');
  let text = req.text || '';
  if (!text && req.fromClipboard) text = await readClipboard();
  $('#qText').value = text;
  autosize($('#qText'));
  $('#qSrc').textContent = req.title || req.url ? '来自：' + (req.title || req.url) : req.fromClipboard ? '来自剪贴板' : '';
  $('#qPanel').classList.toggle('hidden', mode !== 'reply' || !PLAT_PAGES.test(req.url || ''));
  $('#qView').value = '';
  if (mode === 'reply' && isHN(req.url)) {
    showErr('Hacker News 不允许 AI 生成或改写的评论，这里不生成回复。可以在工作台里看中文解读、和我讨论，想清楚后自己写。');
    return;
  }
  if (text.trim()) generate();
  else $('#qText').focus();
}

async function readClipboard() {
  try { return (await navigator.clipboard.readText()).trim(); } catch { return ''; }
}

async function generate(extra = '') {
  const text = $('#qText').value.trim();
  if (!text) return showErr(mode === 'reply' ? '先把要回复的内容放进来（粘贴，或点「粘贴剪贴板」）。' : '先写下你想说的话。');
  busy = true;
  showErr('');
  render();
  let res;
  if (mode === 'reply') {
    res = await send({ type: 'QUICK_REPLY', text, title: req.title || '', url: req.url || '', lang: lang.reply, view: extra, previous: extra && drafts.length ? drafts : null });
    if (res?.ok) {
      drafts = res.result.drafts;
      $('#qSuggest').textContent = res.result.suggestion ? '💡 ' + res.result.suggestion : '';
    }
  } else {
    // 别人的外文（不是你的母语）→ 默认翻成你的母语、只求看懂；你自己写的 → 按下拉选的语言，可润色
    const foreign = inMyLang(text) === false && !autoTr?.manual;
    if (!foreign && isHN(req.url)) { busy = false; render(); return showErr('Hacker News 不允许 AI 翻译或润色过的评论：要发到 HN 的内容请自己写。翻译别人的外文帮你看懂没问题。'); }
    const target = foreign ? myLang : lang.translate;
    const polish = foreign ? false : $('#qPolish').checked;
    if (foreign) { autoTr = { target }; $('#qLang').value = target; }
    res = await send({ type: 'TRANSLATE', text, target, polish, instruction: extra, previous: extra && drafts[0] ? drafts[0].text : '' });
    if (res?.ok) {
      drafts = [{ angle: foreign ? '翻成你的母语（帮你看懂）' : polish ? '翻译 + 按你的风格润色' : '忠实翻译', text: res.result.text, out: res.result.text, src: text, lang: res.result.lang, foreign }];
      $('#qSuggest').textContent = '';
    }
  }
  busy = false;
  if (res?.ok) { if (extra) $('#qView').value = ''; }
  else showErr(res?.error || '生成失败，请重试。');
  render();
  document.querySelector('.q-main').scrollTop = 0;
}

function showErr(msg) {
  $('#qErr').textContent = msg;
  $('#qErr').classList.toggle('hidden', !msg);
}

function render() {
  $('#qBusy').classList.toggle('hidden', !busy);
  $('#qBusy').textContent = mode === 'reply' ? '正在想怎么回…' : '正在翻译润色…';
  $('#qGo').disabled = busy;
  $('#qGo').textContent = drafts.length ? '重新生成' : '生成';
  $('#qSuggest').classList.toggle('hidden', busy || !drafts.length || !$('#qSuggest').textContent);
  $('#qList').classList.toggle('dim', busy);
  $('#qList').innerHTML = drafts.map((d, i) => `
    <div class="draft">
      <div class="draft-head"><span class="angle">${esc(d.angle || '选项 ' + (i + 1))}</span><span class="chars">${[...d.text].length} 字</span></div>
      <textarea data-i="${i}" rows="1">${esc(d.text)}</textarea>
      ${d.gloss ? `<div class="gloss"><span>意思：</span>${esc(d.gloss)}</div>` : ''}
      <div class="actions"><button class="small" data-copy="${i}">复制</button></div>
    </div>`).join('');
  $('#qList').querySelectorAll('textarea').forEach(autosize);
}

$('#qModes').addEventListener('click', (e) => {
  const m = e.target.closest('[data-mode]')?.dataset.mode;
  if (!m || m === mode) return;
  setMode(m);
  $('#qPanel').classList.add('hidden');
  showErr('');
  autoTr = null;
  // 选中的文字保留：切过去直接翻译 / 回复这段
  if ($('#qText').value.trim() && !(m === 'reply' && isHN(req.url))) generate();
  else $('#qText').focus();
});
$('#qList').addEventListener('input', (e) => {
  const t = e.target.closest('textarea[data-i]');
  if (!t) return;
  autosize(t);
  drafts[t.dataset.i].edited = t.value;
  t.closest('.draft').querySelector('.chars').textContent = [...t.value].length + ' 字';
});
$('#qList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const i = +b.dataset.copy;
  const text = $(`#qList textarea[data-i="${i}"]`).value.trim();
  try { await navigator.clipboard.writeText(text); } catch { return showErr('复制失败：请手动选中文字复制。'); }
  $('#qList').querySelectorAll('[data-copy]').forEach((x) => { x.classList.remove('done'); x.textContent = '复制'; });
  b.classList.add('done');
  b.textContent = '✓ 已复制，去粘贴发送';
  const d = drafts[i];
  // 你复制走的版本用来学风格；改过的地方也记下来
  if (mode === 'reply') send({ type: 'QUICK_USED', text, draft: d?.text || '', context: $('#qText').value.trim() });
  else if (!d.foreign) send({ type: 'TRANSLATION_FINAL', src: d.src, out: d.out, final: text, lang: d.lang });
});

const go = () => !busy && generate($('#qView').value.trim());
$('#qGo').addEventListener('click', go);
$('#qView').addEventListener('input', (e) => autosize(e.target));
$('#qView').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); }
});
$('#qText').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); go(); }
});
$('#qLang').addEventListener('change', (e) => {
  if (mode === 'translate') autoTr = { manual: true }; // 你手动选了语言：照你选的来
  lang[mode] = e.target.value;
  chrome.storage.local.set(mode === 'reply' ? { quickLang: lang.reply } : { quickTrLang: lang.translate });
  if ($('#qText').value.trim()) generate($('#qView').value.trim());
});
$('#qPolish').addEventListener('change', (e) => {
  try { localStorage.setItem('qPolish', e.target.checked ? '1' : '0'); } catch {}
  if ($('#qText').value.trim() && drafts.length) generate();
});
$('#qPaste').addEventListener('click', async () => {
  const t = await readClipboard();
  if (!t) return showErr('剪贴板里没有文字。');
  $('#qText').value = t;
  autosize($('#qText'));
  req = { fromClipboard: true, mode };
  $('#qSrc').textContent = '来自剪贴板';
  $('#qPanel').classList.add('hidden');
  drafts = [];
  generate();
});
$('#qText').addEventListener('input', (e) => autosize(e.target));
$('#qToPanel').addEventListener('click', async () => {
  const res = await send({ type: 'QUICK_TO_PANEL', text: $('#qText').value.trim(), url: req.url || '' });
  if (res?.ok) { $('#qToPanel').textContent = '✓ 已挂到你的帖子下面，在侧边栏或工作台查看'; $('#qToPanel').disabled = true; }
  else showErr(res?.error || '没挂上');
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });

// 小窗开着时又右键 / 按了快捷键：换成新内容
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.quickReq?.newValue) load();
});

init();
