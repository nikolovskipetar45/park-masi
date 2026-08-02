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
    ALTER TABLE guests
    ADD COLUMN IF NOT EXISTS checked_in BOOLEAN NOT NULL DEFAULT false
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
  await sql`
    CREATE TABLE IF NOT EXISTS gift_entries (
      id SERIAL PRIMARY KEY,
      amount INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS gift_entry_guests (
      gift_id INTEGER NOT NULL REFERENCES gift_entries(id) ON DELETE CASCADE,
      guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
      PRIMARY KEY (guest_id)
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

  const guestRows = await sql`
    SELECT id, name, checked_in FROM guests ORDER BY id
  `;
  const tableRows = await sql`SELECT id, capacity, owner FROM tables`;
  const seatRows = await sql`
    SELECT s.table_id, s.guest_id, s.position, g.name, g.checked_in
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
    tables[s.table_id].guests.push({
      id: Number(s.guest_id),
      name: s.name,
      checkedIn: Boolean(s.checked_in),
    });
  }

  return {
    guests: guestRows.map((g) => ({
      id: Number(g.id),
      name: g.name,
      checkedIn: Boolean(g.checked_in),
    })),
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
    // Preserve checked_in on existing guests; new guests default to false
    await sql`
      INSERT INTO guests (id, name, checked_in)
      SELECT id, name, false
      FROM UNNEST(${guestIds}::int[], ${guestNames}::text[]) AS t(id, name)
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

export async function listCheckins(sql = getSql()) {
  await ensureSchema(sql);
  const rows = await sql`
    SELECT
      g.id,
      g.name,
      g.checked_in,
      s.table_id
    FROM guests g
    LEFT JOIN seatings s ON s.guest_id = g.id
    ORDER BY g.name ASC, g.id ASC
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    checkedIn: Boolean(r.checked_in),
    tableId: r.table_id || null,
  }));
}

export async function setCheckedIn(guestId, checkedIn, sql = getSql()) {
  await ensureSchema(sql);
  const id = Number(guestId);
  if (!Number.isFinite(id)) throw new Error("Invalid guest id");
  const rows = await sql`
    UPDATE guests
    SET checked_in = ${Boolean(checkedIn)}
    WHERE id = ${id}
    RETURNING id, name, checked_in
  `;
  if (!rows.length) throw new Error("Guest not found");
  const seat = await sql`
    SELECT table_id FROM seatings WHERE guest_id = ${id} LIMIT 1
  `;
  return {
    id: Number(rows[0].id),
    name: rows[0].name,
    checkedIn: Boolean(rows[0].checked_in),
    tableId: seat[0]?.table_id || null,
  };
}

function normalizeGiftAmount(amount) {
  const n = Math.round(Number(amount));
  if (!Number.isFinite(n) || n < 0) throw new Error("Invalid amount");
  return n;
}

function normalizeGuestIds(guestIds) {
  const ids = [...new Set((guestIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id)))];
  if (!ids.length) throw new Error("Select at least one guest");
  return ids;
}

async function fetchGiftEntry(giftId, sql) {
  const rows = await sql`
    SELECT
      e.id,
      e.amount,
      COALESCE(
        json_agg(
          json_build_object('id', g.id, 'name', g.name)
          ORDER BY g.name ASC, g.id ASC
        ) FILTER (WHERE g.id IS NOT NULL),
        '[]'::json
      ) AS guests
    FROM gift_entries e
    LEFT JOIN gift_entry_guests eg ON eg.gift_id = e.id
    LEFT JOIN guests g ON g.id = eg.guest_id
    WHERE e.id = ${giftId}
    GROUP BY e.id
  `;
  if (!rows.length) throw new Error("Gift not found");
  const guests = typeof rows[0].guests === "string" ? JSON.parse(rows[0].guests) : rows[0].guests;
  return {
    id: Number(rows[0].id),
    amount: Number(rows[0].amount),
    guests: (guests || []).map((g) => ({ id: Number(g.id), name: g.name })),
  };
}

