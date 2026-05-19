import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronExecutable =
  process.platform === "win32"
    ? path.join(root, "node_modules", "electron", "dist", "electron.exe")
    : path.join(root, "node_modules", ".bin", "electron");

const child = spawn(electronExecutable, ["."], {
  cwd: root,
  stdio: "ignore",
  windowsHide: true
});

const exitPromise = new Promise((resolve) => {
  child.once("exit", (code) => {
    resolve({ code: code ?? 0 });
  });
});

const errorPromise = new Promise((_, reject) => {
  child.once("error", reject);
});

const earlyExit = await Promise.race([
  exitPromise,
  errorPromise,
  new Promise((resolve) => setTimeout(() => resolve(undefined), 6000))
]);

if (earlyExit) {
  throw new Error(`Electron exited early with code ${earlyExit.code}`);
}

child.kill();
await Promise.race([
  exitPromise,
  new Promise((resolve) => setTimeout(resolve, 2000))
]);
console.log("Electron smoke launch passed");
