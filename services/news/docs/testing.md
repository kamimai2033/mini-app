# 検証

## API unit / localhost HTTP tests

repository root から実行します。外部 RSS、NAS、実データを使用しません。Python 3.11 以降、追加 pip package 不要です。

```sh
python -m unittest discover -s services/news/tests -p 'test_*.py' -v
```

認証/CORS/no-store、入力、接続 timeout、部分障害、stale キャッシュ、巨大 upstream 応答のページ縮小、ID/UUID 衝突、未確定 intent による後続抑止、再起動後 receipt を確認します。SQLite の receipt 更新を意図的に失敗させ、FreshRSS への適用だけ成功した状況から復旧しても後の操作を逆転させないことを検証します。

## 実 FreshRSS Docker integration

Docker Compose v2、openssl、Python が必要です。Ubuntu GitHub Actions runner でそのまま実行できます。

```sh
python services/news/tests/integration.py
```

毎回固有の Compose project/新規 volume とテスト秘密値を作り、HTTPS RSS fixture、FreshRSS **1.30.4**、NAS API を起動します。外部ニュース配信元や NAS は使用しません。テスト専用 Compose override だけで fixture hostname の内部アクセスを許可し、fixture の一時 CA を FreshRSS に信頼させます。本番 Compose の内部ホスト許可リストは空のままです。

検証内容:

- FreshRSS 本体/パッチ/bridge の Docker build と PHP 構文
- RSS 取得 → タイトル/概要/元リンク/取得状態の API 応答
- DOCTYPE、形式不正、HTML、遅い応答、private IP redirect、HTTP downgrade の拒否
- 既読/保存、重複 UUID、後から届く古い UUID、server_id 不一致
- 保存一覧の全件ページング、カテゴリ変更、停止/再開での記事保持
- API コンテナー再起動後の identity/receipt、FreshRSS 停止時の stale キャッシュ

終了時は固有テストコンテナーの `stop` のみ実行します。volume削除、`down -v`、prune は行いません。証跡と停止済みテスト環境を残します。共有ホストで繰り返す場合の容量管理は利用者が確認してください。

証跡は `services/news/tests/.integration-artifacts/run-*/`。CI へ upload するのは **`result.txt` と `containers.log` だけ**にしてください。同じディレクトリには一時の API 秘密値と TLS 秘密鍵があるため、ディレクトリ丸ごとを upload しないでください。これらは Git/Docker build 対象外です。

実機の LAN/Tailscale HTTPS 到達、PWA インストール/復帰、NAS バックアップと復元はこの検証には含みません。実 NAS の変更と復旧試験は別工程です。
