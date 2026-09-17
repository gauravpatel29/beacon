const express = require("express");
const axios = require("axios");

const router = express.Router();

const callPython = async (pythonUrl, method, endpoint, data = null) => {
  const url = `${pythonUrl}${endpoint}`;
  const response = await axios({
    method,
    url,
    data,
    headers: { "Content-Type": "application/json" },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 120000,
  });
  return response.data;
};

// GET /api/workflows
router.get("/", async (req, res) => {
  try {
    const data = await callPython(req.pythonUrl, "GET", "/api/workflows");
    res.json(data);
  } catch (err) {
    const status = err.response?.status || 500;
    const detail = err.response?.data?.detail || err.response?.data?.error || err.message;
    res.status(status).json({ error: detail });
  }
});

// POST /api/workflows
router.post("/", async (req, res) => {
  try {
    const data = await callPython(req.pythonUrl, "POST", "/api/workflows", req.body);
    res.json(data);
  } catch (err) {
    console.error("Workflow create proxy error:", err.response?.data || err.message);
    const status = err.response?.status || 500;
    const detail = err.response?.data?.detail || err.response?.data?.error || err.message;
    res.status(status).json({ error: detail });
  }
});

// GET /api/workflows/:id
router.get("/:id", async (req, res) => {
  try {
    const data = await callPython(req.pythonUrl, "GET", `/api/workflows/${req.params.id}`);
    res.json(data);
  } catch (err) {
    const status = err.response?.status || 500;
    const detail = err.response?.data?.detail || err.response?.data?.error || err.message;
    res.status(status).json({ error: detail });
  }
});

// PUT /api/workflows/:id
router.put("/:id", async (req, res) => {
  try {
    const data = await callPython(req.pythonUrl, "PUT", `/api/workflows/${req.params.id}`, req.body);
    res.json(data);
  } catch (err) {
    const status = err.response?.status || 500;
    const detail = err.response?.data?.detail || err.response?.data?.error || err.message;
    res.status(status).json({ error: detail });
  }
});

// DELETE /api/workflows/:id
router.delete("/:id", async (req, res) => {
  try {
    const data = await callPython(req.pythonUrl, "DELETE", `/api/workflows/${req.params.id}`);
    res.json(data);
  } catch (err) {
    const status = err.response?.status || 500;
    const detail = err.response?.data?.detail || err.response?.data?.error || err.message;
    res.status(status).json({ error: detail });
  }
});

module.exports = router;