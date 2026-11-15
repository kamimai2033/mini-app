# ニュースくん NAS サービス

FreshRSS **1.30.4** が RSS/Atom を取得・保存し、小さな Python API が mini-app に必要な情報だけを渡します。記事本文のスクレイピング、外部への要約送信、通知配信は行いません。Python は標準ライブラリのみです。

実 NAS への配備はまだ行っていません。既存の FreshRSS・家計簿・バックアップ用コンテナーやボリュームをこの Compose に流用しないでください。

## 構成

```text
mini-app PWA ── HTTPS + Bearer ── household reverse proxy ── api:8010
                                                             │
                                                  GReader + internal bridge
                                                             │
                                                       freshrss:80 ── public HTTPS RSS
```

- FreshRSS: SQLite、15 分 cron、標準 TTL 900 秒。取得状態と記事の正本です。
- API: SQLite に server_id、永続 UUID 操作記録、表示用の一時キャッシュを保存します。
- 内部 PHP bridge: 取得状態、停止/再開、形式検証、手動更新を補います。停止は TTL を負数にする処理で、購読や記事を削除しません。
- 自動削除は **OFF**。FreshRSS の自動保持処理も無効にしています。30 日保持は将来の設定案で、現実装では適用しません。
- ブラウザーには API 用キーだけを入力します。FreshRSS 管理パスワード・API パスワード・bridge キーは NAS 内に保持します。

## 新規導入の手順

Docker Compose v2 と Python 3.11 以降を前提に、`services/news` で操作します。新しい専用 Compose プロジェクト/ボリュームを作る手順です。

1. `.env.example` を `.env` にコピーします。`NEWS_ALLOWED_ORIGINS` に PWA の正確な origin（例 `https://daily.example.com`）、`FRESHRSS_PUBLIC_URL` に利用者が開ける管理画面 URL を設定します。複数 origin はカンマ区切りです。実 LAN 設定はローカルファイルだけに置きます。
2. `python init_secrets.py` を実行します。4 個の独立した秘密値を `.secrets/` に生成し、既存ファイルは上書きしません。このディレクトリと `.env` は Git/Docker build 対象外です。
3. `docker compose config --quiet` で構成を確認し、`docker compose up -d --build` で新規起動します。既存サービスを停止/削除するコマンドは含めません。
4. NAS の reverse proxy から API へ HTTPS で接続します。初期 bind は `127.0.0.1` のみです。proxy が別コンテナーの場合は管理者が専用ネットワーク参加または適切なホスト bind を設定し、家庭内/VPNからの到達範囲を確認します。
5. `/api/news/info` の `protocol: 1` と `mode: "news"` を確認します。PWA のニュース設定へ API URL と `.secrets/api_token` の値を入力します。キーは画面内メモリーだけに保持し、再読み込み後は再入力します。
6. 任意で `python seed.py` を実行すると Yahoo!ニュースの主要・経済・IT を登録します。初期登録は自動実行しません。NHK・日経などはニュース画面から公式 HTTPS RSS URL を手動追加できます。配信条件、有料記事の制限、URL の変更に従って利用してください。

FreshRSS 管理ユーザーは既定 `news`、管理パスワードは `.secrets/admin_password` です。管理画面 URL は `FRESHRSS_PUBLIC_URL` で変えられます。インストール時だけユーザー・パスワード・base URL を設定するため、既存ボリュームに対して `.env` を編集するだけでは FreshRSS 内の設定は更新されません。変更は管理画面/公式 CLI で明示的に行ってください。

## proxy の設定

- PWA へ API 全体を埋め込む必要はありません。API endpoint は PWA のニュース設定で指定できます。同一 origin に `/api/news/` を転送する構成も使えます。
- `Authorization` と `Origin` を API に渡し、API 応答をキャッシュしないでください。API は `Cache-Control: no-store` を返します。
- FreshRSS 管理画面を公開する proxy では `/api/news-bridge.php` を **403 で遮断**します。bridge は API コンテナーからの内部アクセス専用です。
- 家庭内 LAN と Tailscale の両方から、PWA/API/管理画面の名前解決と HTTPS が通ることを確認します。既存の AdGuard/Tailscale DNS 構成をこのサービスから変更することはありません。

## 運用とデータ保全

- 1 個の API プロセスで運用してください。同一 API データボリュームを複数 API コンテナーで共有する構成には対応しません。
- 既読/保存は「反転」ではなく指定した最終状態を送ります。受付 intent を先に SQLite に保存し、未確定操作を先に復旧してから後続操作を実行します。UUID 記録は削除しません。
- FreshRSS 管理 UI からの既読操作は API の操作順序に含まれません。通常の既読/保存はニュース画面に揃え、管理 UI は運用設定に使用してください。
- 取得障害時は以前の確認済みキャッシュを `stale` として返します。フィード単位のエラーや bridge の障害は `partial` として表示し、最後に取得できた記事を保持します。
- 手動更新は 1 分間隔の制限があり、FreshRSS の TTL・再試行待ち・フィードごとのロックを尊重します。全フィードの即時強制再取得を保証するボタンではありません。
- バックアップ対象は `freshrss_data`、`api_data`、`.secrets`、`.env`。一貫したバックアップでは両サービスの書き込みを止めるか、SQLite 対応バックアップ手段を使います。復元手順・実 NAS での復旧試験は別途実施します。
- 復元で過去の API receipt に巻き戻ると、すでに処理済みの UUID が失われる可能性があります。復元時は新しい API identity として扱い、端末の未送信操作を確認してから再接続してください。API SQLite 単体だけを過去へ戻す運用は避けます。
- `docker compose down -v`、`docker volume prune`、既存データの削除はこの手順に含めません。容量の増加は監視してください。

## 収集の制限

公開 HTTPS、443 番ポート、認証情報を含まない RSS/Atom のみを登録できます。FreshRSS の DNS 解決結果を接続先に固定し、リダイレクト先にも IP/HTTPS 制限を適用します。内部ホストの許可リストは本番では空です。DOCTYPE/ENTITY、形式不正、2 MiB を超える取得は拒否します。RSS 本文はプレーンテキストの短い概要にし、外部画像を自動表示しません。

FreshRSS 公式コードへの小さいパッチは固定版との完全一致を Docker build で確認します。更新時は `freshrss/apply-policy.php` と実 FreshRSS テストを再検証してください。変更箇所は自動保持の停止、HTTPS/接続先制限、TLS 検証、転送量/DOCTYPE制限です。FreshRSS 本体は AGPL-3.0 であり、この派生イメージを配布する場合は対応するソースとパッチを提供してください。

API 契約は [docs/api.md](docs/api.md)、検証方法は [docs/testing.md](docs/testing.md) を参照してください。

公式資料: [FreshRSS 1.30.4](https://github.com/FreshRSS/FreshRSS/releases/tag/1.30.4)、[Docker](https://github.com/FreshRSS/FreshRSS/blob/1.30.4/Docker/README.md)、[GReader API](https://freshrss.github.io/FreshRSS/en/developers/06_GoogleReader_API.html)。
