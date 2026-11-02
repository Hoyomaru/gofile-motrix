# GoFile → Motrix

GoFile のフォルダページにツールバーを追加して、ファイルを Motrix に送るユーザースクリプトです。サブフォルダの構造もそのまま再現します。

- ファイル一覧の取得処理（再帰取得・名前の整形・送信済みスキップ・パスワード対応）は gofile-dl を JavaScript に移植したものです。
- ページ上の UI は gofile-enhanced と同じ方法で作っています（GoFile 自身のメニュー・ポップアップ・トースト通知を使います）。
- ダウンロード自体は Motrix（aria2 RPC）に任せます。

## インストール

1. Tampermonkey か Violentmonkey を入れた状態で、[gofile-motrix.user.js](https://raw.githubusercontent.com/Hoyomaru/gofile-motrix/main/gofile-motrix.user.js) を開いてインストールします（以降は自動で更新されます）。
2. Motrix の「詳細設定」で RPC を確認します（ポート 16800 とシークレット）。
3. GoFile のページでツールバーの ⚙ を開き、RPC シークレットと基準フォルダを設定します。基準フォルダを空欄にすると、Motrix の既定の保存先を使います。設定したら「接続テスト」を押してください。

## 使い方

ツールバーの「Motrix へ送る」には、次の送り方があります。

- **選択した項目**：一覧でチェックを入れたファイル・フォルダを送ります。
- **このフォルダ全体**：表示中のページだけでなく、全ページ分を取得し直して送ります。
- **URL を指定して…**：GoFile の URL を複数まとめて貼り付けて送ります（1 行に 1 つ。ID だけでも可）。共通のパスワードを入力できます。合わないときは個別に聞かれます。Tampermonkey のメニューからも呼べるので、フォルダページ以外でも使えます。

送る前に確認一覧が出ます。各ファイルには、Motrix の実際の状態に合わせたバッジが付きます。

| バッジ | 意味 | 最初のチェック |
|---|---|---|
| 完了 | Motrix でダウンロードが完了した | 外れている |
| Motrix で処理中 | 待機中・ダウンロード中・一時停止中 | 外れている |
| 送信済み | 送ったが、Motrix 側に情報が残っていない（Motrix の再起動などで消えた） | 外れている |
| 前回失敗 | Motrix で失敗した、または完了前に削除された | **付いている**（再送信の対象） |
| 名前変更 | 同じフォルダ内の同名ファイルと重なったため ` (2)` などを付けた | — |

保存先は `<基準フォルダ>/<共有フォルダ名>/<サブフォルダ…>/<ファイル名>` になります。保存先に既に同名のファイルがあるときは、Motrix 側で別名（`file.1.zip` など）にして保存します。

## 送信済みの記録

- Tampermonkey のストレージに、ファイル 1 件あたり約 30 バイトで保存します。
- 記録は 1 回の操作につき 1 回だけ読み込みます。10 万件（約 3MB）でも読み込みは 0.1 秒ほどです。
- 保持日数（既定は 365 日）を過ぎた記録は自動で消えます。設定画面で件数とサイズの確認、記録の全消去ができます。

## 警告表示

GoFile 側の仕様変更などで動かなくなったときは、画面右下に赤い警告が出ます。次のような場合です。

- GoFile の内部モジュールを読み込めない
- ページのファイル管理部分を取得できない

## gofile-dl との対応

| gofile-dl | このスクリプト |
|---|---|
| `fetch_contents`（wt トークンを自前で計算） | ページの `getFolder` を呼びます。wt はページ側が計算するので、ソルトが変わっても追従できます |
| `execute` による再帰 | `collect` / `walk`。ページングにも対応しています |
| `parse_content_id` | `parseContentIds`（URL 指定で送るとき） |
| `sanitize_filename` | `sanitize`（禁止文字の置換・予約名の回避・長さの制限） |
| `normalize_folder_name` | `normalizeFolderName`（既定パターンに加えて、独自の接頭辞を `\|` 区切りで指定できます） |
| `strip_emojis` | 設定の「絵文字を除去」（既定はオフ） |
| `DownloadTracker`（incremental） | 送信済みの記録（Motrix の実際の状態と突き合わせます） |
| `download()` | Motrix へ `aria2.addUri` を送ります（Cookie・Referer・User-Agent を付けます） |

## ライセンスと出典

MIT ライセンスです（[LICENSE](LICENSE)）。次の 2 つのプロジェクト（いずれも MIT）を元にしています。

- [gofile-dl](https://github.com/martadams89/gofile-dl)：ファイル一覧の取得・名前の整形・送信済み管理の考え方
- [GoFile Enhanced](https://github.com/ewigl/gofile-enhanced)：GoFile のページへの UI 追加の手法

GoFile・Motrix の公式ツールではありません。GoFile の利用規約を守ってお使いください。
