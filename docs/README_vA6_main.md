# README_vA6_main — 運用版（完成形）

---

## 第1章：目的と概要
この文書は、vA6 システムを **最短手順で再構築・運用** するためのマニュアルである。  
思想や試行記録は `README_vA6_dev.md` に記載されている。  
本書では、実務に必要な「手順」「構造」「注意点」のみを記す。

---

## 第2章：環境構成

| 層 | サービス | 役割 | 備考 |
|----|-----------|------|------|
| **Render** | Node.js | APIサーバ | /health, /notes, /export.csv |
| **Neon** | PostgreSQL | データベース | PITR, スナップショット対応 |
| **GitHub** | Actions + Pages | 自動バックアップ / UI配信 | Publicリポジトリで無料運用 |
| **UptimeRobot** | 外部監視 | 常時稼働維持 | 15分間隔チェック |

---

## 第3章：初期構築手順（5クリック＋数回コピペ）

1. **Render 環境を作成**  
   - Node.js + TypeScript アプリをデプロイ  
   - 環境変数：`READ_KEY` / `EXPORT_KEY` / `ADMIN_KEY` を設定  

2. **Neon データベースを初期化**  
   - `init.sql` を実行してスキーマ作成  
   - PITR 有効化を確認  

3. **GitHub Actions を設定**  
   - `.github/workflows/backup.yml` に /export.csv 自動バックアップを登録  
   - `.github/workflows/health.yml` に /health チェックを登録  

4. **UptimeRobot を設定**  
   - 監視URLに Render の `/health` を登録  
   - 15分間隔監視でスリープ防止  

5. **Minimal Web UI を配信**  
   - GitHub Pages を有効化  
   - `UI_ORIGIN` を Pages URL に設定  
   - `/notes` のCRUDが動作することを確認  

---

## 第4章：運用ルールと点検

| 項目 | 頻度 | 操作内容 |
|------|------|----------|
| **バックアップ確認** | 毎日自動（手動時はActionsログ確認） | `/export.csv` 正常出力を確認 |
| **Neon PITR確認** | 月1回 | 復旧テスト（スナップショット復元） |
| **UptimeRobot監視** | 常時 | ダウン検知後に自動再起動を確認 |
| **README更新** | 必要時 | 設計変更・障害報告の反映 |

---

## 第5章：復旧と引継ぎ

- **障害時**：  
  - Render 落ち → 自動再起動を待機（15〜30分以内）。  
  - GitHub Actions 停止 → 再実行ボタンで復旧。  
  - Neon 障害 → PITRまたはCSV復旧を利用。  

- **引継ぎ時**：  
  1. DEATH.md を参照。  
  2. README_vA6_main → 実運用手順。  
  3. README_vA6_dev → 構造・思想の理解。  

---

## 付録：参照リンク

- [README_vA6_dev.md](./README_vA6_dev.md)
- [archive/README_vA4+.md](./archive/README_vA4+.md)
- [archive/README_vA5.md](./archive/README_vA5.md)
- [archive/README_vA5.1.md](./archive/README_vA5.1.md)
