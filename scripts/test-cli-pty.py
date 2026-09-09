#!/usr/bin/env python3
"""PTY test for the bkup CLI menu — drives it like a real terminal."""
import os, pty, time, select, sys, subprocess

APP = "/home/z/my-project"

def run_cli(inputs, timeout=15):
    """Spawn cli.sh in a pty, send inputs sequentially, collect output."""
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.chdir(APP)
        os.execv("/bin/bash", ["/bin/bash", f"{APP}/cli.sh"])
        os._exit(1)

    out = b""
    start = time.time()
    inputs = list(inputs)

    while time.time() - start < timeout:
        r, _, _ = select.select([fd], [], [], 0.4)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            out += data
        # crude prompt detection: send next input after seeing menu prompt
        if inputs and (b"bkup >" in out or b"Press Enter" in out or b"password" in out.lower() or b"port " in out.lower()):
            time.sleep(0.25)
            os.write(fd, (inputs.pop(0) + "\n").encode())
            time.sleep(0.2)
    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)
    return out.decode("utf8", "replace")

if __name__ == "__main__":
    scenario = sys.argv[1] if len(sys.argv) > 1 else "status"
    if scenario == "status":
        text = run_cli(["1", ""])
    elif scenario == "url":
        text = run_cli(["2", ""])
    elif scenario == "menu":
        text = run_cli([], timeout=4)
    elif scenario == "noninteractive":
        r = subprocess.run(["bash", f"{APP}/cli.sh"], capture_output=True, text=True, timeout=20)
        text = r.stdout
    print(text[-3500:])
