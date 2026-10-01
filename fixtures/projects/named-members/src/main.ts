// The entry. The server's members are reached by literal keys, one by a computed key
// and one through a local Reflect.

import { Page, Server } from "./page.ts";
import { shadowed } from "./shadow.ts";

const page = new Page();
const server = new Server();
const computed = ["re", "start"].join("");

server["refresh"]();
Reflect.get(server, "reload");
Reflect.get(server, "token");
Reflect.has(server, "hidden");
Reflect.get(server, computed);

if (page === undefined || shadowed(server) !== undefined) {
  throw new Error("unexpected");
}
