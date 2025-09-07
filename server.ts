import express from "express";
import { neon } from "@neondatabase/serverless";

const app = express();
app.use(express.json());

// Neonに接続（Renderの環境変数 DATABASE_URL を使う）
const sql = neon(process.env.DATABASE_URL!);

// 健康チェック
app.get("/health", (_, res) => res.json({ ok: true }));

// メモを保存
app.post("/notes.create", async (req, res) => {
  const { text, author } = req.body;
  const rows = await sql`
    insert into notes (text, author) values (${text}, ${author ?? null})
    returning id, created_at;
  `;
  res.json(rows[0]);
});

// メモを一覧表示
app.get("/notes.list", async (_, res) => {
  const rows = await sql`
    select id, created_at, author, text, tags
    from notes
    order by created_at desc
    limit 20;
  `;
  res.json(rows);
});

app.listen(3000, () => {
  console.log("API running on port 3000");
});
