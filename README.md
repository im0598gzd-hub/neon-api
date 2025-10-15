neon-api — 運用プロトコル（vA4+）

目的：このREADMEは、復元力（RTO/RPO）と日次運用を最小手数で回すための“真実のソース”です。
実装と手順書を一体化し、事故後もこの1枚から復旧できます。

0. 要約（3行）

API：/health（公開）, /notes（CRUD, Bearer必須）, /export.csv（CSV）

中枢：鍵運用／RTO-RPO／監視／CSV規約／変更管理（DoD）を本書で固定

初動：3分スモーク → 監視オン → 週次ドリル（復旧訓練）

1. 環境構成
項目	内容
Runtime	Render（Node.js / TypeScript）
DB	Neon（PostgreSQL, pg_trgm）
ブランチ	main（本番）
構成定義	render.yaml（※後続で実体化／IaC化）
API仕様	openapi.yaml（OpenAPI 3.1, リポ直下に格納）

将来：Neon BranchingでA/B検証（手順は #9 参照）

2. 鍵運用プロトコル（スコープ／発行・失効・ローテ）
スコープ

admin：全操作、運用者のみ

read：GET系（/notes参照, /export.csv ダウンロード）

export：エクスポート専用（読み取り限定）

運用ルール
区分	内容
保管	OSユーザ環境変数＋パスワードマネージャ
発行	Renderダッシュボード → Env登録（READMEからリンク）
失効	漏洩・退職時は即時失効 → Render再デプロイ
ローテ	90日ごと（重複期間1日）
漏洩時の初動	①即時失効 → ②監査ログ確認（x-request-id） → ③API再デプロイ → ④READMEに記録
3. RTO / RPO と復旧ドリル
指標	値
RTO	30分以内
RPO	24時間以内
週次ドリル（3分）

/export.csv を取得し日付付きで保存

/health と /notes?limit=1 を確認

Render再起動 → 復帰時間を記録

事故時は #8（CSV）→ #9（Neonバックアップ）→ #10（Self Test） の順で復元。

4. 監視（/_status, Ping, アラート）
項目	設定内容
監視対象	/_status（200/NG判定）
間隔	1時間ごと
通知条件	連続2回NGで通知
通知先	運用者メール／Discord（本READMEに記載）
Cold start対策	1時間ごとに起床ping（無害GET）

証跡：監視設定と最終テストのスクショを /docs/monitoring/ に保存。

5. セキュリティ最小セット
項目	実装内容
Bearer比較	crypto.timingSafeEqual
Rate Limit	express-rate-limit（IP単位60req/分）
Helmet	helmet() デフォルト適用
CORS	既知のOriginのみ許可
要求ID	x-request-idを受理／生成しpinoログ出力
Idempotency-Key（将来）	POST/PUT/PATCH重複防止用に実装予定

DoD：401／429／CORS拒否テスト結果を /docs/security/ に記録。

6. 検索・カーソル一貫性

rank（類似度ソート）使用時はカーソル無効化
→ X-Cursor-Disabled: 1 を返却しUIも無効化

order_by=updated_at のカーソルは (updated_at, id) 複合キーで安定化

将来：X-Rank-Disabled 等ヘッダ追加予定

7. 変更管理（DoD / OpenAPI差分ガード）
DoD（Definition of Done）

README更新（該当章追記）

OpenAPI更新

手動テスト結果を /docs/changes/ に保存

セマンティックバージョニング採用

差分ガード

CIで openapi-diff を実行し、破壊的変更があればビルド失敗。
（導入は後続タスク）

8. CSVエクスポート規約
項目	規約内容
ファイル名	notes_YYYYMMDD.csv
文字コード	UTF-8（BOM付き）
改行	CRLF（Windows/Excel互換）
列順	固定。列追加は末尾のみ
Excel対策	長数値には先頭 ' を付加

規約変更時はメジャーバージョン更新扱い。

9. データベース運用（Neon）
項目	内容
Branching	main → 一時ブランチ → テスト → マージ／破棄
Backups	月1確認 → /docs/db/ に記録（スクショ or SQL）
削除設計（将来）	deleted_at によるソフトデリート → /restore API予定
10. 3分スモークテスト
# 1. 健康確認
curl -sS https://<your-host>/health | jq .

# 2. 最小データ確認
curl -sS -H "Authorization: Bearer <READ_KEY>" \
  "https://<your-host>/notes?limit=1"

# 3. CSVダウンロード
curl -sS -H "Authorization: Bearer <EXPORT_KEY>" \
  -o notes_$(date +%Y%m%d).csv \
  "https://<your-host>/export.csv"

11. Self Test（notes-selftest.ps1）

3手で診断：/_status → /notes?limit=1 → /export.csv

出力：[OK] または [ERROR:<phase>]

配置：ツールは /tools/ 配下

README：使い方とサンプル出力を本章に追記予定

12. リリース手順（最小構成）

README / OpenAPI / Server を更新

render.yaml で環境差を吸収 → デプロイ

3分スモーク（#10）→ 監視確認（#4）

13. 付録リンク（リポジトリ内）
付録	内容
A	OpenAPI全文 → openapi.yaml
F	render.yaml テンプレ（IaC）
I	timingSafeEqual パッチ例
J	3分スモーク詳細手順
K	技術設計の懸念・改善余地
L	所見／意思決定ログ（短評）
14. DoD（README完了条件）

 リポ直下に配置し、Renderからリンク済

 監視テストスクショを /docs/monitoring/ に保存

 最新スモークログを /docs/runbooks/ に保存

 実施日を本章に記入

15. README更新ルール（2025-10-16追記）
区分	指針
原文維持	原文は改変せず、差分を追記で管理する
追記優先	日次更新・小改修は追記方式で行う
改版基準	章構成や思想が変わる場合のみ版番号を更新（例：vA5）
履歴管理	変更は「更新履歴」に必ず日付＋概要を記載
Render検証	README更新＝軽デプロイ検証の役割も兼ねる

追記時は、末尾に新章を追加して原文整合を保つこと。
再構成は設計思想が変わる場合のみに限定する。

16. 本日の作業履歴（2025-10-16）
時刻(JST)	作業内容	結果
13:00	GitHub README 最終整形・Render反映確認	✅ 成功
13:40	lockファイル生成・コミット	✅ 成功
14:00	Render再デプロイ（npm install運用）	✅ 稼働中（/health OK）
14:40	Blueprint試行（UI非対応）	⚠ 実行不可（UI更新による非表示）
15:20	IaC運用方針：手動安定版に確定	✅ 確立
15:50	常駐ルールを3本柱に再固定	✅ 完了
16:30	README更新方針（追記型）決定	✅ 確定

本日は、Render自動反映・安定稼働・追記運用ルール確立まで完了。
残タスクは「Blueprint UI再登場時のIaC再適用」のみ。

更新履歴
日付	内容
2025-10-15 vA4+	初版（運用プロトコル定着／短時間復旧最優先）
2025-10-16	追記：README更新ルール＋本日の作業履歴追加（vA4+維持）

✅ 完全統合版（vA4+追記済）
原文保持／全履歴連動／Render再適用可。
