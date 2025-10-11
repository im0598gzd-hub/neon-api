// server.ts（Neon + Express / フィルタ & ページネーション & CSV & rank_min & trgm切替対応）
// 変更点：/notes に 0件時の自然言語応答を追加。rank使用時は ORDER BY _rank DESC, id。
//        /notes/export.csv は Content-Type を text/csv に先行設定し、成功パスは send のみ使用。

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { neon } from "@neondatabase/serverless";

const app = express();

/* ===== Runtime config ===== */
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const sql = neon(DATABASE_URL);

/* ===== Middlewares ===== */
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// minimal audit log
app.use((req: Request, _res: Response, next: NextFunction) => {
  const hasBody =
    (req.headers["content-length"] && Number(req.headers["content-length"]) > 0) ||
    (req as any).body
      ? "yes"
      : "no";
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.path} body:${hasBody}`
  );
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

/* ===== Helpers ===== */

function normalizeTags(input: any): string[] {
  if (!Array.isArray(input)) return [];
  const cleaned = input
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x.length > 0)
    // 全角英数→半角
    .map((x) =>
      x.replace(
        /[\uFF01-\uFF5E]/g,
        (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
      )
    )
    // 英数のみは小文字化
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

/* ===== Validation ===== */

const MAX_CONTENT_LEN = 2000;
const MAX_TAGS = 8;
const MAX_TAG_LEN = 32;

function validateContent(raw: any) {
  if (typeof raw !== "string") {
    return { ok: false as const, error: "content must be a string" };
  }
  const v = raw.trim();
  if (v.length === 0) {
    return { ok: false as const, error: "content is required (non-empty string)" };
  }
  if (v.length > MAX_CONTENT_LEN) {
    return {
      ok: false as const,
      error: `content is too long (max ${MAX_CONTENT_LEN} chars)`,
    };
  }
  return { ok: true as const, value: v };
}
function validateTags(raw: any) {
  const tags = normalizeTags(raw);
  if (tags.length === 0) {
    return {
      ok: false as const,
      error: "tags must be a non-empty array of non-empty strings",
    };
  }
  if (tags.length > MAX_TAGS) {
    return { ok: false as const, error: `too many tags (max ${MAX_TAGS})` };
  }
  for (const t of tags) {
    if (t.length > MAX_TAG_LEN) {
      return {
        ok: false as const,
        error: `tag '${t.slice(0, 40)}' is too long (max ${MAX_TAG_LEN})`,
      };
    }
  }
  return { ok: true as const, value: tags };
}

/* ===== WHERE Builder ===== */

function buildNotesFilters(req: Request) {
  const qRaw = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const q = qRaw.length > 0 ? qRaw : "";
  const qLen = q.length;

  // q_mode: exact / partial / trgm（未指定は partial）
  const qm = typeof req.query.q_mode === "string" ? req.query.q_mode.toLowerCase() : "";
  const q_mode: "exact" | "partial" | "trgm" =
    qm === "exact" ? "exact" : qm === "trgm" ? "trgm" : "partial";

  const tagsMatch =
    typeof req.query.tags_match === "string" &&
    req.query.tags_match.toLowerCase() === "partial"
      ? "partial"
      : "exact";
  const tagsAll = parseTagsQuery(req.query.tags_all);
  const tagsAny = parseTagsQuery(req.query.tags_any);
  const tagsNone = parseTagsQuery(req.query.tags_none);

  const legacyTags = parseTagsQuery(req.query.tags);
  const legacyMode =
    typeof req.query.tags_mode === "string" &&
    req.query.tags_mode.toLowerCase() === "any"
      ? "any"
      : "all";

  const fromIso = parseIsoDate(req.query.from);
  const toIso = parseIsoDate(req.query.to);
  if (fromIso && toIso && new Date(fromIso) > new Date(toIso)) {
    return { error: "from must be earlier than to" } as const;
  }

  const whereParts: string[] = [];
  const values: any[] = [];

  if (q) {
    if (q_mode === "exact") {
      const i = values.push(q);
      whereParts.push(`content = $${i}`);
    } else if (q_mode === "trgm" && qLen >= 3) {
      // pg_trgm を明示使用。短い語（<3）はILIKEにフォールバック
      const i = values.push(q);
      whereParts.push(`content % $${i}`);
    } else {
      const i = values.push(`%${q}%`);
      whereParts.push(`content ILIKE $${i}`);
    }
  }

  // tags
  if (tagsAll.length + tagsAny.length + tagsNone.length > 0) {
    if (tagsMatch === "exact") {
      if (tagsAll.length > 0) {
        const i = values.push(tagsAll);
        whereParts.push(`tags @> $${i}`);
      }
      if (tagsAny.length > 0) {
        const i = values.push(tagsAny);
        whereParts.push(`tags && $${i}`);
      }
      if (tagsNone.length > 0) {
        const i = values.push(tagsNone);
        whereParts.push(`NOT (tags && $${i})`);
      }
    } else {
      // 部分一致（配列要素の部分一致）
      const buildPartial = (patterns: string[], mode: "all" | "any" | "none") => {
        if (patterns.length === 0) return "";
        const clauses = patterns.map((p) => {
          const idx = values.push(`%${p}%`);
          const ex = `EXISTS (SELECT 1 FROM unnest(tags) t WHERE t ILIKE $${idx})`;
          return mode === "none" ? `NOT ${ex}` : ex;
        });
        if (mode === "all" || mode === "none") return `(${clauses.join(" AND ")})`;
        return `(${clauses.join(" OR ")})`;
      };
      if (tagsAll.length > 0) whereParts.push(buildPartial(tagsAll, "all"));
      if (tagsAny.length > 0) whereParts.push(buildPartial(tagsAny, "any"));
      if (tagsNone.length > 0) whereParts.push(buildPartial(tagsNone, "none"));
    }
  } else if (legacyTags.length > 0) {
    const i = values.push(legacyTags);
    whereParts.push(legacyMode === "any" ? `tags && $${i}` : `tags @> $${i}`);
  }

  if (fromIso) {
    const i = values.push(fromIso);
    whereParts.push(`created_at >= $${i}`);
  }
  if (toIso) {
    const i = values.push(toIso);
    whereParts.push(`created_at <= $${i}`);
  }

  const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

  return { whereClause, values, q, qLen } as const;
}

/* ===== Public ===== */

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/_status", async (_req, res) => {
  try {
    let db = "na";
    try {
      const r: any = await sql`select 1 as ok`;
      db = r?.[0]?.ok === 1 ? "ok" : "ng";
    } catch {
      db = "ng";
    }
    res.json({ app: "ok", db, now: new Date().toISOString() });
  } catch {
    res.status(500).json({ app: "ng" });
  }
});

/* ===== Notes: list / count / export ===== */

// GET /notes
app.get("/notes", requireAuth, async (req, res) => {
  try {
    const orderBy = parseOrderBy(req.query.order_by);
    const order = parseOrder(req.query.order);
    const limit = Math.min(
      100,
      Math.max(1, Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 50)
    );
    const offset =
      Number.isFinite(Number(req.query.offset)) && Number(req.query.offset) >= 0
        ? Number(req.query.offset)
        : 0;
    const cursor = decodeCursor(req.query.cursor);
    const wantRank =
      String(req.query.rank ?? "").toLowerCase() === "1" ||
      String(req.query.rank ?? "").toLowerCase() === "true";
    const rankMin = Number.isFinite(Number(req.query.rank_min))
      ? Number(req.query.rank_min)
      : null;

    // クエリからWHERE作成
    const built = buildNotesFilters(req);
    if ("error" in built) return res.status(400).json({ error: built.error });

    const whereParts: string[] = [];
    const values: any[] = [];

    if (built.whereClause) {
      whereParts.push(built.whereClause.replace(/^where\s+/i, ""));
      values.push(...built.values);
    }

    // rank（pg_trgm: similarity）: 3文字未満は無効化（ヘッダで通知）
    const rankDisabled = built.qLen > 0 && built.qLen < 3;
    if (rankDisabled) {
      res.setHeader("X-Rank-Disabled", "1");
    }

    // rank_min フィルタ（有効時のみ）
    if (!rankDisabled && built.q && rankMin !== null && !isNaN(rankMin)) {
      const i = values.push(built.q);
      const j = values.push(rankMin);
      whereParts.push(`similarity(content, $${i}) >= $${j}`);
    }

    // cursor または offset
    if (cursor && !req.query.offset) {
      const cmp = order === "asc" ? ">" : "<";
      if (orderBy === "created_at") {
        const i1 = values.push(cursor.created_at);
        const i2 = values.push(cursor.id);
        whereParts.push(`(created_at, id) ${cmp} ($${i1}::timestamptz, $${i2}::int)`);
      } else if (orderBy === "updated_at") {
        const i1 = values.push(cursor.created_at); // for compatibility
        const i2 = values.push(cursor.id);
        whereParts.push(`(updated_at, id) ${cmp} ($${i1}::timestamptz, $${i2}::int)`);
      } else {
        const i = values.push(cursor.id);
        whereParts.push(`id ${cmp} $${i}`);
      }
    }

    const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

    // ▼ rankが使える状況では rank優先の安定ソート（_rank DESC, id）
    //   それ以外は従来の order_by / order を適用
    let orderClause: string;
    const rankUsable = wantRank && !rankDisabled && !!built.q;
    if (rankUsable) {
      orderClause = `ORDER BY _rank DESC, id`;
    } else {
      orderClause =
        orderBy === "created_at"
          ? `ORDER BY created_at ${order}, id ${order}`
          : orderBy === "updated_at"
          ? `ORDER BY updated_at ${order}, id ${order}`
          : `ORDER BY id ${order}`;
    }

    // SELECT 列
    const cols = rankUsable
      ? `id, content, tags, created_at, updated_at, similarity(content, $${values.push(
          built.q
        )}) as _rank`
      : `id, content, tags, created_at, updated_at`;

    const limitParam = `$${values.push(limit)}`;
    const offsetSql = cursor || offset === 0 ? "" : ` offset $${values.push(offset)}`;

    const rows: any = await sql(
      `
      select ${cols}
      from notes
      ${whereClause}
      ${orderClause}
      limit ${limitParam}${offsetSql}
    `,
      values
    );

    // cursor next
    if (!req.query.offset && rows && rows.length === limit) {
      const last = rows[rows.length - 1];
      res.setHeader("X-Next-Cursor", encodeCursor(last.created_at, last.id));
    }

    // ✅ 0件時は自然言語メッセージで返却（HTTP 200）
    if (!rows || rows.length === 0) {
      return res.status(200).json({
        results: [],
        message: "一致するノートは見つかりませんでした。",
        tips: [
          "キーワードを短くする（例：「テスト」→「テス」）",
          "rank_min を下げて再検索（例：0.5 → 0.3）",
          "別の表記・同義語を試す（例：表記ゆれ・カナ/漢字）",
        ],
        echo: {
          q: built.q || null,
          rank_min: rankMin,
          limit,
          order_by: rankUsable ? "rank_desc_id" : `${orderBy}_${order}`,
        },
      });
    }

    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET /notes/count
app.get("/notes/count", requireAuth, async (req, res) => {
  try {
    const built = buildNotesFilters(req);
    if ("error" in built) return res.status(400).json({ error: built.error });

    const r: any = await sql(
      `select count(*)::int as total from notes ${built.whereClause}`,
      built.values
    );
    res.json({ total: r?.[0]?.total ?? 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET /notes/export.csv  （UTF-8+BOM、JSTの日時、rank_min 反映）
app.get("/notes/export.csv", requireAuth, async (req, res) => {
  try {
    // 成功パスで JSON に化けないよう最初に明示
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");

    const orderBy = parseOrderBy(req.query.order_by);
    const order = parseOrder(req.query.order);
    const limit = Math.min(
      10000,
      Math.max(1, Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 1000)
    );

    const built = buildNotesFilters(req);
    if ("error" in built) return res.status(400).json({ error: built.error });

    const wantRank =
      String(req.query.rank ?? "").toLowerCase() === "1" ||
      String(req.query.rank ?? "").toLowerCase() === "true";
    const rankMin = Number.isFinite(Number(req.query.rank_min))
      ? Number(req.query.rank_min)
      : null;
    const rankDisabled = built.qLen > 0 && built.qLen < 3;
    if (rankDisabled) res.setHeader("X-Rank-Disabled", "1");

    const whereParts: string[] = [];
    const values: any[] = [];

    if (built.whereClause) {
      whereParts.push(built.whereClause.replace(/^where\s+/i, ""));
      values.push(...built.values);
    }

    if (!rankDisabled && built.q && rankMin !== null && !isNaN(rankMin)) {
      const i = values.push(built.q);
      const j = values.push(rankMin);
      whereParts.push(`similarity(content, $${i}) >= $${j}`);
    }

    const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

    const orderClause =
      orderBy === "created_at"
        ? `ORDER BY created_at ${order}, id ${order}`
        : orderBy === "updated_at"
        ? `ORDER BY updated_at ${order}, id ${order}`
        : `ORDER BY id ${order}`;

    const colsBase = `
      id,
      content,
      tags,
      to_char((created_at at time zone 'Asia/Tokyo'), 'YYYY/MM/DD HH24:MI:SS') as created_at_jst,
      to_char((updated_at at time zone 'Asia/Tokyo'), 'YYYY/MM/DD HH24:MI:SS') as updated_at_jst
    `;

    const cols =
      wantRank && !rankDisabled && built.q
        ? `${colsBase}, similarity(content, $${values.push(built.q)}) as _rank`
        : colsBase;

    const rows: any = await sql(
      `
      select ${cols}
      from notes
      ${whereClause}
      ${orderClause}
      limit $${values.push(limit)}
    `,
      values
    );

    const headerAlways = ["id", "content", "tags", "created_at_jst", "updated_at_jst"];
    const header =
      wantRank && !rankDisabled && built.q
        ? [...headerAlways, "_rank"]
        : headerAlways;

    const escape = (s: any) => {
      const v = s === null || s === undefined ? "" : String(s);
      return `"${v.replace(/"/g, '""')}"`;
    };
    const toCsvLine = (r: any) =>
      header
        .map((k) => escape(Array.isArray(r[k]) ? r[k].join(",") : r[k]))
        .join(",");

    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const csv = [header.join(","), ...(rows || []).map(toCsvLine)].join("\r\n");

    res.setHeader("Content-Disposition", `attachment; filename="notes_export.csv"`);
    // 成功パスは send のみ（json禁止）
    res.status(200).send(Buffer.concat([bom, Buffer.from(csv, "utf8")]));
  } catch (e) {
    console.error(e);
    // エラー時は JSON でOK
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/* ===== CRUD ===== */

app.post("/notes", requireAuth, async (req, res) => {
  try {
    const c = validateContent(req.body?.content);
    if (!c.ok) return res.status(400).json({ error: c.error });

    const t = validateTags(req.body?.tags);
    if (!t.ok) return res.status(400).json({ error: t.error });

    const rows: any = await sql`
      insert into notes (content, tags)
      values (${c.value}, ${t.value})
      returning id, content, tags, created_at, updated_at
    `;
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.patch("/notes/:id", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "invalid id" });

    const setParts: string[] = [];
    const values: any[] = [];

    if ("content" in req.body) {
      const c = validateContent(req.body?.content);
      if (!c.ok) return res.status(400).json({ error: c.error });
      setParts.push(`content = $${values.length + 1}`);
      values.push(c.value);
    }
    if ("tags" in req.body) {
      const t = validateTags(req.body?.tags);
      if (!t.ok) return res.status(400).json({ error: t.error });
      setParts.push(`tags = $${values.length + 1}`);
      values.push(t.value);
    }
    if (setParts.length === 0) return res.status(400).json({ error: "nothing to update" });

    const query = `
      update notes
      set ${setParts.join(", ")}, updated_at = now()
      where id = $${values.length + 1}
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

app.delete("/notes/:id", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "invalid id" });
    const rows: any = await sql`delete from notes where id = ${id} returning id`;
    if (!rows || rows.length === 0) return res.status(404).json({ error: "not found" });
    res.status(204).send();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/* ===== Listen ===== */
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
