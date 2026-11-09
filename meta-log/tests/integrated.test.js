import { test } from "node:test";
import assert from "node:assert/strict";
import { group, jst, plan, normalizeText } from "../core.js";
import {
  renderIntegrated,
  parseIntegrated,
  planIntegrated,
  integratedRows,
} from "../integrated.js";
const ms = Date.UTC(2025, 0, 1, 14, 59, 59);
const enc = (s) => new TextEncoder().encode(s);
const m = (offset, content, sender = "合成A") => ({
  timestamp_ms: ms + offset,
  sender_name: sender,
  content,
});
const g = (id, messages) =>
  group([
    {
      thread_path: id,
      participants: [{ name: "合成A" }, { name: "合成B" }],
      messages,
    },
  ])[0];
const row = (offset, body, label = "IG(A)", sender = "合成A") => {
  const [date, time] = jst(ms + offset);
  return { date, time, sender, body, label };
};
const spec = {
  path: "archive/full_ver1.9.txt",
  initialLabel: "IG(A)",
  triggerThreads: ["source-a"],
  sources: [
    { thread: "source-a", label: "IG(A)", rename: {} },
    { thread: "source-b", label: "IG(B)", rename: {} },
  ],
};
test("統合版の完全往復・切替・別アカウント並行会話の挿入・再実行0", () => {
  const events = [
    row(0, "開始"),
    row(2000, "別アカウント", "IG(B)"),
    row(4000, "既存末尾"),
  ];
  const original = renderIntegrated(events);
  assert.equal(
    renderIntegrated(
      parseIntegrated(original, "IG(A)", ["IG(A)", "IG(B)"]).events,
    ),
    original,
  );
  const groups = [
    g("source-a", [
      m(0, "開始"),
      m(1000, "穴埋め"),
      m(4000, "既存末尾"),
      m(5000, "新着"),
    ]),
    g("source-b", [m(2000, "別アカウント"), m(3000, "並行")]),
  ];
  const p = planIntegrated(spec, groups, enc(original));
  assert.equal(p.held, false, p.reason);
  assert.equal(p.count, 3);
  assert.equal(p.next, "archive/full_ver2.0.txt");
  const text = new TextDecoder().decode(p.bytes);
  const parsed = parseIntegrated(text, "IG(A)", ["IG(A)", "IG(B)"]);
  assert.deepEqual(
    parsed.events.map((r) => r.body),
    ["開始", "穴埋め", "別アカウント", "並行", "既存末尾", "新着"],
  );
  assert.match(text, /――アカウント切替: IG\(B\) → IG\(A\)――/);
  assert.equal(
    planIntegrated({ ...spec, path: p.next }, groups, p.bytes).count,
    0,
  );
});
test("統合専用表記・actor置換・GIF・空スタンプ・ストーリー最新指示", () => {
  const source = {
    thread: "source-a",
    label: "IG(A)",
    rename: { 匿名: "合成名" },
    compactBlankLines: true,
    suppressOrdinaryShareWithContent: true,
  };
  const gg = g("source-a", [
    {
      ...m(0, "本文\n\n続き", "匿名"),
      reactions: [{ actor: "匿名", reaction: "❤️" }],
    },
    {
      ...m(1000, "返信"),
      share: { link: "https://example.invalid/stories/s" },
    },
    { ...m(2000, "通常"), share: { link: "https://example.invalid/post/p" } },
    m(3000, "https://media.giphy.com/media/sample/giphy.gif"),
    {
      timestamp_ms: ms + 4000,
      sender_name: "合成A",
      sticker: { uri: "local" },
    },
    { ...m(5000, "本文"), share: { username: "sample" } },
  ]);
  const rr = integratedRows(gg, source);
  assert.equal(rr[0].body, "本文\n続き →❤️(合成名)");
  assert.equal(rr[0].sender, "合成名");
  assert.equal(rr[1].body, "[シェア: https://example.invalid/stories/s] 返信");
  assert.equal(rr[2].body, "通常");
  assert.equal(rr[3].body, "[スタンプ]");
  assert.equal(rr[4].body, "");
  assert.equal(rr[5].body, "[シェア: @sample] 本文");
  const text = renderIntegrated(rr);
  assert.equal(
    renderIntegrated(parseIntegrated(text, "IG(A)", ["IG(A)"]).events),
    text,
  );
});
test("統合版の往復不一致・不明ソース・不確定同秒・内容不一致は保留", () => {
  const original = renderIntegrated([row(0, "開始")]);
  assert.equal(
    planIntegrated(
      spec,
      [g("source-a", [m(1000, "新着")])],
      enc(original.trimEnd()),
    ).held,
    true,
  );
  assert.equal(
    planIntegrated(
      { ...spec, initialLabel: "不明" },
      [g("source-a", [m(1000, "新着")])],
      enc(original),
    ).held,
    true,
  );
  assert.equal(
    planIntegrated(
      spec,
      [g("source-b", [m(100, "同秒の別ソース")])],
      enc(original),
    ).held,
    true,
  );
  assert.equal(
    planIntegrated(spec, [g("source-a", [m(0, "違う内容")])], enc(original))
      .held,
    true,
  );
});
test("同秒でも元JSONでms確定なら別ソースの発言を保持・既存を改変しない", () => {
  const original = renderIntegrated([row(0, "開始")]);
  const p = planIntegrated(
    spec,
    [g("source-a", [m(0, "開始")]), g("source-b", [m(100, "別の発言")])],
    enc(original),
  );
  assert.equal(p.held, false, p.reason);
  assert.equal(p.count, 1);
  assert.match(new TextDecoder().decode(p.bytes), /別の発言/);
  const equalms = planIntegrated(
    spec,
    [g("source-a", [m(0, "開始")]), g("source-b", [m(0, "別の発言")])],
    enc(original),
  );
  assert.equal(equalms.held, true);
});
test("通常ログの既存インライン形式・添付枚数・通話本文を保持", () => {
  const gg = g("source-a", [
    { ...m(0, "末尾"), reactions: [{ actor: "合成B", reaction: "👍" }] },
    { ...m(1000, "You started an audio call"), call_duration: 30 },
    {
      timestamp_ms: ms + 2000,
      sender_name: "合成A",
      photos: [{}, {}],
      reactions: [{ actor: "合成B", reaction: "❤️" }],
    },
  ]);
  const old = "2025.01.01\n23:59:59 合成A: 末尾 →👍(合成B)\n";
  const p = plan(gg, "x_ver1.0.txt", enc(old));
  assert.equal(p.held, false, p.reason);
  const text = new TextDecoder().decode(p.bytes);
  assert.match(text, /\[写真 2枚\] →❤️\(合成B\)/);
  assert.match(text, /You started an audio call\n/);
  assert.equal(plan(gg, p.next, p.bytes).count, 0);
  const normalized = normalizeText(
    "23:59:59 合成A: 合成B reacted 👍 to your message\n23:59:59 合成A: 感想 reacted 👍 to your message\n",
    ["合成B"],
  );
  assert.equal(normalized.count, 1);
});
