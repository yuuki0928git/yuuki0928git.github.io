"""§9を合成データで固定する。実データの一致を主張しない。"""

import datetime as dt
import hashlib
import json
import unicodedata
from pathlib import Path
import reference_converter as ref

ORIGINAL_SHA = "2d2758ae67bd82879925c66856540a3bb858c315f5d6006f5b17c8bf8d4c34d6"


def message(second, content, sender="合成A", **extra):
    epoch = int(
        (
            dt.datetime(2026, 11, 8, 21, 0, 0) - ref.JST - dt.datetime(1970, 1, 1)
        ).total_seconds()
        * 1000
    )
    return dict(
        timestamp_ms=epoch + second * 1000, sender_name=sender, content=content, **extra
    )


def ordered(tmp_path, messages):
    folder = tmp_path / "synthetic"
    folder.mkdir(exist_ok=True)
    (folder / "message_1.json").write_text(
        json.dumps({"messages": list(reversed(messages))}), encoding="utf-8"
    )
    return ref.load_messages([str(folder)])


def test_reference_unchanged():
    assert hashlib.sha256(Path(ref.__file__).read_bytes()).hexdigest() == ORIGINAL_SHA


def test_01_append_seventeen_exact(tmp_path):
    old = "2026.11.08\n21:00:00 合成A: 境界\n"
    msgs = ordered(
        tmp_path, [message(0, "境界")] + [message(n, f"合成{n}") for n in range(1, 18)]
    )
    result = ref.append_to_log(old, msgs)
    expected = old + "".join(f"21:00:{n:02d} 合成A: 合成{n}\n" for n in range(1, 18))
    assert result.tail_ok and result.new_count == 17
    assert result.new_text.encode() == expected.encode()


def test_02_two_story_patches_and_eighty_nine(tmp_path):
    old = "2026.11.08\n20:59:58 合成A: 返信一\n20:59:59 合成A: 返信二\n21:00:00 合成A: 境界\n"
    history = [
        message(-2, "返信一", share={"link": "https://example.invalid/stories/a"}),
        message(-1, "返信二", share={"link": "https://example.invalid/stories/b"}),
        message(0, "境界"),
    ]
    result = ref.append_to_log(
        old, ordered(tmp_path, history + [message(n, f"新着{n}") for n in range(1, 90)])
    )
    expected = "2026.11.08\n20:59:58 合成A: [シェア: https://example.invalid/stories/a] 返信一\n20:59:59 合成A: [シェア: https://example.invalid/stories/b] 返信二\n21:00:00 合成A: 境界\n"
    expected += "".join(
        f"21:{n//60:02d}:{n%60:02d} 合成A: 新着{n}\n" for n in range(1, 90)
    )
    assert result.tail_ok and result.new_count == 89 and result.patched_story_links == 2
    assert result.new_text.encode() == expected.encode()


def test_03_line_ig_127_rows_six_switches():
    # 7ブロックを交互にし、IG=51、LINE=76。最後は送信取消。
    base = dt.datetime(2026, 3, 29, 10)
    blocks = [
        ("IG", 13),
        ("LINE", 25),
        ("IG", 13),
        ("LINE", 25),
        ("IG", 13),
        ("LINE", 26),
        ("IG", 12),
    ]
    sources = {"IG": [], "LINE": []}
    expected = ["2026.03.29"]
    previous = None
    minute = 0
    line_parts = [
        "[LINE] 合成相手とのトーク履歴",
        "保存日時：2026/11/10 00:04",
        "",
        "2026/03/29(日)",
    ]
    ig = []
    for label, count in blocks:
        if previous and previous != label:
            expected += ["", f"――アカウント切替: {previous} → {label}――"]
        for i in range(count):
            t = base + dt.timedelta(minutes=minute)
            minute += 1
            if label == "IG":
                ig.append(
                    {
                        "timestamp_ms": int(
                            (t - ref.JST - dt.datetime(1970, 1, 1)).total_seconds()
                            * 1000
                        ),
                        "sender_name": "合成A",
                        "content": f"IG-{len(ig)+1}",
                    }
                )
                text = f"合成A: IG-{len(ig)}"
            else:
                idx = sum(1 for x in line_parts if "\t" in x) + 1
                who = "" if idx == 76 else "合成B"
                body = (
                    "メッセージの送信を取り消しました" if idx == 76 else f"LINE-{idx}"
                )
                line_parts.append(f"{t:%H:%M}\t{who}\t{body}")
                text = f'{"(不明)" if not who else who}: {body}'
            expected.append(f"{t:%H:%M:%S} {text}")
        previous = label
    sources["IG"] = [
        (ref.jst(m["timestamp_ms"]), i, ref.render(m)[9:]) for i, m in enumerate(ig)
    ]
    sources["LINE"] = ref.parse_line_txt(
        "\n".join(line_parts), {"合成B": "合成B", "": "(不明)"}
    )
    merged = ref.merge_sources(sources, ["IG", "LINE"])
    assert len(sources["IG"]) == 51 and len(sources["LINE"]) == 76
    assert merged.count("――アカウント切替:") == 6
    assert merged.encode() == ("\n".join(expected) + "\n").encode()
    assert "(不明): メッセージの送信を取り消しました" in merged


