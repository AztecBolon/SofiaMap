// Thin wrapper around the Meilisearch JS client. Deliberately just a host +
// key from env vars — this is the whole "self-hosted vs Meilisearch Cloud"
// swap surface described in claude/search-results-plan.md §11: swapping
// MEILI_HOST/MEILI_KEY to a Cloud project's URL/key is the entire migration,
// no code change needed on either side of that decision.
const { MeiliSearch } = require("meilisearch");

const client = new MeiliSearch({
  host: process.env.MEILI_HOST || "http://127.0.0.1:7700",
  apiKey: process.env.MEILI_KEY || undefined,
});

module.exports = client;
