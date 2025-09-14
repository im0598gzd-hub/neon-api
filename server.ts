import express, { Request, Response } from "express";
import { neon } from "@neondatabase/serverless";

const app = express();
app.use(express.json());

// ---- APIキー認証（/health は公開）----
app.use((req, res, next) => {
  if (req.path === "/health") return next(); // ヘルスチェックは誰でもOK

  const expected = process.env.API_KEY;                   // RenderのEnvironmentで設定
  const auth = (req.header("authorization") || "").trim(); // 受け取ったヘッダ

  if (!expected) return res.status(500).json({ error: "Server misconfigured" });
  if (auth !== `Bearer ${expected}`) return res.status(401).json({ error: "Unauthorized" });

  next();
});

// ---- DB接続（Render の Environment に DATABASE_URL を設定済み前提）----
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const sql = neon(DATABASE_URL);

// ヘルスチェック
app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// メモ作成: body = { "content": "テキスト" }
app.post("/notes", async (req: Request, res: Response) => {
  const content = (req.body?.content ?? "").toString();
  if (!content) return res.status(400).json({ error: "content is required" });

  try {
    const rows = await sql/*sql*/`
      insert into notes (content)
      values (${content})
      returning id, content, created_at
    `;
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB insert failed" });
  }
});

// メモ一覧
app.get("/notes", async (_req: Request, res: Response) => {
  try {
    const rows = await sql/*sql*/`
      select id, content, created_at
      from notes
      order by id desc
      limit 50
    `;
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB select failed" });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`API listening on :${port}`));