def test_04_version():
    assert [ref.bump_version(v) for v in ["6.4", "7.9", "1.9"]] == ["6.5", "8.0", "2.0"]


def test_05_nfd_filename():
    nfd = unicodedata.normalize("NFD", "合成がver1.0.txt")
    assert ref.FNAME_RE.match(ref.nfc(nfd)).group("base") == "合成が"


def test_06_zero_keeps_text():
    old = "2026.11.08\n21:00:00 合成A: 境界\n"
    r = ref.append_to_log(old, [message(0, "境界")])
    assert r.new_count == 0 and r.new_text.encode() == old.encode() and r.tail_ok


def test_07_mismatch_reports_false():
    assert not ref.append_to_log(
        "2026.11.08\n21:00:00 合成A: 境界X\n", [message(0, "境界"), message(1, "新着")]
    ).tail_ok


def test_08_regular_and_full_same_new_count():
    msgs = [message(0, "境界"), message(1, "新着")]
    regular = "2026.11.08\n21:00:00 合成A: 境界\n"
    full = (
        "2026.01.01\n00:00:00 過去の合成名: 過去\n\n――アカウント切替: IG(old) → IG(current)――\n\n"
        + regular
    )
    a, b = ref.append_to_log(regular, msgs), ref.append_to_log(full, msgs)
    assert (
        a.tail_ok
        and b.tail_ok
        and a.new_count == b.new_count == 1
        and a.last_after == b.last_after
    )


def test_09_day_boundary_and_multiline():
    old = "2026.11.08\n23:59:59 合成A: 境界\n"
    shift = 3 * 3600 - 1
    result = ref.append_to_log(
        old,
        [
            message(shift, "境界"),
            message(shift + 1, "二行\n本文"),
            message(shift + 2, "同日"),
        ],
    )
    assert (
        result.new_text
        == old + "\n2026.11.09\n00:00:00 合成A: 二行\n本文\n00:00:01 合成A: 同日\n"
    )
    assert result.new_text.count("2026.11.09\n") == 1


def test_same_second_stable_order(tmp_path):
    rows = [message(1, "ミリ秒後"), message(1, "ミリ秒前")]
    rows[0]["timestamp_ms"] += 900
    rows[1]["timestamp_ms"] += 100
    assert [m["content"] for m in ordered(tmp_path, list(reversed(rows)))] == [
        "ミリ秒前",
        "ミリ秒後",
    ]


def test_line_quotes_photo_unknown():
    text = '2026/03/29(日)\n11:23\t合成A\t"一行\n二行 ""引用"" 終わり"\n11:23\t\tメッセージの送信を取り消しました\n11:24\t合成A\t[写真]'
    r = ref.parse_line_txt(text, {"合成A": "合成A", "": "(不明)"})
    assert r[0][2] == '合成A: 一行\n二行 "引用" 終わり'
    assert r[1][2].startswith("(不明):") and r[2][2] == "合成A: [写真 1枚]"


def test_seconds_sort_does_not_change_reference_order(tmp_path):
    late = message(1, "900msを先に保持")
    late["timestamp_ms"] += 900
    early = message(1, "100msが後に残る")
    early["timestamp_ms"] += 100
    result = ordered(tmp_path, [late, early])
    assert [x["content"] for x in result] == ["900msを先に保持", "100msが後に残る"]


def test_message_markers_variation_selector_and_system_text():
    row = message(
        1,
        "本文\n二行",
        share={"link": "https://example.invalid/stories/sample"},
        photos=[{}, {}],
        videos=[{}],
        audio_files=[{}],
        sticker={},
        reactions=[{"actor": "合成B", "reaction": "❤️"}],
    )
    # 空のstickerは偽なので参照コードではマーカーを付けない。
    assert (
        ref.render(row)
        == "21:00:01 合成A: [シェア: https://example.invalid/stories/sample] [写真 2枚] [動画 1件] [音声] 本文\n二行 →❤️(合成B)"
    )
    assert ref.render(message(1, "")) == "21:00:01 合成A: [写真 1枚]"
    assert ref.render(message(1, "Reacted ❤️ to your message")).endswith(
        "Reacted ❤️ to your message"
    )
    assert ref.render(message(1, "Liked a message")).endswith("Liked a message")
