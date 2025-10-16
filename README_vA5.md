# neon-api — 運用プロトコル（vA5・完全統合版）

本書は README vA4+（2025-10-16）を基礎とし、  
原本「vA4 Neon.docx」（付録A〜L）に含まれる技術情報・思想・改善提案を再統合した**完全版（Full Spec）**です。

---

## 0. 要約（3行）

API：/health（公開）, /notes（CRUD, Bearer必須）, /export.csv（CSV）  
中枢：鍵運用／RTO-RPO／監視／CSV規約／変更管理（DoD）  
目的：RTO=30分 / RPO=24時間 の復旧基準を実現し、無料枠で持続運用を保証する。

---

## 1. 環境と構成
- Runtime：Render（Node.js / TypeScript）
- DB：Neon（PostgreSQL + pg_trgm）
- ブランチ：main（本番）
- IaC：render.yaml（付録Fに定義）
- OpenAPI：openapi.yaml（付録Aに全文）
- 運用時間軸：UTC保存／JST表示

---

## 2. 鍵運用プロトコル
- スコープ種別：admin / read / export
- 発行・失効手順
- ローテポリシー
- 漏洩時の初動対応
- 記録保存：/docs/keys/

---

## 3. RTO / RPO と復旧ドリル
- 目標：RTO=30分 / RPO=24時間
- 週次3分スモークテスト
- 復旧手順（#10参照）

---

## 4. 監視と通知
- 対象：/_status（200/NG）
- 通知先：Discord / Mail
- 頻度：1時間ごと（2回連続NGで通知）
- Cold start対策：定時ping

---

## 5. セキュリティ最小セット
- Bearer検証：crypto.timingSafeEqual（付録I）
- Rate Limit / Helmet / CORSホワイト
- 監査ログ：pino + x-request-id

---

## 6. 検索とカーソル制御
- rank=true時：cursor無効化（X-Cursor-Disabled:1）
- order_by=updated_at,id で安定化
- 将来：Idempotency-Key対応予定

---

## 7. 変更管理とDoD
- Definition of Done（付録J参照）
- OpenAPI差分ガード（openapi-diff CI）
- Render設定の宣言的化（付録F）

---

## 8. CSVエクスポート規約
- UTF-8 BOM + CRLF
- Content-Disposition: notes_YYYYMMDD.csv
- Excel対応注記あり

---

## 9. データベース運用（Neon）
- BranchingによるA/B検証
- PITR・Snapshot月次確認
- DDL・索引・トリガー（付録B）

---

## 10. Self Test（notes-selftest.ps1）
- /_status → /notes?limit=1 → /export.csv
- 結果：OK / ERROR:<phase>
- 実体：付録H（PowerShell Profile）

---

## 11. リリース手順（最小構成）
- README・openapi.yaml・server.ts 更新
- render.yamlで環境差吸収
- 3分スモーク→監視到達確認

---

## 12. 技術詳細・参照付録
- 付録A：OpenAPI全文
- 付録B：NeonスキーマDDL
- 付録C：server.ts詳細インベントリ
- 付録D：package.json差分
- 付録E：tsconfig差分
- 付録F：render.yaml雛形
- 付録G：タスクスケジューラ定義
- 付録H：PowerShellツール群
- 付録I：最小パッチ例
- 付録J：DoDテンプレ & 3分スモーク
- 付録K：思想・構造・コスト統合図
- 付録L：レビュア所見／KPI表

---

## 13. 運用ルール（3本柱・再掲）
- 証拠優先
- 停止ワード即中断
- 狙撃型実行（1手＋バックアップ1案）

補強：承認確認・確度明示・成果物提示

---

## 14. 更新履歴（vA5作業記録）
| 日付 | 内容 | 担当 |
|------|------|------|
| 2025-10-16 | vA4+ 発行・Render安定稼働 | i.m |
| 2025-10-17 | vA5骨格構築（本テンプレ作成） | ChatGPT |
| 2025-10-XX | 付録A〜L 統合反映 | — |

---

