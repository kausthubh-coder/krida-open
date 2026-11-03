// Makes a built Krida.app stand on its own: libmpv and every Homebrew library it needs go into Contents/Frameworks
// (mpv_mac.rs loads them from there), with MoltenVK, the Vulkan driver mpv draws through, and the file the Vulkan
// loader finds it by. Then it fails if anything still points into Homebrew, and signs the app ad hoc, which Apple
// Silicon needs to run it at all (it isn't signed with an Apple Developer ID: a first open asks).
// Usage: node scripts/bundle-mac.mjs <Krida.app>   (needs brew install mpv dylibbundler)
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const app = resolve(process.argv[2] ?? "");
if (!existsSync(join(app, "Contents/MacOS"))) throw new Error(`Not an app: ${app}`);
const brew = "/opt/homebrew";
const frameworks = join(app, "Contents/Frameworks");
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

rmSync(frameworks, { recursive: true, force: true });
mkdirSync(join(frameworks, "vulkan"), { recursive: true });
// Each library goes in beside the others, and each finds the rest beside itself (@loader_path).
for (const lib of ["libmpv.2.dylib", "libMoltenVK.dylib"]) {
  copyFileSync(join(brew, "lib", lib), join(frameworks, lib));
  run("chmod", ["u+w", join(frameworks, lib)]);
  run("dylibbundler", ["-of", "-b", "-x", join(frameworks, lib), "-d", frameworks, "-p", "@loader_path/", "-s", join(brew, "lib")]);
  // Its own name, which dylibbundler leaves as Homebrew's.
  run("install_name_tool", ["-id", `@loader_path/${lib}`, join(frameworks, lib)]);
}
writeFileSync(
  join(frameworks, "vulkan/MoltenVK_icd.json"),
  JSON.stringify({ file_format_version: "1.0.0", ICD: { library_path: "../libMoltenVK.dylib", api_version: "1.4.0", is_portability_driver: true } }, null, 2),
);

const libs = readdirSync(frameworks).filter((name) => name.endsWith(".dylib"));
// dylibbundler adds @loader_path/ to libraries that already had it, and dyld refuses one with a path twice.
for (const name of libs) {
  const file = join(frameworks, name);
  const paths = [...run("otool", ["-l", file]).matchAll(/cmd LC_RPATH\n\s+cmdsize \d+\n\s+path (\S+)/g)].map((m) => m[1]);
  for (const [i, path] of paths.entries()) if (paths.indexOf(path) !== i) run("install_name_tool", ["-delete_rpath", path, file]);
}
const outside = libs.flatMap((name) =>
  run("otool", ["-L", join(frameworks, name)])
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ")[0])
    .filter((path) => path && (path.startsWith(brew) || path.startsWith("/usr/local")))
    .map((path) => `${name} -> ${path}`),
);
if (outside.length) throw new Error(`Still pointing into Homebrew:\n${outside.join("\n")}`);

for (const name of libs) run("codesign", ["--force", "--sign", "-", join(frameworks, name)]);
run("codesign", ["--force", "--deep", "--sign", "-", app]);
run("codesign", ["--verify", "--deep", "--strict", app]);
// And it loads, with everything it needs from inside the app: what dyld would refuse at runtime fails here.
const loaded = run("/usr/bin/python3", ["-c", "import ctypes,sys; ctypes.CDLL(sys.argv[1])", join(frameworks, "libmpv.2.dylib")]);
if (loaded.trim()) throw new Error(loaded);
console.log(`Bundled ${libs.length} libraries into ${frameworks}`);
