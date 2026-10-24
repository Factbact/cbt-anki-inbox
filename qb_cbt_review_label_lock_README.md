# QB CBT 復習ラベル固定（Tampermonkey）

QB CBTの解答後に、既存の評価ボタンを使って選択したラベル（△または×）を自動適用するユーザースクリプト。

## インストール（Mac / Windows共通）
1. Chrome等にTampermonkeyをインストールする。
2. [この.user.jsを開く](https://raw.githubusercontent.com/Factbact/cbt-anki-inbox/main/qb_cbt_review_label_lock.user.js)。
3. Tampermonkeyでインストール／更新を承認する。
4. QB CBTの問題ページを再読み込みする。

**重要**: GitHub自動更新への切り替えは、各PCで新しいバージョンを**一度だけ**インストールまたは上書きする必要がある。既存の0.2.0には`@updateURL`がないため、現状のままではGitHubから自動更新されない。

## 自動更新
- `@updateURL` と `@downloadURL` は、上記GitHub上の.user.jsを参照する。
- GitHub上の`@version`が更新されると、Tampermonkeyが定期的に更新を確認する（Tampermonkeyの自動更新設定が有効な場合）。
- MacとWindowsで同じバージョンを利用可能。ただし**即時反映ではない**。
- パネル位置・選択モード・ボタン登録などの設定はブラウザのlocalStorageに保存され、GitHubを通じて端末間同期はしない。

## 現行0.2.1の動作
- OFF、△固定、×固定の3モード
- 既存Anki追加箱と独立
- パネルを右上に初期表示し、ドラッグ・位置保存・折りたたみ可能
- QBの画面UIから評価ボタンをクリックする（内部APIを直接操作しない）

**注意**: 現行版は問題ごとの前回評価を認識しない。△・×・○の混在演習で前回評価に応じて判定する機能は**未実装**。復習前ラベルと今回の結果による新ルールは、ユーザーと判定表を確定してから次の版に実装する。

## 安全
- 初期モードはOFF
- 実際のQBアカウントでの本番保存動作は未検証。最初は1問で確認する
- 取り込むコードの変更はGitHubの差分を確認してから配布する
