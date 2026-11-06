// 首次安装的设置引导：模型 → 账号 → 画像 → 回复风格 → 开始用
import { getSettings, saveSettings, getStyle, saveStyle } from '../lib/store.js';
import { PROVIDERS } from '../lib/llm.js';
import { importConfig, parseConfig } from '../lib/config.js';

const $ = (s) => document.querySelector(s);
const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: String(e.message || e) }));
const list = (v) => v.split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);
const LANGS = [['zh', '中文'], ['en', '英文'], ['ja', '日文'], ['ko', '韩文'], ['es', '西班牙文'], ['fr', '法文'], ['de', '德文'], ['pt', '葡萄牙文']];
const STEPS = 5;
let step = 0;
let prov = 'anthropic';
const keys = {};

function notice(msg, ms = 6000) {
  const n = $('#notice');
  n.textContent = msg;
  n.classList.remove('hidden');
  clearTimeout(notice._t);
  notice._t = setTimeout(() => n.classList.add('hidden'), ms);
}

async function init() {
  const s = await getSettings();
  const st = await getStyle();
  prov = PROVIDERS[s.provider] ? s.provider : 'anthropic';
  for (const [k, P] of Object.entries(PROVIDERS)) keys[k] = s[P.keyField] || '';
  renderProv();
  $('#obMyLang').innerHTML = LANGS.map(([k, n]) => `<option value="${k}" ${k === (s.myLang || 'zh') ? 'selected' : ''}>${n}</option>`).join('');
  $('#obReddit').value = s.redditUsername || '';
  $('#obX').value = s.xHandle || '';
  $('#obLinkedin').value = s.linkedinName || '';
  $('#obHn').value = s.hnUser || '';
  $('#obRedditImport').value = s.redditUsername || '';
  $('#obInterests').value = s.interests || '';
  $('#obViews').value = st.viewpoints || '';
  $('#obKeywords').value = (s.keywords || []).join(', ');
  $('#obSubs').value = (s.subreddits || []).join(', ');
  $('#obHnKw').value = (s.hnKeywords || []).join(', ');
  if (st.profile) { $('#obProfileOut').textContent = st.profile; $('#obProfileOut').classList.remove('hidden'); }
  $('#obSampleMsg').textContent = st.samples.length ? `已有 ${st.samples.length} 条样本` : '';
  // 已经配好 Key 的老用户从设置里重新打开：从画像开始更有用
  const q = new URLSearchParams(location.search).get('step');
  go(q != null ? +q : 0);
}

function renderProv() {
  $('#obProv').innerHTML = Object.entries(PROVIDERS).map(([k, P]) => `<button class="chip ${k === prov ? 'on' : ''}" data-prov="${k}">${P.name}</button>`).join('');
  $('#obKeyLabel').textContent = `${PROVIDERS[prov].name} API Key`;
  $('#obKey').placeholder = PROVIDERS[prov].keyHint;
  $('#obKey').value = keys[prov] || '';
  $('#obTestMsg').textContent = '';
  $('#obTestMsg').className = 'hint';
}
$('#obProv').addEventListener('click', (e) => {
  const k = e.target.dataset.prov;
  if (!k) return;
  keys[prov] = $('#obKey').value.trim();
  prov = k;
  renderProv();
});

