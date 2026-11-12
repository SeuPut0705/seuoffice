// Runs the wasm32-wasip1 build of limit_wasm.rs under Node's WASI:
// node limit_wasm.mjs <module.wasm> [characters]
import { readFile } from "node:fs/promises";
import { WASI } from "node:wasi";

const [path, length = "25000000"] = process.argv.slice(2);
const wasi = new WASI({ version: "preview1", args: ["limit_wasm", length] });
const module = await WebAssembly.compile(await readFile(path));
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
process.exitCode = wasi.start(instance);
