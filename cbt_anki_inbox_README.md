# QB版 Anki追加箱 v6.15

[Tampermonkeyで更新](https://raw.githubusercontent.com/Factbact/cbt-anki-inbox/main/cbt_anki_inbox.user.js)

リンク先のバージョンが6.15であることを確認し、既存の「CBT Anki 追加箱」を更新してQBを再読み込みする。保存済みの候補・設定を削除する必要はない。既に開いている旧Exporterは必要な保存を済ませて手動で閉じ、更新後のQB画面から起動し直す。

## v6.15：保存先・名前を維持して、成功後にExporterを閉じる

- Anki追加箱の「QB取得ツール」から起動すると、対応環境では親userscriptの `GM_download` がJSONを保存し、成功完了通知の後に専用Exporterだけ閉じる。保存先選択や保存確認クリック、終了タイマーは追加しない。
- 保存先はブラウザ既定のダウンロード先、ファイル名は従来の `qb_<取得問数>questions_with_answers_manual_<手動候補数>.json`。例：`qb_22questions_with_answers_manual_4.json`。同名ファイルは上書きせずブラウザが連番等を付ける。
- 全件取得・保存成功・中断なし・手動画像の取得失敗なしの場合だけ閉じる。保存失敗・取消・タイムアウト・部分取得では画面と再保存ボタンを残す。QB本体や遷移後の別画面は閉じない。
- 新規grantは `GM_download` のみ。既存の接続範囲・他の権限は拡張しない。`GM_info` で実行中の拡張名・バージョン・ダウンロードモードを読み、設定は自動変更しない。

### 最初の一度だけ必要な確認

1. 上の更新リンクでv6.15に更新し、追加されるダウンロード権限の表示があれば確認する。
2. Tampermonkeyのダッシュボード → 設定 → Downloads（ダウンロード）で Download Mode を Browser API にする必要がある。既に設定済みなら変更不要。項目が見えない場合は設定表示モードをAdvanced（詳細）にする。ブラウザからダウンロード権限の確認が出た場合は本人が許可する。
3. JSONが許可されていないというエラーが出た場合だけ、同じDownloadsの「Whitelisted File Extensions」で `.json` を許可する。既存の許可項目を削除したり全拡張子を許可したりしない。
4. QBを再読み込みし、旧Exporterを必要な保存後に閉じ、Anki追加箱の「QB取得ツール」から起動し直す。

対応条件はTampermonkeyのBlob対応版（安定版5.4.0以降、5.4系開発版は5.4.6226以降）、Browser APIモード、GM_downloadが利用可能なこと。旧版・非対応拡張・native/disabledモード・単体のコピー実行では従来の通常ダウンロードを行い、自動では閉じない旨を表示する。完了を確認できない環境でタイマーによる自動終了は行わない。

42件のローカルテストと構文チェックに合格。実ユーザー環境の拡張バージョン・設定・権限・保存および終了動作は未検証。ブラウザや組織のポリシー、他のダウンロード管理機能がファイル名や保存先を変更する可能性はある。

[GM_download公式仕様](https://www.tampermonkey.net/documentation.php?locale=en&q=GM_download) / [公式設定説明](https://www.tampermonkey.net/faq.php?locale=en&q=Q302)

```sh
deno check cbt_anki_inbox.user.js
deno run --allow-read=. tests/cbt_anki_inbox_v615_download.test.mjs
deno run --allow-read=. tests/cbt_anki_inbox_v615_controller.test.mjs
deno run --allow-read=. tests/cbt_anki_inbox_v611.test.mjs
deno run --allow-read=. tests/cbt_anki_inbox_v612.test.mjs
```

## v6.12：理由を残す・今の問題の候補を編集する

- 「勘で正解」「知識不足」「鑑別で迷った」「画像を覚えたい」をワンタップで選択。同じ理由を再度押すと選択解除。
- 選んだ理由は次に保存する候補へ付く。理由だけでも「候補に追加」や「次の問題」の自動保存を使える。理由は保存後・問題移動時にリセット。
- 「○・◎でもカード化する」にも理由を保持する。本文・画像のない理由だけの下書きは、その指定に使った後にリセットし、手動候補の二重追加を防ぐ。
- 「この問題：追加済み○件」を開くと、現在の演習・問題の候補のみ表示。本文・理由・残す画像を編集し、「取り消す」で候補を削除できる。
- 自動カード指定も同じ場所で理由を変更・解除できる。
- 既存のcaptureId・Anki IDは維持。保存済み画像・内容を勝手に別問題へ移さない。別の変更を検出したときは上書きを停止。
- 編集した候補は再書き出し対象になる。既存のJSONファイルやAnkiのカードは直接変更しない。画像の新規追加は従来の候補入力から行う。
- 編集中は自動再描画で入力を消さない。問題を移動する前に「編集を保存」を押すこと。移動時の未保存編集は反映せず閉じる。
- 既存データはそのまま読める。追加理由は任意の `captureReason` フィールドとして通常JSON・QB全問JSONへ引き継ぐ。本文がある候補の本文へ理由を自動挿入しない。

## v6.11：常時表示するカード化ボタン

- 「＋ ○・◎でもカード化する」を「自動カード設定・使い方」の外へ移動し、「候補に追加」と同じ固定フッターに常時表示する。
- 1回押すと現在の問題をカード化対象に指定し、「指定済み」を表示する。繰り返し押しても指定を解除しない。
- 取り消したい場合は「○・◎でも自動カード指定」一覧の「解除」を使う。
- 指定はJSON書き出し時に反映する。ボタンを押した時点でAnkiへ直接カードを送信する機能ではない。
- 問題ごとの指定と解除・既存保存形式・QB取得処理・他のスクリプトは維持する。

## 検証

構文チェック、新機能15件とv6.11の7件のローカルテスト、HTML構造チェックに合格。1回の追加、連打、解除後の再追加、別問題への切替、QB ID不明・問題画面以外での停止、および固定フッターへの配置を確認。実ブラウザでの見た目・実QB・Ankiへの取り込みは未検証。

```sh
deno check cbt_anki_inbox.user.js
deno run --allow-read=. tests/cbt_anki_inbox_v611.test.mjs
deno run --allow-read=. tests/cbt_anki_inbox_v612.test.mjs
```
