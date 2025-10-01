// server.ts (差し替え用・フルコード)
// 目的：/health と /_status（公開）、/notes（認証必須）に
// - ページネーション（limit/offset, cursor 併用）
// - 並び順（order_by=id|created_at|updated_at, order=asc|desc）
// - 件数取得（GET /notes/count）
// - CSVエクスポート（GET /notes/export.csv, UTF-8 BOM）
// を追加。DBスキーマ変更なし（deleted_at は未導入のまま）。

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

// タグ正規化：空白除去／全角英数→半角／英数字は小文字化／重複除去
function normalizeTags(input: any): string[] {
  if (!Array.isArray(input)) return [];
  const cleaned = input
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x.length > 0)
    .map((x) =>
      x.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    ) // 全角英数→半角
    .map((x) => (/^[A-Za-z0-9]+$/.test(x) ? x.toLowerCase() : x)); // 英数字は小文字化
  return Array.from(new Set(cleaned)); // 重複除去
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

// id / created_at / updated_at を許可
function parseOrderBy(raw: any): "id" | "created_at" | "updated_at" {
  const v = (typeof raw === "string" ? raw.toLowerCase() : "") as
    | "id"
    | "created_at"
    | "updated_at";
  return v === "created_at" || v === "updated_at" ? v : "id";
}

function parseIsoDate(raw: any): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

// 部分一致タグ条件（unnest + ILIKE）
function buildTagPartialCondition(
  column: string,
  patterns: string[],
  mode: "all" | "any" | "none",
  values: any[]
): string {
  if (patterns.length === 0) return "";
  const clauses = patterns.map((p) => {
    const idx = values.push(`%${p}%`); // ILIKE用
    const ex = `EXISTS (SELECT 1 FROM unnest(${column}) t WHERE t ILIKE $${idx})`;
    return mode === "none" ? `NOT ${ex}` : ex;
  });
  if (mode === "all" || mode === "none") return `(${clauses.join(" AND ")})`;
  return `(${clauses.join(" OR ")})`; // any
}

// ===== キーセットページング用カーソル（created_at|id を base64化） =====
function encodeCursor(created_at: string, id: number): string {
  return Buffer.from(`${created_at}|${id}`, "utf8").toString("base64url");
}
function decodeCursor(raw: any): { created_at: string; id: number } | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const s = Buffer.from(raw, "base64url").toString("utf8");
    const [c, i] = s.split("|");
    const id = Number(i);
    if (!c || !Number.isInteger(id)) return null;
    const d = new Date(c);
    if (isNaN(d.getTime())) return null;
    return { created_at: d.toISOString(), id };
  } catch {
    return null;
  }
}

