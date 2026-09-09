"""Launcher for the Beacon API. Use this instead of the bare `uvicorn` command.

On Windows, uvicorn builds its event loop *before* it imports the app, so the
policy switch in app/__init__.py lands too late and every database call fails
with "Psycopg cannot use the 'ProactorEventLoop'". Setting the policy here -
before uvicorn starts - is what makes async psycopg work.

    python run.py                 # http://127.0.0.1:8100
    python run.py --port 9000
    python run.py --no-reload
"""

import argparse
import asyncio
import sys

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

import uvicorn  # noqa: E402  - must follow the policy switch


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Beacon API.")
    parser.add_argument("--host", default="127.0.0.1")
    # 8100, not 8000: something else is commonly already bound to 8000 here.
    parser.add_argument("--port", type=int, default=8100)
    parser.add_argument("--no-reload", action="store_true")
    args = parser.parse_args()

    uvicorn.run(
        "app.main:app",
        host=args.host,
        port=args.port,
        reload=not args.no_reload,
        log_level="info",
    )


if __name__ == "__main__":
    main()
