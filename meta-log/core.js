export function repair(s) {
  if (typeof s !== "string" || [...s].some((c) => c.codePointAt(0) > 255))
    return s;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(s, (c) => c.charCodeAt(0)),
    );
  } catch {
    return s;
  }
}
function deep(v) {
  if (typeof v === "string") return repair(v);
  if (Array.isArray(v)) return v.map(deep);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]));
  return v;
}
export function jst(ms) {
  return new Date(ms + 32400000)
    .toISOString()
    .slice(0, 19)
    .replaceAll("-", ".")
    .split("T");
}
export function version(path) {
  const m = path.match(/ver(\d+)\.(\d)(?=\.txt$)/i);
  return m ? `${m[1]}.${m[2]}` : null;
}
export function nextPath(path) {
  const v = version(path);
  if (!v) throw Error("ファイル名に ver1.0 形式が必要です");
  const [major, minor] = v.split(".").map(Number);
  return path.replace(
    /ver\d+\.\d(?=\.txt$)/i,
    `ver${major + (minor === 9 ? 1 : 0)}.${(minor + 1) % 10}`,
  );
}
export function safePath(p) {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    p.length < 500 &&
    !p.startsWith("/") &&
    !p.includes("\\") &&
    !p.includes(":") &&
    !p.split("/").some((x) => x === ".." || x === ".") &&
    !/[\x00-\x1f]/.test(p)
  );
}
export function parse(txt) {
  const lines = txt.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  let date;
  const records = [];
  for (const l of lines) {
    if (/^\d{4}\.\d{2}\.\d{2}$/.test(l)) {
      if (records.length && records.at(-1).body.endsWith("\n"))
        records.at(-1).body = records.at(-1).body.slice(0, -1);
      date = l;
      continue;
    }
    const m = l.match(/^(\d{2}:\d{2}:\d{2}) ([^:\n]+): (.*)$/);
    if (m) {
      if (!date) throw Error("日付見出しがありません");
      records.push({ date, time: m[1], sender: m[2], body: m[3] });
    } else if (l !== "" || records.length) {
      if (records.length) records.at(-1).body += "\n" + l;
      else if (l.trim()) throw Error("未対応のTXTヘッダー");
    }
  }
  return records;
}
export function normalize(body, names = []) {
  const inline = body.match(/( →[^\n]+\([^\n()]+\)(?: →[^\n]+\([^\n()]+\))*)$/);
  if (inline) {
    const base = body.slice(0, -inline[1].length);
    return normalize(base, names) + inline[1];
  }
  const explicit = body.match(
    /^[（(][^\n()（）]+[）)] reacted (.+) to your message$/,
  );
  if (explicit) return `Reacted ${explicit[1]} to your message`;
  const plain = body.match(/^([^\n]+) reacted (\S+) to your message$/);
  if (plain && names.includes(plain[1]))
    return `Reacted ${plain[2]} to your message`;
  return body;
}
export function normalizeText(txt, names = []) {
  let count = 0;
  const text = txt.replace(
    /^(\d{2}:\d{2}:\d{2} ([^:\n]+): )([^\r\n]*)(\r?)$/gm,
    (_, prefix, sender, content, cr) => {
      const n = normalize(content, [...names, sender]);
      if (n !== content) count++;
      return prefix + n + cr;
    },
  );
  return { text, count };
}
export function messageBody(m, options = {}) {
  let s = typeof m.content === "string" ? m.content : "";
  if (options.compactBlankLines)
    s = s
      .split("\n")
      .filter((l) => l.trim() !== "")
      .join("\n");
  if (options.integrated)
    s = s.replace(
      /https?:\/\/(?:[a-z0-9.-]+\.)?(?:giphy\.com|gph\.is)\/[^\s]+/gi,
      "[スタンプ]",
    );
  if (m.share) {
    const sh = m.share;
    const link = typeof sh.link === "string" ? sh.link : "";
    const story = /\/stories\/|story\.php|\/story\//i.test(link);
    const who =
      typeof sh.username === "string"
        ? sh.username
        : typeof sh.owner === "string"
          ? sh.owner
          : sh.owner?.username;
    const tag = link
      ? `[シェア: ${link}]`
      : who
        ? `[シェア: @${String(who).replace(/^@/, "")}]`
        : "[シェア]";
    if (story || !link || !s || options.ordinaryShareWithContent)
      s = tag + (s ? " " + s : "");
  }
  for (const [key, label, unit] of [
    ["photos", "写真", "枚"],
    ["videos", "動画", "件"],
  ])
    if (m[key]?.length)
      s += (s ? " " : "") + `[${label} ${m[key].length}${unit}]`;
  if (m.audio_files?.length) s += (s ? " " : "") + "[音声メッセージ]";
  if (m.sticker && !options.integrated) s += (s ? " " : "") + "[スタンプ]";
  if (!s && !options.integrated)
    throw Error("未対応または本文のないメッセージがあります");
  return normalize(s, options.names || []);
}
export function reactionStyle(txt, explicit) {
  const inline = / →[^\n]+\([^\n()]+\)/.test(txt);
  const standalone =
    /^\d{2}:\d{2}:\d{2} [^:\n]+: (?:Reacted |[（(].+[）)] reacted |.+ reacted )/m.test(
      txt,
    );
  if (explicit) {
    if (!["standalone", "inline"].includes(explicit))
      throw Error("不明なリアクション形式");
    return explicit;
  }
  if (inline && standalone)
    throw Error(
      "複数のリアクション形式があります。設定で形式を確認してください",
    );
  return inline ? "inline" : "standalone";
}
export function group(inputs) {
  const groups = new Map();
  for (const input of inputs) {
    const d = deep(input);
    if (!Array.isArray(d.messages) || !Array.isArray(d.participants))
      throw Error("Metaメッセージ形式ではありません");
    const id = d.thread_path || d.thread_id;
    if (!id) throw Error("スレッド識別情報がないJSONは結合できません");
    const participants = d.participants.map((p) => p.name).sort();
    const key = String(id);
    if (!groups.has(key))
      groups.set(key, {
        id: key,
        participants,
        messages: [],
        title: d.title || "",
      });
    const g = groups.get(key);
    if (JSON.stringify(g.participants) !== JSON.stringify(participants))
      throw Error("分割JSONの参加者が一致しません");
    g.messages.push(...d.messages);
  }
  return [...groups.values()].map((g) => {
    for (const m of g.messages)
      if (!Number.isSafeInteger(m.timestamp_ms))
        throw Error("timestamp_msが不正です");
    g.messages.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    return g;
  });
}

