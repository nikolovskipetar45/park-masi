import { neon } from "@neondatabase/serverless";
import seedGuests from "./seed-guests.js";

const TABLE_IDS = [
  "head",
  ...Array.from({ length: 30 }, (_, i) => String(i + 1)),
];

const VALID_OWNERS = new Set(["toni", "najdan", "ane"]);

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
    ALTER TABLE tables
    ADD COLUMN IF NOT EXISTS owner TEXT
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

function normalizeOwner(owner) {
  const id = String(owner || "").trim();
  return VALID_OWNERS.has(id) ? id : "ane";
}

export async function loadState(sql = getSql()) {
  await ensureSchema(sql);

  const guestRows = await sql`SELECT id, name FROM guests ORDER BY id`;
  const tableRows = await sql`SELECT id, capacity, owner FROM tables`;
  const seatRows = await sql`
    SELECT s.table_id, s.guest_id, s.position, g.name
    FROM seatings s
    JOIN guests g ON g.id = s.guest_id
    ORDER BY s.table_id, s.position, s.guest_id
  `;

  const tables = {};
  for (const t of tableRows) {
    tables[t.id] = {
      capacity: Number(t.capacity),
      owner: t.owner ? normalizeOwner(t.owner) : null,
      guests: [],
    };
  }
  for (const s of seatRows) {
    if (!tables[s.table_id]) {
      tables[s.table_id] = { capacity: 10, owner: null, guests: [] };
    }
    tables[s.table_id].guests.push({ id: Number(s.guest_id), name: s.name });
  }

  return {
    guests: guestRows.map((g) => ({ id: Number(g.id), name: g.name })),
    tables,
  };
}

function normalizePayload(payload) {
  const guests = Array.isArray(payload?.guests) ? payload.guests : [];
  const tables =
    payload?.tables && typeof payload.tables === "object" ? payload.tables : {};

  const guestMap = new Map();
  for (const g of guests) {
    const id = Number(g.id);
    const name = String(g.name || "").trim();
    if (!Number.isFinite(id) || !name) continue;
    guestMap.set(id, name);
  }

  const tableMap = new Map();
  for (const [tableId, t] of Object.entries(tables)) {
    const capacity = Math.max(1, Number(t?.capacity) || 10);
    const owner = normalizeOwner(t?.owner);
    const list = Array.isArray(t?.guests) ? t.guests : [];
    const seated = [];
    list.forEach((g, position) => {
      const gid = Number(g.id);
      if (!Number.isFinite(gid)) return;
      const name = String(g.name || "").trim() || guestMap.get(gid) || `guest-${gid}`;
      guestMap.set(gid, name);
      seated.push({ id: gid, name, position });
    });
    tableMap.set(String(tableId), { capacity, owner, guests: seated });
  }

  return { guestMap, tableMap };
}

export async function saveState(payload, sql = getSql()) {
  await ensureSchema(sql);
  const { guestMap, tableMap } = normalizePayload(payload);

  if (tableMap.size === 0) {
    return loadState(sql);
  }

  const guestIds = [...guestMap.keys()];
  const guestNames = guestIds.map((id) => guestMap.get(id));

  if (guestIds.length) {
    await sql`
      INSERT INTO guests (id, name)
      SELECT * FROM UNNEST(${guestIds}::int[], ${guestNames}::text[])
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
    `;
  }

  if (guestIds.length) {
    await sql`DELETE FROM guests WHERE NOT (id = ANY(${guestIds}::int[]))`;
  } else {
    await sql`DELETE FROM guests`;
  }

  const tableIds = [...tableMap.keys()];
  const capacities = tableIds.map((id) => tableMap.get(id).capacity);
  const owners = tableIds.map((id) => tableMap.get(id).owner);

  if (tableIds.length) {
    await sql`
      INSERT INTO tables (id, capacity, owner)
      SELECT * FROM UNNEST(
        ${tableIds}::text[],
        ${capacities}::int[],
        ${owners}::text[]
      )
      ON CONFLICT (id) DO UPDATE
      SET capacity = EXCLUDED.capacity,
          owner = EXCLUDED.owner
    `;
  }

  await sql`DELETE FROM seatings`;

  const seatTableIds = [];
  const seatGuestIds = [];
  const seatPositions = [];
  for (const [tableId, t] of tableMap) {
    for (const g of t.guests) {
      seatTableIds.push(tableId);
      seatGuestIds.push(g.id);
      seatPositions.push(g.position);
    }
  }

  if (seatTableIds.length) {
    await sql`
      INSERT INTO seatings (table_id, guest_id, position)
      SELECT * FROM UNNEST(
        ${seatTableIds}::text[],
        ${seatGuestIds}::int[],
        ${seatPositions}::int[]
      )
      ON CONFLICT (table_id, guest_id) DO UPDATE SET position = EXCLUDED.position
    `;
  }

  return loadState(sql);
}

export { getSql, TABLE_IDS };
