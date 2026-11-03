// What PikaClow may offer to delete. Every rule targets something a tool regenerates
// (dependencies, build output, caches) and must sit next to a project marker, so a
// random folder that happens to be called "build" is never touched.

export type JunkKind = "deps" | "build" | "cache";

export interface CleanRule {
  id: string;
  names: string[];
  /** At least one of these must exist next to the folder (files or folders). */
  markers?: string[];
  /** Or a sibling matching this pattern (e.g. *.csproj). */
  markerPattern?: RegExp;
  /** All of these must exist next to the folder. */
  markersAll?: string[];
  kind: JunkKind;
  /**
   * "safe": always regenerable. "verify": usually output, but some projects commit it
   * (e.g. Electron's build/ holds icons), so it is only pre-selected when git ignores it.
   */
  risk: "safe" | "verify";
  /** How to get it back. */
  regen: string;
  ecosystem: string;
}

const JS = ["package.json"];

export const RULES: CleanRule[] = [
  { id: "node_modules", names: ["node_modules"], markers: JS, kind: "deps", risk: "safe", regen: "npm install", ecosystem: "Node.js" },
  {
    id: "js-cache",
    names: [".next", ".nuxt", ".output", ".svelte-kit", ".turbo", ".parcel-cache", ".angular", ".docusaurus", ".expo", ".astro", ".vite", ".eslintcache", ".nx"],
    markers: JS,
    kind: "cache",
    risk: "safe",
    regen: "npm run build / dev",
    ecosystem: "Node.js",
  },
  { id: "js-build", names: ["dist", "build", "out", "coverage", "storybook-static"], markers: JS, kind: "build", risk: "verify", regen: "npm run build", ecosystem: "Node.js" },
  { id: "rust-target", names: ["target"], markers: ["Cargo.toml"], kind: "build", risk: "safe", regen: "cargo build", ecosystem: "Rust" },
  { id: "maven-target", names: ["target"], markers: ["pom.xml"], kind: "build", risk: "safe", regen: "mvn package", ecosystem: "Java" },
  { id: "gradle", names: ["build", ".gradle"], markers: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"], kind: "build", risk: "safe", regen: "gradle build", ecosystem: "Java/Kotlin" },
  { id: "py-cache", names: ["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".nox", ".hypothesis"], kind: "cache", risk: "safe", regen: "(automatic)", ecosystem: "Python" },
  { id: "py-venv", names: [".venv", "venv"], markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile", "poetry.lock", "uv.lock"], kind: "deps", risk: "verify", regen: "pip install -r requirements.txt", ecosystem: "Python" },
  { id: "dotnet", names: ["bin", "obj"], markerPattern: /\.(csproj|fsproj|vbproj)$/i, kind: "build", risk: "safe", regen: "dotnet build", ecosystem: ".NET" },
  { id: "flutter", names: [".dart_tool", "build"], markers: ["pubspec.yaml"], kind: "build", risk: "safe", regen: "flutter pub get", ecosystem: "Flutter" },
  { id: "pods", names: ["Pods"], markers: ["Podfile"], kind: "deps", risk: "safe", regen: "pod install", ecosystem: "iOS" },
  { id: "elixir", names: ["_build", "deps"], markers: ["mix.exs"], kind: "build", risk: "safe", regen: "mix deps.get", ecosystem: "Elixir" },
  { id: "zig", names: ["zig-cache", ".zig-cache", "zig-out"], markers: ["build.zig"], kind: "build", risk: "safe", regen: "zig build", ecosystem: "Zig" },
  { id: "cmake", names: ["cmake-build-debug", "cmake-build-release"], markers: ["CMakeLists.txt"], kind: "build", risk: "safe", regen: "cmake --build", ecosystem: "C/C++" },
  { id: "godot", names: [".godot"], markers: ["project.godot"], kind: "cache", risk: "safe", regen: "(reimport)", ecosystem: "Godot" },
  { id: "unity", names: ["Library", "Temp", "obj"], markersAll: ["Assets", "ProjectSettings"], kind: "cache", risk: "verify", regen: "(Unity reimport)", ecosystem: "Unity" },
];

/** Finds the rule matching a folder, given the names of its siblings. */
export function matchRule(name: string, siblings: ReadonlySet<string>, siblingList: readonly string[]): CleanRule | null {
  for (const rule of RULES) {
    if (!rule.names.includes(name)) continue;
    if (!rule.markers && !rule.markerPattern && !rule.markersAll) return rule;
    if (rule.markers?.some((m) => siblings.has(m))) return rule;
    if (rule.markerPattern && siblingList.some((s) => rule.markerPattern!.test(s))) return rule;
    if (rule.markersAll?.every((m) => siblings.has(m))) return rule;
  }
  return null;
}

// Never descend into these (system folders, VCS data, app data, global caches).
export const SKIP_DIRS = new Set(
  [
    "$recycle.bin", "system volume information", "windows", "program files", "program files (x86)", "programdata",
    "appdata", "library", "applications", "proc", "sys", "dev", "snap", "private", "cores", "volumes",
    "node_modules", "bower_components", "vendor",
  ].map((s) => s.toLowerCase()),
);
