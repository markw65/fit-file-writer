import * as esbuild from "esbuild";
import * as child_process from "node:child_process";
import * as fs from "node:fs/promises";
import * as readline from "node:readline";

const buildDir = "build";
const releaseBuild = process.argv.includes("--release");
const sourcemap = !releaseBuild;

let buildActive = 0;
let tsBuildActive = 0;
function activate(ts) {
  if (ts) {
    if (tsBuildActive !== 0) {
      console.error(`tsBuildActive expected to be 0 but got ${tsBuildActive}`);
    }
    tsBuildActive = 1;
  } else {
    buildActive++;
  }
  const state = buildActive + tsBuildActive;
  if (state === 1) {
    console.log(`${new Date().toLocaleString()} - Build active (${state})`);
  }
}

function deactivate(ts) {
  setTimeout(() => {
    if (ts) {
      if (tsBuildActive !== 1) {
        console.error(
          `tsBuildActive expected to be 1 but got ${tsBuildActive}`
        );
      }
      tsBuildActive = 0;
    } else {
      buildActive--;
    }
    const state = buildActive + tsBuildActive;
    if (!state) {
      console.log(`${new Date().toLocaleString()} - Build inactive (${state})`);
    }
  }, 500);
}

async function report(diagnostics, kind) {
  diagnostics.forEach(
    (diagnostic) =>
      diagnostic.location?.column != null && diagnostic.location.column++
  );

  esbuild
    .formatMessages(diagnostics, {
      kind,
      color: true,
      terminalWidth: 100,
    })
    .then((messages) => messages.forEach((error) => console.log(error)));
}

const startEndPlugin = {
  name: "startEnd",
  setup(build) {
    build.onStart(() => {
      activate(false);
      console.log(`${new Date().toLocaleString()} - ESBuild start`);
    });
    build.onEnd(async (result) => {
      try {
        await report(result.errors, "error");
        await report(result.warnings, "warning");
      } catch (e) {
        console.log(e);
      }

      Object.entries(result.metafile?.outputs ?? {}).forEach(
        ([key, value]) =>
          key.endsWith(".js") &&
          value.bytes > 10000 &&
          console.log(`${key}: ${value.bytes >>> 10}kb`)
      );

      console.log("");
      console.log(`${new Date().toLocaleString()} - ESBuild end`);
      deactivate(false);
    });
  },
};

function spawnByLine(command, args, lineHandler, options) {
  return new Promise((resolve, reject) => {
    const proc = child_process.spawn(command, args, {
      ...(options || {}),
      shell: false,
    });
    const rl = readline.createInterface({
      input: proc.stdout,
    });
    const rle = readline.createInterface({
      input: proc.stderr,
    });
    proc.on("error", reject);
    proc.stderr.on("data", (data) => console.error(data.toString()));
    rl.on("line", lineHandler);
    rle.on("line", lineHandler);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      reject(new Error(`Process ${command} failed with code ${code}`));
    });
  });
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const tscCommand = ["tsc", "--build"];
const logger = (line) => {
  // tsc in watch mode does ESC-c to clear the screen
  // eslint-disable-next-line no-control-regex
  line = line.replace(/[\x1b]c/g, "");
  if (
    /Starting compilation in watch mode|File change detected\. Starting incremental compilation/.test(
      line
    )
  ) {
    activate(true);
  }
  console.log(line);
  if (/Found \d+ errors?\. Watching for file changes/.test(line)) {
    deactivate(true);
  }
};

fs.readFile("package.json", "utf-8").then(async (pkg) => {
  const { version } = JSON.parse(pkg);
  const define = {
    DEBUG: JSON.stringify(!releaseBuild),
    VERSION: JSON.stringify(version),
  };

  const mainConfig = {
    entryPoints: [
      "src/fit-encode.ts",
      "tools/generate-fit-tables.ts",
      "test/test.ts",
    ],
    bundle: true,
    platform: "node",
    outdir: `${buildDir}`,
    outExtension: { ".js": ".js" },
    target: "node16.4",
    format: "cjs",
    plugins: [startEndPlugin],
    sourcemap,
    sourcesContent: false,
    metafile: true,
    define,
    minify: releaseBuild,
    logLevel: "silent",
    treeShaking: true,
  };
  if (process.argv.includes("--watch")) {
    const mainCtx = await esbuild.context(mainConfig);
    await Promise.all([
      mainCtx.watch(),
      spawnByLine(npx, tscCommand.concat(["--watch"]), logger),
    ]);
  } else {
    activate(true);
    if (releaseBuild) {
      await fs.rm("build", { force: true, recursive: true });
    }
    await Promise.all([
      esbuild.build(mainConfig),
      spawnByLine(npx, tscCommand, logger)
        .catch(() => null)
        .then(() => {
          console.log(`${new Date().toLocaleString()} - tsc end`);
        })
        .then(() => deactivate(true)),
    ]).catch((e) => console.log(e));
  }
});
