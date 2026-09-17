const make = require("../services/makeProxyRouter");

module.exports = make("/api/correlation", [
  "matrix",
  "pca",
  "vif",
  "candidate-features",
  "high-pairs",
  "preview-removal",
  "apply-removal",
  "find-clusters",
  "preview-combination",
  "apply-combination",
  "apply-weighted-sum",
  "apply-pca-treatment",
]);
