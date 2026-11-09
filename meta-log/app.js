import { unzipSync, zipSync } from "./vendor/fflate-0.8.2.js";
import { plan, candidates, safePath, resolvePath } from "./core.js";
import { importConversations } from "./importer.js";
import { ZipInputError } from "./zip-reader.js";
import { planIntegrated } from "./integrated.js";
const $ = (id) => document.getElementById(id);
let entries = new Map(),
  groups = [],
  config = {},
  plans = [],
  choices = new Map(),
  urls = [];
let candidatePage = 0;
let catalog = [],
  importStats = {},
  inputErrors = [],
  controller;
const accountAssignments = new Map();
const LIMIT = 256 * 1024 * 1024;
function say(s) {
  $("status").textContent = s;
}
function download(bytes, name, type) {
  const u = URL.createObjectURL(new Blob([bytes], { type }));
  urls.push(u);
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  a.textContent = name;
  a.click();
  if (type === "application/zip") {
    $("download").href = u;
    $("download").download = name;
    $("download").hidden = false;
  }
}
function invalidate() {
  plans = [];
  $("generate").disabled = true;
  $("saveconfig").disabled = true;
  $("confirm").checked = false;
  $("preview").replaceChildren();
  $("integration-settings").replaceChildren();
  $("candidate-list").replaceChildren();
  $("download").hidden = true;
}
for (const id of ["existing", "incoming", "exports", "config", "json-account"])
  $(id).onchange = () => {
    controller?.abort();
    invalidate();
    if (id === "exports" || id === "config") drawZipAccounts();
  };
