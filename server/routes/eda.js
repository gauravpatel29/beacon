const make = require("../services/makeProxyRouter");
module.exports = make("/api/eda", ["stats", "histogram", "scatter"]);
