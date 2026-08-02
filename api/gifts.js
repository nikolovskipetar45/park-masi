import { createGift, deleteGift, listGifts, updateGift } from "../lib/db.js";

export const config = {
  maxDuration: 30,
  regions: ["fra1"],
};

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function parseBody(req) {
  return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    if (req.method === "GET") {
      const data = await listGifts();
      res.status(200).json(data);
      return;
    }

    if (req.method === "POST") {
      const body = parseBody(req);
      const entry = await createGift(body.guestIds, body.amount);
      const data = await listGifts();
      res.status(201).json({ entry, ...data });
      return;
    }

    if (req.method === "PATCH") {
      const body = parseBody(req);
      const entry = await updateGift(body.id, {
        amount: body.amount,
        guestIds: body.guestIds,
      });
      const data = await listGifts();
      res.status(200).json({ entry, ...data });
      return;
    }

    if (req.method === "DELETE") {
      const body = parseBody(req);
      const id = body.id ?? req.query?.id;
      await deleteGift(id);
      const data = await listGifts();
      res.status(200).json(data);
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    const status = /not found|Invalid|Select at least|already have/i.test(err.message || "")
      ? 400
      : 500;
    res.status(status).json({ error: err.message || "Server error" });
  }
}
