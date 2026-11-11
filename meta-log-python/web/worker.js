import { findSetupEntries } from "./zip-setup.js?v=20261112-wrap1";
import { loadPyodide } from "./vendor/pyodide-0.27.7/pyodide.mjs";
import {
  indexZip,
  readEntry,
  conversationFiles,
  ZipInputError,
  ZIP_LIMITS,
} from "./zip-reader.js?v=20261112-utf8";
const SHA = "2d2758ae67bd82879925c66856540a3bb858c315f5d6006f5b17c8bf8d4c34d6";
const LIMITS = {
  ...ZIP_LIMITS,
  json: 32 * 1024 * 1024,
  totalJSON: 256 * 1024 * 1024,
};
let py,
  engineText,
  job = null,
  mapping,
  reference;
const encode = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 32768)
    s += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(s);
};
const decode = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const text = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const progress = (phase, done) =>
  postMessage({ type: "progress", phase, done });
async function initialize() {
  try {
    progress("Pythonを準備しています（初回は少し時間がかかります）");
    const response = await fetch("./engine.py?v=20261110-py1");
    if (!response.ok) throw Error();
    engineText = await response.text();
    py = await loadPyodide({
      indexURL: new URL("./vendor/pyodide-0.27.7/", import.meta.url).href,
      stdout: () => {},
      stderr: () => {},
    });
    await py.runPythonAsync(
      'import sys, json, base64, hashlib, io, zipfile, pathlib, glob, tempfile, datetime, dataclasses, unicodedata\nsys.path.insert(0,"/work")',
    );
    py.FS.mkdirTree("/work");
    py.FS.writeFile("/work/engine.py", engineText);
    globalThis.fetch = () =>
      Promise.reject(Error("処理中の通信は禁止されています"));
    postMessage({ type: "ready" });
  } catch {
    postMessage({
      type: "fatal",
      message:
        "Pythonの準備に失敗しました。最新版のページを開き直してください。",
    });
  }
}
const ready = initialize();
function safeName(name) {
  return (
    !name.startsWith("/") &&
    !name.includes("\\") &&
    !name.split("/").some((x) => x === ".." || x === ".") &&
    !/[\x00-\x1f]/.test(name)
  );
}
async function readFile(file, max) {
  if (file.size > max)
    throw new ZipInputError("このファイルは読み込み上限を超えています");
  return new Uint8Array(await file.arrayBuffer());
}
async function inspect(files, names = {}) {
  const existing = {},
    threads = [],
    lines = [],
    setups = [],
    inputIssues = [];
  let bytesRead = 0;
  const manifests = [];
  let embeddedReference, embeddedMapping;
  for (const [fileIndex, file] of files.entries()) {
    if (file.size > 5 * 1024 ** 3)
      throw new ZipInputError("ZIPは5GB以下を選択してください");
    const id = "file-" + fileIndex;
    if (!/\.zip$/i.test(file.name)) {
      bytesRead += file.size;
      if (bytesRead > 256 * 1024 ** 2)
        throw new ZipInputError(
          "既存ログとJSON・LINEの合計が256MBを超えています",
        );
    }
    if (/\.zip$/i.test(file.name)) {
      const entries = await indexZip(file, LIMITS),
        json = conversationFiles(entries),
        logs = entries.filter((e) => /ver\d+\.\d+\.txt$/i.test(e.name));
      const embedded = findSetupEntries(entries);
      if (json.length && logs.length)
        throw new ZipInputError(
          "元JSONと変換済みTXTが混在したZIPです。ログZIPとMetaエクスポートを分けてください",
        );
      if (logs.length || embedded.reference) {
        for (const entry of entries) {
          if (!safeName(entry.name))
            throw new ZipInputError("ZIPのファイル名に不正なパスがあります");
          if (/ver\d+\.\d+\.txt$/i.test(entry.name)) {
            if (Object.hasOwn(existing, entry.name))
              throw new ZipInputError("同じ既存TXTを重複して選択しています");
            bytesRead += entry.original;
            if (bytesRead > 256 * 1024 ** 2)
              throw new ZipInputError("既存ログの合計が256MBを超えています");
            existing[entry.name] = encode(
              await readEntry(file, entry, 64 * 1024 ** 2),
            );
          } else if (entry === embedded.mapping)
            embeddedMapping = text(await readEntry(file, entry, 2 * 1024 ** 2));
          else if (entry === embedded.reference)
            embeddedReference = await readEntry(file, entry, 64 * 1024);
        }
      } else if (json.length) {
        const folders = new Map();
        for (const entry of json) {
          const dir = entry.name.slice(0, entry.name.lastIndexOf("/"));
          if (!folders.has(dir)) folders.set(dir, []);
          folders.get(dir).push(entry);
        }
        manifests.push({ file, fileIndex, folders });
      } else
        throw new ZipInputError("会話JSONまたは既存ログTXTがZIP内にありません");
    } else if (/\.py$/i.test(file.name)) {
      setups.push({
        kind: "reference",
        bytes: await readFile(file, 64 * 1024),
      });
    } else if (/\.md$/i.test(file.name)) {
      setups.push({
        kind: "spec",
        text: text(await readFile(file, 2 * 1024 ** 2)),
      });
    } else if (/\.json$/i.test(file.name)) {
      const raw = text(await readFile(file, 32 * 1024 ** 2));
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        inputIssues.push({
          id,
          reason: "個別JSONを読み込めません。入力ファイルを確認してください",
        });
        continue;
      }
      if (Array.isArray(data.messages)) {
        threads.push({
          id,
          kind: "ig",
          account: "",
          folder: "",
          title: data.title || "",
          participants: (data.participants || []).map((p) => p.name),
          parts: [{ name: file.name, text: raw }],
        });
      } else setups.push({ kind: "mapping", text: raw });
    } else if (/\.txt$/i.test(file.name)) {
      const raw = await readFile(file, 64 * 1024 ** 2);
      if (/ver\d+\.\d+\.txt$/i.test(file.name)) {
        if (Object.hasOwn(existing, file.name))
          throw new ZipInputError("同じ既存TXTを重複して選択しています");
        existing[file.name] = encode(raw);
      } else {
        const content = text(raw);
        const title = content.match(/^\[LINE\]\s*(.+?)とのトーク履歴/m)?.[1];
        if (!title)
          throw new ZipInputError(
            "LINE履歴の見出し、または既存TXTのver形式を確認してください",
          );
        lines.push({
          id,
          kind: "line",
          title,
          text: content.replaceAll("\r\n", "\n"),
        });
      }
    } else throw new ZipInputError("対応していないファイル形式です");
  }
  reference =
    setups.find((x) => x.kind === "reference")?.bytes || embeddedReference;
  if (!reference)
    throw new ZipInputError(
      "選択したログZIPに変換用コードが見つかりません。前回このサイトで保存したZIPを選ぶか、「初回だけ」の欄でreference_converter.pyと仕様書を選択してください",
    );
  const hash = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", reference)),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  if (hash !== SHA)
    throw new ZipInputError(
      "reference_converter.pyが元ファイルと一致しません。中身を変更していないファイルを選んでください",
    );
  py.FS.writeFile("/work/reference_converter.py", reference);
  await py.runPythonAsync(
    "import importlib\nimportlib.invalidate_caches()\nimport engine",
  );
  const explicit = setups.find((x) => x.kind === "mapping");
  const spec = setups.find((x) => x.kind === "spec");
  const rawMap = explicit?.text || embeddedMapping;
  if (rawMap) {
    py.globals.set("_map_text", rawMap);
    try {
      mapping = JSON.parse(
        py.runPython(
          "json.dumps(engine.normalize_mapping(json.loads(_map_text)),ensure_ascii=False)",
        ),
      );
    } catch {
      throw new ZipInputError("mapping.jsonの形式を確認してください");
    } finally {
      py.globals.delete("_map_text");
    }
  } else if (spec) {
    py.globals.set("_spec_text", spec.text);
    try {
      mapping = JSON.parse(
        py.runPython(
          "json.dumps(engine.mapping_from_spec(_spec_text),ensure_ascii=False)",
        ),
      );
    } catch {
      throw new ZipInputError(
        "仕様書から対応表を読み込めません。mapping.jsonも指定できます",
      );
    } finally {
      py.globals.delete("_spec_text");
    }
  } else
    throw new ZipInputError(
      "初回セットアップで仕様書またはmapping.jsonを選択してください",
    );
  const accountSources = Object.values(mapping.conversations)
    .flatMap((c) => c.sources || [])
    .filter((s) => s.kind !== "line");
  for (const manifest of manifests) {
    const aliases = Object.entries(mapping.accounts || {})
      .filter(([account, cfg]) =>
        (cfg.filename_contains || [account]).some((alias) =>
          manifest.file.name
            .normalize("NFC")
            .toLowerCase()
            .includes(alias.normalize("NFC").toLowerCase()),
        ),
      )
      .map(([account]) => account);
    const fromFolders = new Set();
    for (const folder of manifest.folders.keys())
      for (const src of accountSources)
        if (
          src.folder?.normalize("NFC") ===
            folder.split("/").at(-1).normalize("NFC") &&
          src.account
        )
          fromFolders.add(src.account);
    const account =
      aliases.length === 1
        ? aliases[0]
        : !aliases.length && fromFolders.size === 1
          ? [...fromFolders][0]
          : "";
    for (const [dir, entries] of manifest.folders) {
      const folder = dir.split("/").at(-1);
      let known = accountSources.some(
        (src) =>
          src.folder?.normalize("NFC") === folder.normalize("NFC") &&
          (!account || !src.account || src.account === account),
      );
      const item = {
        id: `zip-${manifest.fileIndex}-${threads.length}`,
        kind: "ig",
        account,
        folder,
        title: folder,
        participants: [],
        parts: [],
      };
      const chosen = names[item.id];
      if (chosen && chosen.trim()) {
        mapping.conversations[chosen] = {
          sources: [{ kind: "ig", account, folder }],
        };
        known = true;
      }
      if (known) {
        try {
          for (const entry of entries) {
            bytesRead += entry.original;
            if (bytesRead > 256 * 1024 ** 2)
              throw new ZipInputError(
                "処理対象JSONと既存ログの合計が256MBを超えています",
              );
            item.parts.push({
              name: entry.name.split("/").at(-1),
              text: text(await readEntry(manifest.file, entry, LIMITS.json)),
            });
          }
          const first = JSON.parse(item.parts[0].text);
          item.title = first.title || folder;
          item.participants = (first.participants || []).map((p) => p.name);
        } catch {
          item.parts = [];
          item.error = "会話JSONの読み込みまたは形式を確認できません";
        }
      }
      threads.push(item);
      progress("会話JSONだけを確認しています", threads.length);
    }
  }
  return {
    mapping,
    existing,
    threads,
    lines,
    reference: encode(reference),
    inputIssues,
  };
}
onmessage = async (event) => {
  await ready;
  const msg = event.data;
  try {
    if (!py) throw new ZipInputError("Pythonの準備が完了していません");
    if (msg.type === "analyze") {
      if (job) py.runPython("engine.clear_session()");
      job = await inspect(msg.files, msg.names || {});
      job.force = msg.force || [];
      if (msg.names) {
        for (const [id, base] of Object.entries(msg.names)) {
          if (!base.trim()) continue;
          const source = [...job.threads, ...job.lines].find(
            (s) => s.id === id,
          );
          if (!source) continue;
          job.mapping.conversations[base] = {
            sources: [
              source.kind === "line"
                ? { kind: "line", title: source.title }
                : {
                    kind: "ig",
                    account: source.account,
                    folder: source.folder || undefined,
                    title: source.folder ? undefined : source.title,
                  },
            ],
          };
        }
      }
      py.globals.set("_payload", JSON.stringify(job));
      let result;
      try {
        result = JSON.parse(py.runPython("engine.analyze_json(_payload)"));
      } finally {
        py.globals.delete("_payload");
        py.FS.unlink("/work/reference_converter.py");
      }
      postMessage({ type: "preview", ...result });
    } else if (msg.type === "execute") {
      py.globals.set("_partial", !!msg.partial);
      let bytes;
      try {
        bytes = decode(py.runPython("engine.zip_base64(_partial)"));
      } finally {
        py.globals.delete("_partial");
        py.runPython("engine.clear_session()");
        job = null;
        mapping = null;
        reference = null;
      }
      postMessage({ type: "download", buffer: bytes.buffer }, [bytes.buffer]);
      close();
    } else if (msg.type === "clear") {
      if (py)
        try {
          py.runPython("engine.clear_session()");
        } catch {}
      job = null;
      mapping = null;
      reference = null;
      close();
    }
  } catch (e) {
    job = null;
    mapping = null;
    reference = null;
    try {
      py.runPython("engine.clear_session()");
      if (py.FS.analyzePath("/work/reference_converter.py").exists)
        py.FS.unlink("/work/reference_converter.py");
    } catch {}
    postMessage({
      type: "error",
      message:
        e instanceof ZipInputError
          ? e.message
          : "処理を完了できませんでした。対応表・入力形式を確認してください。データは送信していません。",
    });
  }
};
