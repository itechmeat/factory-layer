#!/bin/sh
# Factory smoke: prints one fixed JSON line and exits 0. No model, no writes.
printf '%s\n' '{"smoke":"ok"}'
