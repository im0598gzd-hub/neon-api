// server.ts（filters対応版）

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

// ===== Helpers =====
function normalizeTags(input: any): string[] {
  if (!Array.isArray(input)) return [];
  const cleaned = input
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x.length > 0)
    .map((x) =>
      x.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    )
    .map((x) => (/^[A-Za-z0-9]+$/.test(x) ? x.toLowerCase() : x));
  return Array.from(new Set(cleaned));
}
function parseTagsQuery(raw: any): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  const arr = raw.split(",").map((s) => s.trim());
  return normalizeTags(arr);
}
function parseOrder(raw: any): "asc" | "desc" {
  const v = (typeof raw === "string" ? raw.toLowerCase() : "") as "asc" | "desc";
  return v === "asc" || v === "desc" ? v : "desc";
}
function parseOrderBy(raw: any): "id" | "created_at" | "updated_at" {
  const v = (typeof raw === "string" ? raw.toLowerCase() : "") as
    | "id" | "created_at" | "updated_at";
  return v === "created_at" || v === "updated_at" ? v : "id";
}
function parseIsoDate(raw: any): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

// content/tags validator
function validateContent(raw: any) {
  if (typeof raw !== "string") return { ok: false as const, error: "content must be string" };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false as const, error: "content is required (non-empty string)" };
  if (trimmed.length > 2000) return { ok: false as const, error: "content too long (max 2000 chars)" };
  return { ok: true as const, value: trimmed };
}
function validateTags(raw: any) {
  const tags = normalizeTags(raw);
  if (tags.length === 0) return { ok: false as const, error: "tags must be a non-empty array of non-empty strings" };
  if (tags.length > 8) return { ok: false as const, error: "too many tags (max 8)" };
  for (const t of tags) {
    if (t.length > 32) return { ok: false as const, error: "tag too long (max 32 chars)" };
  }
  return { ok: true as const, value: tags };
}

// ===== Filters helpers =====
type FilterBody = {
  name: string;
  q?: string;
  q_mode?: "exact" | "partial";
  tags_all?: string[]; tags_any?: string[]; tags_none?: string[];
  tags_match?: "exact" | "partial";
  from_at?: string; to_at?: string;
};

function validateFilterBody(raw: any) {
  if (typeof raw !== "object" || raw === null) return { ok:false as const, error:"invalid body" };
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return { ok:false as const, error:"name is required" };
  if (name.length > 64) return { ok:false as const, error:"name is too long (max 64)" };

  const q = typeof raw.q === "string" ? raw.q.trim() : undefined;
  const q_mode = raw.q_mode === "exact" ? "exact" : "partial";

  const tags_all = normalizeTags(raw.tags_all);
  const tags_any = normalizeTags(raw.tags_any);
  const tags_none = normalizeTags(raw.tags_none);
  const tags_match = raw.tags_match === "partial" ? "partial" : "exact";

  const from_at = typeof raw.from_at === "string" && !isNaN(new Date(raw.from_at).getTime())
    ? new Date(raw.from_at).toISOString() : undefined;
  const to_at = typeof raw.to_at === "string" && !isNaN(new Date(raw.to_at).getTime())
    ? new Date(raw.to_at).toISOString() : undefined;

  return { ok:true as const, value: { name, q, q_mode, tags_all, tags_any, tags_none, tags_match, from_at, to_at } };
}

// ===== Routes =====

// 公開
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/_status", async (_req, res) => {
  try {
    let db = "na";
    try { const r: any = await sql`select 1 as ok`; db = r?.[0]?.ok === 1 ? "ok" : "ng"; }
    catch { db = "ng"; }
    res.json({ app: "ok", db, now: new Date().toISOString() });
  } catch { res.status(500).json({ app: "ng" }); }
});

// ...（/notes 関連のコードは省略、既存のまま残す）

// ===== Filters routes =====
app.get("/filters", requireAuth, async (_req, res) => {
  try {
    const rows: any = await sql`
      select id, name, q, q_mode, tags_all, tags_any, tags_none, tags_match, from_at, to_at, created_at, updated_at
      from filters
      order by updated_at desc, id desc
    `;
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error:"Internal Server Error" }); }
});

app.post("/filters", requireAuth, async (req, res) => {
  try {
    const v = validateFilterBody(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const f = v.value;

    const rows: any = await sql`
      insert into filters (name, q, q_mode, tags_all, tags_any, tags_none, tags_match, from_at, to_at)
      values (${f.name}, ${f.q ?? null}, ${f.q_mode}, ${f.tags_all}, ${f.tags_any}, ${f.tags_none}, ${f.tags_match}, ${f.from_at ?? null}, ${f.to_at ?? null})
      on conflict (name) do update set
        q = excluded.q,
        q_mode = excluded.q_mode,
        tags_all = excluded.tags_all,
        tags_any = excluded.tags_any,
        tags_none = excluded.tags_none,
        tags_match = excluded.tags_match,
        from_at = excluded.from_at,
        to_at = excluded.to_at,
        updated_at = now()
      returning id, name, q, q_mode, tags_all, tags_any, tags_none, tags_match, from_at, to_at, created_at, updated_at
    `;
    res.status(201).json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error:"Internal Server Error" }); }
});

app.delete("/filters/:id", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error:"invalid id" });
    const rows: any = await sql`delete from filters where id = ${id} returning id`;
    if (!rows || rows.length === 0) return res.status(404).json({ error:"not found" });
    res.status(204).send();
  } catch (e) { console.error(e); res.status(500).json({ error:"Internal Server Error" }); }
});

app.listen(PORT, () => { console.log(`Server listening on :${PORT}`); });
