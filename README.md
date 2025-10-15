### Auto Deploy Test
# neon-api — 運用プロトコル（vA4+）

> 目的：このREADMEは、**復元力（RTO/RPO）**と**日次運用**を最小手数で回すための“真実のソース”です。実装と手順書を一体化し、事故後もこの1枚から復旧できます。

---

## 0. 要約（3行）

* **API**：`/health`（公開）, `/notes`（CRUD, Bearer必須）, `/export.csv`（CSV）
* **中枢**：鍵運用／RTO-RPO／監視／CSV規約／変更管理（DoD）を本書で固定
* **初動**：3分スモーク → 監視オン → 週次ドリル（復旧訓練）

---

## 1. 環境

* **Runtime**：Render（Node.js / TypeScript）
* **DB**：Neon（PostgreSQL, pg_trgm）
* **ブランチ**：`main`（本番）
* **構成定義**：`render.yaml`（※後続で実体化／IaC化）
* **API仕様**：`openapi.yaml`（OpenAPI 3.1, リポ直下に格納）

> 将来：Neon BranchingでA/B検証（手順は#9参照）

---

## 2. 鍵運用プロトコル（Scopes / 発行・失効・ローテ）

* **スコープ**：

  * `admin`：全操作、運用者のみ
  * `read`：GET系（/notes参照, /export.csv ダウンロード）
  * `export`：エクスポート専用（読み取り限定）
* **保管**：ユーザ環境変数（OSユーザスコープ）＋ パスワードマネージャ
* **発行**：Render ダッシュボード → Env に登録（READMEからリンク）
* **失効**：漏洩・退職時は**即時失効**→Render再デプロイ
* **ローテ**：**90日**ごと。重複期間を1日設け、切替確認後に旧鍵失効
* **漏洩時の初動**：

  1. 鍵の即時失効 2) 監査ログ確認（`x-request-id`） 3) API再デプロイ 4) READMEに事後記録

---

## 3. RTO / RPO と復旧ドリル

* **宣言**：RTO=**30分**／RPO=**24時間**
* **週次ドリル（3分）**：

  1. `/export.csv` を取得し日付付で保存
  2. `/health` と `/notes?limit=1` を確認
  3. Render 再起動→復帰時間を記録

> 事故時は本章→#8（CSV）→#9（Neonバックアップ）→#10（Self Test）の順で復元。

---

## 4. 監視（/ _status, Ping, アラート）

* **監視対象**：`/_status`（200/NG判定）
* **間隔**：**1時間**ごと。**連続2回NGで通知**
* **通知先**：運用者メール/Discord（本READMEに宛先を書く）
* **Cold start対策**：1h毎に**起床ping**（無害GET）
* **READMEの証跡**：監視設定と最終到達テストのスクショを本リポ`/docs/monitoring/`に保存

---

## 5. セキュリティ最小セット（High→Low）

* **Bearer比較の耐タイミング化**：`crypto.timingSafeEqual`
* **Rate Limit**：`express-rate-limit`（例：IPごと 60req/分）
* **Helmet**：`helmet()` デフォルト
* **CORSホワイト**：既知のフロントOriginのみ許可
* **要求ID**：`x-request-id` を受理/生成しログ（`pino`）へ
* **Idempotency-Key**（将来）：POST/PUT/PATCHの重複防止

> DoD：401動作／429動作／CORS拒否の**手動テスト**記録を`/docs/security/`に残す。

---

## 6. 検索・カーソルの一貫性

* **rank（類似度ソート）使用時はカーソル無効**：

  * `rank=true` のレスポンスに `X-Cursor-Disabled: 1`
  * UIへも同ヘッダを伝播し、ページングUIを抑止
* **`order_by=updated_at` のカーソル**：安定のため **(updated_at, id)** の複合キーでページング
* **付記**：`X-Rank-Disabled` 等の明示ヘッダは将来追加

---

## 7. 変更管理（DoD / OpenAPI差分ガード）

* **DoD（Definition of Done）**：

  1. README更新（該当章の追記）  2) OpenAPI更新  3) 手動テスト結果を`/docs/changes/`に保存  4) セマンティックバージョニング
* **OpenAPI差分ガード**：CIで `openapi-diff` を走らせ**破壊的変更で失敗**（※導入は後続タスク）

---

## 8. CSVエクスポート規約（互換性固定）

* **Content-Disposition**：`attachment; filename="notes_YYYYMMDD.csv"`
* **文字コード**：UTF-8 **BOM付き**
* **改行**：**CRLF**（Windows/Excel互換）
* **列順**：固定。将来列追加時は**末尾追加のみ**
* **Excel注意**：長い数値は先頭`'`で桁落ち防止（必要時）
* **README注記**：仕様を変える場合は**メジャー更新**扱い

---

## 9. データベース運用（Neon）

* **BranchingでA/B**：`main`から一時ブランチ→テスト→マージ/破棄
* **Backups履歴**：PITR/スナップショットの一覧を**月1で確認**し`/docs/db/`へ記録（スクショorSQL）
* **削除設計（将来）**：`deleted_at` でソフトデリート→`/restore` API

---

## 10. 3分スモークテスト

```bash
# 1) 健康確認
curl -sS https://<your-host>/health | jq .

# 2) 最小データ確認
curl -sS -H "Authorization: Bearer <READ_KEY>" \
  "https://<your-host>/notes?limit=1"

# 3) CSVダウンロード（BOM/CRLF/ファイル名を確認）
curl -sS -H "Authorization: Bearer <EXPORT_KEY>" \
  -o notes_$(date +%Y%m%d).csv \
  "https://<your-host>/export.csv"
```

---

## 11. Self Test（`notes-selftest.ps1` 概要）

* **3手でOK/ERRORを出力**：`/_status` → `/notes?limit=1` → `export.csv`
* **結果**：`[OK]` か `[ERROR:<phase>]` を標準出力
* **README**：使い方とサンプル出力を本章に追記（ツールは`/tools/`配下）

---

## 12. リリース手順（最小）

1. 変更をコミット（README, openapi.yaml, server.ts など）
2. `render.yaml` で**環境差**を吸収 → デプロイ
3. 3分スモーク（#10）→ 監視で到達確認（#4）

---

## 13. 付録リンク（本リポ内）

* **付録A**：OpenAPI全文 → `openapi.yaml`
* **付録F**：`render.yaml` テンプレ（IaC）
* **付録I**：`timingSafeEqual` 最小パッチ例
* **付録J**：3分スモークの詳細手順
* **付録K**：技術設計の懸念・改善余地
* **付録L**：所見／意思決定ログ（短評）

---

## 14. DoD（このREADME自体の完了条件）

* [ ] リポ直下に配置し、**Renderダッシュボードからリンク**
* [ ] 監視タスクの到達テストスクショを `/docs/monitoring/` に保存
* [ ] 3分スモークの最新実行ログ（日時・要約）を `/docs/runbooks/` に保存
* [ ] 本章のチェック項目に**日付**を記入

---

### 更新履歴

* 2025-10-15 vA4+ 初版（運用プロトコル定着／短時間復旧を最優先）
