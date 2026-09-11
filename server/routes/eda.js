const make = require("../services/makeProxyRouter");

// Every endpoint the Data Review screen calls. An endpoint missing from this
// list is not proxied at all: the Node tier 404s it and the browser never
// reaches Python, even though the route exists there. That is invisible from
// the API tests, which talk to Python directly - so this list has to be kept in
// step with routers/eda.py by hand.
module.exports = make("/api/eda", [
  "stats",
  "histogram",
  "scatter",
  "sparsity",
  "poor-mans-curve",
  "detect-outliers",
  "remove-outliers",
  "trend-rollup",
]);
