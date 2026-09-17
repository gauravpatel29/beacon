require("dotenv").config();
const express = require("express");
const cors = require("cors");

const workflowRoutes = require("./routes/workflows");
const ingestionRoutes = require("./routes/ingestion");
const correlationRoutes = require("./routes/correlation");
const edaRoutes = require("./routes/eda");
const transformationRoutes = require("./routes/transformation");
const modellingRoutes = require("./routes/modelling");
const resultsRoutes = require("./routes/results");
const responseCurvesRoutes = require("./routes/responseCurves");
const optimizationRoutes = require("./routes/optimization");
const makePassthrough = require("./routes/passthrough");

const app = express();
const PORT = process.env.PORT || 5001;
const PYTHON_URL = process.env.PYTHON_URL || "http://localhost:8000";

app.use(cors({ origin: process.env.CLIENT_URL || "http://localhost:3000", credentials: true }));
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));

// Attach python base URL to every request
app.use((req, _res, next) => {
  req.pythonUrl = PYTHON_URL;
  next();
});

// Route Handlers
app.use("/api/workflows", workflowRoutes);
app.use("/api/ingestion", ingestionRoutes);
app.use("/api/correlation", correlationRoutes);
app.use("/api/eda", edaRoutes);
app.use("/api/transformation", transformationRoutes);
app.use("/api/modelling", modellingRoutes);
app.use("/api/results", resultsRoutes);
app.use("/api/response-curves", responseCurvesRoutes);
app.use("/api/optimization", optimizationRoutes);

// Beacon v1/v2 contracts - forwarded verbatim (all verbs, path params, multipart).
app.use("/v1", makePassthrough("/v1"));
app.use("/v2", makePassthrough("/v2"));

app.get("/health", (_req, res) => res.json({ status: "ok", python: PYTHON_URL }));

app.use((err, _req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => console.log(`✅ Node server running on http://localhost:${PORT}`));