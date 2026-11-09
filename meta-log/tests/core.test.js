import { test } from "node:test";
import assert from "node:assert/strict";
import { group, plan, jst, repair, nextPath, normalizeText } from "../core.js";
import { zipSync, unzipSync } from "../vendor/fflate-0.8.2.js";
const enc = (s) => new TextEncoder().encode(s);
const ms = Date.UTC(2025, 0, 1, 14, 59, 59);
const msg = (t, content) => ({
  timestamp_ms: t,
  sender_name: "テスト",
  content,
});
const fixture = (messages, id = "synthetic/thread") => ({
  thread_path: id,
  participants: [{ name: "テスト" }],
  messages,
});
const old = "2025.01.01\n23:59:59 テスト: 末尾\n";
test("JST日付またぎ・同秒・改行・一意照合・見出し・繰上げ・再実行", () => {
  const g = group([
    fixture([
      msg(ms, "末尾"),
      msg(ms + 1000, "本文\n続き"),
      msg(ms + 1100, "同秒"),
    ]),
  ])[0];
  const p = plan(g, "dir/test_ver1.9.txt", enc(old));
  assert.equal(p.held, false);
  assert.equal(p.count, 2);
  assert.equal(p.next, "dir/test_ver2.0.txt");
  const txt = new TextDecoder().decode(p.bytes);
  assert.equal(txt.split("2025.01.02").length, 2);
  assert.match(txt, /本文\n続き/);
  assert.equal(plan(g, p.next, p.bytes).count, 0);
  assert.deepEqual(jst(ms + 1000), ["2025.01.02", "00:00:00"]);
});
test("失敗時保留・同ms保留・重複候補", () => {
  assert.equal(
    plan(group([fixture([msg(ms, "別")])])[0], "x_ver1.0.txt", enc(old)).held,
    true,
  );
  assert.equal(
    plan(group([fixture([msg(ms, "a"), msg(ms, "b")])])[0], "x_ver1.0.txt")
      .held,
    true,
  );
  assert.equal(
    plan(
      group([fixture([msg(ms, "末尾"), msg(ms + 1, "末尾")])])[0],
      "x_ver1.0.txt",
      enc(old),
    ).held,
    true,
  );
});
test("共有とリアクション・文字復元・既存置換", () => {
  const g = group([
    fixture([
      {
        ...msg(ms, "返信"),
        share: { link: "https://example.invalid/stories/test" },
        reactions: [{ actor: "試験", reaction: "❤️" }],
      },
      { ...msg(ms + 1, "説明"), share: { username: "sample" } },
      { ...msg(ms + 2, "内容"), share: {} },
    ]),
  ])[0];
  const p = plan(g, "new_ver1.0.txt");
  const text = new TextDecoder().decode(p.bytes);
  assert.match(text, /stories\/test\] 返信/);
  assert.match(text, /Reacted ❤️ to your message/);
  assert.match(text, /\[シェア: @sample\] 説明/);
  assert.match(text, /\[シェア\] 内容/);
  assert.equal(repair("ã\u0081\u0082"), "あ");
  assert.equal(repair("正常😀"), "正常😀");
  const n = normalizeText(
    "23:00:00 試験: (別名) reacted ❤️ to your message\n23:00:01 試験: 通常 (別名) reacted ❤️ to your message\n",
  );
  assert.equal(n.count, 1);
});
test("分割結合・未更新バイト保持", () => {
  const g = group([
    fixture([msg(ms, "末尾")]),
    fixture([msg(ms + 1, "新着")]),
  ])[0];
  assert.equal(g.messages.length, 2);
  const raw = new Uint8Array([0, 255, 13, 10]);
  const z = unzipSync(zipSync({ "dir/unchanged.bin": raw }));
  assert.deepEqual(z["dir/unchanged.bin"], raw);
  assert.equal(nextPath("x_ver9.9.txt"), "x_ver10.0.txt");
});
test("別名照合・リアクション境界・正規化だけなら版維持", () => {
  const input = fixture([msg(ms, "末尾"), msg(ms + 1000, "新着")]);
  input.messages[0].sender_name = "別名";
  const g = group([input])[0];
  assert.equal(
    plan(g, "x_ver1.0.txt", enc(old), { aliases: { 別名: "テスト" } }).count,
    1,
  );
  const reactive = group([
    fixture([
      { ...msg(ms, "末尾"), reactions: [{ actor: "試験", reaction: "👍" }] },
    ]),
  ])[0];
  assert.equal(plan(reactive, "x_ver1.0.txt", enc(old)).held, true);
  const reaction = fixture([
    { ...msg(ms, "(名義) reacted 👍 to your message") },
  ]);
  const p = plan(
    group([reaction])[0],
    "x_ver1.0.txt",
    enc("2025.01.01\n23:59:59 テスト: (名義) reacted 👍 to your message\n"),
  );
  assert.equal(p.count, 0);
  assert.equal(p.normalizations, 1);
  assert.equal(p.next, "x_ver1.0.txt");
});
test("同日見出しなし・時刻が同じでもmsの異なる発言を保持", () => {
  const g = group([
    fixture([msg(ms, "末尾"), msg(ms + 1, "同秒1"), msg(ms + 2, "同秒2")]),
  ])[0];
  const p = plan(g, "x_ver1.0.txt", enc(old));
  assert.equal(p.count, 2);
  assert.equal(new TextDecoder().decode(p.bytes).split("2025.01.01").length, 2);
});
test("本文末尾の改行も再実行で保持・警告・メディア", () => {
  const g = group([
    fixture([
      {
        ...msg(ms, "改行\n\n"),
        photos: [{ uri: "ignored" }],
        videos: [{}],
        audio_files: [{}],
        sticker: { uri: "ignored" },
        call_duration: 3,
      },
      msg(ms + 1000, "末尾\n"),
    ]),
  ])[0];
  const p = plan(g, "x_ver1.0.txt");
  assert.equal(p.held, false);
  assert.equal(plan(g, "x_ver1.0.txt", p.bytes).count, 0);
  const gap = group([
    fixture([msg(ms, "末尾"), msg(ms + 31 * 86400000, "翌月")]),
  ])[0];
  assert.match(plan(gap, "x_ver1.0.txt", enc(old)).warnings.join(""), /6時間/);
  const many = group([
    fixture(Array.from({ length: 10000 }, (_, i) => msg(ms + i, "合成" + i))),
  ])[0];
  assert.match(plan(many, "x_ver1.0.txt").warnings.join(""), /打ち切り/);
});
