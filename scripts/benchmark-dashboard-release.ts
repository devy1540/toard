import { spawn } from "node:child_process";
import { assertNonProductionBenchmarkEnvironment } from "./benchmark-dashboard-http-lib";
import { releaseBenchmarkMain, type ReleaseBenchmarkDependencies } from "./benchmark-dashboard-release-lib";

const PROJECT = `toard-benchmark-http-${process.pid}`;
const dependencies: ReleaseBenchmarkDependencies = {
  spawn: (command, args, options) => spawn(command, args, options),
  exit: (code) => process.exit(code),
  onSignal: (signal, listener) => { process.on(signal, listener); },
  offSignal: (signal, listener) => { process.off(signal, listener); },
  log: (message) => { console.log(message); },
  reportError: (error) => { console.error(error); },
};

try {
  assertNonProductionBenchmarkEnvironment(process.env);
  void releaseBenchmarkMain(dependencies, PROJECT);
} catch (error) {
  dependencies.reportError(error);
  dependencies.exit(1);
}
