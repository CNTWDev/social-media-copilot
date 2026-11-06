export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function randBetween(a, b) {
  return a + Math.random() * (b - a);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 粗略的语言判断，只用来挑选同语言的风格样本；真正的回复语言由模型根据原帖判断。
export function detectLang(text = '') {
  const s = text.slice(0, 600);
  if (/[぀-ヿ]/.test(s)) return 'ja';
  if (/[가-힯]/.test(s)) return 'ko';
  const han = (s.match(/[一-鿿]/g) || []).length;
  if (han > 4) return 'zh';
  if (/[Ѐ-ӿ]{4,}/.test(s)) return 'ru';
  return 'en';
}

export function normLang(lang) {
  if (!lang) return '';
  return lang.toLowerCase().split('-')[0];
}
