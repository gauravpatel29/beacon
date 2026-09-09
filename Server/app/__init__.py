"""Beacon backend.

Windows note: psycopg's async driver cannot run on the ProactorEventLoop that
Python selects by default on win32, so the policy is switched here - the
earliest point shared by the API, the scripts and the Streamlit tester. Without
it every database call fails with:

    Psycopg cannot use the 'ProactorEventLoop' to run in async mode
"""

import asyncio
import sys

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
