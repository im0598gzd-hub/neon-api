<!--
README_vA5.md
作成日: 2025-10-17 JST
目的: README vA4+ と原本 vA4 Neon.docx の完全統合版（付録A〜L再収録ベース）
-->
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

---

### 付録A：OpenAPI 3.1 修正版（全文・貼り替え可）

（Actions Builder のスキーマ欄にそのまま貼付 → 保存 → 右上「更新する」）

```yaml
openapi: 3.1.0
info:
  title: Neon Notes API
  version: '1.0.1'

servers:
  - url: https://neon-api-3a0h.onrender.com

components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: API_KEY

  schemas:
    Note:
      type: object
      additionalProperties: false
      properties:
        id: { type: integer }
        content: { type: string }
        tags:
          type: array
          items: { type: string }
        created_at:
          type: string
          format: date-time
          description: UTCで保存（表示はJSTに変換されることがあります）
        updated_at:
          type: [string, 'null']
          format: date-time
          description: UTCで保存（表示はJSTに変換されることがあります）
        _rank:
          type: number
          description: pg_trgm similarity（`rank=1`時のみ出現）

paths:
  /health:
    get:
      summary: 健康状態確認
      responses:
        '200':
          description: OK
  /notes:
    get:
      summary: ノート一覧取得
      parameters:
        - name: q
          in: query
          description: 検索クエリ
          schema: { type: string }
        - name: rank
          in: query
          description: 類似度検索（true/false）
          schema: { type: boolean }
        - name: limit
          in: query
          description: 最大取得件数
          schema: { type: integer, default: 20 }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: array
                items: { $ref: '#/components/schemas/Note' }
  /export.csv:
    get:
      summary: CSVエクスポート
      security:
        - bearerAuth: []
      responses:
        '200':
          description: CSVファイルを返す
---

### 付録B：Neon スキーマ DDL・索引・トリガー（再掲／適用可）

> 目的：`notes` テーブルの最小スキーマを再現し、`updated_at` 自動更新と検索性能（pg_trgm）を確保する。  
> 方針：**安全な再適用**（IF NOT EXISTS／OR REPLACE）で idempotent に実行できる SQL を提示。

#### ✅ 前提
```sql
-- 必要拡張（類似度検索）
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE IF NOT EXISTS public.notes (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  content     TEXT NOT NULL,
  tags        TEXT[] DEFAULT '{}'::text[] NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ
);
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.notes;
CREATE TRIGGER trg_set_updated_at
BEFORE UPDATE ON public.notes
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
-- updated_at ソート安定化用（併用: id）
CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON public.notes (updated_at, id);

-- 全文・類似度検索（pg_trgm）
CREATE INDEX IF NOT EXISTS idx_notes_content_trgm
  ON public.notes USING GIN (content gin_trgm_ops);

-- タグ検索（配列包含）
CREATE INDEX IF NOT EXISTS idx_notes_tags_gin
  ON public.notes USING GIN (tags);
-- テーブル定義確認
\d+ public.notes

-- 拡張と索引確認
\dx
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'notes';
5) メモ

order_by=updated_at 時は (updated_at, id) の複合インデックスで安定化。

rank=true（pg_trgm 類似度）とカーソルは排他、実装は本文 #6 を参照。

追加列は末尾追加で CSV 互換性を維持（本文 #8）。
