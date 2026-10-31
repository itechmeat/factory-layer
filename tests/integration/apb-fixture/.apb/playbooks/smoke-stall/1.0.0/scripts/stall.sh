#!/bin/sh
# Factory stall smoke: sleeps for an hour so the caller can exercise its stop
# path. No model, no writes.
exec sleep 3600
