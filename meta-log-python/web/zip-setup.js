import { ZipInputError } from "./zip-reader.js?v=20261112-utf8";
export function findSetupEntries(entries) {
  const refs = entries.filter((e) =>
    /(^|\/)__converter\/reference_converter\.py$/.test(e.name),
  );
  const maps = entries.filter((e) => /(^|\/)mapping\.json$/.test(e.name));
  if (refs.length > 1 || maps.length > 1)
    throw new ZipInputError(
      "ZIP内に設定ファイルが複数あります。最新版のログZIPを1つ選択してください",
    );
  const reference = refs[0];
  const prefix = reference?.name.slice(
    0,
    -"__converter/reference_converter.py".length,
  );
  if (reference && maps.length && maps[0].name !== prefix + "mapping.json")
    throw new ZipInputError(
      "ZIP内の変換用コードと設定のフォルダが一致しません",
    );
  return { reference, mapping: maps[0] };
}
