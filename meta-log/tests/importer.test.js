import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "../vendor/fflate-0.8.2.js";
import {
  indexZip,
  readEntry,
  conversationFiles,
  ZIP_LIMITS,
} from "../zip-reader.js";
import { importConversations, threadKey } from "../importer.js";
import { plan } from "../core.js";
import { planIntegrated, renderIntegrated } from "../integrated.js";
const enc = (s) => new TextEncoder().encode(s);
const ms = Date.UTC(2025, 0, 1, 14, 59, 59);
const msg = (n, text) => ({
  timestamp_ms: ms + n,
  sender_name: "合成A",
  content: text,
});
const fixture = (thread, messages, participants = ["合成A", "合成B"]) => ({
  thread_path: thread,
  participants: participants.map((name) => ({ name })),
  title: "合成会話",
  messages,
});
const jf = (d) => enc(JSON.stringify(d));
const file = (bytes, name = "synthetic.zip") =>
  Object.assign(new Blob([bytes]), { name });
const path = (id, n = 1) =>
  `your_instagram_activity/messages/inbox/${id}/message_${n}.json`;
function config(account = "account-A") {
  return {
    schemaVersion: 2,
    mappings: [
      { thread: threadKey(account, "inbox/target"), path: "normal_ver1.9.txt" },
      { thread: threadKey(account, "inbox/group-a"), path: "group_ver1.0.txt" },
    ],
    integrated: [],
    aliases: {},
    logs: [],
  };
}
test("混在ZIPの登録対象だけ読込・分割結合・未登録本文非保持・メディア未展開", async () => {
  const media = new Uint8Array(1024 * 1024).fill(127);
  const bytes = zipSync({
    [path("target")]: jf(fixture("inbox/target", [msg(1000, "新着")])),
    [path("target", 2)]: jf(fixture("inbox/target", [msg(0, "末尾")])),
    [path("unrelated")]: jf(
      fixture("inbox/unrelated", [msg(1, "UNREGISTERED_PRIVATE_BODY")]),
    ),
    [path("group-a")]: jf(
      fixture(
        "inbox/group-a",
        [msg(0, "グループ末尾"), msg(1000, "グループ新着")],
        ["合成A", "合成B", "合成C"],
      ),
    ),
    [path("group-b")]: jf(
      fixture(
        "inbox/group-b",
        [msg(2, "OTHER_GROUP_BODY")],
        ["合成A", "合成B", "合成C"],
      ),
    ),
    "photos/private.jpg": [media, { level: 0 }],
    "videos/private.mp4": [media, { level: 0 }],
  });
  const base = file(bytes);
  const spans = [];
  const observed = {
    size: base.size,
    name: base.name,
    slice: (a, b) => {
      spans.push([a, b]);
      return base.slice(a, b);
    },
  };
  const index = await indexZip(base);
  const photos = index.filter((e) => /private\.(jpg|mp4)$/.test(e.name));
  const r = await importConversations({
    archives: [{ file: observed, account: "account-A" }],
    config: config(),
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.catalog.length, 4);
  const target = r.catalog.find((i) => i.thread === "inbox/target");
  assert.equal(target.group.messages.length, 2);
  assert.equal(
    plan(
      target.group,
      "normal_ver1.9.txt",
      enc("2025.01.01\n23:59:59 合成A: 末尾\n"),
    ).count,
    1,
  );
  assert.equal(r.catalog.filter((i) => i.state === "skipped").length, 2);
  const unknown = r.catalog.find((i) => i.thread === "inbox/unrelated");
  assert.equal(unknown.group, undefined);
  assert.equal(
    JSON.stringify(unknown).includes("UNREGISTERED_PRIVATE_BODY"),
    false,
  );
  assert.equal(r.stats.mediaSkipped, 2);
  for (const e of photos) {
    const dataStart = e.local + 30 + enc(e.name).length;
    assert.equal(
      spans.some(([a, b]) => a < dataStart + e.compressed && b > dataStart),
      false,
      "Media data was read",
    );
  }
  const loaded = await unknown.load();
  assert.equal(loaded.messages[0].content, "UNREGISTERED_PRIVATE_BODY");
});
test("同参加者・同スレッド文字列でも別アカウントのZIPを誤結合しない", async () => {
  const a = file(
    zipSync({
      [path("target")]: jf(
        fixture("inbox/target", [msg(0, "末尾"), msg(1000, "A新着")]),
      ),
    }),
    "a.zip",
  );
  const b = file(
    zipSync({
      [path("target")]: jf(
        fixture("inbox/target", [msg(0, "別アカウント"), msg(2000, "B新着")]),
      ),
    }),
    "b.zip",
  );
  const r = await importConversations({
    archives: [
      { file: a, account: "account-A" },
      { file: b, account: "account-B" },
    ],
    config: config(),
  });
  assert.equal(r.catalog.length, 2);
  assert.equal(r.catalog[0].group.messages.length, 2);
  assert.equal(r.catalog[1].state, "skipped");
  assert.notEqual(r.catalog[0].id, r.catalog[1].id);
});
test("個別JSONを維持・同一アカウントの明示的同一スレッドはZIP間の分割も結合", async () => {
  const first = fixture("inbox/target", [msg(0, "末尾")]);
  const second = fixture("inbox/target", [msg(1000, "新着")]);
  const r = await importConversations({
    individual: [
      file(jf(first), "message_2.json"),
      file(jf(second), "random.json"),
    ],
    config: {
      mappings: [{ thread: "inbox/target", path: "normal_ver1.0.txt" }],
    },
  });
  assert.equal(r.catalog[0].state, "registered");
  assert.equal(r.catalog[0].group.messages.length, 2);
  const z = await importConversations({
    archives: [
      {
        file: file(zipSync({ [path("target", 2)]: jf(first) })),
        account: "account-A",
      },
      {
        file: file(zipSync({ [path("target")]: jf(second) })),
        account: "account-A",
      },
    ],
    config: config(),
  });
  assert.equal(z.catalog.length, 1);
  assert.equal(z.catalog[0].group.messages.length, 2);
});
test("旧設定のアカウント未指定・複数候補は保留して利用者が解決", async () => {
  const archive = file(
    zipSync({
      [path("target")]: jf(fixture("inbox/target", [msg(0, "末尾")])),
    }),
  );
  const r = await importConversations({
    archives: [{ file: archive, account: "account-A" }],
    config: {
      mappings: [{ thread: "inbox/target", path: "normal_ver1.0.txt" }],
    },
  });
  assert.equal(r.catalog[0].state, "held");
  assert.match(r.catalog[0].reason, /アカウント/);
  assert.equal((await r.catalog[0].load()).messages.length, 1);
  const cfg = config();
  cfg.mappings.push({
    thread: threadKey("account-A", "inbox/target"),
    path: "other_ver1.0.txt",
  });
  const ambiguous = await importConversations({
    archives: [{ file: archive, account: "account-A" }],
    config: cfg,
  });
  assert.equal(ambiguous.catalog[0].state, "held");
});
test("破損ZIP・暗号化JSON・CRC不一致・上限・分割JSONの破損を説明して保留", async () => {
  await assert.rejects(indexZip(file(enc("broken"))), /終端/);
  const archive = file(
    zipSync({
      [path("target")]: jf(fixture("inbox/target", [msg(0, "末尾")])),
    }),
  );
  const entries = await indexZip(archive);
  await assert.rejects(
    readEntry(archive, { ...entries[0], flags: entries[0].flags | 1 }),
    /暗号化/,
  );
  await assert.rejects(readEntry(archive, { ...entries[0], crc: 0 }), /CRC/);
  await assert.rejects(readEntry(archive, entries[0], 1), /上限/);
  await assert.rejects(
    indexZip(archive, { ...ZIP_LIMITS, entries: 0 }),
    /上限/,
  );
  const broken = file(
    zipSync({
      [path("target")]: jf(fixture("inbox/target", [msg(0, "末尾")])),
      [path("target", 2)]: enc("{broken"),
    }),
  );
  const result = await importConversations({
    archives: [{ file: broken, account: "account-A" }],
    config: config(),
  });
  assert.equal(result.catalog[0].state, "held");
  assert.equal(result.catalog[0].group, undefined);
  await assert.rejects(result.catalog[0].load(), /JSON/);
  const noAccount = await importConversations({
    archives: [{ file: archive, account: "" }],
    config: config(),
  });
  assert.equal(noAccount.errors.length, 1);
  assert.match(noAccount.errors[0].reason, /アカウント/);
});
test("登録済みでもグループDMを1対1完全統合版へ入れない", async () => {
  const gg = fixture(
    "inbox/group-a",
    [msg(0, "本文")],
    ["合成A", "合成B", "合成C"],
  );
  const r = await importConversations({
    archives: [
      {
        file: file(zipSync({ [path("group-a")]: jf(gg) })),
        account: "account-A",
      },
    ],
    config: config(),
  });
  const g = r.catalog[0].group;
  const id = g.id;
  const spec = {
    path: "full_ver1.0.txt",
    initialLabel: "IG(合成)",
    triggerThreads: [id],
    sources: [{ thread: id, label: "IG(合成)" }],
  };
  const p = planIntegrated(
    spec,
    [g],
    enc(
      renderIntegrated([
        {
          date: "2025.01.01",
          time: "23:59:59",
          sender: "合成A",
          body: "本文",
          label: "IG(合成)",
        },
      ]),
    ),
  );
  assert.equal(p.held, true);
  assert.match(p.reason, /グループDM/);
});
test("ZIP64の64bit位置を扱い巨大ZIPでも必要範囲だけ読む", async () => {
  const bytes = zipSync({
    [path("target")]: jf(fixture("inbox/target", [msg(0, "末尾")])),
  });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22,
    cdOffset = view.getUint32(end + 16, true),
    cdSize = view.getUint32(end + 12, true);
  const directory = bytes.slice(cdOffset, end);
  const largeOffset = 4294967296 + 4096;
  const z = new Uint8Array(56),
    zv = new DataView(z.buffer);
  zv.setUint32(0, 0x06064b50, true);
  zv.setBigUint64(4, 44n, true);
  zv.setBigUint64(24, 1n, true);
  zv.setBigUint64(32, 1n, true);
  zv.setBigUint64(40, BigInt(cdSize), true);
  zv.setBigUint64(48, BigInt(largeOffset), true);
  const locator = new Uint8Array(20),
    lv = new DataView(locator.buffer);
  lv.setUint32(0, 0x07064b50, true);
  lv.setBigUint64(8, BigInt(largeOffset + cdSize), true);
  lv.setUint32(16, 1, true);
  const ending = bytes.slice(end),
    ev = new DataView(ending.buffer);
  ev.setUint16(8, 65535, true);
  ev.setUint16(10, 65535, true);
  ev.setUint32(12, 0xffffffff, true);
  ev.setUint32(16, 0xffffffff, true);
  const segments = [
    [0, bytes.slice(0, cdOffset)],
    [largeOffset, directory],
    [largeOffset + cdSize, z],
    [largeOffset + cdSize + 56, locator],
    [largeOffset + cdSize + 76, ending],
  ];
  let readBytes = 0;
  const virtual = {
    size: largeOffset + cdSize + 98,
    slice(a, b) {
      readBytes += b - a;
      assert.ok(b - a < 1024 * 1024);
      const result = new Uint8Array(b - a);
      for (const [at, data] of segments) {
        const start = Math.max(a, at),
          finish = Math.min(b, at + data.length);
        if (start < finish)
          result.set(data.subarray(start - at, finish - at), start - a);
      }
      return new Blob([result]);
    },
  };
  const index = await indexZip(virtual);
  assert.equal(index.length, 1);
  const json = await readEntry(virtual, index[0]);
  assert.match(new TextDecoder().decode(json), /末尾/);
  assert.ok(readBytes < 10000);
});
test("フォルダ不一致・同アカウント内の破損ZIP・中止は更新を保留", async () => {
  const wrong = file(
    zipSync({ [path("target")]: jf(fixture("inbox/other", [msg(0, "本文")])) }),
  );
  const result = await importConversations({
    archives: [{ file: wrong, account: "account-A" }],
    config: config(),
  });
  assert.equal(result.catalog[0].state, "held");
  assert.match(result.catalog[0].reason, /フォルダ/);
  const valid = file(
    zipSync({
      [path("target")]: jf(fixture("inbox/target", [msg(0, "末尾")])),
    }),
  );
  const r = await importConversations({
    archives: [
      { file: valid, account: "account-A" },
      { file: file(enc("broken")), account: "account-A" },
    ],
    config: config(),
  });
  assert.equal(r.errors.length, 1);
  assert.equal(r.catalog[0].state, "held");
  assert.equal(r.catalog[0].group, undefined);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    importConversations({
      archives: [{ file: valid, account: "account-A" }],
      config: config(),
      signal: abort.signal,
    }),
    (e) => e.name === "AbortError",
  );
});
test("識別できない複数の個別JSONを混ぜず入力ごとに保留", async () => {
  const r = await importConversations({
    individual: [
      file(enc("{broken"), "bad-a.json"),
      file(jf({ messages: [] }), "bad-b.json"),
    ],
  });
  assert.equal(r.catalog.length, 2);
  assert.ok(r.catalog.every((i) => i.state === "held" && i.readError));
  assert.notEqual(r.catalog[0].id, r.catalog[1].id);
});
