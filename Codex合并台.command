#!/bin/zsh
set -e

APP_DIR="${0:A:h}"
cd "$APP_DIR"

/Library/Frameworks/Python.framework/Versions/3.12/bin/python3 server.py --open
