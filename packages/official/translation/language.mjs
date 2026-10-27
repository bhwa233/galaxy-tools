// Consolidates the existing provider/workspace rule. No installed dependency
// identifies language, and a classifier would exceed this local direction rule.
// Kana/Hangul take precedence over shared Han characters; Han-only ambiguity
// remains user-correctable through an explicit target.
export function translationTarget(text, override) {
  if (override !== undefined) return override;
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)) return "zh-CN";
  return /\p{Script=Han}/u.test(text) ? "en" : "zh-CN";
}
