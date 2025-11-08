README_vA6_quick.md

— 導入・再構築用クイックガイド（vA6一発実装対応）—

0. 目的

この文書は、vA6 システムをゼロから導入・再構築するための
最短マニュアルです。
開発・運用・思想・検証の詳細は README_vA6_main.md および README_vA6_dev.md を参照。

1. 構成の全体像（理解）

Render（Node.js／APIサーバ）
　→ /health, /notes, /export.csv を提供する中心。

Neon（PostgreSQL／DB）
　→ notes テーブルとログデータを保持。

GitHub（コード・設定・バックアップ）
　→ Render・Neon構成をIaC（Infrastructure as Code）で管理。

UptimeRobot（監視）
　→ /health を60秒ごとに監視し、Renderを常時稼働状態に保つ。

2. 導入手順
ステップ	操作	所要時間
①	GitHubで Fork する（1クリック）	約30秒
②	Renderで “New Web Service” → GitHub連携（2クリック）	約1分
③	環境変数をコピー＆ペースト（5項目）	約2分
④	Neonで DB作成 → init.sql を実行（1クリック＋1ペースト）	約1分
⑤	/health にアクセスして {"ok":true} を確認	約10秒

合計：5クリック＋数回コピペで完了（所要約5分）

3. 動作確認
項目	方法	正常時の挙動
API応答	/health	{"ok":true}
データ書込	/notes POST	データベース登録成功
CSV出力	/export.csv	CSVが自動ダウンロード
監視	UptimeRobot	ステータス 200（OK）を保持
4. 関連ファイル
ファイル	内容
README_vA6_main.md	運用・設計・環境設定の正式手順
README_vA6_dev.md	思想・経緯・試行記録
archive/	旧版の完全保存群（vA4+〜vA5.1）
init.sql	Neon DB初期化スクリプト
openapi.yaml	ChatGPT Actions 登録用仕様書
5. 補足（設計思想の要約）

「誰が導入しても、同じ形で動く」
そのために、構成・変数・監視すべてをクラウドに固定した。
この quick.md は、5クリックで“同じ環境”を再現できることを目的としている。