// 共通：/notes 系の WHERE 条件を構築
function buildNotesFilters(req: Request) {
  // 本文検索
  const qRaw = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const q = qRaw.length > 0 ? qRaw : "";
  const qMode =
    typeof req.query.q_mode === "string" && req.query.q_mode.toLowerCase() === "exact"
      ? "exact"
      : "partial"; // 既定: partial

  // タグ（新UI）
  const tagsMatch =
    typeof req.query.tags_match === "string" && req.query.tags_match.toLowerCase() === "partial"
      ? "partial"
      : "exact"; // 既定: exact
  const tagsAll = parseTagsQuery(req.query.tags_all);
  const tagsAny = parseTagsQuery(req.query.tags_any);
  const tagsNone = parseTagsQuery(req.query.tags_none);

  // 旧パラメータ互換
  const legacyTags = parseTagsQuery(req.query.tags);
  const legacyMode =
    typeof req.query.tags_mode === "string" && req.query.tags_mode.toLowerCase() === "any"
      ? "any"
      : "all"; // 既定: all

  // 日付
  const fromIso = parseIsoDate(req.query.from);
  const toIso = parseIsoDate(req.query.to);

  if (fromIso && toIso && new Date(fromIso) > new Date(toIso)) {
    return { error: "from must be earlier than to" } as const;
  }

  const whereParts: string[] = [];
  const values: any[] = [];

  // 本文
  if (q) {
    if (qMode === "exact") {
      const i = values.push(q);
      whereParts.push(`content = $${i}`);
    } else {
      const i = values.push(`%${q}%`);
      whereParts.push(`content ILIKE $${i}`);
    }
  }

  // タグ（新UIが1つでも指定されていれば優先）
  if (tagsAll.length + tagsAny.length + tagsNone.length > 0) {
    if (tagsMatch === "exact") {
      if (tagsAll.length > 0) {
        const i = values.push(tagsAll);
        whereParts.push(`tags @> $${i}`); // すべて含む
      }
      if (tagsAny.length > 0) {
        const i = values.push(tagsAny);
        whereParts.push(`tags && $${i}`); // どれか含む
      }
      if (tagsNone.length > 0) {
        const i = values.push(tagsNone);
        whereParts.push(`NOT (tags && $${i})`); // 含まない
      }
    } else {
      if (tagsAll.length > 0) whereParts.push(buildTagPartialCondition("tags", tagsAll, "all", values));
      if (tagsAny.length > 0) whereParts.push(buildTagPartialCondition("tags", tagsAny, "any", values));
      if (tagsNone.length > 0) whereParts.push(buildTagPartialCondition("tags", tagsNone, "none", values));
    }
  } else if (legacyTags.length > 0) {
    const i = values.push(legacyTags);
    whereParts.push(legacyMode === "any" ? `tags && $${i}` : `tags @> $${i}`);
  }

  // 日付
  if (fromIso) {
    const i = values.push(fromIso);
    whereParts.push(`created_at >= $${i}`);
  }
  if (toIso) {
    const i = values.push(toIso);
    whereParts.push(`created_at <= $${i}`);
  }

  return {
    whereClause: whereParts.length ? `where ${whereParts.join(" AND ")}` : "",
    values,
  } as const;
}

// ===== Routes =====

// health（公開）
app.get("/health", (_req, res) => res.json({ ok: true }));

// 軽量ステータス（公開）: DB確認つき
app.get("/_status", async (_req, res) => {
  try {
    let db = "na";
    try {
      const r: any = await sql`select 1 as ok`;
      db = r && r[0] && r[0].ok === 1 ? "ok" : "ng";
    } catch {
      db = "ng";
    }
    res.json({
      app: "ok",
      db,
      now: new Date().toISOString(),
    });
  } catch {
    res.status(500).json({ app: "ng" });
  }
});

