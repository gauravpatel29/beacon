import sys
sys.path.insert(0, r"C:\Users\GauravPatel\procDNA-proj\Beacon branch\Aashika\beacon\python")
import httpx

import os
B = os.environ.get("BEACON_BASE_URL", "http://127.0.0.1:8000")
FOREIGN = "http://192.168.1.50:3000"   # stands in for the dev's machine
c = httpx.Client(timeout=30.0)

def show(label, r):
    ao = r.headers.get("access-control-allow-origin", "(none)")
    ac = r.headers.get("access-control-allow-credentials", "(none)")
    bad = ao == "*" and ac == "true"
    print(f"  {label:34s} {r.status_code}  allow-origin={ao:28s} creds={ac}"
          + ("   <-- INVALID COMBO" if bad else ""))
    return not bad

ok = True
ok &= show("preflight OPTIONS (foreign)", c.request("OPTIONS", f"{B}/v2/workflows/x/files",
    headers={"Origin": FOREIGN, "Access-Control-Request-Method": "POST",
             "Access-Control-Request-Headers": "content-type"}))
ok &= show("GET  /v1/workflows (foreign)", c.get(f"{B}/v1/workflows", headers={"Origin": FOREIGN}))
ok &= show("GET  /health (foreign)", c.get(f"{B}/health", headers={"Origin": FOREIGN}))
ok &= show("GET  /health (localhost:3000)", c.get(f"{B}/health",
    headers={"Origin": "http://localhost:3000"}))

r = c.post(f"{B}/v1/workflows", headers={"Origin": FOREIGN},
           json={"workflow_name": "cors probe", "tag": "cors"})
ok &= show("POST /v1/workflows (foreign)", r)
if r.status_code == 201:
    c.delete(f"{B}/v1/workflows/{r.json()['id']}")
    print("  (probe workflow deleted)")

print("\n  " + ("PASS  origin echoed on every response" if ok
                else "FAIL  '*' returned with credentials"))
raise SystemExit(0 if ok else 1)
