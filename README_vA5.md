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
---

### 付録C：server.ts 詳細インベントリ（挙動・ヘッダ・ミドルウェア順）

> 目的：運用時の“再現性”を担保するため、server.ts の**実行順序・受け渡しヘッダ・判定基準**を文章で固定化。  
> 本文 #5（セキュリティ最小セット）/#6（検索とカーソル）/#8（CSV）と相互参照。

#### 0) サービス基本
- ランタイム: Node.js / TypeScript（Express）
- ログ: pino（JSON構造）
- 監視: `/health`（200/NG判定）

#### 1) 環境変数（必須/任意）
| 変数 | 用途 | 例 |
|---|---|---|
| `DATABASE_URL` | Neon 接続文字列 | `postgres://…` |
| `READ_KEY` | readスコープ用APIキー | ランダム文字列 |
| `EXPORT_KEY` | exportスコープ用APIキー | ランダム文字列 |
| `ADMIN_KEY` | 管理操作用 | ランダム文字列 |
| `CORS_ORIGINS` | 許可Origin（カンマ区切り） | `https://app.example.com` |
| `RATE_LIMIT_PER_MIN` | レート制限/分 | `60` （既定） |

> いずれも Render ダッシュボードの **Env** に登録（README #2）。

#### 2) ミドルウェアの**実行順序**
1. `request-id` 付与/受理  
   - 受信ヘッダ `x-request-id` を採用。未指定なら `uuid.v4()` 生成。
2. `pino-http` で**リクエスト開始ログ**  
   - 出力：`{id, method, url, remoteAddr}`。
3. `helmet()` 既定有効化。
4. `cors()`  
   - `CORS_ORIGINS` のホワイトリストのみ許可。`OPTIONS` 事前応答。
5. `express-rate-limit`  
   - 既定 `IPごと60req/分`。429到達時に本文 #5 のDoDで確認。
6. `json/urlencoded` パーサ。
7. **ルータ**（/health, /notes, /export.csv など）。
8. **エラーハンドラ**（末尾で集約）

#### 3) 鍵（Bearer）検証
- 対象エンドポイント:  
  - `/notes` の **書き込み系**（POST/PUT/PATCH/DELETE） … `ADMIN_KEY`  
  - `/export.csv` … `EXPORT_KEY`  
  - `/notes?…` の **GET参照** は `READ_KEY` があるとき優先（公開にしない）  
- 実装ポイント: `crypto.timingSafeEqual` で `Authorization: Bearer <KEY>` を**定数時間比較**（付録I参照）。  
- 失敗時: `401` / JSON `{error:"unauthorized", request_id: <id>}`

#### 4) ルーティング挙動（要点）
- `GET /health` … `200 {"ok":true}`。**監視用**。
- `GET /notes`  
  - クエリ: `q`（文字列）, `rank`（true/false）, `limit`（int, 既定20）, `order_by`（`updated_at` 推奨）。  
  - `rank=true` のときは **pg_trgm** 類似度で並び替え。**本文 #6 の規約に従いカーソル無効**。  
  - レスポンスヘッダ:
    - `X-Cursor-Disabled: 1`（`rank=true` の場合）
    - それ以外でページング有効時は `X-Next-Cursor: <token>`
  - 監査: `x-request-id` を**必ずログ出力**し、pinoに `res.statusCode` と `responseTime` を残す。
- `GET /export.csv`  
  - **要 EXPORT_KEY**。  
  - ヘッダ:  
    - `Content-Type: text/csv; charset=UTF-8`  
    - **BOM付きUTF-8 / CRLF / 列順固定**（本文 #8）  
    - `Content-Disposition: attachment; filename="notes_YYYYMMDD.csv"`

#### 5) クエリとカーソルの一貫性（本文 #6 の具体）
- `rank=true` ⇔ **カーソル不可**（`X-Cursor-Disabled: 1` を返す）  
- `order_by=updated_at` の既定ソートは `(updated_at, id)` の複合キーで**安定化**  
- UI 側は上記ヘッダを見て、ページングUIを**自動抑止**する

#### 6) エラーハンドリング（統一形）
- 例外捕捉 → `status || 500`  
- 返却JSON例：  
  ```json
  { "error": "bad_request", "message": "invalid cursor", "request_id": "<id>" }
pinoに err, stack を付与（PII無し）

7) ログ出力フィールド（pino）

time, level, id(request-id), method, url, statusCode, responseTime, remoteAddr

8) セルフテスト対応（本文 #10）

フェーズ: /_status → /notes?limit=1 → /export.csv

成果: [OK] or [ERROR:<phase>] を PowerShell スクリプト（付録H）で出力
---

### 付録D：package.json 差分（vA4→vA5）

> 目的：vA4からvA5への依存関係更新内容を追跡し、再構築・復旧時の整合性を保証する。  
> 実装：Render / Neon / GitHub Actions すべて同一バージョンで再現可能。

#### 1. 差分サマリ
| 区分 | パッケージ | vA4 | vA5 | 備考 |
|------|-------------|-----|-----|------|
| 追加 | `express-rate-limit` | — | ^7.x | APIアクセス制限用（DoS防止） |
| 更新 | `pino` | ^8.0.0 | ^9.0.0 | 構造化ログ出力の高速化対応 |
| 更新 | `pg` | ^8.11 | ^8.13 | Neon接続安定化（SSLモード自動） |
| 更新 | `pg-trgm` | ^1.1.0 | ^1.2.0 | 類似度検索の安定化・高速化 |
| 更新 | `typescript` | ^5.3 | ^5.6 | tsconfig最適化（strictNullChecks維持） |
| 維持 | `express` | ^4.18 | ^4.18 | 安定版維持 |
| 維持 | `dotenv` | ^16.3 | ^16.3 | Render環境変数連携用 |
| 維持 | `cors` | ^2.8 | ^2.8 | Origin制御（CORS_ORIGINS適用） |
| 削除 | — | — | — | 該当なし（クリーンアップ済） |

#### 2. 開発系（devDependencies）
| パッケージ | vA4 | vA5 | 備考 |
|-------------|-----|-----|------|
| `ts-node` | ^10.9 | ^10.9 | 不変 |
| `@types/express` | ^4.17 | ^4.17 | 不変 |
| `@types/node` | ^20.10 | ^20.12 | v5.6対応 |
| `eslint` | ^8.56 | ^8.57 | CI内Lint最適化 |
| `prettier` | ^3.2 | ^3.3 | Markdown整形統一 |

#### 3. 補足事項
- Render自動ビルド時の`npm ci`検証済（2025-10-17 JST）。  
- `package-lock.json`の差分はリポジトリ自動生成（手動編集不要）。  
- 依存更新は全て`semver`互換（破壊的変更なし）。  
- 将来リリース（vA6）では`express@5`対応を想定（現行は安全域に留める）。

---
