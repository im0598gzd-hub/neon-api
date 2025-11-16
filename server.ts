// server.ts (three-scope auth: READ / EXPORT / ADMIN)

import express, { Request, Response, NextFunction } from "express";
import cors, { CorsOptions } from "cors";
import { neon } from "@neondatabase/serverless";
import crypto from "crypto";

const app = express();

/* ===== Runtime config ===== */

const PORT = process.env.PORT || 3000;

// three keys
const READ_KEY_RAW = process.env.READ_KEY || "";
const EXPORT_KEY_RAW = process.env.EXPORT_KEY || "";
const ADMIN_KEY_RAW = process.env.ADMIN_KEY || "";

// Backward-compat (optional): treat API_KEY as ADMIN during migration
const API_KEY_LEGACY = process.env.API_KEY || "";

const DATABASE_URL = process.env.DATABASE_URL || "";
const UI_ORIGIN = process.env.UI_ORIGIN || ""; // strict match

// 必須環境変数の一括チェック
const REQUIRED_ENV: Record<string, string> = {
  DATABASE_URL,
  UI_ORIGIN,
};

for (const [name, value] of Object.entries(REQUIRED_ENV)) {
  if (!value) {
    console.error(`[FATAL] ${name} is not set`);
    process.exit(1);
  }
}

// Warn for missing keys (don’t exit: “鍵すべて消去”のテストや段階導入に対応)
if (!READ_KEY_RAW) console.warn("[WARN] READ_KEY is empty (read endpoints will 401).");
if (!EXPORT_KEY_RAW) console.warn("[WARN] EXPORT_KEY is empty (export endpoints will 401).");
if (!ADMIN_KEY_RAW && !API_KEY_LEGACY) {
  console.warn("[WARN] ADMIN_KEY is empty (write endpoints will 401).");
}
if (API_KEY_LEGACY) {
  console.warn("[MIGRATION] API_KEY is present. It will be accepted as ADMIN (temporary).");
}

// logging helper
function log(...args: any[]) {
  console.log(new Date().toISOString(), "-", ...args);
}

const sql = neon(DATABASE_URL);

/* ===== Types (for future safety) ===== */

interface Note {
  id: number;
  content: string;
  tags: string[];
  created_at: string; // ISO
  updated_at: string; // ISO
  deleted_at: string | null;
}

/* ===== Security helpers (constant-time compare) ===== */

function sha256Buf(s: string): Buffer {
  // Hash to fixed-length buffer for timingSafeEqual
  return crypto.createHash("sha256").update(s, "utf8").digest();
}
const READ_KEY_HASH = READ_KEY_RAW ? sha256Buf(READ_KEY_RAW) : null;
const EXPORT_KEY_HASH = EXPORT_KEY_RAW ? sha256Buf(EXPORT_KEY_RAW) : null;
const ADMIN_KEY_HASH = ADMIN_KEY_RAW ? sha256Buf(ADMIN_KEY_RAW) : null;
const API_KEY_LEGACY_HASH = API_KEY_LEGACY ? sha256Buf(API_KEY_LEGACY) : null;

function getBearer(req: Request): string | null {
  const h = req.header("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function safeEqualAgainst(hash: Buffer | null, candidate: string): boolean {
  if (!hash) return false;
  const cand = sha256Buf(candidate);
  try {
    return crypto.timingSafeEqual(hash, cand);
  } catch {
    return false;
  }
}

// 統一スコープ判定
type Scope = "read" | "export" | "admin";

function hasScope(req: Request, scope: Scope): boolean {
  const token = getBearer(req);
  if (!token) return false;

  switch (scope) {
    case "read":
      // READ or ADMIN
      return safeEqualAgainst(READ_KEY_HASH, token) || hasScope(req, "admin");
    case "export":
      return safeEqualAgainst(EXPORT_KEY_HASH, token);
    case "admin":
      return (
        safeEqualAgainst(ADMIN_KEY_HASH, token) ||
        safeEqualAgainst(API_KEY_LEGACY_HASH, token) // migration
      );
    default:
      return false;
  }
}

// 既存コード互換のラッパー
function hasRead(req: Request): boolean {
  return hasScope(req, "read");
}
function hasExport(req: Request): boolean {
  return hasScope(req, "export");
}
function hasAdmin(req: Request): boolean {
  return hasScope(req, "admin");
}

function respond401(res: Response) {
  return res.status(401).json({ error: "Unauthorized" });
}
function respond403(res: Response, want: Scope) {
  return res.status(403).json({
    error: "Forbidden",
    hint: `This operation requires ${want} key. Check your Authorization: Bearer <token>.`,
  });
}

/* ===== Middlewares ===== */

const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    if (!origin) {
      // ブラウザ以外（curl など）からのアクセスは CORS なしで来ることもあるので、
      // 単に拒否しておく（エラーにはしない）
      log("[CORS] blocked request without Origin header");
      return callback(null, false);
    }
    if (origin === UI_ORIGIN) return callback(null, true);

    log("[CORS] blocked origin:", origin);
    return callback(null, false);
  },
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
  optionsSuccessStatus: 204,
  maxAge: 600,
};

