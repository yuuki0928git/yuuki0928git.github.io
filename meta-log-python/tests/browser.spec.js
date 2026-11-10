import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { zipSync, unzipSync } from "../web/vendor/fflate-0.8.2.js";
const enc = (s) => new TextEncoder().encode(s),
  ms = Date.UTC(2026, 10, 8, 12);
const message = (n, content) => ({
  timestamp_ms: ms + n * 1000,
  sender_name: "合成A",
  content,
});
const payload = (messages) =>
  enc(
    JSON.stringify({
      participants: [{ name: "合成A" }, { name: "合成B" }],
      title: "合成",
      messages: listReverse(messages),
    }),
  );
const listReverse = (a) => [...a].reverse();
const upload = (name, data) => ({
  name,
  mimeType: "application/octet-stream",
  buffer: Buffer.from(data),
});
const old = enc("2026.11.08\n21:00:00 合成A: 境界\n");
const config = {
  schema: 1,
  conversations: {
    合成: {
      sources: [{ kind: "ig", account: "account-A", folder: "synthetic_123" }],
    },
  },
  accounts: { "account-A": { filename_contains: ["account-A"] } },
  line_name_map: { "": "(不明)" },
};
const reference = await readFile(
  new URL("../reference_converter.py", import.meta.url),
);
async function prepare(page, mapping = config) {
  await page.goto("/");
  await expect(page.locator("#analyze")).toBeEnabled({ timeout: 60000 });
  await page.locator("#setup-panel").evaluate((el) => (el.open = true));
  await page
    .locator("#setup")
    .setInputFiles([
      upload("mapping.json", enc(JSON.stringify(mapping))),
      upload("reference_converter.py", reference),
    ]);
}
async function analyze(page) {
  await page.locator("#analyze").click();
  await expect(page.locator("#status")).toContainText("追記予定", {
    timeout: 30000,
  });
}
async function download(page) {
  const event = page.waitForEvent("download");
  await page.locator("#execute").click();
  const d = await event;
  return new Uint8Array(await readFile(await d.path()));
}
test("初回セットアップ→Pythonで追記→次回は最新版ZIPだけで再実行0、実データ通信なし", async ({
  page,
  context,
}) => {
  await prepare(page);
  await expect(page.locator("#partial-wrap")).toBeHidden();
  const requests = [],
    errors = [];
  context.on("request", (r) => {
    if (/^https?:/.test(r.url()))
      requests.push({ url: r.url(), method: r.method(), body: r.postData() });
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const source = zipSync({
    "your_instagram_activity/messages/inbox/synthetic_123/message_1.json":
      payload([message(0, "境界"), message(1, "新着")]),
    "photos/private.jpg": new Uint8Array(1024),
    "inbox/unknown_999/message_1.json": payload([
      message(0, "UNREGISTERED_BODY"),
    ]),
  });
  await page.locator("#old").setInputFiles(
    upload(
      "logs.zip",
      zipSync({
        "kaiwa_latest_only/合成ver1.9.txt": old,
        "unchangedver1.0.txt": enc("exact\r\nbytes\x00"),
      }),
    ),
  );
  await page
    .locator("#sources")
    .setInputFiles(upload("export-account-A.zip", source));
  await analyze(page);
  await expect(page.locator("#status")).toContainText("1件追記予定");
  expect(await page.locator("body").innerText()).not.toContain(
    "UNREGISTERED_BODY",
  );
  const bytes = await download(page),
    z = unzipSync(bytes);
  expect(new TextDecoder().decode(z["kaiwa_latest_only/合成ver2.0.txt"])).toBe(
    "2026.11.08\n21:00:00 合成A: 境界\n21:00:01 合成A: 新着\n",
  );
  expect(z["unchangedver1.0.txt"]).toEqual(enc("exact\r\nbytes\x00"));
  expect(z["__converter/reference_converter.py"]).toEqual(
    new Uint8Array(reference),
  );
  expect(Object.keys(z).sort()).toEqual(
    [
      "kaiwa_latest_only/合成ver2.0.txt",
      "unchangedver1.0.txt",
      "mapping.json",
      "__converter/reference_converter.py",
    ].sort(),
  );
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
  await expect(page.locator("#old")).toHaveValue("");
  await expect(page.locator("#sources")).toHaveValue("");
  await expect(page.locator("#setup")).toHaveValue("");
  await page.locator("#old").setInputFiles(upload("latest.zip", bytes));
  await page
    .locator("#sources")
    .setInputFiles(upload("export-account-A.zip", source));
  await analyze(page);
  await expect(page.locator("#status")).toContainText("0件追記予定");
  const second = unzipSync(await download(page));
  expect(second["kaiwa_latest_only/合成ver2.0.txt"]).toEqual(
    z["kaiwa_latest_only/合成ver2.0.txt"],
  );
  expect(second["kaiwa_latest_only/合成ver2.1.txt"]).toBeUndefined();
  // Runtime restart may fetch program assets; no request contains input data or targets another host.
  expect(
    requests.every(
      (r) =>
        r.method === "GET" &&
        r.body === null &&
        new URL(r.url).hostname === "127.0.0.1",
    ),
  ).toBe(true);
});
test("末尾不一致では書かず、明示した会話だけ続行できる", async ({ page }) => {
  await prepare(page);
  await page
    .locator("#old")
    .setInputFiles(
      upload("合成ver1.0.txt", enc("2026.11.08\n21:00:00 合成A: 変更済み\n")),
    );
  await page.locator("#sources").setInputFiles(
    upload(
      "export-account-A.zip",
      zipSync({
        "messages/inbox/synthetic_123/message_1.json": payload([
          message(0, "境界"),
          message(1, "新着"),
        ]),
      }),
    ),
  );
  await analyze(page);
  await expect(page.locator("#preview")).toContainText(
    "末尾の時刻・送信者・本文が一致しません",
  );
  await expect(page.locator("#execute")).toBeDisabled();
  await page
    .getByLabel(
      "不一致の内容を確認し、この会話だけ続行を許可する（選択後に再確認）",
    )
    .check();
  await analyze(page);
  await expect(page.locator("#execute")).toBeEnabled();
  const z = unzipSync(await download(page));
  expect(new TextDecoder().decode(z["合成ver1.1.txt"])).toContain(
    "変更済み\n21:00:01 合成A: 新着",
  );
});
test("IGとLINEの新規統合は参照コードの形式で保存、引用の問題は保留", async ({
  page,
}) => {
  const mapping = {
    schema: 1,
    conversations: {
      合成統合: {
        sources: [
          { kind: "ig", title: "合成", participants: ["合成A", "合成B"] },
          { kind: "line", title: "合成相手" },
        ],
        merge: "time",
      },
    },
    line_name_map: { 合成B: "合成B", "": "(不明)" },
  };
  await prepare(page, mapping);
  await page
    .locator("#sources")
    .setInputFiles([
      upload(
        "message_1.json",
        payload([message(0, "IG発言"), message(120, "IG続き")]),
      ),
      upload(
        "line.txt",
        enc(
          "[LINE] 合成相手とのトーク履歴\n2026/11/08(日)\n21:01\t合成B\tLINE発言\n21:01\t\tメッセージの送信を取り消しました",
        ),
      ),
    ]);
  await analyze(page);
  await expect(page.locator("#status")).toContainText("4件追記予定");
  const z = unzipSync(await download(page));
  expect(
    new TextDecoder().decode(z["kaiwa_latest_only/合成統合ver1.0.txt"]),
  ).toBe(
    "2026.11.08\n21:00:00 合成A: IG発言\n\n――アカウント切替: IG → LINE――\n21:01:00 合成B: LINE発言\n21:01:00 (不明): メッセージの送信を取り消しました\n\n――アカウント切替: LINE → IG――\n21:02:00 合成A: IG続き\n",
  );
});
test("参照コードの変更を拒否し、初回の仕様書から対応表を作れる", async ({
  page,
}) => {
  await prepare(page);
  await page
    .locator("#setup")
    .setInputFiles([
      upload(
        "reference_converter.py",
        Buffer.concat([reference, Buffer.from(" ")]),
      ),
      upload("mapping.json", enc(JSON.stringify(config))),
    ]);
  await page
    .locator("#sources")
    .setInputFiles(upload("message_1.json", payload([message(0, "境界")])));
  await page.locator("#analyze").click();
  await expect(page.locator("#status")).toContainText(
    "元ファイルと一致しません",
  );
  const spec =
    "### 4.1 会話\n| `synthetic_123` | account-A | 合成 |\n### 4.2 次";
  await page
    .locator("#setup")
    .setInputFiles([
      upload("reference_converter.py", reference),
      upload("spec.md", enc(spec)),
    ]);
  await page.locator("#old").setInputFiles(upload("合成ver1.0.txt", old));
  await page.locator("#sources").setInputFiles(
    upload(
      "export-account-A.zip",
      zipSync({
        "messages/inbox/synthetic_123/message_1.json": payload([
          message(0, "境界"),
          message(1, "新着"),
        ]),
      }),
    ),
  );
  await analyze(page);
  await expect(page.locator("#status")).toContainText("1件追記予定");
});
test("未登録の会話は自動作成せず、名前を入力して再確認した場合だけ新規作成", async ({
  page,
}) => {
  await prepare(page);
  await page
    .locator("#sources")
    .setInputFiles(
      upload(
        "export-account-A.zip",
        zipSync({
          "messages/inbox/new_777/message_1.json": payload([
            message(1, "新規本文"),
          ]),
        }),
      ),
    );
  await analyze(page);
  await expect(page.locator("#status")).toContainText("未登録 1件");
  await expect(page.locator("#execute")).toBeDisabled();
  await page.locator("#pending summary").click();
  await page
    .getByPlaceholder("必要な会話だけ保存名を入力")
    .fill("新規の合成会話");
  await page.getByPlaceholder("必要な会話だけ保存名を入力").blur();
  await analyze(page);
  await expect(page.locator("#status")).toContainText("1件追記予定");
  const z = unzipSync(await download(page));
  expect(
    new TextDecoder().decode(z["kaiwa_latest_only/新規の合成会話ver1.0.txt"]),
  ).toBe("2026.11.08\n21:00:01 合成A: 新規本文\n");
  expect(
    JSON.parse(new TextDecoder().decode(z["mapping.json"])).conversations[
      "新規の合成会話"
    ].sources[0].folder,
  ).toBe("new_777");
});
