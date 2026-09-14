// Sandbox spike (claude/search-results-plan.md §11-§12): builds Meilisearch
// indexes straight from sofia.db, REPLACING every current SQL LIKE/GLOB
// matching query in routes/search.js (not running alongside it — the
// project's explicit direction, §12: the point of this migration is speed,
// and running SQL AND Meilisearch for every request would only ever be
// slower than SQL alone, defeating that).
//
// 2026-09-14 (§14, real-machine deployment finding): originally this built
// ONE Meilisearch index per "sub" (12 total: address, street, district, ...).
// That worked fine in the Linux sandbox but broke on the real Windows
// machine: per Meilisearch's own engineering blog ("Squeezing millions of
// documents in 128 TB of virtual memory"), the number of indexes Meilisearch
// can hold open AT ONCE is capped by the process's usable virtual address
// space divided by 2TB per index — roughly 46 indexes on Linux, but only
// ~4-6 on Windows (Windows exposes far less usable address space per
// process). Every search here queries ALL 12 subs in parallel
// (Promise.all in search.js), so on the real machine Meilisearch had to
// constantly close and reopen indexes just to serve one request — and
// observed live, that reopen path itself is flaky enough on Windows to
// throw "Too many spurious wake ups while trying to open the index X"
// (crates/index-scheduler/src/index_mapper/mod.rs's own retry-limit panic),
// not just slow.
//
// Fix (matches Meilisearch's own general recommendation regardless of OS —
// prefer fewer, larger indexes over many small ones): the 12 subs are now
// merged into 3 Meilisearch indexes, grouped by what's naturally already
// searched together, each document tagged with a `sub` field so search.js
// can filter back down to exactly one sub's candidates (`sub = "address"`,
// etc.) — functionally identical recall/ranking to one-index-per-sub
// (Meilisearch filters BEFORE ranking, so ranking still only ever sees the
// filtered sub's own documents), just fewer index handles for Windows to
// juggle:
//   places     - address, street, district, settlement
//   transport  - metro_route, metro_stop, stop, rail, terminal, route
//   business   - rubric, company
//
// Run: node src/scripts/reindexMeilisearch.js
const db = require("../db");
const client = require("../lib/meiliClient");

// Parses a housenumber string ("5", "5А", "50-52", "5,12", "бл. 42", "") into
// its leading numeric run + immediate following letter, e.g. "50-52" -> {5:
// digits 50, letter ""}, "5А-7" -> {digits: 5, letter: "А"}. This is the
// SAME shape houseNumberGlob() in search.js already parses the QUERY into —
// applying it to the STORED value too, at index time, replaces the old
// GLOB-boundary trick (`housenumber GLOB '5[^0-9]*'`) with a plain integer
// equality filter at query time (§12.1): "5" (digits 5, no letter) matches
// stored "5", "5А", "5-7", "5,12" (all parse to leading digits 5) but NOT
// "15" or "505А" (leading digits 15 / 505) — the exact distinction the old
// GLOB existed for, without needing GLOB, and it also subsumes the old
// separate `housenumber = @numberExact` check (a bare "5" stored value
// parses to digits=5/letter="" too, so plain digit equality already
// catches it — seeCommentary in search-results-plan.md §12.1 for why the
// old code needed two conditions and this needs only one).
function parseHousenumber(hn) {
  const m = String(hn || "").match(/^(\d+)([a-zA-Zа-яА-Я]?)/u);
  if (!m) return { digits: null, letter: "" };
  return { digits: parseInt(m[1], 10), letter: (m[2] || "").toLowerCase() };
}

