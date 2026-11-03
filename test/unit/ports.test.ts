import { test } from "node:test";
import assert from "node:assert/strict";
import { detectApp, detectProject, isSystemProcess, parseLsof, parseNetstat, parseSs } from "../../src/core/ports.js";

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1364
  TCP    0.0.0.0:5173           0.0.0.0:0              ABHÖREN         9001
  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       4242
  TCP    192.168.1.73:49246     20.42.65.84:443        ESTABLISHED     8420
  TCP    [::]:135               [::]:0                 LISTENING       1364
  TCP    [::1]:42050            [::]:0                 LISTENING       13780
  TCP    [fe80::1%12]:8080      [::]:0                 LISTENING       77
  UDP    0.0.0.0:5353           *:*                                    2000
`;

test("parseNetstat finds listening TCP sockets in any Windows language", () => {
  const s = parseNetstat(NETSTAT);
  const ports = s.map((x) => `${x.address}:${x.port}/${x.pid}`);
  assert.deepEqual(ports, ["0.0.0.0:135/1364", "0.0.0.0:5173/9001", "127.0.0.1:3000/4242", ":::135/1364", "::1:42050/13780", "fe80::1:8080/77"]);
  assert.ok(!s.some((x) => x.port === 49246), "outgoing connections are not listening ports");
});

test("parseNetstat includes UDP only on request", () => {
  assert.equal(parseNetstat(NETSTAT).filter((x) => x.protocol === "udp").length, 0);
  assert.deepEqual(parseNetstat(NETSTAT, true).filter((x) => x.protocol === "udp").map((x) => x.port), [5353]);
});

test("parseLsof reads field output", () => {
  const out = "p501\ncnode\nPTCP\nn*:3000\nn127.0.0.1:9229\np88\ncpostgres\nPTCP\nn[::1]:5432\n";
  assert.deepEqual(
    parseLsof(out).map((x) => [x.pid, x.process, x.address, x.port]),
    [
      [501, "node", "0.0.0.0", 3000],
      [501, "node", "127.0.0.1", 9229],
      [88, "postgres", "::1", 5432],
    ],
  );
});

test("parseSs reads ss -ltnpH output", () => {
  const out = 'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=1234,fd=21))\nLISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*\n';
  assert.deepEqual(
    parseSs(out).map((x) => [x.port, x.pid, x.process]),
    [
      [3000, 1234, "node"],
      [53, 0, ""],
    ],
  );
});

test("detectApp recognizes dev servers, databases and well-known ports", () => {
  assert.equal(detectApp("node.exe", '"C:\\Program Files\\nodejs\\node.exe" D:\\app\\node_modules\\vite\\bin\\vite.js --port 5173', 5173), "Vite");
  assert.equal(detectApp("node", "node /home/me/app/node_modules/.bin/next dev", 3000), "Next.js");
  assert.equal(detectApp("python.exe", "python manage.py runserver", 8000), "Django");
  assert.equal(detectApp("postgres.exe", "", 5432), "PostgreSQL");
  assert.equal(detectApp("node.exe", "node server.js", 4000), "Node.js app");
  assert.equal(detectApp("mystery.exe", "", 27017), "MongoDB");
  assert.equal(detectApp("mystery.exe", "", 40000), "");
});

test("detectProject extracts the project folder from a command line", () => {
  assert.equal(detectProject('"C:\\Program Files\\nodejs\\node.exe" D:\\work\\shop\\node_modules\\vite\\bin\\vite.js --host'), "D:\\work\\shop");
  assert.equal(detectProject("node /home/me/api/node_modules/.bin/nodemon src/index.js"), "/home/me/api");
  assert.equal(detectProject("node C:\\code\\bot\\index.js"), "C:\\code\\bot");
  assert.equal(detectProject("svchost.exe -k RPCSS"), "");
});

test("system processes are recognized", () => {
  assert.ok(isSystemProcess(4, "System"));
  assert.ok(isSystemProcess(1364, "svchost.exe"));
  assert.ok(!isSystemProcess(4242, "node.exe"));
});
