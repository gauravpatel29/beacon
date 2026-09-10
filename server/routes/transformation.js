const make = require("../services/makeProxyRouter");
module.exports = make("/api/transformation", ["apply", "optuna"]);
