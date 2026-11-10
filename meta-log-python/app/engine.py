"""参照変換器の外側。変換文字列の生成はreference_converterだけに委譲する。"""

import base64
import datetime as dt
import hashlib
import io
import json
import re
import tempfile
from pathlib import Path, PurePosixPath
import zipfile
import reference_converter as ref

REFERENCE_SHA = "2d2758ae67bd82879925c66856540a3bb858c315f5d6006f5b17c8bf8d4c34d6"
SOURCE_RE = re.compile(r"^――アカウント切替: (.+) → (.+)――$")


class InputError(Exception):
    pass


def normalize_mapping(value):
    if not isinstance(value, dict):
        raise InputError("対応表はJSONオブジェクトが必要です")
    if "conversations" not in value:
        value = {"schema": 1, "conversations": value}
    if not isinstance(value["conversations"], dict):
        raise InputError("対応表のconversations形式が違います")
    normalized = {}
    for base, cfg in value["conversations"].items():
        key = ref.nfc(base)
        if key in normalized:
            raise InputError("対応表の会話名がUnicode正規化後に重複しています")
        normalized[key] = cfg
        if isinstance(cfg, dict) and "also_update" in cfg:
            cfg["also_update"] = [ref.nfc(v) for v in cfg["also_update"]]
    value["conversations"] = normalized
    value.setdefault("line_name_map", {"": "(不明)"})
    value.setdefault("accounts", {})
    for base, cfg in value["conversations"].items():
        if (
            not safe_base(base)
            or not isinstance(cfg, dict)
            or not isinstance(cfg.get("sources"), list)
        ):
            raise InputError("対応表の会話名・sourcesを確認してください")
    return value


def safe_base(base):
    return (
        isinstance(base, str)
        and bool(base.strip())
        and not any(c in base for c in "/\\\x00\r\n")
        and base not in (".", "..")
        and len(base) < 200
    )


def mapping_from_spec(text):
    """利用者の私的仕様書§4の表を設定に変換。プログラムに個別対応を埋め込まない。"""
    section = text.split("### 4.1", 1)[-1].split("### 4.2", 1)[0]
    conversations = {}
    accounts = set()
    rows = []
    for line in section.splitlines():
        if not line.startswith("|") or "`" not in line:
            continue
        cells = [c.strip() for c in re.split(r"(?<!\\)\|", line.strip("|"))]
        if len(cells) < 3:
            continue
        folder, account, target = cells[:3]
        account_match = re.search(r'別アカ[「"]([^」"]+)', account)
        account = (
            account_match.group(1)
            if account_match
            else re.sub(r"側.*", "", account).strip("` *")
        )
        rows.append((folder, account, target))
        if account and account != "両方":
            accounts.add(account)
    for folder, account, target in rows:
        targets = [
            ref.nfc(re.sub(r"[*`]", "", s).strip())
            for s in re.split(r"\*\*と\*\*", target)
        ]
        base = targets[0]
        sources = []
        title = re.search(r'title[「"]([^」"]+)', folder)
        if title:
            sources.append(
                {
                    "kind": "ig",
                    "account": account,
                    "title": title.group(1),
                    "participants": [account, title.group(1)],
                }
            )
            if "LINE" in folder:
                sources.append({"kind": "line", "title": title.group(1)})
        else:
            for match in re.finditer(r"`([^`]+)`(?:（([^）]+)）|\(([^)]+)\))?", folder):
                name = match.group(1)
                if not re.search(r"(?:_\d+|^\d+)$", name):
                    continue
                source_account = match.group(2) or match.group(3) or account
                sources.append(
                    {"kind": "ig", "account": source_account, "folder": name}
                )
                accounts.add(source_account)
        if not sources:
            continue
        cfg = {"sources": sources}
        if len(targets) > 1:
            cfg["also_update"] = targets[1:]
        if len(sources) > 1:
            cfg["merge"] = "time"
        conversations[base] = cfg
    if not conversations:
        raise InputError(
            "仕様書の§4.1から対応表を読み取れません。mapping.jsonも指定できます"
        )
    names = {"": "(不明)"}
    for match in re.finditer(r"([^\s、（(]+)→`([^`]+)`", text):
        names[match.group(1)] = match.group(2)
    return normalize_mapping(
        {
            "schema": 1,
            "conversations": conversations,
            "line_name_map": names,
            "accounts": {
                a: {"filename_contains": [a]} for a in accounts if a and a != "両方"
            },
        }
    )


