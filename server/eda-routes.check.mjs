// Every /api/eda endpoint the Data Review screen calls must be proxied by the
// Node tier. Run with the Node server up:
//
//     PYTHON_URL=http://localhost:8090 PORT=5001 node index.js &
//     node server/eda-routes.check.mjs
//
// This exists because the API tests talk to Python directly on :8090 and so
// cannot see this layer at all. Five endpoints were live in Python and simply
// not routed here, and the browser got a 404 the UI silently discarded.

const BASE = process.env.NODE_BASE_URL || "http://localhost:5001";

const CSV = [
  "geo,week,sales,calls",
  "A,04-01-2026,100,5",
  "A,11-01-2026,120,6",
  "B,04-01-2026,200,4",
  "B,11-01-2026,210,5",
].join("\n") + "\n";

// name -> the body EDA.jsx actually sends
const CALLS = {
  stats: { csv_data: CSV, date_column: "week", geo_column: "geo", dependent_variable: "sales" },
  histogram: { csv_data: CSV, column: "sales" },
  scatter: { csv_data: CSV, x_column: "calls", y_column: "sales" },
  sparsity: { csv_data: CSV, metric_columns: ["sales", "calls"] },
  "poor-mans-curve": { csv_data: CSV, x_column: "calls", y_column: "sales", n_bins: 4 },
  "detect-outliers": { csv_data: CSV, column: "sales", method: "iqr", threshold: 1.5 },
  "remove-outliers": { csv_data: CSV, column: "sales", method: "iqr", threshold: 1.5 },
  "trend-rollup": { csv_data: CSV, date_column: "week", metric_columns: ["sales"], period: "month" },
};

// What the screen reads off each response. A 200 carrying the wrong shape is
// still a blank panel.
const EXPECT = {
  stats: (d) => Array.isArray(d.numeric_cols) && Array.isArray(d.summary_stats),
  histogram: (d) => Array.isArray(d.counts) && Array.isArray(d.bin_labels),
  scatter: (d) => Array.isArray(d.x) && Array.isArray(d.trendline),
  sparsity: (d) => Array.isArray(d.sparsity_table),
  "poor-mans-curve": (d) => Array.isArray(d.binned_curve),
  "detect-outliers": (d) => typeof d.outlier_count === "number",
  "remove-outliers": (d) => typeof d.clean_csv === "string" && d.clean_csv.length > 0,
  "trend-rollup": (d) => Array.isArray(d.trend_data) && d.trend_data.length > 0,
};

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? "  PASS  " : "  FAIL  ") + label + (cond ? "" : `  :: ${got}`));
};

const run = async () => {
  for (const [ep, body] of Object.entries(CALLS)) {
    let res, text;
    try {
      res = await fetch(`${BASE}/api/eda/${ep}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      text = await res.text();
    } catch (err) {
      t(`/api/eda/${ep} reachable`, false, err.message);
      continue;
    }

    // A 404 here means the endpoint is missing from server/routes/eda.js,
    // regardless of whether Python implements it.
    t(`/api/eda/${ep} is proxied (not 404)`, res.status !== 404, `status ${res.status}`);
    if (res.status === 404) continue;

    t(`/api/eda/${ep} -> 200`, res.status === 200, `status ${res.status}: ${text.slice(0, 160)}`);
    if (res.status !== 200) continue;

    let data;
    try { data = JSON.parse(text); } catch { t(`/api/eda/${ep} returns JSON`, false, text.slice(0, 120)); continue; }
    t(`/api/eda/${ep} shape is what the screen reads`, EXPECT[ep](data),
      JSON.stringify(data).slice(0, 160));
  }

  console.log("\n" + "=".repeat(52));
  console.log(`PASSED ${pass} / ${pass + fail}`);
  process.exit(fail ? 1 : 0);
};

run();
