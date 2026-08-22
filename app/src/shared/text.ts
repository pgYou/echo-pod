// 文本判定（主进程与渲染进程共用）

/**
 * 有效文稿判定：去掉说话人标签（[名字]/[说话人 N]，标签是元数据不算内容）后，
 * 标点空白不算，实质字符（汉字/字母/数字）需 ≥2 个。
 * 噪音/空白录音的空转写常是零散标点（"· 。"）或单个字母（"I."）——只判"有无"挡不住，需数个数。
 */
export function hasMeaningfulText(text?: string | null): boolean {
  if (!text) return false
  const chars = text.replace(/\[[^\]]*\]/g, ' ').match(/[\p{L}\p{N}]/gu)
  return chars != null && chars.length >= 2
}
