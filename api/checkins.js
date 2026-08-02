import { listCheckins, setCheckedIn } from "../lib/db.js";

export const config = {
  maxDuration: 30,
  regions: ["fra1"],
};

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    if (req.method === "GET") {
      const guests = await listCheckins();
      const arrived = guests.filter((g) => g.checkedIn).length;
      res.status(200).json({
        guests,
        stats: { total: guests.length, arrived, pending: guests.length - arrived },
      });
      return;
    }

    if (req.method === "PATCH") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const guest = await setCheckedIn(body?.id, body?.checkedIn);
      res.status(200).json({ guest });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Server error" });
  }
}