function node(tag, text, parent) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (parent) parent.append(el);
  return el;
}
function render() {
  invalidate();
  drawIntegratedSettings();
  drawCandidates();
  for (const g of groups) {
    const card = node("article", undefined, $("preview"));
    node("strong", g.title || g.id, card);
    node("p", `参加者: ${g.participants.join(" / ")}`, card);
    node(
      "p",
      `入力元: ${g.account || "個別JSON（従来設定）"} / スレッド: ${g.thread || g.id}`,
      card,
    );
    const item = catalog.find((i) => i.id === g.id);
    if (item?.opened && item.state !== "registered") {
      const cancel = node("button", "登録せずスキップへ戻す", card);
      cancel.className = "secondary";
      cancel.onclick = () => {
        item.opened = false;
        groups = groups.filter((x) => x.id !== item.id);
        choices.delete(item.id);
        render();
      };
    }
    const suggested = candidates(
      g,
      [...entries.keys()].map((path) => ({ path })),
      config,
    );
    if (suggested.length)
      node(
        "p",
        "参加者・別名による候補: " + suggested.map((x) => x.path).join(" / "),
        card,
      );
    const select = node("select", undefined, card);
    select.setAttribute("aria-label", "対応先");
    const opts = [
      ["", "保留：対応先を選択"],
      ...Array.from(entries.keys())
        .filter((p) => p.endsWith(".txt"))
        .map((p) => [p, p]),
      ["NEW", "新規作成（名前の確認が必要）"],
      ["INTEGRATED_ONLY", "通常TXTは作らず、設定した完全統合版のみへ反映"],
    ];
    for (const [v, t] of opts) {
      const o = node("option", t, select);
      o.value = v;
      if (v === "INTEGRATED_ONLY" && (g.isGroup || g.participants.length !== 2))
        o.disabled = true;
    }
    const c = choices.get(g.id);
    if (c) select.value = c.target;
    select.onchange = () => {
      choices.set(g.id, { target: select.value, name: c?.name || "" });
      render();
    };
    let target = c?.target;
    let p;
    if (target === "NEW") {
      const inp = node("input", undefined, card);
      inp.placeholder = "フォルダ/会話名_ver1.0.txt";
      inp.setAttribute("aria-label", "新規ファイル名");
      inp.value = c.name || "";
      inp.onchange = () => {
        choices.set(g.id, { target: "NEW", name: inp.value });
        render();
      };
      target = c.name;
      if (
        !target ||
        !safePath(target) ||
        !/ver1\.0\.txt$/.test(target) ||
        entries.has(target)
      )
        p = {
          held: true,
          reason: "安全な新規名（ver1.0.txt）を確認してください",
        };
    }
    if (target === "INTEGRATED_ONLY")
      p =
        g.isGroup || g.participants.length !== 2
          ? {
              held: true,
              reason: "グループDMは1対1の完全統合版へ入れられません",
            }
          : {
              held: false,
              skipped: true,
              count: 0,
              changed: false,
              normalizations: 0,
            };
    if (g.error) p = { held: true, reason: g.error };
    if (
      g.account &&
      g.thread !== g.id &&
      (config.integrated || []).some((s) =>
        (s.triggerThreads || []).includes(g.thread),
      )
    )
      p = {
        held: true,
        reason: "連動する完全統合版の入力元アカウントを設定で確認してください",
      };
    if (!p)
      p = target
        ? plan(g, target, entries.get(target), config)
        : { held: true, reason: "対応先未確定・複数候補・新規名未確認" };
    p.id = g.id;
    plans.push(p);
    if (p.held) {
      node("p", "保留: " + p.reason, card).className = "held";
    } else if (p.skipped) {
      node("p", "通常TXTの出力対象外（完全統合版の設定を別途確認）", card);
    } else {
      const dl = node("dl", undefined, card);
      for (const [k, v] of [
        ["対応先", p.next],
        ["現在 → 次の版", `${p.oldVersion} → ${p.nextVersion}`],
        ["既存末尾 JST", p.last ? `${p.last.date} ${p.last.time}` : "—"],
        ["最初の新着 JST", p.first ? `${p.first.date} ${p.first.time}` : "—"],
        ["追記予定", `${p.count}件`],
        ["既存Reacted置換", `${p.normalizations}件`],
        ["注意", p.warnings.join(" / ") || "—"],
      ]) {
        node("dt", k, dl);
        node("dd", v, dl);
      }
    }
  }
  for (const spec of config.integrated || []) {
    const triggers = spec.triggerThreads || [];
    const triggerPlans = plans.filter((p) => triggers.includes(p.id));
    if (
      !spec.always &&
      !triggerPlans.some((p) => !p.held && p.count > 0) &&
      !spec.sources?.some((src) =>
        groups.some((g) => g.id === src.thread && !g.error),
      )
    )
      continue;
    let p = planIntegrated(spec, groups, entries.get(spec.path));
    plans.push(p);
    const card = node("article", undefined, $("preview"));
    node("strong", p.id, card);
    if (p.held) {
      node("p", "保留: " + p.reason, card).className = "held";
      for (const related of triggerPlans.filter(
        (x) => !x.held && x.count > 0,
      )) {
        related.held = true;
        related.reason = "連動する完全統合版が保留のため通常版も保留";
        node("p", related.path + ": " + related.reason, card).className =
          "held";
      }
    } else {
      node(
        "p",
        `${p.oldVersion} → ${p.nextVersion} / 追加・挿入 ${p.count}件 / 既存置換 ${p.normalizations}件`,
        card,
      );
      node("p", `対応先: ${p.next}`, card);
      node(
        "p",
        `既存末尾 JST: ${p.last?.date || "—"} ${p.last?.time || ""} / 最初の追加 JST: ${p.first?.date || "—"} ${p.first?.time || ""}`,
        card,
      );
      for (const w of p.warnings) node("p", w, card);
    }
  }
  const targets = plans.filter((p) => !p.held && !p.skipped).map((p) => p.path);
  const outputs = new Map();
  for (const p of plans.filter((p) => !p.held && !p.skipped)) {
    if (outputs.has(p.next)) {
      p.held = true;
      p.reason = "出力先パスの重複";
      const other = outputs.get(p.next);
      other.held = true;
      other.reason = p.reason;
      node(
        "p",
        "出力先パスが重複しています。対象は保留します。",
        $("preview"),
      ).className = "held";
    } else outputs.set(p.next, p);
  }
  if (new Set(targets).size !== targets.length) {
    for (const p of plans.filter(
      (p) => targets.filter((t) => t === p.path).length > 1,
    )) {
      p.held = true;
      p.reason = "同一TXTへの複数スレッド指定";
    }
    node(
      "p",
      "同一TXTへの複数スレッド指定を検出しました。該当分は保留します。",
      $("preview"),
    ).className = "held";
  }
  for (const spec of config.integrated || []) {
    const full = plans.find((p) => p.integrated && p.path === spec.path);
    if (!full) continue;
    const linked = plans.filter(
      (p) => (spec.triggerThreads || []).includes(p.id) && p.count > 0,
    );
    if (full.held || linked.some((p) => p.held)) {
      full.held = true;
      full.reason ||= "関連通常ログが保留です";
      for (const p of linked) {
        p.held = true;
        p.reason ||= "連動する完全統合版が保留です";
      }
    }
  }
  say(
    `${groups.length}会話 / 保留 ${plans.filter((p) => p.held).length} / 追記 ${plans.filter((p) => !p.held).reduce((s, p) => s + p.count, 0)}件 / スキップ ${catalog.filter((i) => i.state === "skipped" && !i.opened).length}会話 / メディア等 ${importStats.mediaSkipped || 0}ファイルを未展開`,
  );
  $("generate").disabled = !plans.some((p) => !p.held && !p.skipped);
  $("saveconfig").disabled = false;
}
$("analyze").onclick = async () => {
  invalidate();
  $("analyze").disabled = true;
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  candidatePage = 0;
  say("端末内で読み込み中…");
  try {
    entries = new Map();
    choices = new Map();
    const existing = [...$("existing").files],
      incoming = [...$("incoming").files],
      exports = [...$("exports").files];
    if (!incoming.length && !exports.length)
      throw new ZipInputError(
        "MetaエクスポートZIPまたは個別JSONを選択してください",
      );
    if ([...existing, ...incoming].reduce((s, f) => s + f.size, 0) > LIMIT)
      throw Error("合計256MiBを超えています。入力を分けてください");
    if ($("config").files[0]?.size > 2 * 1024 * 1024)
      throw new ZipInputError("設定JSONは2MiB以下にしてください");
    config = $("config").files[0]
      ? JSON.parse(await $("config").files[0].text())
      : {
          schemaVersion: 2,
          accounts: [],
          aliases: {},
          logs: [],
          mappings: [],
          integrated: [],
        };
    if (![1, 2].includes(config.schemaVersion))
      throw new ZipInputError("設定schemaVersionは1または2が必要です");
    let size = 0,
      announcedSize = 0;
    function add(p, b) {
      if (!safePath(p) || entries.has(p))
        throw Error("ZIP内の不正なパスまたは重複ファイル");
      size += b.length;
      if (size > LIMIT) throw Error("展開後256MiBを超えています");
      entries.set(p, b);
    }
    for (const f of existing) {
      const b = new Uint8Array(await f.arrayBuffer());
      if (/\.zip$/i.test(f.name)) {
        const zipNames = new Set();
        const z = unzipSync(b, {
          filter: (file) => {
            if (!safePath(file.name) || zipNames.has(file.name))
              throw Error("ZIP内の不正・重複パス");
            zipNames.add(file.name);
            announcedSize += file.originalSize;
            if (announcedSize > LIMIT) throw Error("ZIP展開サイズ上限");
            return true;
          },
        });
        for (const [p, v] of Object.entries(z)) add(p, v);
      } else add(f.name, b);
    }
    const imported = await importConversations({
      archives: exports.map((file) => ({
        file,
        account: accountAssignments.get(file) || "",
      })),
      individual: incoming,
      jsonAccount: $("json-account").value,
      config,
      signal,
      onProgress: (progress) => {
        if (signal.aborted) throw new DOMException("中止", "AbortError");
        say(
          `会話JSONを順次確認中… ${progress.jsonRead}ファイル / ${progress.threads}会話`,
        );
      },
    });
    if (signal.aborted) return;
    catalog = imported.catalog;
    inputErrors = imported.errors;
    importStats = imported.stats;
    groups = catalog
      .filter((i) => i.state !== "skipped")
      .map(
        (i) =>
          i.group || {
            id: i.id,
            thread: i.thread,
            account: i.account,
            title: i.title,
            participants: i.participants,
            messages: [],
            error: i.reason,
          },
      );
    groups.push(
      ...inputErrors.map((e) => ({
        id: e.id,
        thread: "",
        account: e.account,
        title: e.input,
        participants: [],
        messages: [],
        error: e.reason,
      })),
    );
    for (const spec of config.integrated || []) {
      spec.path = resolvePath(spec.path, entries) || spec.path;
    }
    for (const g of groups) {
      const only = (config.integrated || []).some(
        (spec) =>
          spec.sources?.some((src) => src.thread === g.id) &&
          !(spec.triggerThreads || []).includes(g.id),
      );
      if (only) choices.set(g.id, { target: "INTEGRATED_ONLY" });
      const c = candidates(
        g,
        [...entries.keys()].map((path) => ({ path })),
        config,
      );
      if (
        c.length === 1 &&
        config.mappings?.some(
          (m) =>
            m.thread === g.id && resolvePath(m.path, entries) === c[0].path,
        )
      )
        choices.set(g.id, { target: c[0].path });
    }
    render();
    if ($("skip").checked && plans.some((p) => !p.held && !p.skipped))
      await generate(true);
  } catch (e) {
    if (e.name === "AbortError" || signal.aborted) return;
    invalidate();
    say(
      e instanceof ZipInputError
        ? e.message
        : "読み込みに失敗しました。既存ZIP・設定JSONの形式、重複パス、サイズ上限を確認してください。データは送信していません。",
    );
  } finally {
    $("analyze").disabled = false;
  }
};
async function generate(skip = false) {
  const run = controller;
  if (!skip && !$("confirm").checked) {
    say("更新内容の確認チェックが必要です");
    return;
  }
  const held = plans.filter((p) => p.held);
  if (held.length && !$("partial").checked) {
    say(
      "保留があります。対応先を確認するか「保留分を除いて出力する」を選んでください",
    );
    return;
  }
  const out = Object.fromEntries(entries);
  for (const p of plans.filter((p) => !p.held && p.changed)) {
    if (p.next !== p.path && entries.has(p.next)) {
      say("新版のファイル名が既存ファイルと衝突します");
      return;
    }
    delete out[p.path];
    out[p.next] = p.bytes;
  }
  if (held.length) {
    const report = held.map((p) => `${p.id}: ${p.reason}`).join("\n");
    if (out["__held_conversations.txt"]) {
      say("保留一覧のファイル名が衝突します");
      return;
    }
    out["__held_conversations.txt"] = new TextEncoder().encode(report);
  }
  say("ZIPを生成中…");
  await new Promise((r) => setTimeout(r, 0));
  if (run?.signal.aborted || run !== controller) return;
  download(
    zipSync(out, { level: 6 }),
    "kaiwa_latest_only.zip",
    "application/zip",
  );
  say("生成しました。Safariでは「ZIPを保存・共有」から保存できます。");
}
$("generate").onclick = () =>
  generate().catch(() => say("ZIP生成に失敗しました。入力を分けてください。"));
