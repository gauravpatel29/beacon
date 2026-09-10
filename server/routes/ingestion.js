const express = require("express");
const multer = require("multer");
const { proxyFilesToPython, proxyToPython } = require("../services/pythonProxy");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
});

// POST /api/ingestion/upload - multipart file upload
router.post("/upload", upload.array("files"), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        error: "No files uploaded",
      });
    }

    const data = await proxyFilesToPython(
      req.pythonUrl,
      "/api/ingestion/upload",
      req.files
    );

    return res.json(data);
  } catch (err) {
    console.error("Upload proxy error:", err.response?.data || err.message);
    const status = err.response?.status || 500;
    const detail =
      err.response?.data?.detail ||
      err.response?.data?.error ||
      err.message ||
      "Upload failed. Verify Python backend is running on port 8000.";

    return res.status(status).json({ error: detail });
  }
});

// Generic proxy endpoints
const endpoints = [
  "standardize",
  "merge",
  "filter",
  "detect-granularity",
  "modify-granularity",
  "normalize",
  "download",
];

endpoints.forEach((ep) => {
  router.post(`/${ep}`, async (req, res) => {
    try {
      const data = await proxyToPython(req.pythonUrl, `/api/ingestion/${ep}`, req.body);
      return res.json(data);
    } catch (err) {
      return res.status(err.response?.status || 500).json({
        error: err.response?.data?.detail || err.response?.data?.error || err.message,
      });
    }
  });
});

module.exports = router;