def resolve_sources(mapping, threads, lines):
    routes = {}
    pending = []
    issues = []
    for g in threads:
        found = []
        for base, cfg in mapping["conversations"].items():
            for src in cfg["sources"]:
                if src.get("kind", "ig") != "ig":
                    continue
                if src.get("folder"):
                    if ref.nfc(src["folder"]) != ref.nfc(g.get("folder", "")):
                        continue
                elif src.get("title"):
                    if ref.nfc(src["title"]) != ref.nfc(ref.fx(g.get("title", ""))):
                        continue
                    if src.get("participants") and sorted(
                        map(ref.fx, g.get("participants", []))
                    ) != sorted(src["participants"]):
                        continue
                else:
                    continue
                if (
                    g.get("account")
                    and src.get("account")
                    and g["account"] != src["account"]
                ):
                    continue
                found.append((base, src))
        if (
            not g.get("account")
            and len({src.get("account") for _, src in found if src.get("account")}) > 1
        ):
            issues.append(
                {"id": g["id"], "reason": "入力元アカウントを一意に判定できません"}
            )
            continue
        unique = {base for base, _ in found}
        if len(unique) > 1:
            issues.append({"id": g["id"], "reason": "対応表に複数の変換先があります"})
            continue
        if not unique:
            pending.append(
                {
                    "id": g["id"],
                    "title": ref.fx(
                        g.get("title") or g.get("folder") or "未登録の会話"
                    ),
                    "kind": "ig",
                }
            )
            continue
        base = next(iter(unique))
        routes.setdefault(base, []).append(g["id"])
    for line in lines:
        found = [
            base
            for base, cfg in mapping["conversations"].items()
            if any(
                src.get("kind") == "line"
                and ref.nfc(src.get("title", "")) == ref.nfc(line["title"])
                for src in cfg["sources"]
            )
        ]
        if len(found) == 1:
            routes.setdefault(found[0], []).append(line["id"])
        elif len(found) > 1:
            issues.append({"id": line["id"], "reason": "LINEに複数の変換先があります"})
        else:
            pending.append({"id": line["id"], "title": line["title"], "kind": "line"})
    return {"routes": routes, "pending": pending, "issues": issues}


def _load_ig(groups):
    with tempfile.TemporaryDirectory(prefix="converter-") as folder:
        dirs = []
        for index, g in enumerate(groups):
            d = Path(folder) / f"source_{index}"
            d.mkdir()
            dirs.append(str(d))
            seen = set()
            for n, part in enumerate(g["parts"]):
                name = PurePosixPath(part["name"]).name
                if not re.fullmatch(r"message_[^/]+\.json", name):
                    name = f"message_{n:05d}.json"
                if name in seen:
                    raise InputError("同じスレッドの分割JSON名が重複しています")
                seen.add(name)
                (d / name).write_text(part["text"], encoding="utf-8")
        return ref.load_messages(dirs)


def _line_rows(source, name_map):
    # 正規の引用符の終端を数え、参照コードが後続行を吸い込む入力を止める。
    expected = 0
    quoted = False
    for line in source["text"].split("\n"):
        m = re.match(r"^\d\d:\d\d\t[^\t]*\t(.*)$", line)
        if not quoted and m:
            expected += 1
            body = m.group(1)
            if body.startswith('"'):
                rest = body[1:]
                quoted = not (
                    rest.endswith('"') and (len(rest) - len(rest.rstrip('"'))) % 2 == 1
                )
        elif (
            quoted
            and line.endswith('"')
            and (len(line) - len(line.rstrip('"'))) % 2 == 1
        ):
            quoted = False
    if quoted:
        raise InputError("LINEの引用符が閉じていません")
    try:
        rows = ref.parse_line_txt(source["text"], name_map)
    except KeyError:
        raise InputError(
            "LINEの送信者名が対応表にありません。表示名の対応を確認してください"
        )
    if len(rows) != expected:
        raise InputError(
            "このLINEの引用符形式は参照コードで後続行を取り込むため保留しました（参照コードは変更していません）"
        )
    return rows