// One entry per search "sub" — same docs()/searchable/filterable shape as
// the old one-index-per-sub design, plus `idField`: which field on each row
// `docs()` already returns is that sub's own natural unique key (mirrors
// each old index's own `primaryKey`) — used below to build a
// group-wide-unique `mid` once subs are merged into one physical index.
const SUB_DEFS = {
  address: {
    idField: "id",
    searchable: ["name", "addr_street"],
    filterable: ["hn_digits", "hn_letter"],
    docs: () =>
      db
        .prepare(`SELECT id, name, addr_street, housenumber, building, lat, lon FROM buildings WHERE (name != '' OR housenumber != '')`)
        .all()
        .map((r) => {
          const { digits, letter } = parseHousenumber(r.housenumber);
          return { ...r, hn_digits: digits, hn_letter: letter };
        }),
  },
  street: {
    idField: "id",
    searchable: ["name"],
    docs: () =>
      db
        .prepare(`SELECT DISTINCT name FROM streets WHERE name != ''`)
        .all()
        .map((r, i) => ({ id: i, name: r.name })),
  },
  district: {
    idField: "id",
    searchable: ["name"],
    docs: () => db.prepare(`SELECT id, name, lat, lon FROM districts WHERE name != ''`).all(),
  },
  settlement: {
    idField: "id",
    searchable: ["name"],
    docs: () => db.prepare(`SELECT id, name, lat, lon FROM settlements WHERE name != ''`).all(),
  },
  metro_route: {
    idField: "id",
    searchable: ["name", "ref"],
    docs: () => db.prepare(`SELECT id, ref, name FROM routes_metro`).all(),
  },
  metro_stop: {
    idField: "id",
    searchable: ["name"],
    docs: () => db.prepare(`SELECT id, name, lat, lon FROM stops WHERE stop_type = 'subway'`).all(),
  },
  stop: {
    idField: "id",
    searchable: ["name"],
    docs: () => db.prepare(`SELECT id, name, stop_type, lat, lon FROM stops WHERE stop_type IN ('bus_stop','tram_stop')`).all(),
  },
  rail: {
    idField: "id",
    searchable: ["name"],
    docs: () => db.prepare(`SELECT id, name, lat, lon FROM stops WHERE stop_type = 'rail'`).all(),
  },
  terminal: {
    idField: "id",
    searchable: ["name"],
    docs: () => db.prepare(`SELECT id, name, stop_type, lat, lon FROM stops WHERE stop_type IN ('airport','bus_terminal')`).all(),
  },
  route: {
    // Original design's own primaryKey was "uid", not "id" — bus/tram/
    // trolleybus ids can collide with each other, so docs() already
    // synthesizes a cross-rtype-unique `uid` per row; reuse it as this
    // sub's own idField the same way every other sub reuses its own `id`.
    idField: "uid",
    searchable: ["name", "ref"],
    docs: () => {
      const bus = db.prepare(`SELECT id, ref, name FROM routes_bus`).all().map((r) => ({ ...r, rtype: "bus" }));
      const tram = db.prepare(`SELECT id, ref, name FROM routes_tram`).all().map((r) => ({ ...r, rtype: "tram" }));
      const trolley = db.prepare(`SELECT id, ref, name FROM routes_trolleybus`).all().map((r) => ({ ...r, rtype: "trolleybus" }));
      return [...bus, ...tram, ...trolley].map((r) => ({ ...r, uid: `${r.rtype}-${r.id}` }));
    },
  },
  rubric: {
    // Original design's own primaryKey was "idx" (a plain array index, not
    // a real DB id — rubric names aren't a table with their own id column).
    idField: "idx",
    searchable: ["name"],
    docs: () =>
      db
        .prepare(`SELECT rubric AS name, COUNT(*) as cnt FROM organizations WHERE rubric != '' GROUP BY rubric`)
        .all()
        .map((r, i) => ({ ...r, idx: i })),
  },
  company: {
    idField: "id",
    searchable: ["name"],
    docs: () => db.prepare(`SELECT id, name, rubric, addr_street, housenumber, lat, lon FROM organizations`).all(),
  },
};

// Which physical Meilisearch index each sub's documents live in — see the
// top-of-file comment for why these three groupings (not one-per-sub, not
// one-for-everything: this keeps each group's searchable/filterable
// attribute set small and semantically coherent, while landing comfortably
// under Windows' ~4-6-open-indexes budget with room to spare).
const GROUPS = {
  places: ["address", "street", "district", "settlement"],
  transport: ["metro_route", "metro_stop", "stop", "rail", "terminal", "route"],
  business: ["rubric", "company"],
};

