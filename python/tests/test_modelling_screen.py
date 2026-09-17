"""The /api/modelling contract the Model Configuration screen depends on.

    python/.venv/Scripts/python.exe python/tests/test_modelling_screen.py

The screen used to fit the regression in the browser. It now posts to these
endpoints, so what it relies on is pinned here:

  * `available-channels` decides the channel list - the screen no longer
    guesses it - and returns the date range its pickers are bounded by;
  * every endpoint takes BOTH frames. `granular_csv` is where spend and raw
    activity come from, so ROI is zero without it - section 3 proves the
    difference rather than asserting the field is present;
  * `dependent_variable` and `dependent_variable_user_input` are different
    columns when the dependent variable was itself normalised, and swapping
    them returns a model rather than an error;
  * ridge honours the controls the screen exposes - a larger alpha really does
    shrink coefficients, and `positive_coef` really does bound them at zero;
  * stage 2 needs stage 1's coefficients, and the combined decomposition needs
    both.
"""

import os
import uuid

import httpx

BASE = os.environ.get("BEACON_BASE_URL", "http://127.0.0.1:8090")
PASS, FAIL = [], []


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"  :: {detail}" if detail and not cond else ""))


WEEKS = [f"2026-{m:02d}-{d:02d}" for m in range(1, 7) for d in (5, 12, 19, 26)]

# Two geographies, a dependent variable driven by two channels plus noise, and
# a spend column for each so ROI has something to divide by.
def _rows():
    out = ["week,npi,trx,calls_transformed,emails_transformed,calls,emails,calls Spend,emails Spend"]
    for i, w in enumerate(WEEKS):
        for g in (1001, 1002):
            calls = 10 + (i % 7)
            emails = 5 + (i % 4)
            trx = 100 + 3 * calls + 2 * emails + (i % 3)
            out.append(f"{w},{g},{trx},{calls}.0,{emails}.0,{calls},{emails},{calls * 20},{emails * 5}")
    return "\n".join(out) + "\n"


CSV = _rows()
CHANNELS = ["calls_transformed", "emails_transformed"]
BASE_BODY = {
    "transformed_csv": CSV,
    "granular_csv": CSV,
    "date_column": "week",
    "geo_column": "npi",
    "dependent_variable": "trx",
    "dependent_variable_user_input": "trx",
    "selected_channels": CHANNELS,
    "start_date": WEEKS[0],
    "end_date": WEEKS[-1],
}


