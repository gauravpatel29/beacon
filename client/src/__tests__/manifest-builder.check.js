// Mirrors draftToSpec + seedFromProfile from DataIngestion.jsx
function seedFromProfile(draft, profile) {
  const dateFormats = { ...draft.dateFormats };
  const dtypes = { ...draft.dtypes };
  for (const col of profile || []) {
    const name = col.column;
    if (col.date_candidates?.length && !dateFormats[name] && !col.ambiguous_date) {
      dateFormats[name] = { from: col.suggested_date_from, to: col.suggested_date_to || "%Y-%m-%d" };
    }
    if (!dtypes[name] && col.suggested_dtype) dtypes[name] = col.suggested_dtype;
  }
  return { ...draft, dtypes, dateFormats };
}
function draftToSpec(draft) {
  const column_renames = Object.entries(draft.renames)
    .filter(([from, to]) => to && to.trim() && to.trim() !== from)
    .map(([from, to]) => ({ from, to: to.trim() }));
  const dtype_changes = Object.entries(draft.dtypes)
    .filter(([column, to]) => to && to !== "string" && !["date","timestamp"].includes(to) && !draft.dateFormats[column])
    .map(([column, to]) => (to === "decimal" ? { column, to, precision: 18, scale: 2 } : { column, to }));
  const date_formats = Object.entries(draft.dateFormats)
    .filter(([, cfg]) => cfg && cfg.from && cfg.to)
    .map(([column, cfg]) => ({ column, from: cfg.from, to: cfg.to }));
  return { config_metadata: {}, live_updates: { date_formats, dtype_changes, column_renames }, filters: [] };
}

const profile = [
  { column: "npi",       suggested_dtype: "string",  date_candidates: [] },
  { column: "call_date", suggested_dtype: "date",    date_candidates: [{format:"%d-%m-%Y"}],
    suggested_date_from: "%d-%m-%Y", suggested_date_to: "%Y-%m-%d", ambiguous_date: false },
  { column: "ambig",     suggested_dtype: "date",    date_candidates: [{format:"%d-%m-%Y"},{format:"%m-%d-%Y"}],
    suggested_date_from: "%d-%m-%Y", suggested_date_to: "%Y-%m-%d", ambiguous_date: true },
  { column: "amount",    suggested_dtype: "float",   date_candidates: [] },
  { column: "qty",       suggested_dtype: "integer", date_candidates: [] },
  { column: "active",    suggested_dtype: "boolean", date_candidates: [] },
];
const base = { category: "", renames: {}, dtypes: {}, dateFormats: {}, filters: [], grain: null };
const seeded = seedFromProfile(base, profile);
const spec = draftToSpec(seeded);

let ok = 0, fail = 0;
const check = (l, c, x = "") => { console.log((c ? "  PASS  " : "  FAIL  ") + l + (!c && x ? "  :: " + JSON.stringify(x) : "")); c ? ok++ : fail++; };

check("every column shows a detected type (no blanks)",
  Object.keys(seeded.dtypes).length === 6 && seeded.dtypes.npi === "string", seeded.dtypes);
check("string columns emit NO dtype_change (already text)",
  !spec.live_updates.dtype_changes.some(d => d.column === "npi"), spec.live_updates.dtype_changes);
check("date column emits NO dtype cast (would re-infer)",
  !spec.live_updates.dtype_changes.some(d => d.column === "call_date"), spec.live_updates.dtype_changes);
check("date column emits an explicit date_format instead",
  spec.live_updates.date_formats.some(d => d.column === "call_date" && d.from === "%d-%m-%Y"),
  spec.live_updates.date_formats);
check("ambiguous date left unset — no format, no cast",
  !spec.live_updates.date_formats.some(d => d.column === "ambig") &&
  !spec.live_updates.dtype_changes.some(d => d.column === "ambig"), spec.live_updates);
check("real casts still emitted",
  ["amount","qty","active"].every(c => spec.live_updates.dtype_changes.some(d => d.column === c)),
  spec.live_updates.dtype_changes);
check("user override wins over detection", (() => {
  const s = seedFromProfile({ ...base, dtypes: { amount: "string" } }, profile);
  return s.dtypes.amount === "string" &&
    !draftToSpec(s).live_updates.dtype_changes.some(d => d.column === "amount");
})());

console.log("\nmanifest:", JSON.stringify(spec.live_updates, null, 1));
console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
