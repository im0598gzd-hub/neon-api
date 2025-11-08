README_vA6_quick.md

— 初心者・後任者向けクイックガイド（実践特化）—

0. 目的

この文書は、vA6 システムを 10分以内に復旧・確認 するための
最短マニュアルです。
詳細な背景・構造は README_vA6_main.md および README_vA6_dev.md を参照。

1. 基本原理（理解）

停止しても壊れない構造
　→ Render／Neon／GitHub／UptimeRobot の4層冗長構成。

自動監視・自動起動の仕組み
　→ UptimeRobot が /health を定期チェックし、Renderを常時稼働状態に保つ。
　（手動アクセスは不要）

再現可能性の重視
　→ すべての手順・コードはクラウド上で完結。ローカル依存なし。

2. 最短復旧フロー（操作）
ステップ	行動	理由
①	Render ダッシュボードを開く（ https://dashboard.render.com/
 ）	無料プランは15分無通信で休眠するため、稼働確認。
②	「Deploy live」 状態を確認。
もしスリープ中なら /health をブラウザで開く。	/health が Render の起動トリガー。
③	Neon DB（ https://console.neon.tech
 ）を確認	接続エラーやスリープ解除をチェック。
④	UptimeRobot の監視URLを確認	/health が 200 を返しているかを確認。
⑤	/export.csv を開き、CSV出力を確認	DB通信・API・Renderの全系統が動作しているか確認。
3. もし異常があった場合（応急措置）
現象	対処	根拠
Renderが503／起動遅延	/health をリロード or 数十秒待機	無料枠のコールドスタート。自動復旧。
/export.csvでDB未接続	Neon のブランチを main に戻す	スリープ解除時の一時的分岐。
何をしても反応なし	README_vA6_main.md を参照	詳細手順で再構築可能。
4. 関連資料（構造別）
層	ファイル	内容
思想層	README_vA6_dev.md
	設計思想・旧版リンク・クイックガイド概要
運用層	README_vA6_main.md
	現行システムの手順・RTO/RPO定義
簡易層	README_vA6_quick.md（本書）	後任者・初心者用の最短経路
履歴層	archive/
	vA4+〜vA5.1 の完全バックアップ
