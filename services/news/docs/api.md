# News API protocol 1

Base path は `/api/news`。JSON UTF-8。`GET /info` 以外は `Authorization: Bearer <API用キー>` 必須です。全応答は `Cache-Control: no-store`。CORS は設定した正確な origin のみ許可します。cookie は使用しません。

## GET /info

```json
{"protocol":1,"mode":"news","server_id":"UUID","capabilities":{"read":true,"starred":true,"feeds":true,"pause":true,"refresh":true,"pagination":true,"automatic_deletion":false},"admin_url":"https://rss.example.com"}
```

`server_id` は API データベースごとの永続 UUID。違う ID の接続先に端末の保留操作を自動転送しないでください。`admin_url` は未設定時 `null`。

## GET /snapshot?view=all&limit=500&cursor=...

- `view`: `all`（新しい順）または `saved`（保存済み全件を独立ページング）。保存一覧は `all` の先頭ページで代用しません。
- `limit`: 1〜500。FreshRSS からは最大100件ずつ、必要ならさらに小さく取得し、指定した件数まで集約します。残りの記事が指定数未満の場合は全残件を返します。続きは `pagination.has_more` で判定します。
- `cursor`: 応答の `pagination.next_cursor` をそのまま同じ view に渡します。数値に変換しません。

```json
{
  "protocol":1,"mode":"news","server_id":"UUID","updated_at":"2026-11-15T01:00:00Z",
  "capabilities":{"read":true,"starred":true,"feeds":true,"pause":true,"refresh":true,"pagination":true,"automatic_deletion":false},
  "admin_url":"https://rss.example.com",
  "sync":{"status":"ok","last_success_at":"2026-11-15T01:00:00Z","error":null},
  "feeds":[{"id":"feed/1","title":"配信元","url":"https://example.com/rss.xml","category":"総合","enabled":true,"last_success_at":"2026-11-15T00:55:00Z","last_error_at":null,"error":null}],
  "items":[{"id":"tag:google.com,2005:reader/item/123abc","title":"記事","url":"https://example.com/article","summary":"RSS に含まれる概要","published_at":"2026-11-15T00:50:00Z","received_at":"2026-11-15T00:55:00Z","feed_id":"feed/1","feed_title":"配信元","categories":["総合"],"read":false,"starred":false}],
  "pagination":{"next_cursor":null,"has_more":false}
}
```

記事/フィード ID は常に文字列です。記事 URL が不正な場合は空文字列でリンクを無効化します。未取得の日時は `null`、bridge 状態不明時の `enabled` も `null`。`updated_at`/`sync.last_success_at` は NAS API が一覧を確認できた時刻です。配信元の鮮度は各フィードの `last_success_at` で判断してください。

`sync.status` は `ok` / `partial` / `stale`。`partial` は一部の取得失敗または状態取得失敗、`stale` は以前のキャッシュです。キャッシュがなければ障害時 503 を返し、空の成功一覧を作りません。各 RSS の同 URL 記事は別 ID で返します。UI でまとめる場合は全 ID を保持し、状態変更時にまとめて送ります。

## POST /operations

```json
{"operation_id":"UUID","server_id":"UUID","item_ids":["tag:google.com,2005:reader/item/123abc"],"changes":{"read":true,"starred":false}}
```

`item_ids` は 1〜500 件。`changes` は `read`/`starred` の片方または両方を真偽値で指定します。反転操作はありません。

応答: `{"operation_id":"UUID","status":"applied","server_id":"UUID"}`。

同じ UUID/正規化内容の再送は永続 receipt を返し、再実行しません。同 UUID で異なる内容は 409。NAS 側で intent を先に保存し、外部適用後の receipt 保存に失敗した場合も後続操作より先に復旧します。応答が不明な場合は **同 UUID・同内容** で再送します。

## POST /feeds

共通: `operation_id`, `server_id`, `action`。

| action | フィールド | 動作 |
|---|---|---|
| `add` | `url`, 任意 `title`, `category` | RSS/Atom 登録。category の初期値は総合 |
| `update` | `feed_id`, `title` または `category` | 表示名/単一分類を更新 |
| `pause` | `feed_id` | 取得を停止。記事は保持 |
| `resume` | `feed_id` | 取得を再開 |

カテゴリは `総合` / `経済` / `IT`。表示名は 1〜160 文字。URL の変更は新規登録と元フィードの停止で行います。削除/購読解除 API はありません。応答は operations と同形で、bridge 操作では `feed_id`/`enabled` が追加されることがあります。

## POST /refresh

入力: `{"server_id":"UUID"}`。応答: `{"server_id":"UUID","sync":{"status":"ok","last_success_at":"...","error":null}}`。

1 分間隔で利用でき、FreshRSS の更新スケジュールを実行します。最大 10 フィード、TTL/取得停止/Retry-After は維持します。全件の強制取得を意味しません。

## エラー

形: `{"error":{"code":"...","message":"日本語メッセージ"}}`。内部 URL、パス、秘密値、RSS 生本文はエラーに含めません。

| HTTP/code | 処理 |
|---|---|
| 401 `unauthorized` | キー再入力 |
| 403 `origin_denied` | NAS 側 CORS 設定を確認 |
| 409 `server_id_changed` | 同期先変更として未送信操作を保持し、利用者に確認 |
| 409 `operation_id_reused` | 同 UUID 内容変更を止める |
| 409 `pending_operation` | 先行未確定操作あり。内容と UUID を保持して再送 |
| 409 `refresh_busy` | 前の更新終了後に再実行 |
| 422 `invalid_feed` / `unsafe_feed` | HTTPS/形式/配信元応答を確認。修正した登録は新 UUID |
| 429 `refresh_throttled` | 1 分以上待つ |
| 503 `upstream_unavailable` 等 | 端末キャッシュと操作を保持し、同 UUID で再送 |

JSON Schema の入力定義は [requests.schema.json](requests.schema.json)。
