import base64
import datetime as dt
import io
import json
import unicodedata
import zipfile
from pathlib import Path
import pytest
import reference_converter as ref
from app.engine import (
    Session,
    InputError,
    mapping_from_spec,
    resolve_sources,
    _line_rows,
)
from test_acceptance import message

REFERENCE = Path(ref.__file__).read_bytes()


def thread(messages, id="source", folder="synthetic_123"):
    return {
        "id": id,
        "kind": "ig",
        "account": "account-A",
        "folder": folder,
        "parts": [
            {
                "name": "message_1.json",
                "text": json.dumps({"messages": list(reversed(messages))}),
            }
        ],
    }


def config(extra=None):
    cfg = {
        "schema": 1,
        "conversations": {
            "合成": {
                "sources": [
                    {"kind": "ig", "account": "account-A", "folder": "synthetic_123"}
                ]
            }
        },
        "line_name_map": {"合成B": "合成B", "": "(不明)"},
    }
    if extra:
        cfg["conversations"]["合成"].update(extra)
    return cfg


def unzip(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return {name: z.read(name) for name in z.namelist()}


def test_reference_invocation_bytes_and_cleanup():
    old = b"2026.11.08\n21:00:00 " + "合成A: 境界\n".encode()
    msgs = [message(0, "境界"), message(1, "新着")]
    s = Session(
        config(),
        {
            "kaiwa_latest_only/合成ver1.9.txt": old,
            "untouchedver1.0.txt": b"unchanged\x00",
        },
        [thread(msgs)],
        [],
        REFERENCE,
    )
    report = s.dry_run()
    assert report["report"][0]["count"] == 1
    z = unzip(s.build_zip())
    assert "kaiwa_latest_only/合成ver1.9.txt" not in z
    assert (
        z["kaiwa_latest_only/合成ver2.0.txt"]
        == ref.append_to_log(old.decode(), msgs).new_text.encode()
    )
    assert z["untouchedver1.0.txt"] == b"unchanged\x00"
    assert z["__converter/reference_converter.py"] == REFERENCE and "mapping.json" in z
    s.clear()
    assert not s.existing and not s.outputs and s.reference_bytes == b""


def test_zero_keeps_original_version_and_bytes():
    old = "2026.11.08\n21:00:00 合成A: 境界\n".encode()
    s = Session(
        config(), {"合成ver1.9.txt": old}, [thread([message(0, "境界")])], [], REFERENCE
    )
    s.dry_run()
    z = unzip(s.build_zip())
    assert z["合成ver1.9.txt"] == old and "合成ver2.0.txt" not in z


def test_mismatch_and_linked_files_are_atomic():
    old = "2026.11.08\n21:00:00 合成A: 境界\n".encode()
    bad = "2026.11.08\n21:00:00 合成A: 変更済み\n".encode()
    s = Session(
        config({"also_update": ["合成_完全統合"]}),
        {"合成ver1.0.txt": old, "合成_完全統合ver1.0.txt": bad},
        [thread([message(0, "境界"), message(1, "新着")])],
        [],
        REFERENCE,
    )
    r = s.dry_run()
    assert all(row["status"] == "hold" for row in r["report"])
    assert s.outputs["合成ver1.0.txt"] == old
    with pytest.raises(InputError):
        s.build_zip()
    assert unzip(s.build_zip(True))["合成_完全統合ver1.0.txt"] == bad


def test_nfd_path_matches_nfc_mapping():
    cfg = {
        "conversations": {
            "合成が": {"sources": [{"kind": "ig", "folder": "synthetic_123"}]}
        }
    }
    path = unicodedata.normalize("NFD", "folder/合成がver1.9.txt")
    old = "2026.11.08\n21:00:00 合成A: 境界\n".encode()
    s = Session(
        cfg,
        {path: old},
        [thread([message(0, "境界"), message(1, "新着")])],
        [],
        REFERENCE,
    )
    s.dry_run()
    assert "folder/合成がver2.0.txt" in s.outputs


def test_unknown_is_not_written_or_guessed():
    s = Session(
        config(),
        {},
        [thread([message(1, "PRIVATE_BODY")], folder="unknown_999")],
        [],
        REFERENCE,
    )
    r = s.dry_run()
    assert len(r["pending"]) == 1 and not s.outputs
    assert "PRIVATE_BODY" not in json.dumps(r)


def test_reference_hash_guard():
    with pytest.raises(InputError):
        Session(config(), {}, [], [], REFERENCE + b" ")


def test_line_reference_limitation_is_held():
    text = '2026/03/29(日)\n11:23\t合成B\t"一行\n二行 ""引用"""\n11:24\t合成B\t次の発言'
    with pytest.raises(InputError, match="引用符"):
        _line_rows({"text": text}, {"合成B": "合成B"})


def test_line_ig_new_and_append_use_reference_merge():
    ig = [message(0, "境界"), message(120, "IG新着")]
    line = {
        "id": "line",
        "kind": "line",
        "title": "合成相手",
        "text": "[LINE] 合成相手とのトーク履歴\n2026/11/08(日)\n21:01\t合成B\tLINE発言",
    }
    cfg = config({"merge": "time"})
    cfg["conversations"]["合成"]["sources"].append(
        {"kind": "line", "title": "合成相手"}
    )
    s = Session(cfg, {}, [thread(ig)], [line], REFERENCE)
    s.dry_run()
    expected = ref.merge_sources(
        {
            "IG": [
                (ref.jst(m["timestamp_ms"]), i, ref.render(m)[9:])
                for i, m in enumerate(ig)
            ],
            "LINE": ref.parse_line_txt(line["text"], cfg["line_name_map"]),
        },
        ["IG", "LINE"],
    )
    assert s.outputs["kaiwa_latest_only/合成ver1.0.txt"] == expected.encode()
    old = "2026.11.08\n21:00:00 合成A: 境界\n"
    s = Session(cfg, {"合成ver1.0.txt": old.encode()}, [thread(ig)], [line], REFERENCE)
    r = s.dry_run()
    assert r["report"][0]["tail_ok"]
    assert s.outputs["合成ver1.1.txt"] == expected.encode()


def test_private_spec_mapping_parse_without_embedded_names():
    spec = "### 4.1 会話\n| `sample_123` | account-A | 合成 **と** 合成_完全統合 |\n| `one.json`（title「合成相手」）＋LINE txt | 別アカ「合成A」 | 合成LINE |\n### 4.2 次\n合成A→`合成A`、合成相手→`合成相手`"
    mapping = mapping_from_spec(spec)
    assert mapping["conversations"]["合成"]["also_update"] == ["合成_完全統合"]
    assert mapping["conversations"]["合成LINE"]["merge"] == "time"
    assert mapping["line_name_map"]["合成A"] == "合成A"


def test_bad_json_only_blocks_its_conversation_and_temp_files_are_removed():
    import tempfile

    before = set(Path(tempfile.gettempdir()).glob("converter-*"))
    bad = thread([message(0, "境界")])
    bad["parts"][0]["text"] = "{broken"
    s = Session(config(), {"合成ver1.0.txt": b"original"}, [bad], [], REFERENCE)
    r = s.dry_run()
    assert r["report"][0]["status"] == "hold"
    assert s.outputs["合成ver1.0.txt"] == b"original"
    assert set(Path(tempfile.gettempdir()).glob("converter-*")) == before


def test_duplicate_date_headers_are_held_not_rewritten():
    old = "2026.11.08\n20:59:59 合成A: 古い\n\n2026.11.08\n21:00:00 合成A: 境界\n".encode()
    s = Session(
        config(),
        {"合成ver1.0.txt": old},
        [thread([message(0, "境界"), message(1, "新着")])],
        [],
        REFERENCE,
    )
    r = s.dry_run()
    assert r["report"][0]["status"] == "hold"
    assert s.outputs["合成ver1.0.txt"] == old
