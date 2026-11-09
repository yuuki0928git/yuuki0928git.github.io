import { test, expect } from "@playwright/test";
import { zipSync, unzipSync } from "../vendor/fflate-0.8.2.js";
import { readFile } from "node:fs/promises";
const enc = (s) => new TextEncoder().encode(s),
  ms = Date.UTC(2025, 0, 1, 14, 59, 59);
const fixture = JSON.stringify({
  thread_path: "synthetic/thread",
  title: "合成会話",
  participants: [{ name: "テスト" }, { name: "相手" }],
  messages: [
    { timestamp_ms: ms, sender_name: "テスト", content: "末尾" },
    {
      timestamp_ms: ms + 1000,
      sender_name: "テスト",
      content: "新着\n続き",
      share: { link: "https://example.invalid/stories/test" },
    },
  ],
});
const old = enc("2025.01.01\n23:59:59 テスト: 末尾\n");
const untouched = Uint8Array.from([0, 255, 13, 10]);
const upload = (name, buffer) => ({
  name,
  mimeType: "application/octet-stream",
  buffer: Buffer.from(buffer),
});
test("ファイル選択→確認→ZIP保存→再実行、外向き通信なし", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("#analyze")).toBeEnabled();
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  await page
    .locator("#existing")
    .setInputFiles(
      upload(
        "old.zip",
        zipSync({ "dir/test_ver1.9.txt": old, "dir/untouched.bin": untouched }),
      ),
    );
  await page
    .locator("#incoming")
    .setInputFiles(upload("arbitrary.json", enc(fixture)));
  await page.locator("#analyze").click();
  await expect(page.locator("#status")).toContainText("スキップ 1会話");
  await openCandidate(page);
  await page
    .getByLabel("対応先", { exact: true })
    .selectOption("dir/test_ver1.9.txt");
  await expect(page.locator("#status")).toContainText("追記 1件");
  await page.locator("#confirm").check();
  const dl = page.waitForEvent("download");
  await page.locator("#generate").click();
  const d = await dl;
  const b = await readFile(await d.path());
  const z = unzipSync(b);
  expect(z["dir/test_ver1.9.txt"]).toBeUndefined();
  expect(z["dir/untouched.bin"]).toEqual(untouched);
  expect(new TextDecoder().decode(z["dir/test_ver2.0.txt"])).toContain(
    "新着\n続き",
  );
  await page.locator("#existing").setInputFiles(upload("updated.zip", b));
  await page.locator("#analyze").click();
  await openCandidate(page);
  await page
    .getByLabel("対応先", { exact: true })
    .selectOption("dir/test_ver2.0.txt");
  await expect(page.locator("#status")).toContainText("追記 0件");
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    })),
  ).toEqual({ local: 0, session: 0 });
  await page.screenshot({ path: "test-results/preview.png", fullPage: true });
});
test("新規・設定保存・省略実行・保留明示", async ({ page }) => {
  await page.goto("/");
  await page
    .locator("#incoming")
    .setInputFiles(upload("any.json", enc(fixture)));
  await page.locator("#analyze").click();
  await openCandidate(page);
  await page.getByLabel("対応先", { exact: true }).selectOption("NEW");
  await page.getByLabel("新規ファイル名").fill("new_ver1.0.txt");
  await page.getByLabel("新規ファイル名").blur();
  await expect(page.locator("#status")).toContainText("追記 2件");
  const event = page.waitForEvent("download");
  await page.locator("#saveconfig").click();
  const d = await event;
  const c = JSON.parse(await readFile(await d.path(), "utf8"));
  expect(c.mappings[0].path).toBe("new_ver1.0.txt");
  expect(c.logs[0].participants).toEqual(["テスト", "相手"]);
});
test("省略実行でも不明入力を保留し、除外一覧と未更新バイトを保持", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .locator("#existing")
    .setInputFiles(
      upload(
        "old.zip",
        zipSync({ "dir/test_ver1.9.txt": old, "dir/untouched.bin": untouched }),
      ),
    );
  await page
    .locator("#incoming")
    .setInputFiles([
      upload("good.json", enc(fixture)),
      upload("unknown.json", enc('{"messages":[]}')),
    ]);
  const c = {
    schemaVersion: 1,
    aliases: {},
    logs: [],
    mappings: [{ thread: "synthetic/thread", path: "dir/test_ver1.9.txt" }],
    integrated: [],
  };
  await page
    .locator("#config")
    .setInputFiles(upload("settings.json", enc(JSON.stringify(c))));
  await page.locator("#skip").check();
  await page.locator("#analyze").click();
  await expect(page.locator("#status")).toContainText("保留があります");
  await page.locator("#partial").check();
  const event = page.waitForEvent("download");
  await page.locator("#analyze").click();
  const d = await event;
  const z = unzipSync(await readFile(await d.path()));
  expect(z["__held_conversations.txt"]).toBeDefined();
  expect(z["dir/test_ver2.0.txt"]).toBeDefined();
  expect(z["dir/untouched.bin"]).toEqual(untouched);
});
test("本文HTML・共有URLを実行せずCSPで通信を拒否", async ({ page }) => {
  await page.goto("/");
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  const x = {
    thread_path: "synthetic/xss",
    title: '<img src="https://example.invalid/x">',
    participants: [{ name: "合成" }],
    messages: [
      {
        timestamp_ms: ms,
        sender_name: "合成",
        content: "<script>alert(1)</script>",
        share: { link: "https://example.invalid/stories/no-preview" },
      },
    ],
  };
  await page
    .locator("#incoming")
    .setInputFiles(upload("input.json", enc(JSON.stringify(x))));
  await page.locator("#analyze").click();
  await openCandidate(page);
  await page.getByLabel("対応先", { exact: true }).selectOption("NEW");
  await page.getByLabel("新規ファイル名").fill("safe_ver1.0.txt");
  await page.getByLabel("新規ファイル名").blur();
  await expect(page.locator("#preview img")).toHaveCount(0);
  expect(requests).toEqual([]);
  expect(
    await page.evaluate(async () => {
      try {
        await fetch("https://example.invalid/blocked");
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
});
test("通常ログに新着があれば完全統合版も自動更新・保留時は通常版も保留", async ({
  page,
}) => {
  await page.goto("/");
  const full =
    "2025.01.01\n23:59:59 テスト: 末尾\n\n――アカウント切替: IG(A) → IG(B)――\n23:59:59 別の合成名: 並行する既存発言\n";
  const sourceZip = zipSync({
    "dir/test_ver1.9.txt": old,
    "dir/full_ver1.9.txt": enc(full),
    "dir/untouched.bin": untouched,
  });
  const config = {
    schemaVersion: 1,
    aliases: {},
    logs: [],
    mappings: [{ thread: "synthetic/thread", path: "dir/test_ver1.9.txt" }],
    integrated: [
      {
        path: "dir/full_ver1.9.txt",
        initialLabel: "IG(A)",
        triggerThreads: ["synthetic/thread"],
        sources: [
          {
            thread: "synthetic/thread",
            label: "IG(A)",
            rename: {},
            suppressOrdinaryShareWithContent: true,
          },
          { thread: "synthetic/other", label: "IG(B)", rename: {} },
        ],
      },
    ],
  };
  await page.locator("#existing").setInputFiles(upload("old.zip", sourceZip));
  await page
    .locator("#incoming")
    .setInputFiles(upload("source.json", enc(fixture)));
  await page
    .locator("#config")
    .setInputFiles(upload("settings.json", enc(JSON.stringify(config))));
  await page.locator("#analyze").click();
  await expect(page.locator("#preview")).toContainText("追加・挿入 1件");
  await expect(page.locator("#status")).toContainText("保留 0");
  await page.locator("#confirm").check();
  const event = page.waitForEvent("download");
  await page.locator("#generate").click();
  const d = await event;
  const zip = await readFile(await d.path());
  const z = unzipSync(zip);
  expect(z["dir/test_ver2.0.txt"]).toBeDefined();
  expect(z["dir/full_ver2.0.txt"]).toBeDefined();
  expect(z["dir/full_ver1.9.txt"]).toBeUndefined();
  expect(new TextDecoder().decode(z["dir/full_ver2.0.txt"])).toContain(
    "――アカウント切替: IG(B) → IG(A)――",
  );
  await page.locator("#existing").setInputFiles(upload("updated.zip", zip));
  await page.locator("#analyze").click();
  await expect(page.locator("#status")).toContainText("追記 0件");
  // Canonical parser must reject a damaged baseline before writing either linked file.
  const damaged = zipSync({
    "dir/test_ver1.9.txt": old,
    "dir/full_ver1.9.txt": enc(full.trimEnd()),
  });
  await page.locator("#existing").setInputFiles(upload("damaged.zip", damaged));
  await page.locator("#analyze").click();
  await expect(page.locator("#preview")).toContainText(
    "解析→再出力が元TXTと一致しません",
  );
  await expect(page.locator("#status")).toContainText("保留 2");
  await expect(page.locator("#generate")).toBeDisabled();
});

async function openCandidate(page) {
  const details = page.locator("#unregistered");
  if (!(await details.evaluate((el) => el.open)))
    await page.locator("#candidate-summary").click();
  await page
    .getByRole("button", { name: "候補を開く", exact: true })
    .first()
    .click();
  await expect(
    page.getByLabel("対応先", { exact: true }).first(),
  ).toBeVisible();
}
const accountKey = (account, thread) =>
  `account:${encodeURIComponent(account)}:${encodeURIComponent(thread)}`;
const metaPath = (id, n = 1) =>
  `your_instagram_activity/messages/inbox/${id}/message_${n}.json`;
function metaFixture(id, messages, participants = ["テスト", "相手"]) {
  return {
    thread_path: `inbox/${id}`,
    title: `合成-${id}`,
    participants: participants.map((name) => ({ name })),
    messages,
  };
}
const metaMessage = (offset, content) => ({
  timestamp_ms: ms + offset,
  sender_name: "テスト",
  content,
});
test("丸ごとZIP混在・複数アカウント・登録のみ更新・統合連動・再実行0・出力へ元データを含めない", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const native = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      if (this.name.startsWith("export-"))
        throw Error("Whole export ZIP read is forbidden");
      return native.call(this);
    };
  });
  await page.goto("/");
  const requests = [],
    errors = [];
  page.on("request", (r) => requests.push(r.url()));
  page.on("pageerror", (e) => errors.push(e.message));
  const marker = enc("2025.01.01\n23:59:59 テスト: 末尾\n");
  const initial = zipSync({
    "logs/main_ver1.9.txt": marker,
    "logs/group_ver1.0.txt": marker,
    "logs/full_ver1.0.txt": marker,
    "unchanged.bin": untouched,
  });
  const a = zipSync({
    [metaPath("main")]: enc(
      JSON.stringify(metaFixture("main", [metaMessage(1000, "新着")])),
    ),
    [metaPath("main", 2)]: enc(
      JSON.stringify(metaFixture("main", [metaMessage(0, "末尾")])),
    ),
    [metaPath("unrelated")]: enc(
      JSON.stringify(
        metaFixture("unrelated", [metaMessage(0, "UNRELATED_BODY_SENTINEL")]),
      ),
    ),
    [metaPath("group-a")]: enc(
      JSON.stringify(
        metaFixture(
          "group-a",
          [metaMessage(0, "末尾"), metaMessage(2000, "グループ新着")],
          ["テスト", "相手", "第三者"],
        ),
      ),
    ),
    [metaPath("group-b")]: enc(
      JSON.stringify(
        metaFixture(
          "group-b",
          [metaMessage(0, "OTHER_GROUP_BODY_SENTINEL")],
          ["テスト", "相手", "第三者"],
        ),
      ),
    ),
    "photos/private.jpg": new Uint8Array(1024 * 1024),
    "videos/private.mp4": new Uint8Array(1024),
  });
  const b = zipSync({
    [metaPath("main")]: enc(
      JSON.stringify(
        metaFixture("main", [metaMessage(0, "WRONG_ACCOUNT_BODY_SENTINEL")]),
      ),
    ),
  });
  const main = accountKey("account-A", "inbox/main"),
    group = accountKey("account-A", "inbox/group-a");
  const settings = {
    schemaVersion: 2,
    accounts: [{ id: "account-A" }, { id: "account-B" }],
    aliases: {},
    logs: [],
    mappings: [
      { thread: main, path: "logs/main_ver1.9.txt" },
      { thread: group, path: "logs/group_ver1.0.txt" },
    ],
    integrated: [
      {
        path: "logs/full_ver1.0.txt",
        initialLabel: "IG(合成A)",
        triggerThreads: [main],
        sources: [{ thread: main, label: "IG(合成A)", rename: {} }],
      },
    ],
  };
  await page
    .locator("#existing")
    .setInputFiles(upload("existing.zip", initial));
  await page
    .locator("#config")
    .setInputFiles(upload("settings.json", enc(JSON.stringify(settings))));
  await page
    .locator("#exports")
    .setInputFiles([upload("export-a.zip", a), upload("export-b.zip", b)]);
  await page
    .getByLabel("入力元アカウント 1", { exact: true })
    .fill("account-A");
  await page.getByLabel("入力元アカウント 1", { exact: true }).blur();
  await page
    .getByLabel("入力元アカウント 2", { exact: true })
    .fill("account-B");
  await page.getByLabel("入力元アカウント 2", { exact: true }).blur();
  await page.locator("#analyze").click();
  await expect(page.locator("#status")).toContainText("スキップ 3会話");
  await expect(page.locator("#status")).toContainText("保留 0");
  await expect(page.locator("#status")).toContainText("追記 3件");
  await expect(page.locator("#preview")).toContainText("追加・挿入 1件");
  expect(await page.locator("body").innerText()).not.toMatch(
    /UNRELATED_BODY_SENTINEL|OTHER_GROUP_BODY_SENTINEL|WRONG_ACCOUNT_BODY_SENTINEL/,
  );
  await page.locator("#confirm").check();
  const event = page.waitForEvent("download");
  await page.locator("#generate").click();
  const d = await event,
    bytes = await readFile(await d.path()),
    z = unzipSync(bytes);
  expect(Object.keys(z).sort()).toEqual(
    [
      "logs/main_ver2.0.txt",
      "logs/group_ver1.1.txt",
      "logs/full_ver1.1.txt",
      "unchanged.bin",
    ].sort(),
  );
  expect(z["unchanged.bin"]).toEqual(untouched);
  expect(new TextDecoder().decode(z["logs/full_ver1.1.txt"])).not.toContain(
    "グループ新着",
  );
  expect(new TextDecoder().decode(z["logs/main_ver2.0.txt"])).toContain("新着");
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
  await page.locator("#existing").setInputFiles(upload("updated.zip", bytes));
  await page.locator("#analyze").click();
  await expect(page.locator("#status")).toContainText("追記 0件");
  await expect(page.locator("#status")).toContainText("スキップ 3会話");
});
test("ZIPの未登録候補を明示的に新規登録し設定を書出し・次回は自動照合", async ({
  page,
}) => {
  await page.goto("/");
  const source = zipSync({
    [metaPath("new")]: enc(
      JSON.stringify(metaFixture("new", [metaMessage(0, "登録する会話")])),
    ),
  });
  await page
    .locator("#exports")
    .setInputFiles(upload("export-new.zip", source));
  await page
    .getByLabel("入力元アカウント 1", { exact: true })
    .fill("local-account");
  await page.getByLabel("入力元アカウント 1", { exact: true }).blur();
  await page.locator("#analyze").click();
  await expect(page.locator("#status")).toContainText("スキップ 1会話");
  await expect(page.locator("#generate")).toBeDisabled();
  await openCandidate(page);
  await page.getByLabel("対応先", { exact: true }).selectOption("NEW");
  await page.getByLabel("新規ファイル名").fill("new_ver1.0.txt");
  await page.getByLabel("新規ファイル名").blur();
  await page.locator("#confirm").check();
  let event = page.waitForEvent("download");
  await page.locator("#generate").click();
  let d = await event;
  const zip = await readFile(await d.path());
  event = page.waitForEvent("download");
  await page.locator("#saveconfig").click();
  d = await event;
  const c = JSON.parse(await readFile(await d.path(), "utf8"));
  expect(c.schemaVersion).toBe(2);
  expect(c.mappings[0].thread).toBe(accountKey("local-account", "inbox/new"));
  expect(c.mappings[0].sourceThread).toBe("inbox/new");
  await page.locator("#existing").setInputFiles(upload("updated.zip", zip));
  await page
    .locator("#config")
    .setInputFiles(upload("settings.json", enc(JSON.stringify(c))));
  await page.locator("#analyze").click();
  await expect(page.locator("#status")).toContainText("追記 0件");
  await expect(page.locator("#status")).toContainText("スキップ 0会話");
});
test("ZIPの曖昧な登録と破損入力は確認省略でも保留・勝手に出力しない", async ({
  page,
}) => {
  await page.goto("/");
  const source = zipSync({
    [metaPath("main")]: enc(
      JSON.stringify(
        metaFixture("main", [
          metaMessage(0, "末尾"),
          metaMessage(1000, "新着"),
        ]),
      ),
    ),
  });
  const id = accountKey("account-A", "inbox/main");
  await page
    .locator("#existing")
    .setInputFiles(
      upload(
        "old.zip",
        zipSync({ "one_ver1.0.txt": old, "two_ver1.0.txt": old }),
      ),
    );
  await page
    .locator("#exports")
    .setInputFiles([
      upload("export-valid.zip", source),
      upload("export-broken.zip", enc("broken")),
    ]);
  for (const [i, account] of ["account-A", "account-B"].entries()) {
    await page
      .getByLabel(`入力元アカウント ${i + 1}`, { exact: true })
      .fill(account);
    await page.getByLabel(`入力元アカウント ${i + 1}`, { exact: true }).blur();
  }
  await page.locator("#config").setInputFiles(
    upload(
      "settings.json",
      enc(
        JSON.stringify({
          schemaVersion: 2,
          accounts: [],
          mappings: [
            { thread: id, path: "one_ver1.0.txt" },
            { thread: id, path: "two_ver1.0.txt" },
          ],
          integrated: [],
        }),
      ),
    ),
  );
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.locator("#skip").check();
  await page.locator("#analyze").click();
  await expect(page.locator("#preview")).toContainText(
    "登録された対応先が複数あります",
  );
  await expect(page.locator("#preview")).toContainText(
    "ZIPの終端情報がありません",
  );
  await expect(page.locator("#generate")).toBeDisabled();
  expect(downloads).toBe(0);
});
test("通常版に新着がなくても登録済みの別ソースの新着で完全統合版を更新", async ({
  page,
}) => {
  await page.goto("/");
  const main = accountKey("account-A", "inbox/main"),
    secondary = accountKey("account-A", "inbox/secondary");
  const settings = {
    schemaVersion: 2,
    mappings: [{ thread: main, path: "main_ver1.0.txt" }],
    integrated: [
      {
        path: "full_ver1.0.txt",
        initialLabel: "IG(A)",
        triggerThreads: [main],
        sources: [
          { thread: main, label: "IG(A)" },
          { thread: secondary, label: "IG(B)" },
        ],
      },
    ],
  };
  const source = zipSync({
    [metaPath("main")]: enc(
      JSON.stringify(metaFixture("main", [metaMessage(0, "末尾")])),
    ),
    [metaPath("secondary")]: enc(
      JSON.stringify(
        metaFixture("secondary", [metaMessage(1000, "別ソース新着")]),
      ),
    ),
  });
  await page
    .locator("#existing")
    .setInputFiles(
      upload(
        "old.zip",
        zipSync({ "main_ver1.0.txt": old, "full_ver1.0.txt": old }),
      ),
    );
  await page.locator("#exports").setInputFiles(upload("export-a.zip", source));
  await page
    .getByLabel("入力元アカウント 1", { exact: true })
    .fill("account-A");
  await page.getByLabel("入力元アカウント 1", { exact: true }).blur();
  await page
    .locator("#config")
    .setInputFiles(upload("settings.json", enc(JSON.stringify(settings))));
  await page.locator("#analyze").click();
  await expect(page.locator("#preview")).toContainText("追加・挿入 1件");
  await page.locator("#confirm").check();
  const event = page.waitForEvent("download");
  await page.locator("#generate").click();
  const d = await event,
    z = unzipSync(await readFile(await d.path()));
  expect(Object.keys(z).sort()).toEqual(
    ["main_ver1.0.txt", "full_ver1.1.txt"].sort(),
  );
  expect(z["main_ver1.0.txt"]).toEqual(old);
  expect(new TextDecoder().decode(z["full_ver1.1.txt"])).toContain(
    "別ソース新着",
  );
});
