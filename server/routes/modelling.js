const make = require("../services/makeProxyRouter");
module.exports = make("/api/modelling", [
  "available-channels", "run-regression", "run-ols-stage2",
  "run-ridge", "combined-decomposition",
]);
