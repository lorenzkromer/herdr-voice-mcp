#!/bin/sh
# Prints a fresh 64-hex-char token for auth.token / AGENCY_TOKEN or a read_api token.
openssl rand -hex 32
