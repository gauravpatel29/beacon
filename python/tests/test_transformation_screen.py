"""The Data Transformation screen against the live transformation engines.

    python/.venv/Scripts/python.exe python/tests/test_transformation_screen.py

Tushar's screen used to compute adstock, saturation and correlation in the
browser. This pins the payloads it now sends instead, so the screen and the
engine the model is fitted with cannot drift apart.

The contract is awkward and worth stating: `transformations` entries are keyed
by display strings - "Channel Name", "Adstock", "Lags", "Saturation Function",
"Power (k)", "Log (k)" - and the UI's single `param` control maps to whichever
of the two k-fields the chosen curve uses.
"""

import io
import os
import uuid

import httpx
import numpy as np
import pandas as pd

BASE = os.environ.get("BEACON_BASE_URL", "http://127.0.0.1:8090")
PASS, FAIL = [], []


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"  :: {detail}" if detail and not cond else ""))


def sample_csv() -> str:
    """Two geos, 26 weeks, a spend channel that drives sales with a lag."""
    rng = np.random.default_rng(11)
    rows = []
    for geo in ("G1", "G2"):
        carry = 0.0
        for week in range(26):
            date = (pd.Timestamp("2026-01-05") + pd.Timedelta(weeks=week)).strftime("%Y-%m-%d")
            calls = float(max(0, rng.normal(40, 12)))
            emails = float(max(0, rng.normal(15, 6)))
            carry = 0.6 * carry + calls
            sales = 200 + 1.8 * carry + rng.normal(0, 10)
            rows.append({"geo": geo, "week_end_date": date, "calls": round(calls, 2),
                         "emails": round(emails, 2), "sales": round(sales, 2),
                         "population": 1000})
    buf = io.StringIO()
    pd.DataFrame(rows).to_csv(buf, index=False)
    return buf.getvalue()


CSV = sample_csv()

# Exactly what the screen builds from {decay, horizon, saturation, param}.
def transformation(channel, decay=0.5, lags=2, sat="Log", power_k=0.5, log_k=1.0):
    return {
        "Channel Name": channel, "Normalization": "none",
        "Adstock": decay, "Lags": lags, "Saturation Function": sat,
        "Power (k)": power_k, "Log (k)": log_k,
    }


