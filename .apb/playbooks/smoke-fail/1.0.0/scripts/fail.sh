#!/bin/sh
# Factory failure smoke: prints one fixed line and exits 1, so the run reports
# a node failure. No model, no writes.
printf '%s\n' '{"smoke":"fail"}'
exit 1
