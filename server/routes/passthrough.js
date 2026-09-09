/**
 * Transparent passthrough for the Beacon /v1 and /v2 contracts.
 *
 * Unlike makeProxyRouter (POST-only, fixed endpoint names), these contracts use
 * every verb and carry path parameters, query strings and multipart bodies. The
 * Node tier adds nothing to them, so it forwards verbatim - including the status
 * code and problem+json body, which the client relies on for error detail.
 */

const express = require("express");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

function makePassthrough(prefix) {
  const router = express.Router();

  router.use(upload.any(), async (req, res) => {
    const target = `${req.pythonUrl}${prefix}${req.path === "/" ? "" : req.path}`;

    try {
      let data = req.body;
      let headers = { "Content-Type": "application/json" };

      if (req.files && req.files.length) {
        // Rebuild the multipart body: the backend must see the bytes to
        // transform them, so this cannot be a presigned direct-to-bucket PUT.
        const form = new FormData();
        for (const file of req.files) {
          form.append(file.fieldname, file.buffer, {
            filename: file.originalname,
            contentType: file.mimetype || "text/csv",
          });
        }
        for (const [key, value] of Object.entries(req.body || {})) {
          form.append(key, typeof value === "string" ? value : JSON.stringify(value));
        }
        data = form;
        headers = form.getHeaders();
      }

      const response = await axios({
        method: req.method,
        url: target,
        params: req.query,
        data: ["GET", "HEAD", "DELETE"].includes(req.method) ? undefined : data,
        headers,
        timeout: 300000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        // Forward the backend's status verbatim rather than throwing on 4xx:
        // problem+json bodies carry the per-column errors the UI displays.
        validateStatus: () => true,
        responseType: "arraybuffer",
      });

      const contentType = response.headers["content-type"];
      if (contentType) res.type(contentType);
      return res.status(response.status).send(Buffer.from(response.data));
    } catch (err) {
      const status = err.response?.status || 502;
      return res.status(status).json({
        type: "https://beacon.api/problems/gateway",
        title: "Upstream request failed",
        status,
        detail:
          err.code === "ECONNREFUSED"
            ? `Python API is not reachable at ${req.pythonUrl}. Start it with: cd python && .venv/Scripts/python.exe -m uvicorn main:app --port 8000`
            : err.message,
        instance: target,
      });
    }
  });

  return router;
}

module.exports = makePassthrough;
