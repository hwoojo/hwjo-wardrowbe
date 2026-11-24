#!/usr/bin/env bash

case "$1" in
    start)
        nohup python3 -u frontend_proxy.py > frontend_proxy.log 2>&1 &
        nohup python3 -u backend_proxy.py > backend_proxy.log 2>&1 &
        echo "Proxies started"
        ;;
    stop)
        pkill -f '[^/ ]*_proxy\.py' || true
        echo "Proxies stopped"
        ;;
    restart)
        "$0" stop
        "$0" start
        ;;
    status)
        pgrep -af '[^/ ]*_proxy\.py' || echo "No proxies running"
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status}"
        ;;
esac
