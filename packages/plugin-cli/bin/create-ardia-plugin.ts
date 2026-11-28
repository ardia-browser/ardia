import { runAsProcess } from "../src/entry";

const argv = process.argv.slice(2);
runAsProcess(argv.includes("-h") || argv.includes("--help") ? ["--help"] : ["init", ...argv], "create-ardia-plugin", process.env);
