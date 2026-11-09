import { group, repair } from "./core.js";
import {
  indexZip,
  readEntry,
  conversationFiles,
  ZIP_LIMITS,
  ZipInputError,
} from "./zip-reader.js";
export function threadKey(account, thread) {
  return account
    ? `account:${encodeURIComponent(account)}:${encodeURIComponent(thread)}`
    : String(thread);
}
export function folderThread(path) {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const m = dir.match(
    /(?:^|\/)(inbox|archived_threads|message_requests|filtered_threads|e2ee_cutover)\/(.+)$/,
  );
  return m ? `${m[1]}/${m[2]}` : dir;
}
export function registration(meta, config) {
  const mappings = (config.mappings || []).filter((m) => m.thread === meta.id);
  const sources = (config.integrated || [])
    .flatMap((s) => s.sources || [])
    .filter((s) => s.thread === meta.id);
  if (new Set(mappings.map((m) => m.path)).size > 1)
    return { state: "held", reason: "登録された対応先が複数あります" };
  if (mappings.length || sources.length) return { state: "registered" };
  if (
    meta.account &&
    ((config.mappings || []).some((m) => m.thread === meta.thread) ||
      (config.integrated || []).some((s) =>
        (s.sources || []).some((src) => src.thread === meta.thread),
      ))
  )
    return {
      state: "held",
      reason: "旧設定のスレッドに入力元アカウントの確認が必要です",
    };
  return { state: "skipped" };
}
function parse(bytes) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ZipInputError("会話JSONのUTF-8またはJSON形式が不正です");
  }
}
function metadata(d, account, fallback) {
  const declared = d.thread_path
    ? folderThread(String(d.thread_path) + "/message_1.json")
    : "";
  if (
    fallback &&
    declared &&
    /^(inbox|archived_threads|message_requests|filtered_threads|e2ee_cutover)\//.test(
      fallback,
    ) &&
    declared !== fallback
  )
    throw new ZipInputError(
      "ZIPフォルダとJSONのスレッド識別情報が一致しません",
    );
  const data = { ...d, thread_path: declared || d.thread_id || fallback };
  if (
    !Array.isArray(d.messages) ||
    !Array.isArray(d.participants) ||
    !data.thread_path ||
    !["string", "number"].includes(typeof data.thread_path) ||
    d.participants.some((p) => typeof p?.name !== "string") ||
    d.messages.some((m) => !Number.isSafeInteger(m?.timestamp_ms))
  )
    throw new ZipInputError(
      "Meta会話JSONの参加者・スレッド・時刻を確認できません",
    );
  const participants = d.participants.map((p) => repair(p.name)).sort();
  const thread = String(data.thread_path);
  return {
    data,
    id: threadKey(account, thread),
    thread,
    account,
    title: repair(typeof d.title === "string" ? d.title : ""),
    participants,
    isGroup:
      participants.length !== 2 ||
      d.is_group === true ||
      /group/i.test(String(d.thread_type || "")),
    messageCount: d.messages.length,
  };
}
function groupParts(parts, meta) {
  try {
    const g = group(parts)[0];
    return {
      ...g,
      id: meta.id,
      thread: meta.thread,
      account: meta.account,
      isGroup: meta.isGroup,
    };
  } catch {
    throw new ZipInputError(
      "同一スレッドの分割JSONで参加者・識別情報が一致しません",
    );
  }
}
export async function importConversations({
  archives = [],
  individual = [],
  jsonAccount = "",
  config = {},
  onProgress = () => {},
  limits = ZIP_LIMITS,
  signal,
}) {
  const items = new Map(),
    errors = [],
    failedAccounts = new Set();
  let total = 0,
    mediaSkipped = 0,
    jsonRead = 0;
  function abort() {
    if (signal?.aborted)
      throw new DOMException("処理を中止しました", "AbortError");
  }
  async function read(part) {
    abort();
    const expected = part.entry?.original ?? part.file.size;
    if (expected > limits.json || total + expected > limits.totalJSON)
      throw new ZipInputError("会話JSONの合計サイズが上限を超えています");
    total += expected;
    const bytes = part.entry
      ? await readEntry(part.file, part.entry, limits.json)
      : new Uint8Array(await part.file.arrayBuffer());
    jsonRead++;
    return parse(bytes);
  }
  function error(account, reason, input) {
    errors.push({
      id: `入力保留 ${errors.length + 1}`,
      account,
      reason,
      input,
    });
    failedAccounts.add(account);
  }
  async function process(parts, account, fallback, input) {
    let meta;
    const loaded = [];
    let fault = "";
    for (const part of parts) {
      try {
        const d = await read(part);
        const m = metadata(d, account, fallback);
        if (
          meta &&
          (m.thread !== meta.thread ||
            JSON.stringify(m.participants) !==
              JSON.stringify(meta.participants) ||
            m.isGroup !== meta.isGroup)
        )
          throw new ZipInputError(
            "同じフォルダの分割JSONでスレッドまたは参加者が異なります",
          );
        meta ||= m;
        loaded.push(m.data);
      } catch (e) {
        if (e.name === "AbortError") throw e;
        fault =
          e instanceof ZipInputError ? e.message : "会話JSONを読み込めません";
      }
    }
    if (!meta) {
      meta = {
        id: threadKey(
          account,
          fallback || `unresolved-input-${items.size + 1}`,
        ),
        thread: fallback || `unresolved-input-${items.size + 1}`,
        account,
        title: input || fallback,
        participants: [],
        isGroup: false,
        messageCount: 0,
      };
    }
    const old = items.get(meta.id);
    if (old && old.isGroup !== meta.isGroup)
      fault = "同一識別情報の会話種別が一致しません";
    const route = registration(meta, config);
    const item = old || {
      ...meta,
      messageCount: 0,
      parts: [],
      inputs: [],
      data: [],
      state: route.state,
      reason: route.reason || "",
    };
    item.parts.push(...parts);
    item.inputs.push(input);
    item.messageCount += loaded.reduce((s, d) => s + d.messages.length, 0);
    if (fault) {
      item.state = "held";
      item.reason = fault;
      item.data = [];
      item.readError = true;
    } else if (item.state === "registered") {
      item.data.push(...loaded);
    }
    // No skipped message bodies survive this iteration; a user can explicitly reload this thread later.
    items.set(meta.id, item);
    onProgress({ jsonRead, threads: items.size });
    await new Promise((r) => setTimeout(r, 0));
  }
  for (const source of archives) {
    const account = source.account?.trim();
    if (!account) {
      error("", "入力元アカウントを指定してください", source.file.name);
      continue;
    }
    const before = new Set(items.keys());
    try {
      const entries = await indexZip(source.file, limits);
      const json = conversationFiles(entries);
      mediaSkipped += entries.length - json.length;
      if (!json.length)
        throw new ZipInputError(
          "message_N.json形式の会話JSONがZIP内にありません",
        );
      const folders = new Map();
      for (const entry of json) {
        const dir = entry.name.includes("/")
          ? entry.name.slice(0, entry.name.lastIndexOf("/"))
          : "";
        if (!folders.has(dir)) folders.set(dir, []);
        folders.get(dir).push({ file: source.file, entry });
      }
      for (const [dir, parts] of folders) {
        parts.sort((a, b) =>
          a.entry.name.localeCompare(b.entry.name, undefined, {
            numeric: true,
          }),
        );
        await process(
          parts,
          account,
          folderThread(dir + "/message_1.json"),
          source.file.name,
        );
      }
    } catch (e) {
      if (e.name === "AbortError") throw e;
      for (const key of [...items.keys()])
        if (!before.has(key) && items.get(key).account === account)
          items.delete(key);
      error(
        account,
        e instanceof ZipInputError ? e.message : "ZIPの読み込みに失敗しました",
        source.file.name,
      );
    }
  }
  // Individually selected shards retain their legacy thread identity unless an account is explicitly supplied.
  for (const file of individual)
    await process([{ file }], jsonAccount.trim(), "", file.name);
  const catalog = [...items.values()];
  for (const item of catalog) {
    if (failedAccounts.has(item.account)) {
      item.state = "held";
      item.reason = "同じ入力元アカウントのZIPに読み込めない入力があります";
      item.data = [];
      item.readError = true;
    }
    if (item.state === "registered") {
      try {
        item.group = groupParts(item.data, item);
      } catch (e) {
        item.state = "held";
        item.reason = e.message;
        item.readError = true;
      }
    }
    item.data = [];
    item.load = async () => {
      if (item.readError) throw new ZipInputError(item.reason);
      const parts = [];
      for (const part of item.parts)
        parts.push(metadata(await read(part), item.account, item.thread).data);
      const g = groupParts(parts, item);
      if (g.isGroup && item.isGroup === false)
        throw new ZipInputError("会話の参加者情報が一致しません");
      return g;
    };
  }
  return {
    catalog,
    errors,
    stats: { jsonRead, mediaSkipped, totalJSON: total },
  };
}
