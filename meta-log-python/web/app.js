const $ = (id) => document.getElementById(id);
let worker,
  ready = false,
  url,
  expiry,
  busy = false,
  extraFiles = [];
const names = {};
const force = new Set();
let pendingPage = 0,
  pendingItems = [];
function node(tag, value, parent) {
  const el = document.createElement(tag);
  if (value !== undefined) el.textContent = value;
  if (parent) parent.append(el);
  return el;
}
function status(text) {
  $("status").textContent = text;
}
function revoke() {
  if (url) URL.revokeObjectURL(url);
  url = null;
  clearTimeout(expiry);
  $("download").hidden = true;
}
function start() {
  worker = new Worker("./worker.js?v=20261112-wrap1", { type: "module" });
  worker.onerror = () => {
    status("Pythonの起動に失敗しました。ページを開き直してください。");
    $("analyze").disabled = true;
  };
  worker.onmessage = (event) => {
    const m = event.data;
    if (m.type === "ready") {
      ready = true;
      $("analyze").disabled = busy;
      if (!busy) status("準備できました。ファイルを選んでください。");
    } else if (m.type === "progress")
      status(m.phase + (m.done ? " " + m.done + "会話" : ""));
    else if (m.type === "preview") {
      busy = false;
      show(m);
      $("analyze").disabled = false;
    } else if (m.type === "error" || m.type === "fatal") {
      busy = false;
      status(m.message);
      $("analyze").disabled = !ready;
      $("execute").disabled = true;
      if (m.message.startsWith("初回")) $("setup-panel").open = true;
    } else if (m.type === "download") {
      busy = false;
      revoke();
      url = URL.createObjectURL(
        new Blob([m.buffer], { type: "application/zip" }),
      );
      const a = $("download");
      a.href = url;
      a.download = "kaiwa_latest_only.zip";
      a.hidden = false;
      a.click();
      expiry = setTimeout(() => {
        revoke();
        status(
          "保存リンクを消去しました。必要なら更新ZIPをもう一度選んでください。",
        );
      }, 300000);
      for (const id of ["old", "sources", "setup"]) $(id).value = "";
      extraFiles = [];
      for (const key of Object.keys(names)) delete names[key];
      force.clear();
      pendingItems = [];
      worker.terminate();
      worker = null;
      ready = false;
      $("execute").disabled = true;
      $("analyze").disabled = false;
      status(
        "更新ZIPを作成しました。入力・作業データは解放しました。次回はこのZIPを使ってください。",
      );
    }
  };
}
function show(data) {
  $("preview").replaceChildren();
  $("pending").replaceChildren();
  let holds = data.issues?.length || 0,
    added = 0;
  for (const r of data.report) {
    const card = node("article", undefined, $("preview"));
    node("strong", r.id, card);
    node(
      "p",
      r.status === "hold"
        ? "保留：" + r.reason
        : `${r.count}件追記 / ストーリー補完 ${r.patched}件`,
      card,
    );
    if (r.status === "hold") holds++;
    else added += r.count;
    const dl = node("dl", undefined, card);
    if (r.status === "hold" && /末尾|連動先/.test(r.reason)) {
      const wrap = node("label", undefined, card);
      const check = node("input", undefined, wrap);
      check.type = "checkbox";
      check.checked = force.has(r.id);
      wrap.append(
        " 不一致の内容を確認し、この会話だけ続行を許可する（選択後に再確認）",
      );
      check.onchange = () => {
        if (check.checked) force.add(r.id);
        else force.delete(r.id);
        $("execute").disabled = true;
      };
    }
    for (const [k, v] of [
      ["現在", r.old],
      ["出力", r.new],
      ["現在の末尾", r.before || "—"],
      ["更新後の末尾", r.after || "—"],
      ["末尾照合", r.tail_ok ? "一致" : "不一致"],
      ["追記行数", String(r.lines)],
      ["日付見出しの重複", String(r.duplicate_headers || 0)],
    ]) {
      node("dt", k, dl);
      node("dd", v, dl);
    }
  }
  for (const issue of data.issues || [])
    node("p", "保留：" + issue.reason, $("preview"));
  pendingItems = data.pending || [];
  pendingPage = 0;
  renderPending();
  $("partial-wrap").hidden = !holds;
  $("execute").disabled = !data.report.some((r) => r.status === "ready");
  status(
    `${added}件追記予定 / 保留 ${holds}件 / 未登録 ${data.pending?.length || 0}件。保存ボタンを押すと実行します。`,
  );
}
function renderPending() {
  $("pending").replaceChildren();
  if (!pendingItems.length) return;
  const details = node("details", undefined, $("pending"));
  node(
    "summary",
    `未登録の会話 ${pendingItems.length}件（自動作成しません）`,
    details,
  );
  node(
    "p",
    "必要な会話だけ名前を入力し、更新内容をもう一度確認してください。",
    details,
  );
  const list = node("div", undefined, details);
  const draw = () => {
    list.replaceChildren();
    if (pendingItems.length > 50) {
      const controls = node(
        "p",
        `${pendingPage * 50 + 1}〜${Math.min((pendingPage + 1) * 50, pendingItems.length)}件`,
        list,
      );
      for (const [step, label] of [
        [-1, "前へ"],
        [1, "次へ"],
      ]) {
        const button = node("button", label, controls);
        button.className = "secondary";
        button.disabled =
          step < 0
            ? pendingPage === 0
            : (pendingPage + 1) * 50 >= pendingItems.length;
        button.onclick = () => {
          pendingPage += step;
          draw();
        };
      }
    }
    for (const item of pendingItems.slice(
      pendingPage * 50,
      (pendingPage + 1) * 50,
    )) {
      const label = node("label", item.title, list);
      const input = node("input", undefined, label);
      input.placeholder = "必要な会話だけ保存名を入力";
      input.value = names[item.id] || "";
      input.onchange = () => {
        names[item.id] = input.value;
        $("execute").disabled = true;
        status("名前を登録するため、更新内容をもう一度確認してください。");
      };
    }
  };
  draw();
}
$("analyze").onclick = () => {
  const files = [
    ...$("old").files,
    ...$("sources").files,
    ...$("setup").files,
    ...extraFiles,
  ];
  if (!files.length) {
    status("ログとエクスポートを選択してください。");
    return;
  }
  busy = true;
  if (!worker) start();
  $("preview").replaceChildren();
  $("pending").replaceChildren();
  $("execute").disabled = true;
  $("analyze").disabled = true;
  status("端末内で確認中…");
  worker.postMessage({ type: "analyze", files, names, force: [...force] });
};
$("execute").onclick = () => {
  if (!$("partial-wrap").hidden && !$("partial").checked) {
    status(
      "保留があります。理由を確認するか、更新できる分だけ保存するチェックを選んでください。",
    );
    return;
  }
  $("execute").disabled = true;
  status("更新ZIPを作っています…");
  worker.postMessage({ type: "execute", partial: $("partial").checked });
};
$("reset").onclick = () => {
  busy = false;
  extraFiles = [];
  worker?.terminate();
  worker = null;
  ready = false;
  revoke();
  for (const id of ["old", "sources", "setup"]) $(id).value = "";
  for (const key of Object.keys(names)) delete names[key];
  force.clear();
  $("preview").replaceChildren();
  $("pending").replaceChildren();
  $("execute").disabled = true;
  $("partial-wrap").hidden = true;
  start();
};
for (const id of ["old", "sources", "setup"])
  $(id).onchange = () => {
    $("execute").disabled = true;
    for (const key of Object.keys(names)) delete names[key];
    force.clear();
    if (busy) {
      worker?.terminate();
      busy = false;
      ready = false;
      start();
    }
    $("preview").replaceChildren();
    $("pending").replaceChildren();
  };
addEventListener("pagehide", () => {
  worker?.terminate();
  revoke();
});
start();

addEventListener("dragover", (event) => event.preventDefault());
addEventListener("drop", (event) => {
  event.preventDefault();
  if (!event.dataTransfer?.files.length) return;
  if (busy) {
    worker?.terminate();
    busy = false;
    ready = false;
    start();
  }
  extraFiles.push(...event.dataTransfer.files);
  $("execute").disabled = true;
  status(
    `ドロップした${extraFiles.length}ファイルも対象です。「更新内容を確認」を押してください。`,
  );
});
