import {
  jst,
  messageBody,
  normalize,
  nextPath,
  safePath,
  version,
} from "./core.js";
const DATE = /^\d{4}\.\d{2}\.\d{2}$/;
const MESSAGE = /^(\d{2}:\d{2}:\d{2}) ([^:\n]+): (.*)$/;
const SWITCH = /^――アカウント切替: (.+) → (.+)――$/;
function seconds(r) {
  const n = Date.parse(`${r.date.replaceAll(".", "-")}T${r.time}+09:00`);
  if (!Number.isFinite(n)) throw Error("統合版の日時が不正です");
  return n;
}
function validLabel(s) {
  return (
    typeof s === "string" &&
    s.length > 0 &&
    !/[\r\n]/.test(s) &&
    !s.includes(" → ") &&
    !s.includes("――")
  );
}
export function renderIntegrated(events, eol = "\n") {
  let text = "",
    date,
    label;
  for (const r of events) {
    if (label !== undefined && label !== r.label)
      text += `\n――アカウント切替: ${label} → ${r.label}――\n`;
    if (date !== r.date) {
      if (text) text += "\n";
      text += r.date + "\n";
      date = r.date;
    }
    text += `${r.time} ${r.sender}: ${r.body}\n`;
    label = r.label;
  }
  return eol === "\r\n" ? text.replaceAll("\n", "\r\n") : text;
}
export function parseIntegrated(text, initialLabel, allowed) {
  if (!validLabel(initialLabel)) throw Error("先頭ソースのラベルが必要です");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (eol === "\r\n" && text.replaceAll("\r\n", "").includes("\n"))
    throw Error("改行コードが混在しています");
  const lines = text.split(eol);
  if (lines.at(-1) === "") lines.pop();
  let date,
    label = initialLabel;
  const events = [];
  for (const line of lines) {
    const sw = line.match(SWITCH);
    if (sw || DATE.test(line)) {
      if (events.length && events.at(-1).body.endsWith("\n"))
        events.at(-1).body = events.at(-1).body.slice(0, -1);
      if (sw) {
        if (sw[1] !== label || !allowed.includes(sw[2]))
          throw Error("アカウント切替のソースを確定できません");
        label = sw[2];
      } else date = line;
    } else {
      const m = line.match(MESSAGE);
      if (m) {
        if (!date) throw Error("統合版の日付がありません");
        events.push({
          date,
          time: m[1],
          sender: m[2],
          body: m[3],
          label,
          index: events.length,
        });
      } else if (events.length) events.at(-1).body += "\n" + line;
      else if (line !== "") throw Error("統合版に未対応の先頭行があります");
    }
  }
  if (!events.length || renderIntegrated(events, eol) !== text)
    throw Error("統合版の解析→再出力が元TXTと一致しません");
  for (const [i, r] of events.entries()) {
    r.second = seconds(r);
    if (i && r.second < events[i - 1].second)
      throw Error("既存統合版に時刻逆転があります。推測で修正せず保留");
  }
  return { events, eol };
}
export function integratedRows(g, source) {
  const rename = (n) => source.rename?.[n] || n;
  return g.messages.map((m) => {
    const [date, time] = jst(m.timestamp_ms);
    const sender = rename(m.sender_name);
    if (typeof sender !== "string" || /[\r\n:]/.test(sender))
      throw Error("統合版の送信者名が不正です");
    let body = messageBody(m, {
      integrated: true,
      ordinaryShareWithContent: !source.suppressOrdinaryShareWithContent,
      compactBlankLines: source.compactBlankLines,
      names: g.participants,
    });
    body += (m.reactions || [])
      .map((r) => {
        const actor = rename(r.actor);
        if (
          typeof actor !== "string" ||
          /[\r\n]/.test(actor) ||
          typeof r.reaction !== "string" ||
          /[\r\n]/.test(r.reaction)
        )
          throw Error("統合版のリアクションが不正です");
        return ` →${r.reaction}(${actor})`;
      })
      .join("");
    if (
      body
        .split("\n")
        .some(
          (l, i) => i && (DATE.test(l) || MESSAGE.test(l) || SWITCH.test(l)),
        )
    )
      throw Error("本文が統合版の構造と衝突しています");
    return {
      date,
      time,
      sender,
      body,
      label: source.label,
      ms: m.timestamp_ms,
      second: Math.floor(m.timestamp_ms / 1000) * 1000,
      thread: g.id,
    };
  });
}
function bucket(r) {
  return JSON.stringify([r.label, r.date, r.time, r.sender]);
}
function identity(r, names = []) {
  return JSON.stringify([
    r.label,
    r.date,
    r.time,
    r.sender,
    normalize(r.body, names),
  ]);
}
export function planIntegrated(spec, groups, bytes) {
  const id = `統合版: ${spec.path || "未設定"}`;
  try {
    if (!safePath(spec.path) || !version(spec.path) || !bytes)
      throw Error("既存統合TXTと対応先の設定が必要です");
    if (
      !Array.isArray(spec.sources) ||
      !spec.sources.length ||
      spec.sources.some(
        (s) =>
          typeof s !== "object" ||
          !validLabel(s.label) ||
          typeof s.thread !== "string",
      )
    )
      throw Error("統合ソース・ラベル・スレッドを設定してください");
    const labels = spec.sources.map((s) => s.label);
    if (new Set(labels).size !== labels.length)
      throw Error("統合ソースのラベルが重複しています");
    const threads = spec.sources.map((s) => s.thread);
    if (new Set(threads).size !== threads.length)
      throw Error("同一スレッドが複数ラベルへ指定されています");
    if (!labels.includes(spec.initialLabel))
      throw Error("先頭ソースが設定にありません");
    if ((spec.triggerThreads || []).some((t) => !threads.includes(t)))
      throw Error("連動する通常ログのスレッドが統合ソースにありません");
    const names = [
      ...new Set([
        ...groups.flatMap((g) => g.participants),
        ...spec.sources.flatMap((s) => [
          ...Object.keys(s.rename || {}),
          ...Object.values(s.rename || {}),
        ]),
      ]),
    ];
    const decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const { events, eol } = parseIntegrated(decoded, spec.initialLabel, labels);
    const baseline = new Map();
    for (const r of events) {
      const key = bucket(r);
      if (!baseline.has(key)) baseline.set(key, []);
      baseline.get(key).push(r);
    }
    const added = [];
    let received = 0;
    for (const src of spec.sources) {
      const found = groups.filter((g) => g.id === src.thread);
      if (found.length > 1) throw Error("統合対象スレッドが一意ではありません");
      if (!found.length) continue;
      const g = found[0];
      if (g.error) throw Error("統合対象JSONの解析に失敗しています");
      received++;
      const rows = integratedRows(g, src);
      if (rows.some((r, i) => i && r.ms === rows[i - 1].ms))
        throw Error("統合元に同一ミリ秒の順序が不明な発言があります");
      const buckets = new Map();
      for (const r of rows) {
        const key = bucket(r);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(r);
      }
      for (const [key, incoming] of buckets) {
        const old = baseline.get(key) || [];
        const used = new Set();
        for (const r of old) {
          const matches = incoming.filter(
            (n) => identity(n, names) === identity(r, names),
          );
          if (matches.length !== 1 || used.has(matches[0]))
            throw Error("統合版の同秒の内容・個数が元JSONと一意に一致しません");
          r.ms = matches[0].ms;
          used.add(matches[0]);
        }
        for (const r of incoming) if (!used.has(r)) added.push(r);
      }
    }
    if (!received) throw Error("統合版の設定に一致する元JSONがありません");
    const known = events.filter((r) => r.ms !== undefined);
    for (let i = 1; i < known.length; i++)
      if (known[i].ms < known[i - 1].ms)
        throw Error("元JSONのミリ秒と既存統合版の順序が矛盾します");
    const bySecond = new Map();
    for (const e of events) {
      if (!bySecond.has(e.second)) bySecond.set(e.second, []);
      bySecond.get(e.second).push(e);
    }
    for (const r of added) {
      const same = bySecond.get(r.second) || [];
      if (same.some((e) => e.ms === undefined || e.ms === r.ms))
        throw Error("同秒にある既存発言のミリ秒または挿入位置を確定できません");
    }
    const newSorted = [...added].sort((a, b) => a.ms - b.ms);
    if (newSorted.some((r, i) => i && r.ms === newSorted[i - 1].ms))
      throw Error("別アカウント間の同一ミリ秒の順序を確定できません");
    let normalizations = 0;
    for (const r of events) {
      const body = normalize(r.body, names);
      if (body !== r.body) {
        r.body = body;
        normalizations++;
      }
    }
    const merged = [...events, ...added].sort((a, b) => {
      if (a.second !== b.second) return a.second - b.second;
      if (a.index !== undefined && b.index !== undefined)
        return a.index - b.index;
      return a.ms - b.ms;
    });
    const output = renderIntegrated(merged, eol);
    const changed = added.length > 0 || normalizations > 0;
    const next = added.length ? nextPath(spec.path) : spec.path;
    return {
      id,
      path: spec.path,
      next,
      oldVersion: version(spec.path),
      nextVersion: version(next),
      held: false,
      changed,
      bytes: changed ? new TextEncoder().encode(output) : bytes,
      count: added.length,
      normalizations,
      last: events.at(-1),
      first: newSorted[0],
      warnings: [
        "既存TXTの解析→再出力一致を確認済み",
        ...spec.sources
          .filter((s) => !groups.some((g) => g.id === s.thread))
          .map((s) => `${s.label}: 今回のJSONなし、既存部分を維持`),
      ],
      integrated: true,
    };
  } catch (e) {
    return {
      id,
      path: spec.path,
      held: true,
      reason: e.message,
      integrated: true,
    };
  }
}
