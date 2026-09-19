"""Serve the ScalePad folder over HTTPS for a one-time iPad installation."""

from __future__ import annotations

import argparse
import functools
import http.server
import ssl
from pathlib import Path


class ReusableHTTPServer(http.server.ThreadingHTTPServer):
    allow_reuse_address = True


def main() -> None:
    parser = argparse.ArgumentParser(description="ScalePad local HTTPS server")
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8443)
    parser.add_argument("--cert", required=True, type=Path)
    parser.add_argument("--key", required=True, type=Path)
    args = parser.parse_args()

    root = Path(__file__).resolve().parent
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
    server = ReusableHTTPServer((args.bind, args.port), handler)

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile=args.cert, keyfile=args.key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    print(f"ScalePad HTTPS server running at https://127.0.0.1:{args.port}/")
    print("Keep this window open while installing the app on iPad.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping ScalePad HTTPS server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
