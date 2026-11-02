import { cleanUrl } from './cleaner.mjs';
const byId = id => document.getElementById(id);
const input = byId('input'), output = byId('output'), status = byId('status');
const copy = byId('copy'), share = byId('share');
function update() {
  output.value = ''; byId('removed').replaceChildren();
  copy.disabled = share.disabled = true; status.textContent = '';
  if (!input.value.trim()) { byId('count').textContent = 'URLを入力してください。'; return; }
  try {
    const result = cleanUrl(input.value);
    output.value = result.url;
    byId('count').textContent = result.protected ? '署名・認証用パラメータがあるため、URLをそのまま保持しました。' : result.removed.length + '件の追跡パラメータを削除しました。';
    for (const item of result.removed) {
      const li = document.createElement('li');
      li.textContent = item.name + ' = ' + item.value;
      byId('removed').append(li);
    }
    copy.disabled = false;
    share.disabled = typeof navigator.share !== 'function';
  } catch (error) { byId('count').textContent = error.message; }
}
input.addEventListener('input', update);
byId('clear').addEventListener('click', () => { input.value = ''; update(); input.focus(); });
copy.addEventListener('click', async () => {
  const value = output.value;
  try {
    await navigator.clipboard.writeText(value);
    if (output.value === value) status.textContent = 'コピーしました。';
  } catch {
    output.focus(); output.select(); output.setSelectionRange(0, output.value.length);
    status.textContent = 'コピーできませんでした。選択されたリンクを長押し、またはCtrl/Cmd+Cでコピーしてください。';
  }
});
share.addEventListener('click', async () => {
  try { await navigator.share({ url: output.value }); }
  catch (error) { if (error.name !== 'AbortError') status.textContent = '共有できませんでした。コピーして送信してください。'; }
});
if (typeof navigator.share !== 'function') byId('share-help').textContent = 'このブラウザは共有ボタンに対応していません。コピーして送信してください。';
// Clear restored form values; no URL history or browser-storage writes.
window.addEventListener('pageshow', () => { input.value = ''; update(); });
update();
