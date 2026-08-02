import { neon } from "@neondatabase/serverless";
import seedGuests from "./seed-guests.js";

const TABLE_IDS = [
  "head",
  ...Array.from({ length: 30 }, (_, i) => String(i + 1)),
];

function getSql() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    throw new Error("Missing DATABASE_URL / POSTGRES_URL");
  }
  return neon(url);
}

export async function ensureSchema(sql = getSql()) {
  await sql`
    CREATE TABLE IF NOT EXISTS guests (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS tables (
      id TEXT PRIMARY KEY,
      capacity INTEGER NOT NULL DEFAULT 10
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS seatings (
      table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
      guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (table_id, guest_id)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `;

  for (const id of TABLE_IDS) {
    const cap = id === "head" ? 6 : 10;
    await sql`
      INSERT INTO tables (id, capacity)
      VALUES (${id}, ${cap})
      ON CONFLICT (id) DO NOTHING
    `;
  }

  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM guests`;
  if (count === 0) {
    for (const g of seedGuests) {
      await sql`
        INSERT INTO guests (id, name)
        VALUES (${g.id}, ${g.name})
        ON CONFLICT (id) DO NOTHING
      `;
    }
  }

  return sql;
}

export async function loadState(sql = getSql()) {
  await ensureSchema(sql);

  const guestRows = await sql`SELECT id, name FROM guests ORDER BY id`;
  const tableRows = await sql`SELECT id, capacity FROM tables`;
  const seatRows = await sql`
    SELECT s.table_id, s.guest_id, s.position, g.name
    FROM seatings s
    JOIN guests g ON g.id = s.guest_id
    ORDER BY s.table_id, s.position, s.guest_id
  `;

  const tables = {};
  for (const t of tableRows) {
    tables[t.id] = { capacity: t.capacity, guests: [] };
  }
  for (const s of seatRows) {
    if (!tables[s.table_id]) {
      tables[s.table_id] = { capacity: 10, guests: [] };
    }
    tables[s.table_id].guests.push({ id: s.guest_id, name: s.name });
  }

  return {
    guests: guestRows.map((g) => ({ id: g.id, name: g.name })),
    tables,
  };
}

export async function saveState(payload, sql = getSql()) {
  await ensureSchema(sql);

  const guests = Array.isArray(payload.guests) ? payload.guests : [];
  const tables = payload.tables && typeof payload.tables === "object" ? payload.tables : {};

  // Replace guests
  await sql`DELETE FROM seatings`;
  await sql`DELETE FROM guests`;

  let maxId = 0;
  for (const g of guests) {
    const id = Number(g.id);
    const name = String(g.name || "").trim();
    if (!Number.isFinite(id) || !name) continue;
    if (id > maxId) maxId = id;
    await sql`INSERT INTO guests (id, name) VALUES (${id}, ${name})`;
  }

  for (const [tableId, t] of Object.entries(tables)) {
    const capacity = Math.max(1, Number(t.capacity) || 10);
    await sql`
      INSERT INTO tables (id, capacity)
      VALUES (${tableId}, ${capacity})
      ON CONFLICT (id) DO UPDATE SET capacity = EXCLUDED.capacity
    `;
    const list = Array.isArray(t.guests) ? t.guests : [];
    let pos = 0;
    for (const g of list) {
      const gid = Number(g.id);
      if (!Number.isFinite(gid)) continue;
      // ensure guest exists (in case of race)
      const name = String(g.name || "").trim() || `guest-${gid}`;
      await sql`
        INSERT INTO guests (id, name) VALUES (${gid}, ${name})
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
      `;
      await sql`
        INSERT INTO seatings (table_id, guest_id, position)
        VALUES (${tableId}, ${gid}, ${pos})
        ON CONFLICT (table_id, guest_id) DO UPDATE SET position = EXCLUDED.position
      `;
      pos += 1;
      if (gid > maxId) maxId = gid;
    }
  }

  return loadState(sql);
}

export { getSql, TABLE_IDS };
