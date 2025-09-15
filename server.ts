import express, { Request, Response, NextFunction } from "express";
import { neon } from "@neondatabase/serverless";

const app = express();
app.use(express.json());

// -------------------- 認証（/health は除外） --------------------
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === "/health") return next();

  const expected = process.env.API_KEY;
  const auth = (req.header("authorization") || "").trim();

  if (!expected) return res.status(500).json({ error: "Server misconfigured" });
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

// notes テーブルに title 列があるか事前チェック
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
    console.warn("Failed to detect columns of notes table:", e);
  }
})();

// -------------------- ヘルスチェック --------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

// -------------------- 作成（contentのみ） --------------------
app.post("/notes", async (req, res) => {
  const content = String(req.body?.content ?? "");
  if (!content) return res.status(400).json({ error: "content is required", code: 400 });

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

// -------------------- 一覧 --------------------
app.get("/notes", async (_req, res) => {
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

// ==================== 追加分 ====================

// ---- 削除：ハード削除 ----
app.delete("/notes/:id", async (req, res) => {
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

// ---- 一部更新：PATCH /notes/:id ----
app.patch("/notes/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "IDの形式が正しくありません", code: 400 });
  }

  const allowed = ["title", "content"];
  const keys = Object.keys(req.body ?? {});
  if (keys.length === 0) {
    return res.status(400).json({ error: "更新対象の項目がありません", code: 400 });
  }
  const unknown = keys.filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    return res.status(400).json({ error: `未知の項目があります: ${unknown.join(", ")}`, code: 400 });
  }

  const hasTitle = keys.includes("title");
  const hasContent = keys.includes("content");

  const title: string = hasTitle ? String(req.body.title ?? "") : "";
  const content: string = hasContent ? String(req.body.content ?? "") : "";

  // 入力チェック
  if (hasTitle) {
    if (!NOTES_HAS_TITLE) {
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

  try {
    let rows: any[] = [];

    if (hasTitle && hasContent && NOTES_HAS_TITLE) {
      rows = await sql/*sql*/`
        update notes
        set title = ${title},
            content = ${content},
            updated_at = now()
        where id = ${id}
        returning id, title, content, created_at, updated_at
      `;
    } else if (hasTitle && NOTES_HAS_TITLE) {
      rows = await sql/*sql*/`
        update notes
        set title = ${title},
            updated_at = now()
        where id = ${id}
        returning id, title, content, created_at, updated_at
      `;
    } else if (hasContent) {
      rows = await sql/*sql*/`
        update notes
        set content = ${content},
            updated_at = now()
        where id = ${id}
        returning id, ${NOTES_HAS_TITLE ? sql`title,` : sql``} content, created_at, updated_at
      `;
    } else {
      return res.status(400).json({ error: "更新対象の項目がありません", code: 400 });
    }

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
