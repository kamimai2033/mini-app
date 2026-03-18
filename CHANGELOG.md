# 更新履歴 (Changelog)


## [1.0] - 2024-8-13
### リリース
- オフラインPOSシステムを単独リリース



## [1.1] - 2024-09-14
### 修正
- webサイトの構造を全面的に変更。
- html単独の構成から、中核となるフレームと機能に分割した設計を見直す。
- 文字数カウント機能を実装。


## [1.1.1] - 2024-10-10
### release
- added images folder. it includes two png picture.

### bug
- fixed programs. Because,some codes doesn`t work well before.
- fixed Directory. Same reason.



## [1.2] - 2024-11-09
### release
- Added dictionary system. It provides user experience.

### bug
- To add dictionary system, fixed systems and additional dictionary system jsfile.
- Fixed programs and directory.. Because,some codes doesn`t work well.



## [1.3] - 2024-12-10
### release
- addeed new feature "editorModule". it make us easy to design web site making .

### bug
- fixed programs to work "editorModule" well.



## [1.4] - 2025-02-13
### リリース
- オーディオプレイヤー(AP)を実装。
- APにシャッフル & ループ機能を追加。
- バックグラウンド再生(IOS&Android)を実装。

### 修正
- editorModule.js` のボタンが動作しない問題を修正。
- AP機能の文字化けを修正。
- 機能追加に合わせ、冗長化したミニアプリ基盤のコード全体の最適化を実施。


## [1.4.1] - 2025-02-13
### リリース
- 更新履歴をUI内に実装。


## [1.4.2] - 2025-02-15
### 修正
- ナビゲーションバーが文字化けする問題を修正。
- 字数計測モジュールが表示されない問題を修正。


## [1.4.3] - 2025-02-15
### 修正
- 更新履歴欄の文字化け問題を修正。
- 読み込み時に更新履歴が表示される問題を修正。


## [1.5] - 2026-02-22
### リリース(テスト環境)
- 日語辞書を実装。
- 実装に伴い、辞書モジュールの名称を英英辞書に修正。
- 併せて、旧辞書モジュールに関連する関数名称の最適化を実施(内部処理に変更はありません)。


## [1.5.1] - 2026-02-22
### 修正(テスト環境)
- 全モジュールが動作不能となる問題を修正。
- 原因は3つ見つかった。
- 1.手入力によるlとIの打ち間違いによる関数の異動。
- 2.複数の辞書モジュール併存に伴う類似関数の設定ミス。
- 3.修正すべきjsファイルではなく、同名のtxtファイルを修正し続けていたこと。

## [1.5.2] - 2026-02-22
### リリース(本番環境)
- 日語辞書のリリース。


## [1.6] - 2026-03-17
### リリース(本番環境)
- pdf変換モジュール実装

## [1.6.1] - 2026-03-17
### リリース(本番環境)
- pdf変換モジュールの挙動改善。とくに、CORSによる制限及び、外部モジュールのCDNによる制限へ対応。
- エディタモジュールの動作不能問題を修正。原因は手打ちによるクォーテーショ
