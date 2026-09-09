#!/usr/bin/env python3
"""PTY test: open menu, run option 1 (status), verify dual-panel display."""
import os, pty, time, select, sys

APP = "/home/z/my-project"

pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.chdir(APP)
    os.execv("/bin/bash", ["/bin/bash", f"{APP}/cli.sh"])
    os._exit(1)

out = b""
start = time.time()
sent1 = False
while time.time() - start < 20:
    r, _, _ = select.select([fd], [], [], 0.4)
    if r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        out += data
        if b"0)  Exit" in out and not sent1:
            os.write(fd, b"1\n")
            sent1 = True
    if sent1 and b"Version" in out:
        time.sleep(0.5)
        break

os.write(fd, b"\n")
text = out.decode("utf-8", "replace")
# show everything after the status header
idx = text.find("Service")
print(text[idx:idx+1600] if idx >= 0 else text[-1600:])
