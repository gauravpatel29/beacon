const make = require("../services/makeProxyRouter");
module.exports = make("/api/response-curves", ["generate"]);
