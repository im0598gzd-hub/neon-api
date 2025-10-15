neon-api — 運用プロトコル（vA4+）

目的：このREADMEは、復元力（RTO/RPO）と日次運用を最小手数で回すための“真実のソース”です。
実装と手順書を一体化し、事故後もこの1枚から復旧できます。

0. 要約（3行）

API：/health（公開）, /notes（CRUD, Bearer必須）, /export.csv（CSV）

中枢：鍵運用／RTO-RPO／監視／CSV規約／変更管理（DoD）を本書で固定

初動：3分スモーク → 監視オン → 週次ドリル（復旧訓練）

1. 環境

Runtime：Render（Node.js / TypeScript）

DB：Neon（PostgreSQL, pg_trgm）

ブランチ：main（本番）

構成定義：render.yaml（※後続で実体化／IaC化）

API仕様：openapi.yaml（OpenAPI 3.1, リポ直下に格納）

将来：Neon BranchingでA/B検証（手順は#9参照）

2. 鍵運用プロトコル（Scopes / 発行・失効・ローテ）

スコープ

admin：全操作、運用者のみ

read：GET系（/notes参照, /export.csv ダウンロード）

export：エクスポート専用（読み取り限定）

保管：ユーザ環境変数（OSユーザスコープ）＋ パスワードマネージャ

発行：Render ダッシュボード → Env に登録（READMEからリンク）

失効：漏洩・退職時は即時失効→Render再デプロイ

ローテ：90日ごと。重複期間を1日設け、切替確認後に旧鍵失効

漏洩時の初動

鍵の即時失効

監査ログ確認（x-request-id）

API再デプロイ

READMEに事後記録

3. RTO / RPO と復旧ドリル

宣言：RTO=30分／RPO=24時間

週次ドリル（3分）

/export.csv を取得し日付付で保存

/health と /notes?limit=1 を確認

Render 再起動→復帰時間を記録

事故時は本章→#8（CSV）→#9（Neonバックアップ）→#10（Self Test）の順で復元。

4. 監視（/_status, Ping, アラート）

監視対象：/_status（200/NG判定）

間隔：1時間ごと、連続2回NGで通知

通知先：運用者メール/Discord（本READMEに宛先を書く）

Cold start対策：1h毎に起床ping（無害GET）

README証跡：監視設定と最終到達テストのスクショを/docs/monitoring/に保存

5. セキュリティ最小セット（High→Low）

Bearer比較：crypto.timingSafeEqual

Rate Limit：express-rate-limit（例：IPごと60req/分）

Helmet：helmet() デフォルト

CORSホワイト：既知のフロントOriginのみ許可

要求ID：x-request-idを受理/生成しpinoに記録

Idempotency-Key（将来）：POST/PUT/PATCHの重複防止

DoD：401動作／429動作／CORS拒否のテスト結果を/docs/security/に保存。

6. 検索・カーソルの一貫性

rank（類似度ソート）使用時はカーソル無効

rank=true時、レスポンスにX-Cursor-Disabled: 1

UIも同ヘッダを見てページングを抑止

**order_by=updated_at**時は (updated_at, id) 複合キーで安定化

将来：X-Rank-Disabled等の追加を予定

7. 変更管理（DoD / OpenAPI差分ガード）

DoD（Definition of Done）

README更新（該当章追記）

OpenAPI更新

手動テスト結果を/docs/changes/に保存

セマンティックバージョニング

OpenAPI差分ガード

CIでopenapi-diffを走らせ、破壊的変更はFail

実装は後続タスクで導入予定

8. CSVエクスポート規約（互換性固定）

Content-Disposition：attachment; filename="notes_YYYYMMDD.csv"

文字コード：UTF-8 BOM付き

改行：CRLF（Windows/Excel互換）

列順：固定。将来列追加は末尾追加のみ

Excel注意：長い数値は先頭'で桁落ち防止

仕様変更はメジャー更新扱い

9. データベース運用（Neon）

BranchingでA/B：mainから一時ブランチ→テスト→マージ/破棄

Backups履歴：PITR/スナップショットを月1確認し/docs/db/に保存

削除設計（将来）：deleted_atでソフトデリート→/restoreAPI予定

10. 3分スモークテスト
# 1) 健康確認
curl -sS https://<your-host>/health | jq .

# 2) 最小データ確認
curl -sS -H "Authorization: Bearer <READ_KEY>" \
  "https://<your-host>/notes?limit=1"

# 3) CSVダウンロード（BOM/CRLF/ファイル名を確認）
curl -sS -H "Authorization: Bearer <EXPORT_KEY>" \
  -o notes_$(date +%Y%m%d).csv \
  "https://<your-host>/export.csv"

11. Self Test（notes-selftest.ps1）

3手でOK/ERRORを出力：/_status → /notes?limit=1 → export.csv

結果：[OK] または [ERROR:<phase>]

ツール：/tools/配下に格納、使い方は本章に追記

12. リリース手順（最小）

README・openapi.yaml・server.ts等を更新しコミット

render.yamlで環境差吸収 → 自動デプロイ

3分スモーク（#10）→ 監視到達確認（#4）

13. 付録リンク（本リポ内）

付録A：OpenAPI全文 → openapi.yaml

付録F：render.yamlテンプレ（IaC）

付録I：timingSafeEqual最小パッチ例

付録J：3分スモーク詳細手順

付録K：技術設計の懸念・改善余地

付録L：所見／意思決定ログ（短評）

14. DoD（このREADME自体の完了条件）

 リポ直下に配置し、Renderダッシュボードからリンク

 監視タスクの到達テストスクショを /docs/monitoring/ に保存

 3分スモークの最新実行ログを /docs/runbooks/ に保存

 本章チェックに日付を記入

15. 運用ルール補遺（2025-10-16確定）

核ルール：3本柱

証拠優先（最新の事実を唯一の根拠とする）

停止ワード即中断（作業を止めて現状確認）

狙撃型実行（1手集中＋バックアップ1案）

補強ルール

承認確認を必須化（全操作にOK/NGを得る）

確度・成果物・理由を常に明示

会話モード：作業時＝厳格適用／雑談時＝潜在保持

16. 本日の作業履歴（2025-10-16）
時刻（JST）	作業内容	結果
15:00〜15:31	GitHub README 最終整形・Render反映確認	✅ 成功
15:40〜16:18	lockファイル生成・コミット	✅ 成功
16:28〜16:52	Render再デプロイ（npm install運用）	✅ 稼働中（/health OK）
17:00〜17:44	Render再デプロイ（npm install運用）	✅ 稼働中（/health OK）
17:49〜18:16	Render再デプロイ（npm install運用）	✅ 稼働中（/health OK）
23:20〜23:50	Render再デプロイ（npm install運用）	✅ 稼働中（/health OK）
23:57〜00:48	Render再デプロイ（npm install運用）	✅ 稼働中（/health OK）
23:57〜00:48	常駐ルールを3本柱に再固定	✅ 完了
23:57〜00:48	README更新方針（追記型）決定	✅ 確定
🧭 概要まとめ

本日は、Render自動反映・安定稼働・追記運用ルール確立まで完了。
残タスクは 「Blueprint UI再登場時のIaC再適用」 のみ。
以降は「追記運用モード（append-only）」で更新を継続する。

更新履歴

2025-10-15 vA4+：初版（運用プロトコル定着／短時間復旧優先）

2025-10-16 追補：運用ルール3本柱＋当日作業履歴追加

✅ 次回更新予定：Blueprint UI復活時のIaC統合版（vA5）
⏱ 次検証ドリル：2025-10-20（月） 週次復旧テスト予定