app.use(cors(corsOptions));
app.use(express.json({ limit: "1mb" }));

// minimal audit log（読みやすさのため簡潔化）
app.use((req: Request, _res: Response, next: NextFunction) => {
  const len = Number(req.headers["content-length"] || 0);
  const hasBody =
    len > 0 || (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0);
  log(`${req.method} ${req.path} body:${hasBody ? "yes" : "no"}`);
  next();
});

// New auth middlewares
function requireReadOrAdmin(req: Request, res: Response, next: NextFunction) {
  const token = getBearer(req);
  if (!token) return respond401(res);
  if (hasRead(req)) return next();
  return respond403(res, "read");
}
function requireExport(req: Request, res: Response, next: NextFunction) {
  const token = getBearer(req);
  if (!token) return respond401(res);
  if (hasExport(req)) return next();
  return respond403(res, "export");
}
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const token = getBearer(req);
  if (!token) return respond401(res);
  if (hasAdmin(req)) return next();
  return respond403(res, "admin");
}

/* ===== Helpers ===== */

function normalizeTags(input: any): string[] {
  if (!Array.isArray(input)) return [];
  const cleaned = input
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x.length > 0)
    .map((x) =>
      x.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
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
  const v = (typeof raw === "string" ? raw.toLowerCase() : "") as "id" | "created_at" | "updated_at";
  return v === "created_at" || v === "updated_at" ? v : "id";
}

function parseIsoDate(raw: any): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

/* ===== Cursor helpers (v2: created_at|updated_at|id) with backward-compat ===== */

