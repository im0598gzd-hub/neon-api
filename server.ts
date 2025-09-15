import express, { Request, Response, NextFunction } from "express";
import { neon } from "@neondatabase/serverless";

const app = express();
app.use(express.json());

// -------------------- 認証ミドルウェア（/health は除外） --------------------
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === "/health") return next();

  const expected = process.env.API_KEY; // Render の Environment に設定
  const auth = (req.header("authorization") || "").trim(); // 受け取ったヘッダ

  if (!expected) {
    return res.status(500).json({ error: "Server misconfigured" });
  }
  if (!auth || auth !== `Bearer ${expected}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// -------------------- DB 接続 --------------------
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const sql = neon(DATABASE_URL);

// DBの notes テーブルに title 列があるかどうかを起動時に検出しておく
let NOTES_HAS_TITLE = false;
(async () => {
  try {
    const rows = await sql/*sql*/`
      select column_name
      from information_schema.columns
      where table_name = 'notes' and column_name in ('title','content')
    `;
    NOTES_HAS_TITLE = rows.some((r: any) => r.column_name === "title");
  } catch (e) {
    // 検出に失敗してもアプリは動かす（titleは無い前提で扱う）
    console.warn("Failed to detect columns of notes table:", e);
  }
})();

// -------------------- ヘルスチェック（公開） --------------------
app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// -------------------- メモ作成（content だけ） --------------------
// body 例: { "content": "テキスト" }
app.post("/notes", async (req: Request, res: Response) => {
  const content = (req.body?.content ?? "").toString();
  if (!content) {
    return res.status(400).json({ error: "content is required", code: 400 });
  }
  try {
    const rows = await sql/*sql*/`
      insert into notes (content)
      values (${content})
      returning id, ${NOTES_HAS_TITLE ? sql`title,` : sql``} content, created_at
    `;
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB insert failed", code: 500 });
  }
});

// -------------------- メモ一覧 --------------------
app.get("/notes", async (_req: Request, res: Response) => {
  try {
    const rows = await sql/*sql*/`
      select id, ${NOTES_HAS_TITLE ? sql`title,` : sql``} content, created_at
      from notes
      order by id desc
      limit 50
    `;
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB select failed", code: 500 });
  }
});

// ==================== ここから 追加分 ====================

// ---- 削除：DELETE /notes/:id （ハード削除） ----
app.delete("/notes/:id", async (req: Request, res: Response) => {
  // 数値IDチェック
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "IDの形式が正しくありません", code: 400 });
  }

  try {
    const rows = await sql/*sql*/`delete from notes where id = ${id} returning id`;
    if (rows.length === 0) {
      return res.status(404).json({ error: "指定されたIDのメモは存在しません", code: 404 });
    }
    return res.status(200).json({ message: "メモを削除しました" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "DB delete failed", code: 500 });
  }
});

// ---- 一部更新：PATCH /notes/:id （title / content） ----
// 仕様：送られた項目だけ更新。未知フィールドは 400。
// 入力規則：title=1〜200文字（空禁止） / content=0〜10000文字
app.patch("/notes/:id", async (req: Request, res: Response) => {
  // 数値IDチェック
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "IDの形式が正しくありません", code: 400 });
  }

  // 未知フィールド検出
  const allowed = ["title", "content"];
  const keys = Object.keys(req.body ?? {});
  if (keys.length === 0) {
    return res.status(400).json({ error: "更新対象の項目がありません", code: 400 });
  }
  const unknown = keys.filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    return res.status(400).json({ error: `未知の項目があります: ${unknown.join(", ")}`, code: 400 });
  }

  // 値の取り出し
  const hasTitle = keys.includes("title");
  const hasContent = keys.includes("content");
  const title = hasTitle ? String(req.body.title ?? "") : undefined;
  const content = hasContent ? String(req.body.content ?? "") : undefined;

  // 入力規則チェック
  if (hasTitle) {
    if (!NOTES_HAS_TITLE) {
      // テーブルに title 列が無い場合は未対応として返す
      return res.status(400).json({ error: "この環境では title は更新できません（テーブルに列がありません）", code: 400 });
    }
    if (title.length < 1 || title.length > 200) {
      return res.status(400).json({ error: "タイトルは1〜200文字で入力してください", code: 400 });
    }
  }
  if (hasContent) {
    if (content.length > 10000) {
      return res.status(400).json({ error: "content は1万文字以内で入力してください", code: 400 });
    }
  }

  // 動的に UPDATE 文を組み立てる
  const sets: any[] = [];
  if (hasTitle) {
    sets.push(sql`title = ${title}`);
  }
  if (hasContent) {
    sets.push(sql`content = ${content}`);
  }
  if (sets.length === 0) {
    return res.status(400).json({ error: "更新対象の項目がありません", code: 400 });
  }

  try {
    const rows = await sql/*sql*/`
      update notes
      set ${sql.join(sets, sql`, `)},
          updated_at = now()
      where id = ${id}
      returning id, ${NOTES_HAS_TITLE ? sql`title,` : sql``} content, created_at, updated_at
    `;
    if (rows.length === 0) {
      return res.status(404).json({ error: "指定されたIDのメモは存在しません", code: 404 });
    }
    return res.status(200).json(rows[0]);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "DB update failed", code: 500 });
  }
});

// ==================== 追加分ここまで ====================

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`API listening on :${port}`));