$("saveconfig").onclick = () => {
  const next = structuredClone(config);
  next.schemaVersion = 2;
  next.accounts ||= [];
  for (const g of groups)
    if (g.account && !next.accounts.some((a) => a.id === g.account))
      next.accounts.push({ id: g.account, label: g.account });
  next.mappings = (next.mappings || []).filter(
    (m) =>
      !plans.some(
        (p) => p.id === m.thread && !p.held && !p.skipped && !p.integrated,
      ),
  );
  for (const p of plans.filter((p) => !p.held && !p.skipped && !p.integrated)) {
    const g = groups.find((g) => g.id === p.id);
    if (g.account)
      next.mappings = next.mappings.filter(
        (m) =>
          !(
            m.thread === g.thread &&
            !m.account &&
            resolvePath(m.path, entries) === p.path
          ),
      );
    next.mappings.push({
      thread: p.id,
      path: p.next,
      account: g.account || "",
      sourceThread: g.thread || g.id,
    });
    const previous = next.logs?.find((l) => l.path === p.path) || {};
    next.logs = (next.logs || []).filter((l) => l.path !== p.path);
    next.logs.push({
      ...previous,
      path: p.next,
      participants: groups.find((g) => g.id === p.id).participants,
    });
  }
  for (const spec of next.integrated || []) {
    const p = plans.find(
      (p) => p.integrated && p.path === spec.path && !p.held,
    );
    if (p) spec.path = p.next;
  }
  download(JSON.stringify(next, null, 2), "settings.json", "application/json");
};
$("reset").onclick = () => {
  controller?.abort();
  catalog = [];
  inputErrors = [];
  importStats = {};
  accountAssignments.clear();
  $("zip-accounts").replaceChildren();
  $("account-ids").replaceChildren();
  $("json-account").value = "";
  for (const u of urls) URL.revokeObjectURL(u);
  urls = [];
  entries.clear();
  groups = [];
  config = {};
  choices.clear();
  for (const id of ["existing", "incoming", "exports", "config"])
    $(id).value = "";
  invalidate();
  say("選択・処理結果を消去しました。");
};
function drawIntegratedSettings() {
  $("add-integration").disabled = !groups.length;
  const root = $("integration-settings");
  for (const [index, spec] of (config.integrated || []).entries()) {
    const card = node("article", undefined, root);
    node("strong", `完全統合版 ${index + 1}`, card);
    const path = node("select", undefined, card);
    path.setAttribute("aria-label", "完全統合版のTXT");
    for (const p of ["", ...entries.keys()].filter(
      (p) => p === "" || p.endsWith(".txt"),
    )) {
      const o = node("option", p || "既存の完全統合TXTを選択", path);
      o.value = p;
    }
    path.value = spec.path || "";
    path.onchange = () => {
      spec.path = path.value;
      render();
    };
    const initial = node("input", undefined, card);
    initial.setAttribute("aria-label", "先頭ソースラベル");
    initial.placeholder = "先頭ソースのラベル（既存TXTと同じ）";
    initial.value = spec.initialLabel || "";
    initial.onchange = () => {
      spec.initialLabel = initial.value;
      render();
    };
    const alwaysLabel = node("label", undefined, card);
    const always = node("input", undefined, alwaysLabel);
    always.type = "checkbox";
    always.checked = !!spec.always;
    alwaysLabel.append(" 通常ログの新着に加え、今回も統合版を照合する");
    always.onchange = () => {
      spec.always = always.checked;
      render();
    };
    for (const [sourceIndex, src] of (spec.sources || []).entries()) {
      const section = node("fieldset", undefined, card);
      node("legend", `ソース ${sourceIndex + 1}`, section);
      const thread = node("select", undefined, section);
      thread.setAttribute("aria-label", "統合元スレッド");
      const available = new Map([
        ["", "選択してください"],
        ...groups
          .filter((g) => !g.error && !g.isGroup && g.participants.length === 2)
          .map((g) => [
            g.id,
            `${g.title || g.id} / ${g.participants.join("・")}`,
          ]),
      ]);
      if (src.thread && !available.has(src.thread))
        available.set(src.thread, src.thread + "（今回のJSONなし）");
      for (const [v, t] of available) {
        const o = node("option", t, thread);
        o.value = v;
      }
      thread.value = src.thread || "";
      thread.onchange = () => {
        spec.triggerThreads = (spec.triggerThreads || []).map((t) =>
          t === src.thread ? thread.value : t,
        );
        for (const m of config.mappings || [])
          if (m.thread === src.thread) m.thread = thread.value;
        src.thread = thread.value;
        render();
      };
      const label = node("input", undefined, section);
      label.placeholder = "切替行のラベル";
      label.setAttribute("aria-label", "ソースラベル");
      label.value = src.label || "";
      label.onchange = () => {
        src.label = label.value;
        render();
      };
      const rename = node("textarea", undefined, section);
      rename.setAttribute("aria-label", "ソースの表示名置換JSON");
      rename.value = JSON.stringify(src.rename || {}, null, 2);
      rename.onchange = () => {
        try {
          const value = JSON.parse(rename.value);
          if (
            !value ||
            Array.isArray(value) ||
            typeof value !== "object" ||
            Object.values(value).some((v) => typeof v !== "string")
          )
            throw Error();
          src.rename = value;
          render();
        } catch {
          say("表示名置換は文字列から文字列へのJSONオブジェクトにしてください");
          $("generate").disabled = true;
        }
      };
      for (const [key, text] of [
        ["compactBlankLines", "本文中の空行を詰める（このソースの既存形式）"],
        [
          "suppressOrdinaryShareWithContent",
          "通常共有は本文があればURLを付けない（ストーリーとリンクなし共有は保持）",
        ],
      ]) {
        const wrap = node("label", undefined, section);
        const check = node("input", undefined, wrap);
        check.type = "checkbox";
        check.checked = !!src[key];
        wrap.append(" " + text);
        check.onchange = () => {
          src[key] = check.checked;
          render();
        };
      }
      const triggerLabel = node("label", undefined, section);
      const trigger = node("input", undefined, triggerLabel);
      trigger.type = "checkbox";
      trigger.checked = (spec.triggerThreads || []).includes(src.thread);
      triggerLabel.append(
        " このスレッドの通常ログに新着があれば、統合版も必ず同時更新",
      );
      trigger.onchange = () => {
        spec.triggerThreads = (spec.triggerThreads || []).filter(
          (t) => t !== src.thread,
        );
        if (trigger.checked) spec.triggerThreads.push(src.thread);
        render();
      };
      const remove = node("button", "ソースを削除", section);
      remove.className = "secondary";
      remove.onclick = () => {
        spec.sources.splice(sourceIndex, 1);
        spec.triggerThreads = (spec.triggerThreads || []).filter(
          (t) => t !== src.thread,
        );
        render();
      };
    }
    const add = node("button", "ソースを追加", card);
    add.className = "secondary";
    add.onclick = () => {
      spec.sources ||= [];
      spec.sources.push({ thread: "", label: "", rename: {} });
      render();
    };
    const remove = node("button", "連動設定を削除", card);
    remove.className = "secondary";
    remove.onclick = () => {
      config.integrated.splice(index, 1);
      render();
    };
  }
}
$("add-integration").onclick = () => {
  config.integrated ||= [];
  config.integrated.push({
    path: "",
    initialLabel: "",
    sources: [],
    triggerThreads: [],
    always: true,
  });
  render();
};
async function drawZipAccounts() {
  const root = $("zip-accounts");
  root.replaceChildren();
  const selected = new Set([...$("exports").files]);
  for (const file of accountAssignments.keys())
    if (!selected.has(file)) accountAssignments.delete(file);
  for (const [i, file] of [...$("exports").files].entries()) {
    const wrap = node("label", `${file.name} の入力元アカウント`, root);
    const input = node("input", undefined, wrap);
    input.setAttribute("aria-label", `入力元アカウント ${i + 1}`);
    input.setAttribute("list", "account-ids");
    input.autocomplete = "off";
    input.placeholder = "毎回同じ識別名を指定（例: account-A）";
    input.value = accountAssignments.get(file) || "";
    input.onchange = () => {
      accountAssignments.set(file, input.value.trim());
      controller?.abort();
      invalidate();
    };
  }
  const list = $("account-ids");
  list.replaceChildren();
  const file = $("config").files[0];
  if (!file || file.size > 2 * 1024 * 1024) return;
  try {
    const data = JSON.parse(await file.text());
    for (const a of data.accounts || []) {
      if (typeof a.id === "string") {
        const option = node("option", undefined, list);
        option.value = a.id;
        option.label = a.label || a.id;
      }
    }
  } catch {
    say("設定JSONを読み込めません。形式を確認してください。");
  }
}
function drawCandidates() {
  const candidates = catalog.filter(
    (i) =>
      (i.state === "skipped" && !i.opened) ||
      (i.state === "held" && !i.readError && !i.opened),
  );
  $("candidate-summary").textContent =
    `未登録・アカウント確認の候補（${candidates.length}会話）`;
  candidatePage = Math.min(
    candidatePage,
    Math.max(0, Math.ceil(candidates.length / 50) - 1),
  );
  if (candidates.length > 50) {
    const controls = node(
      "p",
      `${candidates.length}会話中 ${candidatePage * 50 + 1}〜${Math.min(candidates.length, (candidatePage + 1) * 50)}件を表示`,
      $("candidate-list"),
    );
    for (const [step, label] of [
      [-1, "前の50件"],
      [1, "次の50件"],
    ]) {
      const button = node("button", label, controls);
      button.className = "secondary";
      button.disabled =
        step < 0
          ? candidatePage === 0
          : (candidatePage + 1) * 50 >= candidates.length;
      button.onclick = () => {
        candidatePage += step;
        render();
      };
    }
  }
  for (const item of candidates.slice(
    candidatePage * 50,
    (candidatePage + 1) * 50,
  )) {
    const card = node("article", undefined, $("candidate-list"));
    node("strong", item.title || item.thread, card);
    node("p", `${item.account || "個別JSON"} / ${item.thread}`, card);
    node(
      "p",
      `参加者: ${item.participants.join(" / ")} / ${item.messageCount}件`,
      card,
    );
    if (item.reason) node("p", item.reason, card);
    const open = node("button", "候補を開く", card);
    open.className = "secondary";
    open.onclick = async () => {
      open.disabled = true;
      const active = controller;
      try {
        const g = await item.load();
        if (active !== controller || active?.signal.aborted) return;
        item.opened = true;
        groups = groups.filter((x) => x.id !== g.id);
        groups.push(g);
        choices.delete(g.id);
        render();
        say("候補を読み込みました。対応先または新規名を確認してください。");
      } catch (e) {
        if (e.name !== "AbortError")
          say(
            e instanceof ZipInputError
              ? e.message
              : "候補の読み込みに失敗しました",
          );
      } finally {
        open.disabled = false;
      }
    };
  }
}
