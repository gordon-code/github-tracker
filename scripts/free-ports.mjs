// Usage: node scripts/free-ports.mjs [count]
// Prints `count` (default 1) distinct free TCP ports, space-separated. All sockets stay open
// until every port is allocated, so the ports cannot collide with each other. Exits non-zero
// on a bad count, so a failed lookup stops the calling script instead of leaving it portless.
import { createServer } from "node:net";

const count = Number(process.argv[2] ?? "1");
if (!Number.isInteger(count) || count < 1) {
  console.error(`free-ports: invalid count "${process.argv[2]}"`);
  process.exit(1);
}
const servers = [];
for (let i = 0; i < count; i++) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, resolve);
  });
  servers.push(server);
}
process.stdout.write(servers.map((s) => s.address().port).join(" "));
await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