// 每一步离开时保存这一步填的内容
async function saveStep(i) {
  if (i === 0) {
    keys[prov] = $('#obKey').value.trim();
    await saveSettings({ provider: prov, [PROVIDERS[prov].keyField]: keys[prov], myLang: $('#obMyLang').value });
  }
  if (i === 1) {
    await saveSettings({
      redditUsername: $('#obReddit').value.trim().replace(/^\/?u\//, ''),
      xHandle: $('#obX').value.trim().replace(/^@/, ''),
      linkedinName: $('#obLinkedin').value.trim(),
      hnUser: $('#obHn').value.trim()
    });
    if (!$('#obRedditImport').value) $('#obRedditImport').value = $('#obReddit').value.trim();
  }
  if (i === 2) {
    const kw = list($('#obKeywords').value), subs = list($('#obSubs').value).map((x) => x.replace(/^\/?r\//i, '')), hk = list($('#obHnKw').value);
    await saveSettings({
      interests: $('#obInterests').value.trim(),
      ...(kw.length ? { keywords: kw } : {}),
      ...(subs.length ? { subreddits: subs } : {}),
      ...(hk.length ? { hnKeywords: hk } : {})
    });
    const st = await getStyle();
    st.viewpoints = $('#obViews').value.trim();
    await saveStyle(st);
  }
  await send({ type: 'SETTINGS_CHANGED' });
}

function go(i) {
  step = Math.max(0, Math.min(STEPS - 1, i));
  document.querySelectorAll('.ob-step').forEach((el) => el.classList.toggle('on', +el.dataset.step === step));
  document.querySelectorAll('#obSteps li').forEach((li) => {
    const s = +li.dataset.s;
    li.classList.toggle('cur', s === step);
    li.classList.toggle('done', s < step);
  });
  $('#obBack').classList.toggle('hidden', step === 0);
  $('#obSkip').classList.toggle('hidden', step === 0 || step === STEPS - 1);
  $('#obNext').textContent = step === STEPS - 1 ? '完成' : '下一步';
  window.scrollTo({ top: 0 });
}

$('#obNext').addEventListener('click', async () => {
  if (step === 0 && !$('#obKey').value.trim()) return notice('先填上 API Key，插件才能打分和起草。');
  if (step === STEPS - 1) return finish();
  $('#obNext').disabled = true;
  await saveStep(step);
  $('#obNext').disabled = false;
  go(step + 1);
});
$('#obBack').addEventListener('click', () => go(step - 1));
$('#obSkip').addEventListener('click', () => go(step + 1));
document.querySelectorAll('#obSteps li').forEach((li) => li.addEventListener('click', async () => {
  const s = +li.dataset.s;
  if (s > step && step === 0 && !$('#obKey').value.trim()) return notice('先填上 API Key。');
  await saveStep(step);
  go(s);
}));

async function finish() {
  await saveSettings({ onboarded: true });
  await send({ type: 'SETTINGS_CHANGED' });
  openApp();
}
async function openApp() {
  await saveSettings({ onboarded: true });
  const url = chrome.runtime.getURL('sidepanel/sidepanel.html?app=1');
  const [t] = await chrome.tabs.query({ url });
  if (t) await chrome.tabs.update(t.id, { active: true });
  else await chrome.tabs.create({ url });
}
$('#obOpenApp').addEventListener('click', openApp);
$('#obOpenReddit').addEventListener('click', async () => {
  await saveSettings({ onboarded: true });
  chrome.tabs.create({ url: 'https://www.reddit.com/' });
});

// ---- 第 1 步：测试连接 ----
$('#obTest').addEventListener('click', async () => {
  if (!$('#obKey').value.trim()) return notice('先填上 API Key。');
  $('#obTest').disabled = true;
  $('#obTestMsg').className = 'hint';
  $('#obTestMsg').textContent = '测试中…';
  await saveStep(0);
  const res = await send({ type: 'TEST_KEY' });
  $('#obTest').disabled = false;
  $('#obTestMsg').textContent = res?.ok ? '✓ 连接成功' : '连接失败：' + (res?.error || '未知错误');
  $('#obTestMsg').className = 'hint' + (res?.ok ? ' ok' : ' err');
});

// ---- 第 3 步：AI 整理画像 ----
$('#obIntroGo').addEventListener('click', async () => {
  const intro = $('#obIntro').value.trim();
  if (!intro) return notice('先用几句话介绍一下你自己。');
  $('#obIntroGo').disabled = true;
  $('#obIntroMsg').textContent = '整理中…';
  const res = await send({ type: 'INTRO_PROFILE', intro });
  $('#obIntroGo').disabled = false;
  if (!res?.ok) { $('#obIntroMsg').textContent = ''; return notice(res?.error || '整理失败，请重试。', 8000); }
  const r = res.result;
  if (r.interests) $('#obInterests').value = r.interests;
  if (r.viewpoints) $('#obViews').value = r.viewpoints;
  if (r.keywords.length) $('#obKeywords').value = r.keywords.join(', ');
  if (r.subreddits.length) $('#obSubs').value = r.subreddits.join(', ');
  if (r.hnKeywords.length) $('#obHnKw').value = r.hnKeywords.join(', ');
  $('#obIntroMsg').textContent = '✓ 整理好了，看看下面哪里要改；点「下一步」保存。';
});

// ---- 第 4 步：风格样本与风格档案 ----
$('#obAddSamples').addEventListener('click', () => addSamples());
async function addSamples() {
  const texts = $('#obSamples').value.split(/\n\s*\n/).map((x) => x.trim()).filter((x) => x.length >= 5);
  if (!texts.length) return notice('先贴几条你写过的回复，每条之间空一行。');
  const res = await send({ type: 'ADD_SAMPLES', texts, platform: 'manual' });
  if (!res?.ok) return notice(res?.error || '加入失败');
  $('#obSamples').value = '';
  const st = await getStyle();
  $('#obSampleMsg').textContent = `✓ 已加入，共 ${st.samples.length} 条样本`;
}
$('#obImport').addEventListener('click', async () => {
  const u = $('#obRedditImport').value.trim();
  if (!u) return notice('先填 Reddit 用户名。');
  $('#obImport').disabled = true;
  const res = await send({ type: 'IMPORT_REDDIT', username: u });
  $('#obImport').disabled = false;
  if (!res?.ok) return notice(res?.error || '导入失败', 8000);
  const st = await getStyle();
  $('#obSampleMsg').textContent = `✓ 导入了 ${res.result} 条评论，共 ${st.samples.length} 条样本`;
});
$('#obBuild').addEventListener('click', async () => {
  const pending = $('#obSamples').value.trim();
  if (pending) await addSamples();
  $('#obBuild').disabled = true;
  $('#obBuildMsg').textContent = '正在总结你的风格…';
  const res = await send({ type: 'BUILD_PROFILE' });
  $('#obBuild').disabled = false;
  if (!res?.ok) { $('#obBuildMsg').textContent = ''; return notice(res?.error || '生成失败', 8000); }
  const st = await getStyle();
  $('#obBuildMsg').textContent = '✓ 风格档案生成好了，以后还会越用越准。';
  $('#obProfileOut').textContent = st.profile || '';
  $('#obProfileOut').classList.toggle('hidden', !st.profile);
});

// ---- 导入已有的配置文件 ----
$('#obImportCfg').addEventListener('click', () => $('#obCfgFile').click());
$('#obCfgFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const changed = await importConfig(parseConfig(await f.text()), 'merge');
    await init();
    const s = await getSettings();
    const keyOk = !!s[PROVIDERS[s.provider]?.keyField];
    notice((changed.length ? '已导入：' + changed.join('；') + '。' : '没有需要补的内容。') + (keyOk ? '点「下一步」逐项确认就行。' : '文件里没有 API Key，填上 Key 再继续。'), 10000);
    if (keyOk) go(2);
  } catch (err) {
    notice('导入失败：' + (err.message || err), 8000);
  }
});

init();
