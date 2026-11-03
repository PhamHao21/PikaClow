import { spawn, type ChildProcess } from "node:child_process";

/**
 * One long-lived Windows PowerShell process shared by everything that needs it.
 *
 * Starting powershell.exe costs ~0.4s and a burst of CPU, and libraries that spawn a
 * fresh one per query (then poll every second) can pile up processes until the machine
 * stalls. Here we start it once and run small .NET-based scripts that answer in ~30ms.
 * Requests are queued, never overlap, and time out; a stuck session is killed and
 * replaced on the next request. Scripts must be single-line and never contain user input.
 */
class PowerShellSession {
  private proc: ChildProcess | null = null;
  private buf = "";
  private queue: { script: string; timeout: number; resolve: (s: string) => void; reject: (e: Error) => void }[] = [];
  private current: (typeof this.queue)[number] | null = null;
  private timer: NodeJS.Timeout | null = null;
  private seq = 0;
  private marker = "";

  /** PID of the helper process while it is running (shown in the dashboard's self-usage). */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  run(script: string, timeout = 8000): Promise<string> {
    return new Promise((resolve, reject) => {
      this.queue.push({ script, timeout, resolve, reject });
      this.next();
    });
  }

  close(): void {
    const p = this.proc;
    this.proc = null;
    if (p) {
      try {
        p.stdin?.end();
        p.kill();
      } catch {
        // already exited
      }
    }
  }

  private start(): ChildProcess {
    const p = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    p.stdout?.setEncoding("utf8");
    p.stdout?.on("data", (d: string) => this.onData(d));
    p.stderr?.on("data", () => {});
    p.stdin?.on("error", () => {});
    p.on("error", (e) => this.fail(e));
    p.on("exit", () => {
      if (this.proc === p) {
        this.proc = null;
        this.fail(new Error("PowerShell exited"));
      }
    });
    // Do not keep Node alive just for this helper.
    p.unref();
    (p.stdout as unknown as { unref?: () => void })?.unref?.();
    (p.stderr as unknown as { unref?: () => void })?.unref?.();
    (p.stdin as unknown as { unref?: () => void })?.unref?.();
    p.stdin?.write(
      "$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8\n",
    );
    return p;
  }

  private next(): void {
    if (this.current || this.queue.length === 0) return;
    const job = this.queue.shift()!;
    this.current = job;
    if (!this.proc) this.proc = this.start();
    this.seq++;
    this.marker = `<<PKC-${process.pid}-${this.seq}>>`;
    this.buf = "";
    const line = `try { ${job.script} } catch { [Console]::Out.Write('') }; [Console]::Out.WriteLine(''); [Console]::Out.WriteLine('${this.marker}')\n`;
    this.timer = setTimeout(() => {
      this.close();
      this.fail(new Error("PowerShell query timed out"));
    }, job.timeout);
    this.proc.stdin?.write(line);
  }

  private onData(d: string): void {
    this.buf += d;
    const i = this.buf.indexOf(this.marker);
    if (i < 0 || !this.current) return;
    const out = this.buf.slice(0, i).replace(/\r/g, "").replace(/\n+$/, "");
    this.buf = "";
    const job = this.current;
    this.current = null;
    if (this.timer) clearTimeout(this.timer);
    job.resolve(out);
    this.next();
  }

  private fail(e: Error): void {
    if (this.timer) clearTimeout(this.timer);
    const job = this.current;
    this.current = null;
    job?.reject(e);
    this.next();
  }
}

export const pwsh = new PowerShellSession();
process.on("exit", () => pwsh.close());
