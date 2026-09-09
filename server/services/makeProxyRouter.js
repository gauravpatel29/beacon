const express = require("express");
const { proxyToPython } = require("../services/pythonProxy");

function makeProxyRouter(prefix, endpoints) {
  const router = express.Router();
  endpoints.forEach((ep) => {
    router.post(`/${ep}`, async (req, res) => {
      try {
        const data = await proxyToPython(req.pythonUrl, `${prefix}/${ep}`, req.body);
        res.json(data);
      } catch (err) {
        res.status(err.response?.status || 500).json({ error: err.response?.data?.detail || err.message });
      }
    });
  });
  return router;
}

module.exports = makeProxyRouter;
