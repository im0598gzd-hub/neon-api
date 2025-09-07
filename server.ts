import express, { Request, Response } from "express";
import { neon } from "@neondatabase/serverless";

const app = express();
app.use(express.json());

// Neon 接続（Render の環境変数 DATABASE_URL を使用）
const sql = neon(process.env.DATABASE_URL!);

// ヘルスチェック
app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// メモ保存
app.post("/notes.create", async (req: Request, res: Response) => {
  const { text, author } = req.body as { text: string; author?: string };
  const rows = await sql`
    insert into notes (text, author) values (${text}, ${author ?? null})
    returning id, created_at;
  `;
  res.json(rows[0]);
});

// メモ一覧
app.get("/notes.list", async (_req: Request, res: Response) => {
  const rows = await sql`
    select id, created_at, author, text, tags
    from notes
    order by created_at desc
    limit 20;
  `;
  res.json(rows);
});

// Render は環境変数 PORT を割り当てるので、それに合わせて起動
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`API running on port ${port}`);
});
