/**
 * The project app a capture flow's start command runs (`node stand-in-app.ts <port> <pidFile>`):
 * it writes its pid to `<pidFile>`, so the e2e can tell its process group was stopped, and serves
 * one page on 127.0.0.1:`<port>` until it is stopped.
 */
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const [port, pidFile] = process.argv.slice(2);
if (port === undefined || pidFile === undefined) {
  throw new Error("Usage: stand-in-app.ts <port> <pidFile>");
}
writeFileSync(pidFile, String(process.pid));
createServer((_request, response) => {
  response.setHeader("content-type", "text/html");
  response.end("<!doctype html><title>Export</title><h1>Export</h1>");
}).listen(Number(port), "127.0.0.1");