def _append_merged(old, sources):
    all_rows = [
        (t, src, idx, text) for src, rows in sources.items() for t, idx, text in rows
    ]
    all_rows.sort(key=lambda e: (e[0], e[1], e[2]))
    last = ref.last_timestamp(old)
    if last is None:
        raise InputError("既存TXTの末尾日時を確認できません")
    at = {src: [r for r in rows if r[0] == last] for src, rows in sources.items()}
    expected = (
        ref.merge_sources(at, sorted(sources)).split("\n", 1)[-1].rstrip("\n")
        if any(at.values())
        else ""
    )
    ok = bool(expected) and old.rstrip("\n").endswith(expected)
    new = {src: [r for r in rows if r[0] > last] for src, rows in sources.items()}
    count = sum(map(len, new.values()))
    if not count:
        return ref.AppendResult(old, 0, ok, last, last)
    previous = all_rows[0][1] if all_rows else next(iter(sources))
    for line in old.splitlines():
        switch = SOURCE_RE.match(line)
        if switch:
            previous = switch.group(2)
    new.setdefault(previous, []).insert(0, (last, -1, "__BOUNDARY__"))
    rendered = ref.merge_sources(new, sorted(sources))
    prefix = f"{last:%Y.%m.%d}\n{last:%H:%M:%S} __BOUNDARY__\n"
    if not rendered.startswith(prefix):
        raise InputError("複数ソースの追記境界を安全に確定できません")
    text = (old if old.endswith("\n") else old + "\n") + rendered[len(prefix) :]
    return ref.AppendResult(text, count, ok, last, ref.last_timestamp(text))


def duplicate_headers(text):
    previous = None
    count = 0
    for line in text.splitlines():
        if ref.DATE_RE.match(line):
            if line == previous:
                count += 1
            previous = line
    return count