// 2026-09-14 (§14 follow-up, real-machine finding): when the 12-index
// design (one physical index per sub) was consolidated down to 3 grouped
// indexes ("places"/"transport"/"business", see GROUPS below), this
// function only ever started deleting/creating the 3 GROUP names — it
// never touched the 12 OLD per-sub index names ("address", "street", …)
// still sitting on disk from every earlier run. Confirmed live: the real
// machine's data folder had accumulated 15 physical index folders (the 3
// current ones + all 12 abandoned ones, one of them ~60MB, another ~44MB —
// the old, pre-consolidation "address"/"company" indexes never cleaned
// up). Meilisearch still tracks and can touch every REGISTERED index
// (by name), abandoned or not, on things like startup/stats/task-queue
// housekeeping — so 15 registered indexes were still competing for
// Windows' own ~4-6-open-at-once budget (§14.2) even though the app
// itself only ever queries 3 of them. This function now sweeps every
// registered index that ISN'T one of the current GROUPS names before
// doing its normal per-group delete+recreate, so a future redesign (or
// this one, on the real machine, once) can't leave permanent orphans
// again.
async function sweepStaleIndexes(keepNames) {
  const { results } = await client.getIndexes({ limit: 1000 });
  const stale = results.filter((idx) => !keepNames.has(idx.uid));
  for (const idx of stale) {
    const task = await client.index(idx.uid).delete();
    await client.waitForTask(task.taskUid, { timeOutMs: 60000 });
    console.log(`[reindex] swept stale index "${idx.uid}" (not part of current design)`);
  }
}

async function main() {
  const t0 = Date.now();
  await sweepStaleIndexes(new Set(Object.keys(GROUPS)));
  for (const [group, subs] of Object.entries(GROUPS)) {
    const t1 = Date.now();
    const searchable = new Set();
    // `sub` itself must always be filterable — it's how search.js narrows
    // a group-wide search back down to one sub's candidates.
    const filterable = new Set(["sub"]);
    let docs = [];
    let perSubCounts = [];
    for (const sub of subs) {
      const def = SUB_DEFS[sub];
      def.searchable.forEach((f) => searchable.add(f));
      (def.filterable || []).forEach((f) => filterable.add(f));
      const subDocs = def.docs().map((row) => ({
        ...row,
        sub,
        // Group-wide-unique primary key: two different subs' own idFields
        // (e.g. address's numeric `id` and district's numeric `id`) can
        // collide once merged into the same physical index, so every
        // document's real Meilisearch primary key is `${sub}_${itsOwnId}`
        // — `id`/`uid`/`idx` themselves are left untouched on the document
        // so every existing downstream consumer (search.js's toResult(),
        // hrefs, streetsDirectory lookups, ...) keeps working unchanged.
        mid: `${sub}_${row[def.idField]}`,
      }));
      perSubCounts.push(`${sub}: ${subDocs.length}`);
      docs = docs.concat(subDocs);
    }

    // Recreate clean each run (full reindex on server start, per the
    // decided sync strategy — see plan §11.5): delete then create rather
    // than update-in-place, so a document removed from sofia.db since the
    // last reindex (e.g. a patch that deletes/renames something) can't
    // linger in the index forever.
    try {
      const existing = await client.getIndex(group);
      // 2026-09-14 (§14 follow-up): `.delete()` only ENQUEUES a task and
      // returns immediately — it does not wait for Meilisearch to actually
      // remove the physical index. `createIndex` right after used to race
      // that background deletion; waiting for the task here is what makes
      // "delete then create" actually happen in that order.
      const task = await existing.delete();
      await client.waitForTask(task.taskUid, { timeOutMs: 60000 });
    } catch (e) {
      // 404 = didn't exist yet, fine.
    }
    await client.createIndex(group, { primaryKey: "mid" });
    await client.index(group).updateSearchableAttributes([...searchable]);
    await client.index(group).updateFilterableAttributes([...filterable]);
    // Batch in chunks — Meilisearch handles big single payloads fine, but
    // chunking keeps memory/HTTP payload size sane for the biggest group
    // (business, ~20k+ docs) without needing to tune anything else.
    const CHUNK = 5000;
    let lastTask = null;
    for (let i = 0; i < docs.length; i += CHUNK) {
      lastTask = await client.index(group).addDocuments(docs.slice(i, i + CHUNK));
    }
    if (lastTask) await client.waitForTask(lastTask.taskUid, { timeOutMs: 60000 });
    console.log(`[reindex] ${group}: ${docs.length} docs (${perSubCounts.join(", ")}) in ${Date.now() - t1}ms`);
  }
  console.log(`[reindex] total: ${Date.now() - t0}ms`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main, parseHousenumber, GROUPS };
