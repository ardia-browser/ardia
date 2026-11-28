import { runAsProcess } from "../src/entry";

runAsProcess(process.argv.slice(2), "ardia-plugin", process.env);