class Session:
    def __init__(
        self,
        mapping,
        existing,
        threads,
        lines,
        reference_bytes,
        force=(),
        input_issues=(),
    ):
        if hashlib.sha256(reference_bytes).hexdigest() != REFERENCE_SHA:
            raise InputError("参照コードのハッシュが元ファイルと一致しません")
        self.mapping = normalize_mapping(mapping)
        self.existing = dict(existing)
        self.threads = threads
        self.lines = lines
        self.reference_bytes = reference_bytes
        self.force = set(force)
        self.input_issues = list(input_issues)
        self.outputs = dict(existing)
        self.report = []
        self.pending = []
        self.issues = []

    def dry_run(self):
        by_id = {x["id"]: x for x in self.threads + self.lines}
        resolved = resolve_sources(self.mapping, self.threads, self.lines)
        self.pending = resolved["pending"]
        self.issues = resolved["issues"] + self.input_issues
        logs = {}
        for path, data in self.existing.items():
            matched = ref.FNAME_RE.match(ref.nfc(PurePosixPath(path).name))
            if matched:
                logs.setdefault(matched["base"], []).append(
                    (path, matched["ver"], data)
                )
        claimed = {}
        owners = {}
        for base, cfg in self.mapping["conversations"].items():
            for target in [base] + cfg.get("also_update", []):
                owners.setdefault(target, set()).add(base)
        duplicated = {target for target, bases in owners.items() if len(bases) > 1}
        for base, cfg in self.mapping["conversations"].items():
            ids = resolved["routes"].get(base, [])
            if not ids:
                continue
            targets = [base] + cfg.get("also_update", [])
            try:
                if duplicated.intersection(targets):
                    raise InputError("同じTXTに複数の対応表設定があります")
                selected = [by_id[i] for i in ids]

                def rank(g):
                    for i, source in enumerate(cfg["sources"]):
                        if source.get("kind", "ig") != g.get("kind", "ig"):
                            continue
                        if source.get("folder") and ref.nfc(
                            source["folder"]
                        ) == ref.nfc(g.get("folder", "")):
                            return i
                        if source.get("title") == ref.fx(g.get("title", "")):
                            return i
                    return len(cfg["sources"])

                if any(g.get("error") for g in selected):
                    raise InputError(
                        "会話JSONの読み込み・形式を確認できないため保留しました"
                    )
                selected.sort(key=rank)
                ig = [x for x in selected if x.get("kind", "ig") == "ig"]
                line = [x for x in selected if x.get("kind") == "line"]
                identities = [
                    (g.get("account", ""), ref.nfc(g["folder"]))
                    for g in ig
                    if g.get("folder")
                ]
                if len(identities) != len(set(identities)):
                    raise InputError(
                        "同じアカウント・スレッドが複数の入力にあります。重複するZIPを外してください"
                    )
                messages = _load_ig(ig) if ig else []
                sources = {}
                if messages:
                    sources["IG"] = [
                        (ref.jst(m["timestamp_ms"]), i, ref.render(m)[9:])
                        for i, m in enumerate(messages)
                    ]
                if line:
                    sources["LINE"] = sum(
                        (
                            _line_rows(
                                x,
                                cfg.get(
                                    "line_name_map",
                                    self.mapping.get("line_name_map", {"": "(不明)"}),
                                ),
                            )
                            for x in line
                        ),
                        [],
                    )
                count = sum(map(len, sources.values()))
                candidates = []
                for target in targets:
                    if target in claimed:
                        raise InputError("同じTXTに複数の対応表設定があります")
                    if len(logs.get(target, [])) > 1:
                        raise InputError(
                            "同じ会話名の既存TXTが複数あります。最新版を確認してください"
                        )
                    current = logs.get(target, [None])[0]
                    if current:
                        path, ver, raw = current
                        try:
                            old = raw.decode("utf-8")
                        except UnicodeDecodeError:
                            raise InputError("既存TXTはUTF-8が必要です")
                        if "\r" in old or old.startswith("\ufeff"):
                            raise InputError(
                                "既存TXTの改行またはBOMが参照仕様と違います。推測で直さず保留します"
                            )
                        if ref.last_timestamp(old) is None:
                            raise InputError("既存TXTの末尾日時がありません")
                        result = (
                            ref.append_to_log(old, messages)
                            if not line
                            else _append_merged(old, sources)
                        )
                        warning_only = cfg.get("tail_check") == "warning"
                        allowed = result.tail_ok or warning_only or target in self.force
                        next_ver = ref.bump_version(ver) if result.new_count else ver
                        next_path = str(
                            PurePosixPath(path).parent / f"{target}ver{next_ver}.txt"
                        )
                        if next_path.startswith("./"):
                            next_path = next_path[2:]
                        changed = result.new_count > 0 or result.patched_story_links > 0
                        output = result.new_text.encode("utf-8") if changed else raw
                        row = {
                            "id": target,
                            "old": path,
                            "new": next_path,
                            "before": str(result.last_before or ""),
                            "after": str(result.last_after or ""),
                            "count": result.new_count,
                            "lines": len(result.new_text.splitlines())
                            - len(old.splitlines()),
                            "tail_ok": result.tail_ok,
                            "patched": result.patched_story_links,
                            "status": "ready" if allowed else "hold",
                            "reason": (
                                ""
                                if allowed
                                else "末尾の時刻・送信者・本文が一致しません"
                            ),
                            "changed": changed,
                        }
                    else:
                        folder = str(
                            PurePosixPath(
                                next(iter(self.existing), "kaiwa_latest_only/file")
                            ).parent
                        )
                        path = None
                        next_path = str(PurePosixPath(folder) / f"{target}ver1.0.txt")
                        text = (
                            ref.merge_sources(sources, ["IG", "LINE"])
                            if line or cfg.get("merge") == "time"
                            else ref.build_new_log(messages)
                        )
                        output = text.encode("utf-8")
                        row = {
                            "id": target,
                            "old": "—",
                            "new": next_path,
                            "before": "",
                            "after": str(ref.last_timestamp(text) or ""),
                            "count": count,
                            "lines": len(text.splitlines()),
                            "tail_ok": True,
                            "patched": 0,
                            "status": "ready",
                            "reason": "",
                            "changed": bool(count),
                        }
                    row["duplicate_headers"] = duplicate_headers(output.decode("utf-8"))
                    if row["duplicate_headers"]:
                        row["status"] = "hold"
                        row["reason"] = (
                            "日付見出しの重複があります。既存行を推測で修正せず保留します"
                        )
                    candidates.append((path, next_path, output, row))
                if len({x[3]["count"] for x in candidates}) > 1:
                    raise InputError("通常版と同時更新先の追記件数が一致しません")
                for path, next_path, _, row in candidates:
                    if (
                        row["changed"]
                        and next_path in self.outputs
                        and next_path != path
                    ):
                        raise InputError("新版ファイル名が既存ファイルと衝突します")
                blocked = any(x[3]["status"] == "hold" for x in candidates)
                for path, next_path, output, row in candidates:
                    claimed[row["id"]] = base
                    if blocked:
                        row["status"] = "hold"
                        row["reason"] = (
                            row["reason"] or "連動先の照合が不一致のため同時更新を保留"
                        )
                    elif row["changed"]:
                        if next_path in self.outputs and next_path != path:
                            raise InputError("新版ファイル名が既存ファイルと衝突します")
                        if path:
                            self.outputs.pop(path, None)
                        self.outputs[next_path] = output
                    self.report.append(row)
            except (
                InputError,
                KeyError,
                ValueError,
                TypeError,
                json.JSONDecodeError,
                OverflowError,
                OSError,
            ):
                # 本文・送信者を含む生の例外をUIやログへ渡さない。
                import sys

                e = sys.exc_info()[1]
                reason = (
                    str(e)
                    if isinstance(e, InputError)
                    else "元データの形式を確認できません。該当会話を保留しました"
                )
                for target in targets:
                    self.report.append(
                        {
                            "id": target,
                            "status": "hold",
                            "reason": reason,
                            "count": 0,
                            "old": logs.get(target, [("—",)])[0][0],
                            "new": "—",
                            "tail_ok": False,
                            "changed": False,
                            "before": "",
                            "after": "",
                            "lines": 0,
                            "patched": 0,
                        }
                    )
        return {
            "report": self.report,
            "pending": self.pending,
            "issues": self.issues,
            "reference_sha": REFERENCE_SHA,
        }

    def build_zip(self, allow_partial=False):
        if not allow_partial and (
            self.issues or any(r["status"] == "hold" for r in self.report)
        ):
            raise InputError(
                "保留があります。理由を確認し、保留を除いて出力する場合だけ選択してください"
            )
        archive = io.BytesIO()
        with zipfile.ZipFile(
            archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6
        ) as z:
            for name, data in self.outputs.items():
                z.writestr(name, data)
            z.writestr(
                "mapping.json",
                json.dumps(self.mapping, ensure_ascii=False, indent=2).encode(),
            )
            z.writestr("__converter/reference_converter.py", self.reference_bytes)
        return archive.getvalue()

    def clear(self):
        self.existing.clear()
        self.outputs.clear()
        self.threads.clear()
        self.lines.clear()
        self.reference_bytes = b""
        self.mapping.clear()
        self.report.clear()
        self.pending.clear()
        self.issues.clear()


_session = None


def analyze_json(payload):
    global _session
    clear_session()
    data = json.loads(payload)
    existing = {
        name: base64.b64decode(value) for name, value in data["existing"].items()
    }
    _session = Session(
        data["mapping"],
        existing,
        data["threads"],
        data["lines"],
        base64.b64decode(data["reference"]),
        data.get("force", []),
        data.get("inputIssues", []),
    )
    return json.dumps(_session.dry_run(), ensure_ascii=False)


def zip_base64(allow_partial=False):
    if _session is None:
        raise InputError("先に更新内容を確認してください")
    return base64.b64encode(_session.build_zip(allow_partial)).decode("ascii")


def clear_session():
    global _session
    if _session is not None:
        _session.clear()
    _session = None