BASE_PAYLOAD = {
    "csv_data": CSV,
    "geo_column": "geo",
    "date_column": "week_end_date",
    "dependent_variable": "sales",
    "pop_column": None,
}


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=300.0)
    try:
        print("\n1. apply: the payload the screen sends")
        r = c.post("/api/transformation/apply", json={
            **BASE_PAYLOAD,
            "transformations": [transformation("calls"), transformation("emails")],
            "derived_variables": [],
            "add_carryover": False,
        })
        check("200", r.status_code == 200, r.text[:400])
        if r.status_code != 200:
            return 1
        d = r.json()
        check("both channels come back transformed",
              "calls_transformed" in d["columns"] and "emails_transformed" in d["columns"],
              d["columns"])
        check("transformed_channels lists them",
              set(d["transformed_channels"]) >= {"calls_transformed", "emails_transformed"},
              d["transformed_channels"])
        check("every row is returned in csv_data, not just the 60-row preview",
              len(pd.read_csv(io.StringIO(d["csv_data"]))) == 52,
              (len(pd.read_csv(io.StringIO(d["csv_data"]))), len(d["preview"])))
        check("the preview really is only a sample", len(d["preview"]) <= 60, len(d["preview"]))
        check("the raw column survives alongside the transformed one",
              "calls" in d["columns"], d["columns"])

        print("\n2. the saturation choice actually changes the numbers")
        out = {}
        for sat, kw in (("none", {}), ("Log", {"log_k": 1.0}), ("Power", {"power_k": 0.5})):
            rr = c.post("/api/transformation/apply", json={
                **BASE_PAYLOAD,
                "transformations": [transformation("calls", sat=sat, **kw)],
                "derived_variables": [], "add_carryover": False,
            })
            frame = pd.read_csv(io.StringIO(rr.json()["csv_data"]))
            out[sat] = round(float(frame["calls_transformed"].sum()), 3)
        print(f"      none={out['none']}  Log={out['Log']}  Power={out['Power']}")
        check("three curves, three different answers", len(set(out.values())) == 3, out)
        check("log compresses a large positive series", out["Log"] < out["none"], out)

        print("\n3. adstock decay carries spend forward")
        sums = {}
        for decay in (0.0, 0.8):
            rr = c.post("/api/transformation/apply", json={
                **BASE_PAYLOAD,
                "transformations": [transformation("calls", decay=decay, lags=4, sat="none")],
                "derived_variables": [], "add_carryover": False,
            })
            frame = pd.read_csv(io.StringIO(rr.json()["csv_data"]))
            sums[decay] = round(float(frame["calls_transformed"].sum()), 3)
        print(f"      decay 0.0 -> {sums[0.0]}   decay 0.8 -> {sums[0.8]}")
        check("a higher decay accumulates more", sums[0.8] > sums[0.0], sums)

        # Adstock 0 with Lags > 0 is NOT "no adstock": the engine reads it as a
        # pure shift by `lags`, i.e. a lag feature rather than a decay. Worth
        # pinning, because it is the one setting where the two controls stop
        # being independent. The screen's decay dropdown offers 0.3-0.9, so it
        # cannot reach this path by accident.
        rr = c.post("/api/transformation/apply", json={
            **BASE_PAYLOAD,
            "transformations": [transformation("calls", decay=0.0, lags=4, sat="none")],
            "derived_variables": [], "add_carryover": False,
        })
        frame = pd.read_csv(io.StringIO(rr.json()["csv_data"]))
        g1 = frame[frame.geo == "G1"].reset_index(drop=True)
        check("decay 0 shifts the series by `lags`, within the geo",
              np.allclose(g1["calls_transformed"].iloc[4:], g1["calls"].iloc[:-4], atol=0.01),
              g1[["calls", "calls_transformed"]].head(6).to_dict("list"))
        check("and zero-fills the opening weeks rather than borrowing",
              (g1["calls_transformed"].iloc[:4] == 0).all(),
              g1["calls_transformed"].iloc[:4].tolist())

        print("\n4. derived variables, the shape the screen builds from its parts")
        r = c.post("/api/transformation/apply", json={
            **BASE_PAYLOAD,
            "transformations": [transformation("CALLS+EMAILS")],
            "derived_variables": [{"name": "CALLS+EMAILS", "operator": "+",
                                   "variables": ["calls", "emails"], "weights": {}}],
            "add_carryover": False,
        })
        check("200", r.status_code == 200, r.text[:300])
        d = r.json()
        check("the derived column exists", "CALLS+EMAILS" in d["columns"], d["columns"])
        check("and is transformed like any other channel",
              "CALLS+EMAILS_transformed" in d["columns"], d["columns"])
        frame = pd.read_csv(io.StringIO(d["csv_data"]))
        raw = pd.read_csv(io.StringIO(CSV))
        check("it really is the sum of its parts",
              np.allclose(frame["CALLS+EMAILS"], raw["calls"] + raw["emails"], atol=0.01),
              frame["CALLS+EMAILS"].head(3).tolist())

        print("\n5. carryover, from the checkbox")
        r = c.post("/api/transformation/apply", json={
            **BASE_PAYLOAD,
            "transformations": [transformation("calls")],
            "derived_variables": [], "add_carryover": True,
        })
        d = r.json()
        check("a Carryover column is added", "Carryover" in d["columns"], d["columns"])
        frame = pd.read_csv(io.StringIO(d["csv_data"]))
        first_per_geo = frame.groupby("geo").head(1)["Carryover"].tolist()
        check("each geo starts at 0 rather than borrowing the previous geo's last week",
              all(v == 0 for v in first_per_geo), first_per_geo)
        check("and it is the KPI shifted by one week within the geo",
              float(frame[frame.geo == "G1"]["Carryover"].iloc[1])
              == float(frame[frame.geo == "G1"]["sales"].iloc[0]),
              frame[frame.geo == "G1"][["sales", "Carryover"]].head(3).to_dict())
        r2 = c.post("/api/transformation/apply", json={
            **BASE_PAYLOAD, "transformations": [transformation("calls")],
            "derived_variables": [], "add_carryover": False,
        })
        check("and it is absent when the box is unticked",
              "Carryover" not in r2.json()["columns"], r2.json()["columns"])

        print("\n6. auto-select returns a config the screen can read back")
        r = c.post("/api/transformation/auto-select", json={
            **BASE_PAYLOAD,
            "channels": ["calls", "emails"],
            "derived_variables": [],
        })
        check("200", r.status_code == 200, r.text[:400])
        recs = r.json().get("recommendations", [])
        check("one recommendation per channel", len(recs) == 2, len(recs))
        keys = {"Channel Name", "Normalization", "Adstock", "Lags",
                "Saturation Function", "Power (k)", "Log (k)"}
        check("every key the config panel maps back from is present",
              all(keys <= set(rec) for rec in recs),
              [sorted(set(keys) - set(rec)) for rec in recs])
        check("the KPI is never tuned as a channel",
              all(rec["Channel Name"] != "sales" for rec in recs), recs)
        r = c.post("/api/transformation/auto-select", json={
            **BASE_PAYLOAD, "channels": ["calls", "sales"], "derived_variables": [],
        })
        check("even when it is passed in explicitly",
              all(rec["Channel Name"] != "sales" for rec in r.json()["recommendations"]),
              r.json()["recommendations"])

        print("\n7. correlation over the transformed columns")
        applied = c.post("/api/transformation/apply", json={
            **BASE_PAYLOAD,
            "transformations": [transformation("calls"), transformation("emails")],
            "derived_variables": [], "add_carryover": False,
        }).json()
        r = c.post("/api/transformation/correlation", json={
            "csv_data": applied["csv_data"],
            "columns": ["calls_transformed", "emails_transformed"],
            "threshold": 0.7,
        })
        check("200", r.status_code == 200, r.text[:300])
        d = r.json()
        check("the matrix is keyed by column, both ways",
              set(d["columns"]) == {"calls_transformed", "emails_transformed"}
              and "calls_transformed" in d["matrix"], d["columns"])
        check("a column correlates perfectly with itself",
              abs(d["matrix"]["calls_transformed"]["calls_transformed"] - 1.0) < 1e-9,
              d["matrix"]["calls_transformed"]["calls_transformed"])
        check("pairs carry feature1/feature2/corr, the keys the table reads",
              all({"feature1", "feature2", "corr"} <= set(p) for p in d["pairs"]), d["pairs"])
        low = c.post("/api/transformation/correlation", json={
            "csv_data": applied["csv_data"],
            "columns": ["calls_transformed", "emails_transformed"], "threshold": 0.0,
        }).json()
        check("the threshold is honoured - 0.0 reports at least as many pairs as 0.7",
              len(low["pairs"]) >= len(d["pairs"]), (len(low["pairs"]), len(d["pairs"])))
        r = c.post("/api/transformation/correlation", json={
            "csv_data": applied["csv_data"], "columns": ["calls_transformed"], "threshold": 0.7,
        })
        check("fewer than two columns is an empty answer, not an error",
              r.status_code == 200 and r.json()["columns"] == [], r.text[:200])

        print("\n8. bad input is refused rather than guessed")
        r = c.post("/api/transformation/apply", json={
            **BASE_PAYLOAD, "transformations": [], "derived_variables": [],
            "add_carryover": False,
        })
        check("no transformations -> 400", r.status_code == 400, r.status_code)
        r = c.post("/api/transformation/apply", json={
            **BASE_PAYLOAD,
            "transformations": [transformation("does_not_exist")],
            "derived_variables": [], "add_carryover": False,
        })
        check("an unknown channel is skipped, not crashed on",
              r.status_code == 200 and "does_not_exist_transformed" not in r.json()["columns"],
              r.status_code)

        return 1 if FAIL else 0
    finally:
        print("=" * 58)
        print(f"PASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
        for f in FAIL:
            print("   FAILED: " + f)


if __name__ == "__main__":
    raise SystemExit(main())
