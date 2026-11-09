import { test, expect } from "@playwright/test";
import { zipSync, unzipSync } from "../vendor/fflate-0.8.2.js";
import { readFile } from "node:fs/promises";
const enc = (s) => new TextEncoder().encode(s),
  ms = Date.UTC(2025, 0, 1, 14, 59, 59);
const fixture = JSON.stringify({
  thread_path: "synthetic/thread",
  title: "合成会話",
  participants: [{ name: "テスト" }],
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
  await expect(page.locator("#status")).toContainText("保留 1");
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
  await page.getByLabel("対応先", { exact: true }).selectOption("NEW");
  await page.getByLabel("新規ファイル名").fill("new_ver1.0.txt");
  await page.getByLabel("新規ファイル名").blur();
  await expect(page.locator("#status")).toContainText("追記 2件");
  const event = page.waitForEvent("download");
  await page.locator("#saveconfig").click();
  const d = await event;
  const c = JSON.parse(await readFile(await d.path(), "utf8"));
  expect(c.mappings[0].path).toBe("new_ver1.0.txt");
  expect(c.logs[0].participants).toEqual(["テスト"]);
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
