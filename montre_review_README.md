# モントレ誤答復習（2周目・3周目）

Tampermonkey向けユーザースクリプト。モントレのAnki追加箱などで取得した個人用JSONを読み込み、初回×・△だけを解き直す。正誤・学習履歴は利用しているブラウザの `localStorage` に保存する。

## インストール
1. Tampermonkeyを有効にして、[montre_review.user.js](https://raw.githubusercontent.com/Factbact/cbt-anki-inbox/main/montre_review.user.js) を開いてインストールする。
2. すでに「モントレ 誤答復習」v1.0 / v1.1をインストールしていたら、その旧版のみ無効化する（Anki追加箱はそのまま）。
3. [モントレ](https://m3e-medical.com/users/cbt/) で「誤答復習を開く」をクリックする。
4. 初回または未取り込みの場合は「JSONファイルを追加」から手元のモントレ抽出JSONを読み込む。

## 更新
ユーザースクリプトの `@updateURL` と `@downloadURL` は本リポジトリの `main/montre_review.user.js` に固定。将来ファイルを編集して `@version` を上げれば、Tampermonkeyの更新確認から取得できる。手動更新はTampermonkeyの管理画面から「更新を確認」。

## データと注意
- スクリプトには問題文・正答・解説・個人学習履歴を同梱しない。JSONをGitHubに公開しないこと。
- 問題・解答履歴はモントレのアカウントへ送信せず、ブラウザ内に保存する。
- ブラウザのデータ削除・ドメイン変更で消える可能性がある。画面の「バックアップを書き出す」で保存する。
- モントレ本体の問題取得スクリプトは別物。本スクリプトは取得済みJSONを使った復習用である。
