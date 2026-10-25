"""Windows-only manual lifecycle probe; never launches or stops user sessions.

Run in a terminal with CLAUDE_CONFIG_DIR pointing at a disposable config:
  python scripts/probe-claude-job.py -- claude --bg --exec "powershell -NoProfile -Command Start-Sleep 120"
  python scripts/probe-claude-job.py -- claude attach <test-session-id>

Terminate this helper's PID to simulate Project Desk exiting. Its Job Object
kills attached children; a correctly detached Claude supervisor must survive.
Use only synthetic sessions. This is not a production launcher.
"""

import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import subprocess
import sys


def main():
    if sys.platform != "win32":
        raise SystemExit("This probe requires Windows.")
    config = os.environ.get("CLAUDE_CONFIG_DIR")
    if not config or Path(config).resolve() == (Path.home() / ".claude").resolve():
        raise SystemExit("Set CLAUDE_CONFIG_DIR to a disposable test directory first.")
    args = sys.argv[1:]
    if args[:1] == ["--"]:
        args = args[1:]
    if not args:
        raise SystemExit("Supply a test command after --.")

    class BasicLimits(ctypes.Structure):
        _fields_ = [
            ("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
            ("flags", wintypes.DWORD), ("min_ws", ctypes.c_size_t),
            ("max_ws", ctypes.c_size_t), ("active", wintypes.DWORD),
            ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD),
            ("scheduling", wintypes.DWORD),
        ]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in
                    ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [("basic", BasicLimits), ("io", IoCounters)] + [
            (name, ctypes.c_size_t) for name in
            ("process_memory", "job_memory", "peak_process_memory", "peak_job_memory")]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    limits = ExtendedLimits()
    # Match Project Desk: KILL_ON_JOB_CLOSE | BREAKAWAY_OK, no silent breakaway.
    limits.basic.flags = 0x2000 | 0x800
    if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        raise ctypes.WinError(ctypes.get_last_error())
    if not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
        raise ctypes.WinError(ctypes.get_last_error())
    # Keep the handle until process exit, as the application does. Closing it
    # here would kill this helper too. Preserve the caller's console for attach.
    print(f"Disposable terminal host PID: {os.getpid()}", flush=True)
    return subprocess.run(args, shell=False).returncode


if __name__ == "__main__":
    sys.exit(main())
