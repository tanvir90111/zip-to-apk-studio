// Usage: node scripts/build.mjs project.zip
// Detects an Android Gradle project or a plain web project (index.html) and builds a debug APK.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const zip = process.argv[2];
const { APP_NAME = "My App", APP_ID = "com.example.app" } = process.env;
const work = path.resolve("work");
const out = path.resolve("out");
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(out, { recursive: true });

function fail(msg, log = "") {
  fs.writeFileSync(path.join(out, "error.txt"), `${msg}\n${log.split("\n").slice(-12).join("\n")}`);
  console.error(msg);
  process.exit(1);
}

function run(cmd, args, cwd = work) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  const log = `${r.stdout || ""}${r.stderr || ""}`;
  console.log(log.split("\n").slice(-200).join("\n"));
  if (r.status !== 0) fail(`Step failed: ${cmd} ${args[0] || ""}`, log);
}

const visible = (dir) => fs.readdirSync(dir).filter((n) => n !== "__MACOSX" && !n.startsWith("."));

function findRoot(dir) {
  for (let i = 0; i < 3; i++) {
    const items = visible(dir);
    if (items.length === 1 && fs.statSync(path.join(dir, items[0])).isDirectory()) dir = path.join(dir, items[0]);
    else break;
  }
  return dir;
}

function findFile(dir, test, depth = 3) {
  if (depth < 0) return null;
  for (const n of visible(dir)) {
    const f = path.join(dir, n);
    if (fs.statSync(f).isDirectory() && n !== "node_modules") {
      const hit = findFile(f, test, depth - 1);
      if (hit) return hit;
    } else if (test(n)) return f;
  }
  return null;
}

function collectApks(dir, acc = []) {
  for (const n of fs.readdirSync(dir)) {
    const f = path.join(dir, n);
    const st = fs.lstatSync(f);
    if (st.isDirectory()) collectApks(f, acc);
    else if (n.endsWith(".apk") && f.includes(`${path.sep}debug${path.sep}`)) acc.push({ f, size: st.size });
  }
  return acc;
}

function gradleBuild(dir) {
  const wrapper = path.join(dir, "gradlew");
  let cmd = "gradle";
  if (fs.existsSync(wrapper)) {
    fs.chmodSync(wrapper, 0o755);
    cmd = "./gradlew";
  }
  run(cmd, ["assembleDebug", "--no-daemon", "--console=plain"], dir);
  const apks = collectApks(dir).sort((a, b) => b.size - a.size);
  if (!apks.length) fail("Gradle finished but no debug APK was produced");
  fs.copyFileSync(apks[0].f, path.join(out, "app.apk"));
}

run("unzip", ["-q", "-o", path.resolve(zip), "-d", "src"]);
const root = findRoot(path.join(work, "src"));

if (visible(root).some((n) => /^settings\.gradle(\.kts)?$/.test(n))) {
  console.log("Detected: Android Gradle project");
  gradleBuild(root);
} else {
  const idx = findFile(root, (n) => n === "index.html");
  if (!idx) fail("No Android Gradle project or index.html found in the ZIP");
  console.log("Detected: web project");
  const cap = path.join(work, "cap");
  fs.mkdirSync(cap);
  fs.writeFileSync(path.join(cap, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", private: true }));
  run("npm", ["install", "--no-audit", "--no-fund", "@capacitor/core@6", "@capacitor/cli@6", "@capacitor/android@6"], cap);
  fs.cpSync(path.dirname(idx), path.join(cap, "www"), { recursive: true });
  fs.writeFileSync(
    path.join(cap, "capacitor.config.json"),
    JSON.stringify({ appId: APP_ID, appName: APP_NAME, webDir: "www" }, null, 2)
  );
  run("npx", ["cap", "add", "android"], cap);
  run("npx", ["cap", "sync", "android"], cap);
  gradleBuild(path.join(cap, "android"));
}
console.log("APK ready:", path.join(out, "app.apk"));
