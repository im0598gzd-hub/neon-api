import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { neon } from "@neondatabase/serverless";

const app = express();

// ===== Runtime config =====
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = neon(DATABASE_URL);

// ===== Middlewares =====
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// minimal audit log
app.use((req: Request, _res: Response, next: NextFunction) => {
  const hasBody =
    (req.headers["content-length"] && Number(req.headers["content-length"]) > 0) ||
    (req as any).body
      ? "yes"
      : "no";
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} body:${hasBody}`);
  next();
});

// Auth (Bearer)
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const h = req.header("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m || m[1] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ===== Helper: normalize tags =====
function normalizeTags(input: any): string[] {
  if (!Array.isArray(input)) return [];
  const cleaned = input
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x.length > 0)
    .map((x) => x.replace(/[\uFF01-\uFF5E]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
    )) // 全角英数→半角
    .map((x) => /^[A-Za-z0-9]+$/.test(x) ? x.toLowerCase() : x); // 英数字は小文字化
  return Array.from(new Set(cleaned)); // 重複除去
}

// ===== Routes =====

// health
app.get("/health", (_req, res) => res.json({ ok: true }));

// list
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

// create
app.post("/notes", requireAuth, async (req, res) => {
  try {
    const content = req.body?.content;
    if (typeof content !== "string" || content.trim() === "") {
      return res.status(400).json({ error: "content is required (non-empty string)" });
    }

    const tags = normalizeTags(req.body?.tags);
    if (tags.length === 0) {
      return res.status(400).json({ error: "tags must be a non-empty array of non-empty strings" });
    }

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

// patch (partial update)
app.patch("/notes/:id", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }

    const setParts: string[] = [];
    const values: any[] = [];

    if ("content" in req.body) {
      const c = req.body.content;
      if (typeof c !== "string" || c.trim() === "") {
        return res.status(400).json({ error: "content must be non-empty string" });
      }
      setParts.push(`content = $${values.length + 1}`);
      values.push(c);
    }

    if ("tags" in req.body) {
      const tags = normalizeTags(req.body.tags);
      if (tags.length === 0) {
        return res.status(400).json({ error: "tags must be a non-empty array of non-empty strings" });
      }
      setParts.push(`tags = $${values.length + 1}`);
      values.push(tags);
    }

    if (setParts.length === 0) {
      return res.status(400).json({ error: "nothing to update" });
    }

    const whereParam = values.length + 1;
    const query = `
      update notes
      set ${setParts.join(", ")}, updated_at = now()
      where id = $${whereParam}
      returning id, content, tags, created_at, updated_at
    `;

    const rows: any = await sql(query, [...values, id]);
    if (!rows || rows.length === 0) return res.status(404).json({ error: "not found" });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// delete
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

app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
