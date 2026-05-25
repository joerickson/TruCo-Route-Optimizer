"""Standalone HTTP server entry for the TruCo solver (Coolify / any long-lived host).

On Vercel the solver was invoked as a @vercel/python function — the platform
instantiated the `handler` class per request. Off Vercel we need to provide the
server ourselves. This entry runs the SAME `handler` class (do_POST solve +
do_GET health) from index.py under a stdlib http.server.HTTPServer.

We do not touch the handler logic, solver_logic.py, or distance_matrix.py.

Importing `index` here executes index.py's module-level
`sys.path.insert(0, <api dir>)`, which is what lets `solver_logic` and
`distance_matrix` resolve as sibling modules — so that behavior is preserved.
"""
from __future__ import annotations

import os
from http.server import HTTPServer

from index import handler


def main() -> None:
    port = int(os.environ.get("PORT", "8000"))
    server = HTTPServer(("0.0.0.0", port), handler)
    print(f"truco-solver listening on 0.0.0.0:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
