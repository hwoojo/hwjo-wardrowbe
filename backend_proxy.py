import socket
import subprocess
import threading

LOCAL_HOST = "127.0.0.2"
LOCAL_PORT = 8856
TARGET_HOST = "backend"
TARGET_PORT = 8000

def bridge(client_sock):
    js = (
        "const net=require('net');"
        "const s=net.connect({port:%d,host:'%s',allowHalfOpen:true});"
        "process.stdin.pipe(s);s.pipe(process.stdout);"
        "s.on('end',()=>process.exit(0));"
        "s.on('error',()=>process.exit(1));"
    ) % (TARGET_PORT, TARGET_HOST)

    proc = subprocess.Popen(
        ["docker", "exec", "-i", "wardrobe-frontend", "node", "-e", js],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        bufsize=0,
    )

    def to_container():
        try:
            while True:
                data = client_sock.recv(65536)
                if not data:
                    break
                proc.stdin.write(data)
                proc.stdin.flush()
        except Exception:
            pass
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass

    def from_container():
        try:
            while True:
                data = proc.stdout.read(65536)
                if not data:
                    break
                client_sock.sendall(data)
        except Exception:
            pass
        finally:
            try:
                client_sock.close()
            except Exception:
                pass

    threading.Thread(target=to_container, daemon=True).start()
    threading.Thread(target=from_container, daemon=True).start()

def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((LOCAL_HOST, LOCAL_PORT))
    srv.listen(128)
    print("Listening on %s:%d -> wardrobe-frontend:%d" % (LOCAL_HOST, LOCAL_PORT, TARGET_PORT))
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=bridge, args=(conn,), daemon=True).start()

if __name__ == "__main__":
    main()