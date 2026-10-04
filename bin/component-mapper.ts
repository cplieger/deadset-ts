import { mapperConnection } from "./mapper-connection.ts";

const connection = mapperConnection((bytes) => process.stdout.write(bytes));
process.stdin.on("data", (chunk: Buffer) => {
  connection.receive(chunk);
});