export async function listGifts(sql = getSql()) {
  await ensureSchema(sql);
  const entryRows = await sql`
    SELECT
      e.id,
      e.amount,
      COALESCE(
        json_agg(
          json_build_object('id', g.id, 'name', g.name)
          ORDER BY g.name ASC, g.id ASC
        ) FILTER (WHERE g.id IS NOT NULL),
        '[]'::json
      ) AS guests
    FROM gift_entries e
    LEFT JOIN gift_entry_guests eg ON eg.gift_id = e.id
    LEFT JOIN guests g ON g.id = eg.guest_id
    GROUP BY e.id
    ORDER BY e.id DESC
  `;
  const assignedRows = await sql`SELECT guest_id FROM gift_entry_guests`;
  const assigned = new Set(assignedRows.map((r) => Number(r.guest_id)));
  const guestRows = await sql`SELECT id, name FROM guests ORDER BY name ASC, id ASC`;
  const entries = entryRows.map((r) => {
    const guests = typeof r.guests === "string" ? JSON.parse(r.guests) : r.guests;
    return {
      id: Number(r.id),
      amount: Number(r.amount),
      guests: (guests || []).map((g) => ({ id: Number(g.id), name: g.name })),
    };
  });
  const total = entries.reduce((sum, e) => sum + e.amount, 0);
  return {
    entries,
    availableGuests: guestRows
      .filter((g) => !assigned.has(Number(g.id)))
      .map((g) => ({ id: Number(g.id), name: g.name })),
    total,
  };
}

export async function createGift(guestIds, amount, sql = getSql()) {
  await ensureSchema(sql);
  const ids = normalizeGuestIds(guestIds);
  const value = normalizeGiftAmount(amount);

  const existing = await sql`
    SELECT guest_id FROM gift_entry_guests WHERE guest_id = ANY(${ids}::int[])
  `;
  if (existing.length) {
    throw new Error("Some guests already have a gift recorded");
  }

  const found = await sql`SELECT id FROM guests WHERE id = ANY(${ids}::int[])`;
  if (found.length !== ids.length) throw new Error("Guest not found");

  const [row] = await sql`
    INSERT INTO gift_entries (amount)
    VALUES (${value})
    RETURNING id
  `;
  const giftId = Number(row.id);
  for (const guestId of ids) {
    await sql`
      INSERT INTO gift_entry_guests (gift_id, guest_id)
      VALUES (${giftId}, ${guestId})
    `;
  }
  return fetchGiftEntry(giftId, sql);
}

export async function updateGift(giftId, { amount, guestIds } = {}, sql = getSql()) {
  await ensureSchema(sql);
  const id = Number(giftId);
  if (!Number.isFinite(id)) throw new Error("Invalid gift id");

  const current = await sql`SELECT id FROM gift_entries WHERE id = ${id}`;
  if (!current.length) throw new Error("Gift not found");

  if (amount !== undefined) {
    const value = normalizeGiftAmount(amount);
    await sql`UPDATE gift_entries SET amount = ${value} WHERE id = ${id}`;
  }

  if (guestIds !== undefined) {
    const ids = normalizeGuestIds(guestIds);
    const conflict = await sql`
      SELECT guest_id FROM gift_entry_guests
      WHERE guest_id = ANY(${ids}::int[]) AND gift_id <> ${id}
    `;
    if (conflict.length) {
      throw new Error("Some guests already have a gift recorded");
    }
    const found = await sql`SELECT id FROM guests WHERE id = ANY(${ids}::int[])`;
    if (found.length !== ids.length) throw new Error("Guest not found");

    await sql`DELETE FROM gift_entry_guests WHERE gift_id = ${id}`;
    for (const guestId of ids) {
      await sql`
        INSERT INTO gift_entry_guests (gift_id, guest_id)
        VALUES (${id}, ${guestId})
      `;
    }
  }

  return fetchGiftEntry(id, sql);
}

export async function deleteGift(giftId, sql = getSql()) {
  await ensureSchema(sql);
  const id = Number(giftId);
  if (!Number.isFinite(id)) throw new Error("Invalid gift id");
  const rows = await sql`
    DELETE FROM gift_entries WHERE id = ${id} RETURNING id
  `;
  if (!rows.length) throw new Error("Gift not found");
  return { ok: true };
}

export { getSql, TABLE_IDS };
