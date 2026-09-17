"""Diagnose 'CERTIFICATE_VERIFY_FAILED' when talking to Neon Object Storage.

    python/.venv/Scripts/python.exe python/scripts/check_tls.py

Uploads reach the database fine and then fail only on the bucket write, with:

    botocore.exceptions.SSLError: SSL validation failed for
    https://<project>.storage.<region>.aws.neon.tech/...
    [SSL: CERTIFICATE_VERIFY_FAILED] unable to get local issuer certificate

That is never a bug in this repo - the same code works elsewhere. It means
Python on this machine cannot build a trust chain to the storage endpoint's
certificate. Two causes account for almost every case, and they need different
fixes, so this script tells you which one you have:

  1. A TLS-inspecting proxy (Zscaler, Netskope, Blue Coat, many corporate VPNs)
     re-signs traffic with a private root CA. Browsers trust it because Windows
     trusts it; Python does not, because Python ships its own CA bundle and
     ignores the Windows store.

  2. certifi is missing or too old to carry the endpoint's root.

It prints the certificate's real issuer, so case 1 is unmistakable.
"""

import os
import socket
import ssl
import sys
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def heading(text):
    print(f"\n{text}\n" + "-" * len(text))


def _issuer_of(der: bytes) -> str:
    """Issuer string for a DER certificate, without adding a dependency.

    `cryptography` would be tidier but is not required by this project, and a
    diagnostic that first asks you to install something is a poor diagnostic.
    CPython's own certificate decoder works on a PEM file, so the DER is
    written to a temporary one.
    """
    import tempfile

    pem = ssl.DER_cert_to_PEM_cert(der)
    path = None
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False) as fh:
            fh.write(pem)
            path = fh.name
        # Private, but present in every CPython 3.x and stable in shape.
        decoded = ssl._ssl._test_decode_cert(path)     # noqa: SLF001
        parts = [v for rdn in decoded.get("issuer", ()) for (_k, v) in rdn]
        return ", ".join(parts) if parts else "(unknown)"
    except Exception:                                  # noqa: BLE001
        try:
            from cryptography import x509             # optional, if present
            return x509.load_der_x509_certificate(der).issuer.rfc4514_string()
        except Exception:                              # noqa: BLE001
            return "(could not decode)"
    finally:
        if path:
            try:
                os.unlink(path)
            except OSError:
                pass


def main() -> int:
    heading("1. environment")
    print(f"  python      {sys.version.split()[0]}")
    try:
        import certifi
        print(f"  certifi     {certifi.__version__}")
        print(f"  bundle      {certifi.where()}")
    except ImportError:
        certifi = None
        print("  certifi     NOT INSTALLED")

    for var in ("AWS_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "SSL_CERT_FILE",
                "HTTPS_PROXY", "HTTP_PROXY"):
        value = os.environ.get(var)
        print(f"  {var:<19} {value if value else '(unset)'}")

    heading("2. endpoint")
    try:
        from core.config import get_settings
    except Exception as exc:                       # noqa: BLE001
        print(f"  could not load settings: {exc}")
        return 2

    endpoint = get_settings().aws_endpoint_url_s3
    if not endpoint:
        print("  AWS_ENDPOINT_URL_S3 is not set in python/.env - nothing to test.")
        return 2

    host = urlparse(endpoint).hostname
    port = urlparse(endpoint).port or 443
    print(f"  host        {host}:{port}")

    heading("3. TLS handshake with Python's default trust")
    verified = False
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((host, port), timeout=15) as sock:
            with ctx.wrap_socket(sock, server_hostname=host) as tls:
                cert = tls.getpeercert()
        verified = True
        print("  OK - the certificate verifies. TLS is not your problem.")
    except ssl.SSLCertVerificationError as exc:
        print(f"  FAILED - {exc.verify_message or exc}")
    except Exception as exc:                       # noqa: BLE001
        print(f"  FAILED - {type(exc).__name__}: {exc}")
        print("  (a connection error here is a firewall/DNS issue, not a cert issue)")
        return 1

    heading("4. who actually issued the certificate")
    # Fetched WITHOUT verification purely to read the issuer. This proves
    # whether something is re-signing the connection; it is a diagnostic and
    # nothing is sent over this socket.
    try:
        raw_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        raw_ctx.check_hostname = False
        raw_ctx.verify_mode = ssl.CERT_NONE
        with socket.create_connection((host, port), timeout=15) as sock:
            with raw_ctx.wrap_socket(sock, server_hostname=host) as tls:
                der = tls.getpeercert(binary_form=True)
        issuer = _issuer_of(der)
        print(f"  issuer      {issuer}")
        intercepted = any(
            name in issuer.lower()
            for name in ("zscaler", "netskope", "bluecoat", "blue coat", "forcepoint",
                         "fortinet", "sophos", "mcafee", "palo alto", "proxy")
        )
    except Exception as exc:                       # noqa: BLE001
        print(f"  could not read the certificate: {exc}")
        intercepted = False

    heading("5. what to do")
    if verified:
        print("  Nothing. If uploads still fail, the cause is elsewhere.")
        return 0

    if intercepted:
        print("  A TLS-inspecting proxy is re-signing this connection (see the")
        print("  issuer above). Python needs to trust your organisation's root CA.")
    else:
        print("  Python cannot build a chain to this certificate's root.")

    print("""
  Pick ONE of these:

  a) Make Python use the Windows certificate store, where your corporate root
     already lives (this is why your browser works). Simplest on a managed
     Windows laptop:

         python/.venv/Scripts/pip.exe install pip-system-certs

     Then restart uvicorn. No code or .env change.

  b) Point botocore at a PEM containing your root CA. Export it from Windows
     (certmgr.msc -> Trusted Root Certification Authorities -> your corporate
     root -> Export -> Base-64 encoded X.509 .cer), then add to python/.env:

         AWS_CA_BUNDLE=C:\\path\\to\\corporate-root.pem

     botocore reads AWS_CA_BUNDLE on its own; nothing else needs changing.

  c) If there is no proxy and certifi is simply old:

         python/.venv/Scripts/pip.exe install -U certifi

  Do NOT disable certificate verification to get past this. It would send the
  storage credentials over a connection nobody has authenticated.
""")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
