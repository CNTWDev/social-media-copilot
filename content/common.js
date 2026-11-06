// Reddit / X / LinkedIn 内容脚本的公共部分。
// 原则：只读取你自己在浏览器里看到的内容；只往回复框里填字，永远不替你点「发送」。
(() => {
  // 插件升级 / 重新加载后，旧脚本还留在已打开的页面里，但它和插件的连接已经断了
  // （Chrome 报 "Extension context invalidated"）。这里检测到就让旧脚本安静退出。
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  if (window.RC?.alive?.()) return; // 已经有一份正常运行的脚本，不重复加载
  window.RC?.shutdown?.();

  const RC = (window.RC = {});
  RC.alive = alive;
  const cleanups = [];
  RC.shutdown = () => {
    RC.dead = true;
    cleanups.splice(0).forEach((fn) => { try { fn(); } catch {} });
  };

  RC.clip = (s, n = 1500) => (s || '').replace(/\s+\n/g, '\n').trim().slice(0, n);

  // 穿透 shadow DOM 查找元素（新版 Reddit 大量使用 Web Components）。
  RC.deepQueryAll = (selector, root = document) => {
    const out = [];
    const walk = (node) => {
      if (!node) return;
      node.querySelectorAll?.(selector).forEach((el) => out.push(el));
      node.querySelectorAll?.('*').forEach((el) => el.shadowRoot && walk(el.shadowRoot));
    };
    walk(root);
    return out;
  };
  RC.deepQuery = (selector, root) => RC.deepQueryAll(selector, root)[0] || null;

  RC.waitFor = async (fn, timeout = 8000, interval = 250) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, interval));
    }
    return null;
  };

  // 模拟「粘贴文字」到编辑器，React/Draft.js/Lexical 编辑器都能识别。
  RC.insertText = (el, text) => {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    if (document.execCommand('insertText', false, text)) return true;
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  };

  // 防止重复填入：如果回复框里已经有这段草稿（比如重试导致第二次填入），就不再插入。
  RC.fillOnce = (el, text) => {
    const cur = (el.value ?? el.innerText ?? '').replace(/\s+/g, ' ').trim();
    const head = text.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (head && cur.includes(head)) return true;
    return RC.insertText(el, text);
  };

  // 识别你自己的账号，用来排除你自己写的内容。
  RC.reportSelf = (platform, handle) => {
    if (handle && !RC['self_' + platform]) {
      RC['self_' + platform] = handle;
      RC.send({ type: 'SELF_HANDLE', platform, handle });
    }
  };

  RC.readEditor = (el) => (el ? (el.value ?? el.innerText ?? '').trim() : '');

  RC.toast = (msg, ms = 4000) => {
    let box = document.getElementById('__rc_toast');
    if (!box) {
      box = document.createElement('div');
      box.id = '__rc_toast';
      box.style.cssText =
        'position:fixed;z-index:2147483647;right:20px;bottom:24px;max-width:340px;padding:10px 14px;' +
        'border-radius:10px;background:#1f1e1d;color:#fff;font:13px/1.5 system-ui,sans-serif;' +
        'box-shadow:0 6px 24px rgba(0,0,0,.25);transition:opacity .2s';
      document.documentElement.appendChild(box);
    }
    box.textContent = msg;
    box.style.opacity = '1';
    clearTimeout(box._t);
    box._t = setTimeout(() => (box.style.opacity = '0'), ms);
  };

  RC.send = (msg) => {
    if (RC.dead || !alive()) {
      RC.shutdown();
      return Promise.resolve();
    }
    try {
      return chrome.runtime.sendMessage(msg).catch((err) => {
        if (/context invalidated/i.test(String(err))) RC.shutdown();
      });
    } catch {
      RC.shutdown();
      return Promise.resolve();
    }
  };

  // 只收集真正出现在屏幕上停留过的内容（像人一样「看过」才算），批量发给后台。
  let pending = [];
  let flushTimer = null;
  const reported = new Set();
  RC.report = (item) => {
    if (!item || !item.id || reported.has(item.id + (item.context?.parents?.length || 0))) return;
    reported.add(item.id + (item.context?.parents?.length || 0));
    pending.push(item);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      const batch = pending;
      pending = [];
      RC.send({ type: 'ITEMS_SEEN', items: batch });
    }, 1500);
  };

  RC.observe = (selector, extract) => {
    const timers = new WeakMap();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (RC.dead) return;
          if (e.isIntersecting) {
            timers.set(e.target, setTimeout(() => {
              try { RC.report(extract(e.target)); } catch (err) { /* DOM 改版时忽略单条 */ }
            }, 1200));
          } else {
            clearTimeout(timers.get(e.target));
          }
        }
      },
      { threshold: 0.4 }
    );
    const watched = new WeakSet();
    const scan = () => {
      RC.deepQueryAll(selector).forEach((el) => {
        if (!watched.has(el)) {
          watched.add(el);
          io.observe(el);
        }
      });
    };
    scan();
    const mo = new MutationObserver(() => {
      if (RC.dead) return;
      clearTimeout(scan._t);
      scan._t = setTimeout(scan, 500);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    cleanups.push(() => io.disconnect(), () => mo.disconnect(), () => clearTimeout(scan._t));
    return scan;
  };

  // 发送检测：你自己点了平台的发送按钮时，读出最终文本，用于计数和风格学习。
  RC.armSubmitWatch = ({ itemId, draftText, getEditor, isSubmit, onSubmit }) => {
    RC.armed = { itemId, draftText, getEditor, isSubmit, onSubmit, at: Date.now() };
  };
  const onMaybeSubmit = (e) => {
    const a = RC.armed;
    if (!a || Date.now() - a.at > 30 * 60 * 1000) return;
    const path = e.composedPath ? e.composedPath() : [e.target];
    const hit = e.type === 'keydown'
      ? (e.metaKey || e.ctrlKey) && e.key === 'Enter'
      : path.some((n) => n instanceof Element && a.isSubmit(n));
    if (!hit) return;
    const finalText = RC.readEditor(a.getEditor());
    if (!finalText) return;
    RC.armed = null;
    if (a.onSubmit) return a.onSubmit(finalText);
    RC.send({ type: 'REPLY_SENT', itemId: a.itemId, draftText: a.draftText, finalText });
    RC.toast('Reply Copilot：已记录这条回复，并用于学习你的风格。');
  };
  document.addEventListener('click', onMaybeSubmit, true);
  document.addEventListener('keydown', onMaybeSubmit, true);
  cleanups.push(
    () => document.removeEventListener('click', onMaybeSubmit, true),
    () => document.removeEventListener('keydown', onMaybeSubmit, true),
    () => clearTimeout(flushTimer)
  );

  // ---------- 填入草稿 ----------
  // 先尝试自动找到回复框并填入；找不到（页面改版、加载慢）就进入「点一下回复框即填入」模式。
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  const isEditable = (el) => el instanceof Element && (el.isContentEditable || el.tagName === 'TEXTAREA') && el.id !== '__rc_toast';

  RC.handleFill = async (item, text) => {
    RC.disarmFocusFill?.();
    try {
      if (RC.fill && (await withTimeout(RC.fill(item, text), 15000))) {
        RC.send({ type: 'FILL_RESULT', id: item.id, text, mode: 'auto' });
        return { ok: true, mode: 'auto' };
      }
    } catch {}
    RC.armFocusFill(item, text);
    return { ok: true, mode: 'focus' };
  };

  RC.armFocusFill = (item, text) => {
    const done = (el) => {
      RC.disarmFocusFill();
      RC.fillOnce(el, text);
      if (item.id) {
        RC.armSubmitWatch({ itemId: item.id, draftText: text, getEditor: () => el, isSubmit: RC.isSubmit || (() => false) });
        RC.send({ type: 'FILL_RESULT', id: item.id, text, mode: 'focus' });
      }
      RC.toast(`草稿已填入。检查或修改后，请你自己点「${RC.submitLabel || '发送'}」。`, 6000);
    };
    const onFocus = (e) => {
      const el = (e.composedPath ? e.composedPath()[0] : e.target);
      if (isEditable(el)) done(el);
    };
    document.addEventListener('focusin', onFocus, true);
    const timer = setTimeout(() => RC.disarmFocusFill(), 10 * 60 * 1000);
    RC.disarmFocusFill = () => {
      document.removeEventListener('focusin', onFocus, true);
      clearTimeout(timer);
      RC.disarmFocusFill = null;
    };
    cleanups.push(() => RC.disarmFocusFill?.());
    const active = document.activeElement?.shadowRoot?.activeElement || document.activeElement;
    if (isEditable(active)) return done(active);
    RC.toast('Reply Copilot：点一下这条内容的回复框，草稿会自动填进去（草稿也已复制到剪贴板，可以直接粘贴）。', 20000);
  };

  // 翻译页「填入当前页面」：填进你最近点过的输入框；还没点过就等你点一下
  let lastEditable = null;
  const rememberEditable = (e) => {
    const el = e.composedPath ? e.composedPath()[0] : e.target;
    if (isEditable(el)) lastEditable = el;
  };
  document.addEventListener('focusin', rememberEditable, true);
  cleanups.push(() => document.removeEventListener('focusin', rememberEditable, true));
  RC.fillActive = (text) => {
    const el = lastEditable?.isConnected && lastEditable.getClientRects().length ? lastEditable : null;
    if (el) {
      RC.fillOnce(el, text);
      el.focus();
      RC.toast(`译文已填入。检查后请你自己点「${RC.submitLabel || '发送'}」。`, 5000);
      return 'filled';
    }
    RC.armFocusFill({ id: '' }, text);
    return 'focus';
  };

  // 新打开的页面：读取后台留下的「待填入」草稿。
  const idCore = (id) => id.replace(/^(t[13]_|x_)/, '');
  const matchesPending = (item) => (RC.matchesPending ? RC.matchesPending(item) : location.pathname.includes(idCore(item.id)));
  setTimeout(async () => {
    if (RC.dead || !alive()) return;
    try {
      const { pendingFill } = await chrome.storage.local.get('pendingFill');
      if (!pendingFill || Date.now() - pendingFill.at > 3 * 60 * 1000) return;
      if (!matchesPending(pendingFill.item)) return;
      await chrome.storage.local.remove('pendingFill');
      RC.handleFill(pendingFill.item, pendingFill.text);
    } catch {}
  }, 1200);

  // 发帖：侧边栏打开的发帖页。平台自己能预填就不重复填；找不到编辑框就等你点一下
  const SITE = /linkedin\.com$/.test(location.hostname) ? 'linkedin' : /reddit\.com$/.test(location.hostname) ? 'reddit' : /ycombinator\.com$/.test(location.hostname) ? 'hn' : 'x';
  RC.handleCompose = async (pc) => {
    const btn = RC.postButtonLabel || '发布';
    if (pc.title && RC.composeTitle) {
      const t = await RC.waitFor(RC.composeTitle, 12000);
      if (t) RC.fillOnce(t, pc.title);
    }
    const ed = RC.composeEditor && (await RC.waitFor(RC.composeEditor, 12000));
    if (!ed) {
      RC.armFocusFill({ id: '' }, pc.text);
      RC.toast(`Reply Copilot：点一下发帖的正文框，内容会自动填进去（也可以直接粘贴）。发布后回侧边栏点「我已发布」。`, 20000);
      return;
    }
    RC.fillOnce(ed, pc.text);
    ed.focus();
    RC.armSubmitWatch({
      itemId: '', draftText: pc.draftText, getEditor: () => ed, isSubmit: RC.isPostSubmit || (() => false),
      onSubmit: (finalText) => {
        RC.send({ type: 'COMPOSE_SENT', platform: SITE, text: finalText, title: pc.title, draftText: pc.draftText, cid: pc.cid, tid: pc.tid });
        RC.toast('Reply Copilot：已记录这条帖子，并用于学习你的风格。');
      }
    });
    RC.toast(`内容已填好。检查或修改后，请你自己点「${btn}」。`, 8000);
  };
  setTimeout(async () => {
    if (RC.dead || !alive()) return;
    try {
      const { pendingCompose: pc } = await chrome.storage.local.get('pendingCompose');
      if (!pc || pc.platform !== SITE || Date.now() - pc.at > 3 * 60 * 1000) return;
      await chrome.storage.local.remove('pendingCompose');
      RC.handleCompose(pc);
    } catch {}
  }, 1500);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'FILL_REPLY') {
      chrome.storage.local.remove('pendingFill').catch(() => {});
      RC.handleFill(msg.item, msg.text).then(sendResponse);
      return true;
    }
    if (msg.type === 'PING') sendResponse({ ok: true, url: location.href });
    if (msg.type === 'HAS_ITEM') sendResponse({ ok: !!RC.hasItem?.(msg.item) });
    if (msg.type === 'FILL_ACTIVE') sendResponse({ ok: true, mode: RC.fillActive(msg.text) });
    if (msg.type === 'PROBE') sendResponse({ ok: true, text: RC.probe ? RC.probe() : '' });
  });
})();
