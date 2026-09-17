const make = require("../services/makeProxyRouter");

module.exports = make("/api/transformation", [
  "apply",
  "optuna",
  "auto-select",
  "preview-single",
  "correlation",
]);
