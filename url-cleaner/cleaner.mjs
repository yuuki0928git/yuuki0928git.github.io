// No network access: retain raw query bytes, order, duplicates and fragments.
const tracking = new Set(['fbclid', 'gclid', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'twclid', 'ttclid', 'yclid', 'igshid', 'mc_cid', 'mc_eid', '_ga', '_gl']);
const amazon = new Set(['tag', 'linkCode', 'ascsubtag', 'ref_', 'pf_rd_p', 'pf_rd_r', 'pd_rd_w', 'pd_rd_wg', 'pd_rd_r']);
export function cleanUrl(input) {
  const original = input.trim();
  if (!/^https?:\/\//i.test(original) || /[\u0000-\u0020\u007f]/.test(original)) throw new Error('HTTP・HTTPSの完全なURLを入力してください。');
  let parsed;
  try { parsed = new URL(original); } catch { throw new Error('有効なURLを入力してください。'); }
  const hashAt = original.indexOf('#');
  const head = hashAt < 0 ? original : original.slice(0, hashAt);
  const fragment = hashAt < 0 ? '' : original.slice(hashAt);
  const at = head.indexOf('?');
  const entries = at < 0 ? [] : head.slice(at + 1).split('&');
  const decoded = entries.map(part => [...new URLSearchParams(part)][0] || ['', '']);
  // Common signed links are indivisible. Unknown signing schemes cannot be detected.
  if (decoded.some(([key]) => /^(x-amz-|x-goog-)/i.test(key) || /^(signature|sig|token|access_token|policy|key-pair-id|hmac)$/i.test(key))) {
    return { url: original, removed: [], protected: true };
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const isAmazon = /(^|\.)amazon\.(co\.jp|com|co\.uk|de|fr|it|es|ca|com\.au)$/.test(host);
  const removed = [];
  const kept = entries.filter((part, i) => {
    const [name, value] = decoded[i];
    if (/^utm_/i.test(name) || tracking.has(name.toLowerCase()) || (isAmazon && amazon.has(name))) {
      removed.push({ name, value });
      return false;
    }
    return true;
  });
  return { url: removed.length ? head.slice(0, at) + (kept.length ? '?' + kept.join('&') : '') + fragment : original, removed, protected: false };
}
