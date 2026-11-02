# URLクリーナー

`/tools/` のツール一覧からアクセスします。ビルド不要の静的ページです。

## 削除ルール

- 全サイト: `utm_*`（大文字小文字を区別しない）、`fbclid`, `gclid`, `dclid`, `gbraid`, `wbraid`, `msclkid`, `twclid`, `ttclid`, `yclid`, `igshid`, `mc_cid`, `mc_eid`, `_ga`, `_gl`。
- Amazon: amazon.co.jp / com / co.uk / de / fr / it / es / ca / com.au とそのサブドメインに限定し、`tag`, `linkCode`, `ascsubtag`, `ref_`, `pf_rd_p`, `pf_rd_r`, `pd_rd_w`, `pd_rd_wg`, `pd_rd_r`。アフィリエイト識別子も削除します。
- 未知のキー、検索条件、商品・動画ID、再生位置、パス、フラグメントは維持します。残すクエリのエンコード、順序、重複も維持します。
- `x-amz-*`, `x-goog-*`, `signature`, `sig`, `token`, `access_token`, `policy`, `key-pair-id`, `hmac` を含むURLは署名・認証付きとして全体を保持します。未知の署名方式や、サイト独自の用途を完全には判別できません。

## プライバシー・共有

入力内容の通信、永続保存、短縮URLの展開は実装していません。CSPの `connect-src 'none'` と `form-action 'none'` でも通信を制限します。URL表示はvalue/textContentのみです。

コピーとWeb Share APIはHTTPS環境のユーザー操作で実行します。非対応・拒否時は選択コピーを案内します。LINEなどの共有先はOSとインストールアプリに依存します。

Web Share Targetは未実装です。iOS/iPadOSは受信側のWeb Share Targetに対応せず、GET方式は共有URLをホスティング先に送信します。POST方式には受信用サービスワーカー等の別設計が必要なため、ブラウザ内処理のみという本機能の要件に合わせて採用していません。

## テスト

リポジトリルートで `node --test url-cleaner/cleaner.test.mjs`（Node.js 18以降）。外部依存なし。

2026-11-02: 削除件数、重複・エンコード済みキー、必要パラメータと生表記の保持、Amazonドメイン境界、危険スキーム、不正URL、署名付きURL、変更不要なURLを検証済み。
Chromiumで375 / 768 / 1440px幅の横はみ出し、自動処理、コピー、共有API呼び出し（モック）、不正入力、クリア、ツール一覧の導線、JSエラーなしを検証済み。
iPhone/iPad実機のネイティブ共有メニューとLINE送信は未検証です。