export function rows(g, options = {}) {
  return g.messages.map((m) => {
    const [date, time] = jst(m.timestamp_ms);
    const base = {
      date,
      time,
      sender: m.sender_name,
      body: messageBody(m, { ...options, names: g.participants }),
      ms: m.timestamp_ms,
    };
    const reactions = (m.reactions || []).map((r) => {
      if (
        typeof r.actor !== "string" ||
        /[\r\n:]/.test(r.actor) ||
        typeof r.reaction !== "string" ||
        /[\r\n]/.test(r.reaction)
      )
        throw Error("リアクションの送信者または絵文字が不正です");
      if (r.timestamp_ms !== undefined && !Number.isSafeInteger(r.timestamp_ms))
        throw Error("リアクションのtimestamp_msが不正です");
      const reactionMs = r.timestamp_ms ?? m.timestamp_ms;
      const [date, time] = jst(reactionMs);
      return {
        ...base,
        date,
        time,
        ms: reactionMs,
        sender: r.actor,
        body: `Reacted ${r.reaction} to your message`,
        reaction: true,
      };
    });
    if (options.reactionFormat === "inline") {
      base.body += (m.reactions || [])
        .map((r) => ` →${r.reaction}(${r.actor})`)
        .join("");
      return { ...base, reactions: [] };
    }
    return { ...base, reactions };
  });
}
function equal(a, b, config) {
  const canon = (n) => config.aliases?.[n] || n;
  return (
    a.date === b.date &&
    a.time === b.time &&
    canon(a.sender) === canon(b.sender) &&
    normalize(a.body, [
      ...Object.keys(config.aliases || {}),
      a.sender,
      b.sender,
    ]) ===
      normalize(b.body, [
        ...Object.keys(config.aliases || {}),
        a.sender,
        b.sender,
      ])
  );
}
export function plan(g, path, bytes, config = {}) {
  try {
    if (g.error) throw Error(g.error);
    if (!safePath(path) || !version(path))
      throw Error("安全なver形式のTXTパスが必要です");
    if (config.integrated?.some((s) => s.path === path))
      throw Error("完全統合版は専用の処理で更新してください");
    const oldText = bytes
      ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      : "";
    if (oldText.includes("――アカウント切替:"))
      throw Error("完全統合版の連動設定が必要です");
    const logConfig =
      config.logs?.find(
        (l) => resolvePath(l.path, new Map([[path, true]])) === path,
      ) || {};
    const format = reactionStyle(oldText, logConfig.reactionFormat);
    const rr = rows(g, {
      reactionFormat: format,
      ordinaryShareWithContent:
        logConfig.ordinaryShareWithContent ??
        /^\d{2}:\d{2}:\d{2} [^:\n]+: \[シェア: (?![^\]\n]*\/stories\/)[^\]\n]+\] .+/m.test(
          oldText,
        ),
    });
    if (!rr.length) throw Error("メッセージがありません");
    if (
      rr.some((r) =>
        r.body
          .split("\n")
          .slice(1)
          .some(
            (l) =>
              /^\d{4}\.\d{2}\.\d{2}$/.test(l) ||
              /^\d{2}:\d{2}:\d{2} [^:]+: /.test(l),
          ),
      )
    )
      throw Error("本文がTXT構造と衝突するため安全に再照合できません");
    const warnings = [];
    if (g.messages.length && g.messages.length % 10000 === 0)
      warnings.push("履歴の打ち切りの可能性");
    if (
      rr.some((r) => typeof r.sender !== "string" || /[\r\n:]/.test(r.sender))
    )
      throw Error("送信者名を安全にTXTへ表記できません");
    if (rr.some((r, i) => i && r.ms === rr[i - 1].ms))
      throw Error("同一ミリ秒の順序を確定できません");

    let old = "",
      oldRows = [],
      start = 0,
      normalizations = 0;
    if (bytes) {
      old = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      oldRows = parse(old);
      if (!oldRows.length) throw Error("既存末尾を解析できません");
      const flat = rr.flatMap((r) => [r, ...r.reactions]);
      const tail = oldRows.slice(-Math.min(5, oldRows.length));
      const hits = [];
      for (let i = tail.length - 1; i < flat.length; i++)
        if (
          tail.every((r, j) => equal(r, flat[i - tail.length + 1 + j], config))
        )
          hits.push(i);
      if (hits.length !== 1)
        throw Error("既存末尾の一致候補が一意ではありません");
      const last = flat[hits[0]];
      const parent = rr.findIndex(
        (r) => r === last || r.reactions.includes(last),
      );
      if (rr[parent].reactions.length && last !== rr[parent].reactions.at(-1))
        throw Error("末尾リアクションの対応を確定できません");
      start = parent + 1;
      if (start < rr.length && rr[start].ms - rr[parent].ms > 6 * 3600000)
        warnings.push("境界直後に6時間以上の空白");
      const norm = normalizeText(old, [
        ...g.participants,
        ...Object.keys(config.aliases || {}),
      ]);
      old = norm.text;
      normalizations = norm.count;
    }
    const added = rr.slice(start);
    const newEvents = added.flatMap((r) => [r, ...r.reactions]);
    if (newEvents.some((r, i) => i && r.ms < newEvents[i - 1].ms))
      throw Error("リアクション時刻と発言の順序を確定できません");
    if (oldRows.length && newEvents.length) {
      const oldLast = oldRows.at(-1);
      if (
        `${newEvents[0].date} ${newEvents[0].time}` <
        `${oldLast.date} ${oldLast.time}`
      )
        throw Error("追記で時刻が逆転するため保留します");
    }
    let text = old;
    let date = oldRows.at(-1)?.date;
    for (const r of added.flatMap((r) => [r, ...r.reactions])) {
      if (text && !text.endsWith("\n")) text += "\n";
      if (date !== r.date) {
        if (text && !text.endsWith("\n\n")) text += "\n";
        text += r.date + "\n";
        date = r.date;
      }
      text += `${r.time} ${r.sender}: ${r.body}\n`;
    }
    const changed = added.length > 0 || normalizations > 0;
    return {
      id: g.id,
      path,
      next: added.length && bytes ? nextPath(path) : path,
      oldVersion: bytes ? version(path) : "—",
      nextVersion: version(added.length && bytes ? nextPath(path) : path),
      count: added.length,
      normalizations,
      last: oldRows.at(-1),
      first: added[0],
      warnings,
      bytes: changed || !bytes ? new TextEncoder().encode(text) : bytes,
      changed,
      held: false,
    };
  } catch (e) {
    return { id: g.id, path, held: true, reason: e.message };
  }
}
export function candidates(g, entries, config) {
  const canon = (n) => config.aliases?.[n] || n;
  const sig = (a) => JSON.stringify(a.map(canon).sort());
  const mapping = config.mappings?.find((m) => m.thread === g.id);
  if (mapping) {
    const actual = resolvePath(
      mapping.path,
      new Map(entries.map((e) => [e.path, true])),
    );
    const exact = entries.filter((e) => e.path === actual);
    if (exact.length) {
      const metadata = config.logs?.find(
        (l) =>
          resolvePath(l.path, new Map(entries.map((e) => [e.path, true]))) ===
          actual,
      );
      if (
        metadata?.participants &&
        sig(metadata.participants) !== sig(g.participants)
      )
        return [];
      return exact;
    }
  }
  return entries.filter((e) => {
    const m = config.logs?.find((x) => x.path === e.path);
    return m && sig(m.participants || []) === sig(g.participants);
  });
}

export function resolvePath(path, entries) {
  if (typeof path !== "string") return null;
  if (entries.has(path)) return path;
  const stem = (p) => p.replace(/ver\d+\.\d(?=\.txt$)/i, "ver*");
  const matches = [...entries.keys()].filter((p) => stem(p) === stem(path));
  return matches.length === 1 ? matches[0] : null;
}