function encodeCursor(created_at: string, updated_at: string, id: number): string {
  return Buffer.from(`${created_at}|${updated_at}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(raw: any): { created_at: string; updated_at: string; id: number } | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const s = Buffer.from(raw, "base64url").toString("utf8");
    const parts = s.split("|");
    if (parts.length === 3) {
      const [c, u, iRaw] = parts;
      const id = Number(iRaw);
      const cDate = new Date(c);
      const uDate = new Date(u);
      if (!Number.isInteger(id) || isNaN(cDate.getTime()) || isNaN(uDate.getTime())) return null;
      return { created_at: cDate.toISOString(), updated_at: uDate.toISOString(), id };
    }
    if (parts.length === 2) {
      // v1 (backward compat): created_at|id
      const [c, iRaw] = parts;
      const id = Number(iRaw);
      const cDate = new Date(c);
      if (!Number.isInteger(id) || isNaN(cDate.getTime())) return null;
      const iso = cDate.toISOString();
      return { created_at: iso, updated_at: iso, id };
    }
    return null;
  } catch {
    return null;
  }
}

/* ===== NEW: soft delete helpers ===== */

function includeDeleted(req: Request): boolean {
  // 管理者だけ include_deleted=true を許可
  const flag =
    typeof req.query.include_deleted === "string" &&
    req.query.include_deleted.toLowerCase() === "true";
  return flag && hasAdmin(req);
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
    return { ok: false as const, error: `content is too long (max ${MAX_CONTENT_LEN} chars)` };
  }
  return { ok: true as const, value: v };
}
function validateTags(raw: any) {
  const tags = normalizeTags(raw);
  if (tags.length === 0) {
    return { ok: false as const, error: "tags must be a non-empty array of non-empty strings" };
  }
  if (tags.length > MAX_TAGS) {
    return { ok: false as const, error: `too many tags (max ${MAX_TAGS})` };
  }
  for (const t of tags) {
    if (t.length > MAX_TAG_LEN) {
      return { ok: false as const, error: `tag '${t.slice(0, 40)}' is too long (max ${MAX_TAG_LEN})` };
    }
  }
  return { ok: true as const, value: tags };
}

/* ===== WHERE Builder ===== */

function buildNotesFilters(req: Request) {
  const qRaw = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const q = qRaw.length > 0 ? qRaw : "";
  const qLen = q.length;

  const qm = typeof req.query.q_mode === "string" ? req.query.q_mode.toLowerCase() : "";
  const q_mode: "exact" | "partial" | "trgm" =
    qm === "exact" ? "exact" : qm === "trgm" ? "trgm" : "partial";

  const tagsMatch =
    typeof req.query.tags_match === "string" && req.query.tags_match.toLowerCase() === "partial"
      ? "partial"
      : "exact";
  const tagsAll = parseTagsQuery(req.query.tags_all);
  const tagsAny = parseTagsQuery(req.query.tags_any);
  const tagsNone = parseTagsQuery(req.query.tags_none);

  const legacyTags = parseTagsQuery(req.query.tags);
  const legacyMode =
    typeof req.query.tags_mode === "string" && req.query.tags_mode.toLowerCase() === "any"
      ? "any"
      : "all";

  const fromIso = parseIsoDate(req.query.from);
  const toIso = parseIsoDate(req.query.to);
  if (fromIso && toIso && new Date(fromIso) > new Date(toIso)) {
    return { error: "from must be earlier than to" } as const;
  }

  const whereParts: string[] = [];
  const values: any[] = [];

  // default filter (soft delete)
  if (!includeDeleted(req)) {
    whereParts.push("deleted_at IS NULL");
  }

  if (q) {
    if (q_mode === "exact") {
      const i = values.push(q);
      whereParts.push(`content = $${i}`);
    } else if (q_mode === "trgm" && qLen >= 3) {
      const i = values.push(q);
      whereParts.push(`content % $${i}`);
    } else {
      const i = values.push(`%${q}%`);
      whereParts.push(`content ILIKE $${i}`);
    }
  }

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

  return { whereClause, values, q, qLen, q_mode } as const;
}

/* ===== tips builder (Zero result) ===== */

function buildZeroResultTips(opts: {
  q: string;
  q_mode: "exact" | "partial" | "trgm";
  rankMin: number | null;
  rankDisabled: boolean;
}) {
  const tips: string[] = [];
  const { q, q_mode, rankMin, rankDisabled } = opts;

  if (!q || q.trim().length === 0) {
    tips.push("キーワードを入力してください（例：「会議」「テスト」）。");
  } else {
    const len = q.trim().length;
    if (len >= 8) tips.push("長いキーワードは短く分割して検索するとヒットする場合があります。");
    if (len <= 2) tips.push("3文字以上のキーワードにすると類似度検索が有効になります。");
  }

  if (q_mode === "exact") {
    tips.push("完全一致（q_mode=exact）以外に、部分一致（partial）や類似検索（trgm）も試してください。");
  } else if (q_mode === "partial") {
    tips.push("部分一致で見つからない場合は類似検索（q_mode=trgm）を試してください。");
  }

  if (rankDisabled) {
    tips.push("現在、類似度スコアは無効です（短い語など）。3文字以上で再検索してください。");
  } else {
    if (typeof rankMin === "number") {
      if (rankMin >= 0.5) tips.push("rank_min を 0.3 など少し下げて再検索してみてください。");
      else tips.push("rank_min を指定せずに再検索してみてください。");
    } else {
      tips.push("スコア順を確認したい場合は rank=1 を付けて検索してください。");
    }
  }

  if (/[Ａ-Ｚａ-ｚ０-９]/.test(q)) tips.push("全角英数が混じっていないか確認し、半角に統一してください。");
  if (/\s/.test(q)) tips.push("不要な空白を削除して再検索してみてください。");

  if (tips.length === 0) tips.push("別の表記・同義語（表記ゆれ、カナ/漢字違い）も試してください。");

  return Array.from(new Set(tips)).slice(0, 5);
}

/* ===== NEW: 0件時メッセージ ===== */
function formatFriendlyTips(message: string, tips: string[], echo: any) {
  const q = (echo?.q ?? "").toString();
  const hint =
    tips.length > 0
      ? "💡ヒント:\n" + tips.map((t) => `・${t}`).join("\n")
      : "ヒントはありません。";

  const tail = [
    echo?.rank ? `rank=${echo.rank}` : null,
    echo?.rank_min != null ? `rank_min=${echo.rank_min}` : null,
    echo?.order_by ? `order_by=${echo.order_by}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  const footer = tail ? `\n（検索条件: ${tail}）` : "";

  return [
    `🔍 検索ワード「${q}」では一致するノートが見つかりませんでした。`,
    hint,
    footer,
  ]
    .filter(Boolean)
    .join("\n");
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
app.get("/notes", requireReadOrAdmin, async (req, res) => {
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
    const rankMin = Number.isFinite(Number(req.query.rank_min)) ? Number(req.query.rank_min) : null;

    const built = buildNotesFilters(req);
    if ("error" in built) return res.status(400).json({ error: built.error });

    const whereParts: string[] = [];
    const values: any[] = [];

    if (built.whereClause) {
      whereParts.push(built.whereClause.replace(/^where\s+/i, ""));
      values.push(...built.values);
    }

    const rankDisabled = built.qLen > 0 && built.qLen < 3;
    if (rankDisabled) {
      res.setHeader("X-Rank-Disabled", "1");
    }

    if (!rankDisabled && built.q && rankMin !== null && !isNaN(rankMin)) {
      const i = values.push(built.q);
      const j = values.push(rankMin);
      whereParts.push(`similarity(content, $${i}) >= $${j}`);
    }

    // Cursor (order_by-aware)
    if (cursor && !req.query.offset) {
      const cmp = order === "asc" ? ">" : "<";
      if (orderBy === "created_at") {
        const i1 = values.push(cursor.created_at);
        const i2 = values.push(cursor.id);
        whereParts.push(`(created_at, id) ${cmp} ($${i1}::timestamptz, $${i2}::int)`);
      } else if (orderBy === "updated_at") {
        const i1 = values.push(cursor.updated_at);
        const i2 = values.push(cursor.id);
        whereParts.push(`(updated_at, id) ${cmp} ($${i1}::timestamptz, $${i2}::int)`);
      } else {
        const i = values.push(cursor.id);
        whereParts.push(`id ${cmp} $${i}`);
      }
    }

    const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
    const orderClause =
      wantRank && !rankDisabled && built.q
        ? `ORDER BY similarity(content, $${values.push(built.q)}) DESC, id DESC`
        : orderBy === "created_at"
        ? `ORDER BY created_at ${order}, id ${order}`
        : orderBy === "updated_at"
        ? `ORDER BY updated_at ${order}, id ${order}`
        : `ORDER BY id ${order}`;

    const cols =
      wantRank && !rankDisabled && built.q
        ? `id, content, tags, created_at, updated_at, deleted_at, similarity(content, $${values.push(
            built.q
          )}) as _rank`
        : `id, content, tags, created_at, updated_at, deleted_at`;

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

    if (!rows || rows.length === 0) {
      const tips = buildZeroResultTips({
        q: built.q,
        q_mode: built.q_mode,
        rankMin,
        rankDisabled,
      });

      const order_by =
        wantRank && !rankDisabled && built.q
          ? "rank_desc_id"
          : orderBy === "created_at"
          ? `created_at_${order}`
          : orderBy === "updated_at"
          ? `updated_at_${order}`
          : `id_${order}`;

      const payload = {
        results: [] as any[],
        message: "一致するノートは見つかりませんでした。",
        tips,
        echo: {
          q: built.q || null,
          rank_min: rankMin ?? null,
          limit,
          order_by,
        },
      };

      return res.json({
        ...payload,
        friendly_text: formatFriendlyTips(payload.message, payload.tips, payload.echo),
      });
    }

    if (!req.query.offset && rows && rows.length === limit) {
      const last = rows[rows.length - 1];
      const cur = encodeCursor(last.created_at, last.updated_at, last.id);
      res.setHeader("X-Next-Cursor", cur);
    }

    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET /notes/count
app.get("/notes/count", requireReadOrAdmin, async (req, res) => {
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

// GET /export.csv  (canonical)
app.get("/export.csv", requireExport, async (req, res) => {
  await handleExportCsv(req, res);
});
// Back-compat alias: GET /notes/export.csv
app.get("/notes/export.csv", requireExport, async (req, res) => {
  await handleExportCsv(req, res);
});

async function handleExportCsv(req: Request, res: Response) {
  try {
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
    const rankMin = Number.isFinite(Number(req.query.rank_min)) ? Number(req.query.rank_min) : null;
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
      wantRank && !rankDisabled && built.q
        ? `ORDER BY similarity(content, $${values.push(built.q)}) DESC, id DESC`
        : orderBy === "created_at"
        ? `ORDER BY created_at ${order}, id ${order}`
        : orderBy === "updated_at"
        ? `ORDER BY updated_at ${order}, id ${order}`
        : `ORDER BY id ${order}`;

    // include_deleted=true（管理者のみ）のときだけ、CSVに deleted_at を追加
    const includeDel = includeDeleted(req);

    // 列の組み立て（最小分岐）
    const valsForCols: any[] = [];
    let cols = `
      id,
      content,
      tags,
      to_char((created_at at time zone 'Asia/Tokyo'), 'YYYY/MM/DD HH24:MI:SS') as created_at_jst,
      to_char((updated_at  at time zone 'Asia/Tokyo'), 'YYYY/MM/DD HH24:MI:SS') as updated_at_jst
    `;
    if (includeDel) {
      cols += `,
      to_char((deleted_at at time zone 'Asia/Tokyo'), 'YYYY/MM/DD HH24:MI:SS') as deleted_at_jst
      `;
    }
    if (wantRank && !rankDisabled && built.q) {
      const qi = valsForCols.push(built.q);
      cols += `,
      similarity(content, $${qi}) as _rank
      `;
    }

    const rows: any = await sql(
      `
      select ${cols}
      from notes
      ${whereClause}
      ${orderClause}
      limit $${[...values, ...valsForCols].length + 1}
    `,
      [...values, ...valsForCols, limit]
    );

    const headerAlways = ["id", "content", "tags", "created_at_jst", "updated_at_jst"];
    const header =
      includeDel && wantRank && !rankDisabled && built.q
        ? [...headerAlways, "deleted_at_jst", "_rank"]
        : includeDel
        ? [...headerAlways, "deleted_at_jst"]
        : wantRank && !rankDisabled && built.q
        ? [...headerAlways, "_rank"]
        : headerAlways;

    const escape = (s: any) => {
      const v = s === null || s === undefined ? "" : String(s);
      return `"${v.replace(/"/g, '""')}"`;
    };
    const toCsvLine = (r: any) =>
      header.map((k) => escape(Array.isArray(r[k]) ? r[k].join(",") : r[k])).join(",");

    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const csv = [header.join(","), ...(rows || []).map(toCsvLine)].join("\r\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="notes_export.csv"`);
    res.send(Buffer.concat([bom, Buffer.from(csv, "utf8")]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal Server Error" });
  }
}

/* ===== CRUD ===== */

app.post("/notes", requireAdmin, async (req, res) => {
  try {
    const c = validateContent(req.body?.content);
    if (!c.ok) return res.status(400).json({ error: c.error });

    const t = validateTags(req.body?.tags);
    if (!t.ok) return res.status(400).json({ error: t.error });

    const rows: any = await sql`
      insert into notes (content, tags)
      values (${c.value}, ${t.value})
      returning id, content, tags, created_at, updated_at, deleted_at
    `;
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.patch("/notes/:id", requireAdmin, async (req, res) => {
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
      where id = $${values.length + 1} and (deleted_at is null)
      returning id, content, tags, created_at, updated_at, deleted_at
    `;
    const rows: any = await sql(query, [...values, id]);
    if (!rows || rows.length === 0) return res.status(404).json({ error: "not found" });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// DELETE = logical delete (soft)
app.delete("/notes/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "invalid id" });

    const rows: any = await sql`
      update notes
      set deleted_at = now(), updated_at = now()
      where id = ${id} and deleted_at is null
      returning id
    `;
    if (!rows || rows.length === 0) return res.status(404).json({ error: "not found" });
    log(`[soft-delete] id=${id}`);
    res.status(204).send();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// RESTORE endpoint
app.post("/notes/:id/restore", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "invalid id" });

    const rows: any = await sql`
      update notes
      set deleted_at = null, updated_at = now()
      where id = ${id} and deleted_at is not null
      returning id, content, tags, created_at, updated_at, deleted_at
    `;
    if (!rows || rows.length === 0) return res.status(404).json({ error: "not found" });
    log(`[restore] id=${id}`);
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/* ===== Listen ===== */
app.listen(PORT, () => {
  log(`Server listening on :${PORT}`);
});