def coef_of(result, variable):
    for row in result["coefficients"]:
        if row["Variable"] == variable:
            return row
    return {}


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=300.0)
    try:
        print("\n1. available-channels drives the screen's channel list")
        r = c.post("/api/modelling/available-channels", json={
            "csv_data": CSV, "date_column": "week", "geo_column": "npi",
            "dependent_variable": "trx", "dependent_variable_user_input": "trx",
        })
        check("200", r.status_code == 200, r.text[:250])
        data = r.json()
        channels = data["channels"]
        check("the transformed channels are offered", set(CHANNELS) <= set(channels), channels)
        check("the date column is not a channel", "week" not in channels, channels)
        check("nor the geography column", "npi" not in channels, channels)
        check("nor the dependent variable", "trx" not in channels, channels)
        check("the date range spans the data",
              (data["date_range"]["start"], data["date_range"]["end"]) == (WEEKS[0], WEEKS[-1]),
              data["date_range"])

        # The window the pickers are bounded by has to follow the window asked
        # for, or the bounds would not narrow as the user narrows the model.
        r = c.post("/api/modelling/available-channels", json={
            "csv_data": CSV, "date_column": "week", "geo_column": "npi",
            "dependent_variable": "trx", "start_date": WEEKS[4], "end_date": WEEKS[8],
        })
        check("a requested window narrows the reported range",
              (r.json()["date_range"]["start"], r.json()["date_range"]["end"]) == (WEEKS[4], WEEKS[8]),
              r.json()["date_range"])

        print("\n2. OLS stage 1 returns what the results card renders")
        r = c.post("/api/modelling/run-regression", json=BASE_BODY)
        check("200", r.status_code == 200, r.text[:300])
        s1 = r.json()
        for field in ("summary", "coefficients", "r_squared", "adj_r_squared", "rmse"):
            check(f"returns {field}", field in s1, sorted(s1))
        check("R squared is a real fit", 0.5 <= s1["r_squared"] <= 1.0, s1["r_squared"])
        check("an intercept row is present", bool(coef_of(s1, "const")), "no const")
        calls = coef_of(s1, "calls_transformed")
        check("the driving channel has a positive coefficient", calls["Coefficient"] > 0, calls)
        for col in ("Impactable %", "Impactable (%)", "Impactable Sales", "ROI", "Long Term ROI",
                    "Raw Activity", "Modelled Activity", "Spend", "Note"):
            check(f"the coefficient table carries {col}", col in calls, sorted(calls))
        check("the summary is statsmodels' own text", "OLS Regression Results" in s1["summary"],
              s1["summary"][:80])

        print("\n3. the raw frame is what makes ROI a number")
        # Spend lives in the granular frame. Sending the transformed one for
        # both - which is what a screen that only had one CSV would do - leaves
        # spend at zero and ROI with it.
        no_spend_csv = "\n".join(
            [",".join(h for h in CSV.splitlines()[0].split(",") if "Spend" not in h)]
            + [",".join(v for h, v in zip(CSV.splitlines()[0].split(","), line.split(","))
                        if "Spend" not in h)
               for line in CSV.splitlines()[1:]]
        ) + "\n"
        r = c.post("/api/modelling/run-regression", json={**BASE_BODY, "granular_csv": no_spend_csv})
        stripped = coef_of(r.json(), "calls_transformed")
        check("with spend, ROI is non-zero", calls["ROI"] != 0, calls["ROI"])
        check("without it, ROI is zero", stripped["ROI"] == 0, stripped["ROI"])
        check("and the coefficient is unchanged either way",
              round(stripped["Coefficient"], 6) == round(calls["Coefficient"], 6),
              (stripped["Coefficient"], calls["Coefficient"]))

        print("\n4. the two dependent-variable names are not interchangeable")
        # Regress a normalised dependent variable while taking sales totals from
        # the raw column, which is what the screen does when the set normalised
        # the KPI.
        scaled = CSV.replace("trx,", "trx_transformed,", 1)
        r = c.post("/api/modelling/run-regression", json={
            **BASE_BODY, "transformed_csv": scaled,
            "dependent_variable": "trx", "dependent_variable_user_input": "trx_transformed",
        })
        check("a suffixed user input is accepted", r.status_code == 200, r.text[:250])
        # And naming a column that is not in the transformed frame fails loudly
        # rather than quietly modelling something else.
        r = c.post("/api/modelling/run-regression", json={
            **BASE_BODY, "dependent_variable_user_input": "not_a_column",
        })
        check("an unknown dependent column is rejected", r.status_code == 400, r.status_code)

        print("\n5. ridge honours the controls the screen exposes")
        ridge_body = {**BASE_BODY, "stage": 1, "alpha_mode": "manual", "cv_splits": 3,
                      "positive_coef": False, "use_custom_penalties": False, "prior_weights": {}}
        weak = c.post("/api/modelling/run-ridge", json={**ridge_body, "manual_alpha": 0.01})
        strong = c.post("/api/modelling/run-ridge", json={**ridge_body, "manual_alpha": 5000.0})
        check("both fits return 200", weak.status_code == 200 and strong.status_code == 200,
              (weak.status_code, strong.status_code))
        w = abs(coef_of(weak.json(), "calls_transformed")["Coefficient"])
        s = abs(coef_of(strong.json(), "calls_transformed")["Coefficient"])
        check("a larger alpha shrinks the coefficient", s < w, (w, s))

        auto = c.post("/api/modelling/run-ridge", json={**ridge_body, "alpha_mode": "auto"})
        check("cross-validated alpha runs", auto.status_code == 200, auto.text[:250])

        # Media cannot subtract sales; this is the control that says so.
        neg = {**ridge_body, "selected_channels": CHANNELS, "positive_coef": True}
        r = c.post("/api/modelling/run-ridge", json=neg)
        check("non-negative constraint runs", r.status_code == 200, r.text[:250])
        coefs = [row["Coefficient"] for row in r.json()["coefficients"]
                 if row["Variable"] in CHANNELS]
        check("and no channel comes back negative", all(v >= -1e-9 for v in coefs), coefs)

        r = c.post("/api/modelling/run-ridge", json={
            **ridge_body, "use_custom_penalties": True,
            "prior_weights": {"calls_transformed": 3.0, "emails_transformed": 0.5},
        })
        check("per-channel prior weights are accepted", r.status_code == 200, r.text[:250])

        print("\n6. stage 2 and the combined decomposition")
        s2_body = {**BASE_BODY, "parent_channel": "calls_transformed",
                   "s2_channels": ["emails_transformed"],
                   "stage1_coefficients": s1["coefficients"]}
        r = c.post("/api/modelling/run-ols-stage2", json=s2_body)
        check("stage 2 runs", r.status_code == 200, r.text[:300])
        s2 = r.json()
        check("it returns its own coefficients", len(s2.get("coefficients", [])) > 0, sorted(s2))

        r = c.post("/api/modelling/combined-decomposition", json={
            "stage1_coefficients": s1["coefficients"],
            "stage2_coefficients": s2["coefficients"],
            "parent_channel": "calls_transformed",
            "dep_var_label": "trx",
        })
        check("the decomposition runs", r.status_code == 200, r.text[:300])
        comb = r.json()
        check("a combined table comes back", len(comb["combined_table"]) > 0, comb.keys())
        check("every row says which stage it came from",
              all("Source" in row for row in comb["combined_table"]), comb["combined_table"][:1])
        w = comb["waterfall"]
        check("the waterfall has one label per value",
              len(w["labels"]) == len(w["values"]) == len(w["measure"]),
              (len(w["labels"]), len(w["values"])))
        check("and ends on a total", w["measure"][-1] == "total", w["measure"][-5:])
        check("the total equals the sum of the parts",
              abs(w["values"][-1] - sum(w["values"][:-1])) < 1e-6,
              (w["values"][-1], sum(w["values"][:-1])))
        for metric in ("net_impactable_sales", "positive_contributions",
                       "negative_contributions", "stage2_subchannels"):
            check(f"metrics carry {metric}", metric in comb["metrics"], sorted(comb["metrics"]))

        print("\n7. bad configuration fails loudly")
        r = c.post("/api/modelling/run-regression", json={**BASE_BODY, "selected_channels": ["nope"]})
        check("an unknown channel is a 400, not a silent drop", r.status_code == 400, r.status_code)
        r = c.post("/api/modelling/run-regression", json={**BASE_BODY, "geo_column": "nope"})
        check("an unknown geography column is a 400", r.status_code == 400, r.status_code)

        return 1 if FAIL else 0
    finally:
        print("=" * 58)
        print(f"PASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
        for f in FAIL:
            print("   FAILED: " + f)


if __name__ == "__main__":
    raise SystemExit(main())
