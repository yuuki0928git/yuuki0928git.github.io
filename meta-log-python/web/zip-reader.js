import { inflateSync } from "./vendor/fflate-0.8.2.js";
import { safePath } from "./safe-path.js?v=20261110-py1";
export class ZipInputError extends Error {}
export const ZIP_LIMITS = {
  entries: 100000,
  directory: 32 * 1024 * 1024,
  json: 32 * 1024 * 1024,
  totalJSON: 256 * 1024 * 1024,
};
const u16 = (b, p) => b[p] | (b[p + 1] << 8);
const u32 = (b, p) =>
  (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
function fail(message) {
  throw new ZipInputError(message);
}
async function slice(blob, start, length) {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(length) ||
    start < 0 ||
    length < 0 ||
    start + length > blob.size
  )
    fail("ZIP内の位置・長さが不正です");
  const b = new Uint8Array(
    await blob.slice(start, start + length).arrayBuffer(),
  );
  if (b.length !== length) fail("ZIPを最後まで読み込めません");
  return b;
}
function text(bytes, flags) {
  if (!(flags & 0x800) && bytes.some((x) => x > 127))
    fail("UTF-8でないZIPのファイル名には対応していません");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("ZIP内のファイル名が不正です");
  }
}
function integer64(bytes, p) {
  if (p + 8 > bytes.length) fail("ZIP64の管理情報が破損しています");
  const n = u32(bytes, p) + u32(bytes, p + 4) * 4294967296;
  if (!Number.isSafeInteger(n))
    fail("ZIP64のサイズがブラウザの安全な上限を超えています");
  return n;
}
export async function indexZip(blob, limits = ZIP_LIMITS) {
  if (blob.size < 22)
    fail("ZIPの終端情報がありません（破損またはZIP以外の入力）");
  const last = await slice(blob, blob.size - 22, 22);
  const short = u32(last, 0) === 0x06054b50 && u16(last, 20) === 0;
  const start = short ? blob.size - 22 : Math.max(0, blob.size - 65557);
  const tail = short ? last : await slice(blob, start, blob.size - start);
  let end = -1;
  for (let p = tail.length - 22; p >= 0; p--)
    if (
      u32(tail, p) === 0x06054b50 &&
      p + 22 + u16(tail, p + 20) === tail.length
    ) {
      end = p;
      break;
    }
  if (end < 0)
    fail("ZIPの終端情報が見つかりません（破損・分割ZIPは処理できません）");
  if (u16(tail, end + 4) || u16(tail, end + 6))
    fail("複数ディスクに分割されたZIPには対応していません");
  let count = u16(tail, end + 10),
    size = u32(tail, end + 12),
    offset = u32(tail, end + 16),
    directoryEnd = start + end;
  if (count === 65535 || size === 0xffffffff || offset === 0xffffffff) {
    const locator = await slice(blob, start + end - 20, 20);
    if (
      u32(locator, 0) !== 0x07064b50 ||
      u32(locator, 4) ||
      u32(locator, 16) !== 1
    )
      fail("ZIP64の位置情報が不正または複数ディスクです");
    const zOffset = integer64(locator, 8);
    const z = await slice(blob, zOffset, 56);
    if (u32(z, 0) !== 0x06064b50 || u32(z, 16) || u32(z, 20))
      fail("ZIP64の管理情報が不正です");
    count = integer64(z, 32);
    if (integer64(z, 24) !== count) fail("分割ZIP64には対応していません");
    size = integer64(z, 40);
    offset = integer64(z, 48);
    directoryEnd = zOffset;
  } else if (u16(tail, end + 8) !== count) fail("分割ZIPには対応していません");
  if (count > limits.entries || size > limits.directory)
    fail("ZIPのファイル数または管理情報が上限を超えています");
  if (offset + size > directoryEnd) fail("ZIPのファイル一覧が破損しています");
  const directory = await slice(blob, offset, size),
    entries = [],
    names = new Set();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > directory.length || u32(directory, p) !== 0x02014b50)
      fail("ZIPのファイル一覧を読み込めません");
    const flags = u16(directory, p + 8),
      method = u16(directory, p + 10),
      crc = u32(directory, p + 16),
      n = u16(directory, p + 28),
      extraLength = u16(directory, p + 30),
      comment = u16(directory, p + 32);
    if (p + 46 + n + extraLength + comment > directory.length)
      fail("ZIPのファイル一覧が途中で切れています");
    const name = text(directory.subarray(p + 46, p + 46 + n), flags);
    if (!safePath(name) || names.has(name))
      fail("ZIPに不正なパスまたは重複ファイル名があります");
    names.add(name);
    let compressed = u32(directory, p + 20),
      original = u32(directory, p + 24),
      local = u32(directory, p + 42),
      disk = u16(directory, p + 34);
    if (
      compressed === 0xffffffff ||
      original === 0xffffffff ||
      local === 0xffffffff ||
      disk === 65535
    ) {
      const extra = directory.subarray(p + 46 + n, p + 46 + n + extraLength);
      let q = 0,
        found = false;
      while (q + 4 <= extra.length) {
        const type = u16(extra, q),
          len = u16(extra, q + 2);
        q += 4;
        if (q + len > extra.length) fail("ZIP64の拡張情報が破損しています");
        if (type === 1) {
          const info = extra.subarray(q, q + len);
          let at = 0;
          const read = () => {
            const value = integer64(info, at);
            at += 8;
            return value;
          };
          if (original === 0xffffffff) original = read();
          if (compressed === 0xffffffff) compressed = read();
          if (local === 0xffffffff) local = read();
          if (disk === 65535) {
            if (at + 4 > info.length) fail("ZIP64のディスク情報が不正です");
            disk = u32(info, at);
          }
          found = true;
          break;
        }
        q += len;
      }
      if (!found) fail("ZIP64の拡張情報がありません");
    }
    if (disk) fail("分割ZIPには対応していません");
    if (local + 30 > offset || local + compressed > offset)
      fail("ZIP内のファイル位置が不正です");
    entries.push({
      name,
      flags,
      method,
      crc,
      compressed,
      original,
      local,
      directoryOffset: offset,
    });
    p += 46 + n + extraLength + comment;
  }
  if (p !== directory.length) fail("ZIPの管理情報に未対応のデータがあります");
  return entries;
}
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(bytes) {
  let n = 0xffffffff;
  for (const b of bytes) n = table[(n ^ b) & 255] ^ (n >>> 8);
  return (n ^ 0xffffffff) >>> 0;
}
export async function readEntry(blob, entry, limit = ZIP_LIMITS.json) {
  if (entry.original > limit || entry.compressed > limit)
    fail("会話JSONのサイズが上限を超えています");
  if (entry.flags & 1) fail("暗号化された会話JSONは読み込めません");
  if (![0, 8].includes(entry.method))
    fail("会話JSONの圧縮形式に対応していません");
  const h = await slice(blob, entry.local, 30);
  if (
    u32(h, 0) !== 0x04034b50 ||
    u16(h, 8) !== entry.method ||
    u16(h, 6) !== entry.flags
  )
    fail("ZIP内のファイルヘッダーが破損しています");
  const n = u16(h, 26),
    extra = u16(h, 28),
    name = text(await slice(blob, entry.local + 30, n), entry.flags);
  if (name !== entry.name) fail("ZIP内のファイル名が一覧と一致しません");
  const at = entry.local + 30 + n + extra;
  if (at + entry.compressed > entry.directoryOffset)
    fail("ZIP内の会話JSONの位置が不正です");
  const compressed = await slice(blob, at, entry.compressed);
  let bytes;
  try {
    bytes =
      entry.method === 0
        ? compressed
        : inflateSync(compressed, { out: new Uint8Array(entry.original) });
  } catch {
    fail("会話JSONの解凍に失敗しました");
  }
  if (bytes.length !== entry.original || crc32(bytes) !== entry.crc)
    fail("会話JSONの長さ・CRCが一致しません（破損データ）");
  return bytes;
}
export function conversationFiles(entries) {
  return entries.filter((e) => /(^|\/)message_[1-9]\d*\.json$/i.test(e.name));
}