// list + search + filters + sort + match modes + cursor/offset
app.get("/notes", requireAuth, async (req, res) => {
  try {
    // 並び・ページング
    const orderBy = parseOrderBy(req.query.order_by); // "id" | "created_at" | "updated_at"
    const order = parseOrder(req.query.order); // "asc" | "desc"

    const limit = Math.min(
      100,
      Math.max(1, Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 50)
    );

    // offset（オプション・cursorと併用しない）
    const offset =
      Number.isFinite(Number(req.query.offset)) && Number(req.query.offset) >= 0
        ? Number(req.query.offset)
        : 0;

    const cursor = decodeCursor(req.query.cursor);

    // WHERE 条件
    const built = buildNotesFilters(req);
    if ("error" in built) return res.status(400).json({ error: built.error });
    const whereParts: string[] = [];
    const values: any[] = [];
    if (built.whereClause) {
      whereParts.push(built.whereClause.replace(/^where\s+/, ""));
      values.push(...built.values);
    }

    // cursor 条件（offset と同時指定は無視）
    if (cursor && !req.query.offset) {
      if (orderBy === "created_at") {
        const cmp = order === "asc" ? ">" : "<";
        const i1 = values.push(cursor.created_at);
        const i2 = values.push(cursor.id);
        whereParts.push(`(created_at, id) ${cmp} ($${i1}::timestamptz, $${i2}::int)`);
      } else if (orderBy === "updated_at") {
        const cmp = order === "asc" ? ">" : "<";
        const i1 = values.push(cursor.created_at); // 互換のため created_at を流用（問題ない）
        const i2 = values.push(cursor.id);
        whereParts.push(`(updated_at, id) ${cmp} ($${i1}::timestamptz, $${i2}::int)`);
      } else {
        const cmp = order === "asc" ? ">" : "<";
        const i = values.push(cursor.id);
        whereParts.push(`id ${cmp} $${i}`);
      }
    }

    const whereClause = whereParts.length ? `where ${whereParts.join(" AND ")}` : "";

    // 安定順序（同値時は id でタイブレーク）
    let orderClause = "";
    if (orderBy === "created_at") {
      orderClause = `order by created_at ${order}, id ${order}`;
    } else if (orderBy === "updated_at") {
      orderClause = `order by updated_at ${order}, id ${order}`;
    } else {
      orderClause = `order by id ${order}`;
    }

    // offset 併用時は offset、cursor 時は不要
    const limitParam = `$${values.push(limit)}`;
    const offsetSql =
      cursor || offset === 0 ? "" : ` offset $${values.push(offset)}`;

    const query = `
      select id, content, tags, created_at, updated_at
      from notes
      ${whereClause}
      ${orderClause}
      limit ${limitParam}${offsetSql}
    `;

    const rows: any = await sql(query, values);

    // 次ページ用カーソル（cursor利用時のみ付与）
    if (!req.query.offset && rows && rows.length === limit) {
      const last = rows[rows.length - 1];
      const next = encodeCursor(last.created_at, last.id);
      res.setHeader("X-Next-Cursor", next);
    }

    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// 件数だけ取得（UIのページャ制御に使用）
app.get("/notes/count", requireAuth, async (req, res) => {
  try {
    const built = buildNotesFilters(req);
    if ("error" in built) return res.status(400).json({ error: built.error });
    const whereClause = built.whereClause;
    const values = built.values;

    const r: any = await sql(
      `
      select count(*)::int as total
      from notes
      ${whereClause}
    `,
      values
    );
    res.json({ total: r?.[0]?.total ?? 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// CSVエクスポート（UTF-8 BOM, 既定は最大1000件）
app.get("/notes/export.csv", requireAuth, async (req, res) => {
  try {
    const orderBy = parseOrderBy(req.query.order_by);
    const order = parseOrder(req.query.order);
    const limit = Math.min(
      10000,
      Math.max(1, Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 1000)
    );

    const built = buildNotesFilters(req);
    if ("error" in built) return res.status(400).json({ error: built.error });

    const whereClause = built.whereClause;
    const values = built.values;

    const orderClause =
      orderBy === "created_at"
        ? `order by created_at ${order}, id ${order}`
        : orderBy === "updated_at"
        ? `order by updated_at ${order}, id ${order}`
        : `order by id ${order}`;

    const rows: any = await sql(
      `
      select id, content, tags, created_at, updated_at
      from notes
      ${whereClause}
      ${orderClause}
      limit $${values.push(limit)}
    `,
      values
    );

    // CSV生成
    const header = ["id", "content", "tags", "created_at", "updated_at"];
    const escape = (s: any) => {
      const v = s === null || s === undefined ? "" : String(s);
      // ダブルクォートで囲み、内部の " は "" にエスケープ
      return `"${v.replace(/"/g, '""')}"`;
    };
    const toCsvLine = (r: any) =>
      [
        r.id,
        r.content,
        Array.isArray(r.tags) ? r.tags.join(",") : "",
        r.created_at,
        r.updated_at,
      ]
        .map(escape)
        .join(",");

    const bom = Buffer.from([0xef, 0xbb, 0xbf]); // UTF-8 BOM
    const csv = [header.join(","), ...(rows || []).map(toCsvLine)].join("\r\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="notes_export.csv"`);
    res.send(Buffer.concat([bom, Buffer.from(csv, "utf8")]));
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
      return res
        .status(400)
        .json({ error: "tags must be a non-empty array of non-empty strings" });
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
        return res
          .status(400)
          .json({ error: "tags must be a non-empty array of non-empty strings" });
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

// delete（※現在はハードデリート。将来は deleted_at に変更推奨）
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
