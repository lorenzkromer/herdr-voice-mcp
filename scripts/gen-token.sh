#!/bin/sh
# Prints a fresh 64-hex-char token for auth.token / AGENCY_TOKEN.
openssl rand -hex 32
