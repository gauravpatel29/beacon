# ProcTimize — Marketing Mix Modeling (MERN + Python)

A full MERN-stack conversion of the original Streamlit MMM tool, with Python (FastAPI) retaining all ML/statistical logic.

---

## Architecture

```
React (port 3000)  →  Node/Express (port 5001)  →  Python FastAPI (port 8000)
```

```
procTimize/
├── client/          # React frontend
│   ├── public/
│   └── src/
│       ├── pages/         # One page per Streamlit screen
│       ├── components/    # Shared UI components
│       ├── services/      # api.js — all API calls
│       └── context/       # AppContext — global workflow state
│
├── server/          # Node.js + Express API gateway
│   ├── routes/            # One route file per domain
│   ├── services/          # pythonProxy.js, makeProxyRouter.js
│   └── index.js
│
└── python/          # FastAPI — all MMM logic
    ├── routers/           # One router per domain
    ├── core/
    │   └── processing.py  # All ML/stats logic (adstock, OLS, response curves, etc.)
    └── main.py
```

---

## Streamlit → MERN Page Mapping

| Streamlit Page                   | React Page               | Python Router          |
|----------------------------------|--------------------------|------------------------|
| Home.py                          | Home.jsx                 | —                      |
| 1_Data_Ingestion.py              | DataIngestion.jsx        | routers/ingestion.py   |
| 2_Create_Integrated_Analytics.py | IntegratedAnalytics.jsx  | routers/analytics.py   |
| 3_Correlation_Analysis.py        | CorrelationAnalysis.jsx  | routers/correlation.py |
| 4_Exploratory_Data_Analysis.py   | EDA.jsx                  | routers/eda.py         |
| 5_Data_Transformation.py         | DataTransformation.jsx   | routers/transformation.py |
| 6_Modelling.py                   | Modelling.jsx            | routers/modelling.py   |
| 7_Modelling_Results.py           | ModelResults.jsx         | routers/results.py     |
| 8_Response_Curves.py             | ResponseCurves.jsx       | routers/response_curves.py |
| 9_Optimization.py                | Optimization.jsx         | routers/optimization.py |

---

## Prerequisites

- Node.js ≥ 18
- Python ≥ 3.10
- npm ≥ 9

---

## Setup & Run

### 1. Python (FastAPI)

```bash
cd python
python -m venv venv
source venv/bin/activate       # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

API docs available at: http://localhost:8000/docs

---

### 2. Node.js Server

```bash
cd server
npm install
npm run dev        # or: npm start
```

Server runs at: http://localhost:5001

---

### 3. React Client

```bash
cd client
npm install
npm start
```

App opens at: http://localhost:3000

---

## Data Flow

```
User uploads CSV
  → React (DataIngestion.jsx)
  → POST /api/ingestion/upload  (Node)
  → POST /api/ingestion/upload  (Python FastAPI)
  → Polars reads CSV, detects dates, returns preview
  → Node passes back to React
  → React stores in AppContext (session state)

User runs OLS regression
  → React (Modelling.jsx) sends transformed_csv + granular_csv
  → POST /api/modelling/run-regression  (Node)
  → Python runs statsmodels OLS
  → Returns coefficients, R², attribution, ROI
  → React stores output in regressionOutputs[]

User generates response curves
  → React (ResponseCurves.jsx)
  → POST /api/response-curves/generate  (Python)
  → Returns per-channel spend vs impactable_sales arrays
  → React stores as mergedRc in AppContext

User runs optimization
  → React (Optimization.jsx)
  → POST /api/optimization/run  (Python)
  → Marginal ROI greedy algorithm
  → Returns allocation per channel + convergence history
```

---

## Key Features

- **NPI validation** with Luhn algorithm  
- **Date granularity detection** (Daily/Weekly/Monthly) via Polars  
- **Granularity conversion** with last-week apportionment  
- **Geometric Adstock** decay  
- **Saturation functions** (Log, Power)  
- **Lag transformation**  
- **OLS regression** with impactable %, ROI, Long Term ROI  
- **Correlation matrix** + **VIF** + **PCA**  
- **Response curves** with calibration factor  
- **Budget & Sales optimization** using marginal ROI greedy algorithm  
- **Multi-iteration comparison** in Model Results  
- **CSV download** at every step  

---

## Environment Variables

### server/.env
```
PORT=5001
PYTHON_URL=http://localhost:8000
CLIENT_URL=http://localhost:3000
```

---

## API Reference (Python FastAPI)

All endpoints accept `application/json`. CSV data is passed as a string field `csv_data`.

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/ingestion/upload | Upload CSV files |
| POST | /api/ingestion/standardize | Select/rename/date columns |
| POST | /api/ingestion/merge | Merge multiple files |
| POST | /api/ingestion/filter | NPI + date + categorical filters |
| POST | /api/ingestion/detect-granularity | Detect time granularity |
| POST | /api/ingestion/modify-granularity | Convert Daily→Weekly→Monthly |
| POST | /api/ingestion/normalize | Z-score / IQR normalization |
| POST | /api/analytics/build | Build integrated analytics DB |
| POST | /api/correlation/matrix | Pearson/Spearman/Kendall matrix |
| POST | /api/correlation/vif | Variance Inflation Factor |
| POST | /api/correlation/pca | Principal Component Analysis |
| POST | /api/eda/stats | Trend, geo, describe, missing |
| POST | /api/eda/histogram | Histogram bins |
| POST | /api/eda/scatter | Scatter x/y data |
| POST | /api/transformation/apply | Adstock + Saturation + Lag |
| POST | /api/modelling/available-channels | List _transformed channels |
| POST | /api/modelling/run-regression | OLS regression + attribution |
| POST | /api/response-curves/generate | Spend → impactable curves |
| POST | /api/optimization/run | Marginal ROI optimizer |

Full interactive docs: http://localhost:8000/docs
