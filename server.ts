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

// 監査ログ（最小限）
app.use((req: Request, _res: Response, next: NextFunction) => {
  const hasBody =
    (req.headers["content-length"] && Number(req.headers["content-length"]) > 0) ||
    (req as any).body
      ? "yes"
      : "no";
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} body:${hasBody}`);
  next();
});

// 認証（Bearer）
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const h = req.header("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m || m[1] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ===== Routes =====
app.get("/health", (_req, res) => res.json({ ok: true }));

// 一覧
app.get("/notes", requireAuth, async (_req, res) => {
  try {
    const rows: any[] = await sql/*sql*/`
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

// 追加（tags は任意・配列）
app.post("/notes", requireAuth, async (req, res) => {
  try {
    const content = (req.body && req.body.content) ?? "";
    if (typeof content !== "string" || content.trim() === "") {
      return res.status(400).json({ error: "content is required (non-empty string)" });
    }

    const rawTags = (req.body && req.body.tags) ?? [];
    const tags: string[] = Array.isArray(rawTags) ? rawTags.map(String) : [];

    const rows: any[] = await sql/*sql*/`
      insert into notes (content, tags, created_at)
      values (${content}, ${tags}, now())
      returning id, content, tags, created_at, updated_at
    `;
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// 部分更新（content / tags のいずれか・両方OK）
app.patch("/notes/:id", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }

    const hasContent = typeof req.body?.content === "string";
    const content: string | undefined = hasContent ? String(req.body.content) : undefined;

    const hasTags = Array.isArray(req.body?.tags);
    const tags: string[] | undefined = hasTags ? (req.body.tags as any[]).map(String) : undefined;

    if (!hasContent && !hasTags) {
      return res.status(400).json({ error: "nothing to update" });
    }

    let rows: any[];

    if (hasContent && hasTags) {
      rows = await sql/*sql*/`
        update notes
        set content = ${content!}, tags = ${tags!}, updated_at = now()
        where id = ${id}
        returning id, content, tags, created_at, updated_at
      `;
    } else if (hasContent) {
      rows = await sql/*sql*/`
        update notes
        set content = ${content!}, updated_at = now()
        where id = ${id}
        returning id, content, tags, created_at, updated_at
      `;
    } else {
      rows = await sql/*sql*/`
        update notes
        set tags = ${tags!}, updated_at = now()
        where id = ${id}
        returning id, content, tags, created_at, updated_at
      `;
    }

    if (!rows || rows.length === 0) return res.status(404).json({ error: "not found" });
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
    const rows: any[] = await sql/*sql*/`
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

app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
