const make = require("../services/makeProxyRouter");

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