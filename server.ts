// server.ts
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { neon } from "@neondatabase/serverless";

const app = express();

// ===== Runtime config =====
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

// ===== DB client =====
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const sql = neon(DATABASE_URL);

// ===== Middlewares =====
app.use(cors());
app.use(express.json({ limit: "1mb" })); // JSON本文を読む

// 最小限ログ
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ===== 認証（Bearer） =====
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const h = req.header("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m || m[1] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ===== Routes =====

// 健康チェック
app.get("/health", (_req, res) => res.json({ ok: true }));

// 一覧
app.get("/notes", requireAuth, async (_req, res) => {
  try {
    const rows: any = await sql`
      select id, content, tags, created_at, updated_at
      from notes
      order by id desc
    `;
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// 追加（空文字禁止、tagsは文字列配列のみ許可）
app.post("/notes", requireAuth, async (req, res) => {
  try {
    const content = req.body?.content;
    if (typeof content !== "string" || content.trim() === "") {
      return res
        .status(400)
        .json({ error: "content is required (non-empty string)" });
    }

    const tagsRaw = req.body?.tags;
    const tags =
      Array.isArray(tagsRaw) && tagsRaw.every((x: any) => typeof x === "string")
        ? (tagsRaw as string[])
        : [];

    const rows: any = await sql`
      insert into notes (content, tags)
      values (${content}, ${tags})
      returning id, content, tags, created_at, updated_at
    `;
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// 更新（content/tags のみ、部分更新可・プレースホルダずれ対策済み）
app.patch("/notes/:id", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }

    const set: string[] = [];
    const params: any[] = [];
    let p = 1;

    // content が送られてきたときのみ検証＆更新
    if (Object.prototype.hasOwnProperty.call(req.body, "content")) {
      const c = req.body.content;
      if (typeof c !== "string" || c.trim() === "") {
        return res
          .status(400)
          .json({ error: "content must be non-empty string" });
      }
      set.push(`content = $${p++}`);
      params.push(c);
    }

    // tags が送られてきたときのみ検証＆更新（文字列配列のみ受け付け）
    if (Object.prototype.hasOwnProperty.call(req.body, "tags")) {
      const t = req.body.tags;
      if (!Array.isArray(t) || !t.every((x: any) => typeof x === "string")) {
        return res
          .status(400)
          .json({ error: "tags must be an array of strings" });
      }
      set.push(`tags = $${p++}`);
      params.push(t);
    }

    if (set.length === 0) {
      return res.status(400).json({ error: "nothing to update" });
    }

    // updated_at はプレースホルダ不要
    set.push(`updated_at = now()`);

    const q = `
      update notes
      set ${set.join(", ")}
      where id = $${p}
      returning id, content, tags, created_at, updated_at
    `;

    // 動的SQLはunsafeを使う
    const rows: any = await (sql as any).unsafe(q, [...params, id]);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "not found" });
    }
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// 削除
app.delete("/notes/:id", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }
    const rows: any = await sql`
      delete from notes where id = ${id}
      returning id
    `;
    if (!rows || rows.length === 0) return res.status(404).json({ error: "not found" });
    res.status(204).send();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ===== Start =====
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
