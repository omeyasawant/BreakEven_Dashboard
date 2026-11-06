const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REQUIRED_ICO_SIZES = [16, 24, 32, 48, 256];

function readIcoSizes(buffer, label) {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    throw new Error(`${label} is not a valid .ico file.`);
  }
  const count = buffer.readUInt16LE(4);
  const sizes = [];
  for (let index = 0; index < count; index += 1) {
    sizes.push(buffer[6 + index * 16] || 256);
  }
  return sizes;
}

function verifyWindowsIconAsset(appDir, label = "app") {
  const rootIco = path.join(appDir, "icon.ico");
  const assetsIco = path.join(appDir, "assets", "icon.ico");
  for (const iconPath of [rootIco, assetsIco]) {
    if (!fs.existsSync(iconPath)) {
      throw new Error(`Missing Windows icon asset ${iconPath}. The ${label} exe would show a generic icon.`);
    }
  }
  const assetsBuffer = fs.readFileSync(assetsIco);
  if (!assetsBuffer.equals(fs.readFileSync(rootIco))) {
    throw new Error(`${rootIco} and ${assetsIco} differ. The ${label} window and exe icons would not match.`);
  }
  const sizes = readIcoSizes(assetsBuffer, assetsIco);
  const missing = REQUIRED_ICO_SIZES.filter((size) => !sizes.includes(size));
  if (missing.length) {
    throw new Error(`${assetsIco} is missing icon sizes ${missing.join(", ")} (has ${sizes.join(", ")}).`);
  }
  console.log(`✅ Windows icon asset verified for ${label}: ${assetsIco} [${sizes.join(", ")}]`);
  return assetsIco;
}

function findWindowsExecutables(outDir) {
  const executables = [];
  const isSquirrelStub = (name) => /^(squirrel|update)\.exe$/i.test(name);
  if (!fs.existsSync(outDir)) {
    return executables;
  }
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (entry.isDirectory() && /-win32-/i.test(entry.name)) {
      const packagedDir = path.join(outDir, entry.name);
      for (const file of fs.readdirSync(packagedDir)) {
        if (file.toLowerCase().endsWith(".exe") && !isSquirrelStub(file)) {
          executables.push(path.join(packagedDir, file));
        }
      }
    }
  }
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.toLowerCase().endsWith(".exe") && !isSquirrelStub(entry.name)) {
        executables.push(fullPath);
      }
    }
  };
  const squirrelDir = path.join(outDir, "make", "squirrel.windows");
  if (fs.existsSync(squirrelDir)) {
    walk(squirrelDir);
  }
  return executables;
}

// Compares the 32px icon Windows extracts from each exe (what Explorer/Task Manager show)
// with the 32px frame of the expected .ico.
const COMPARE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
function Get-Pixels([System.Drawing.Bitmap]$bitmap) {
  $pixels = New-Object 'int[]' 1024
  for ($y = 0; $y -lt 32; $y++) { for ($x = 0; $x -lt 32; $x++) { $pixels[$y * 32 + $x] = $bitmap.GetPixel($x, $y).ToArgb() } }
  return ,$pixels
}
$expected = Get-Pixels ((New-Object System.Drawing.Icon($env:BE_EXPECTED_ICO, 32, 32)).ToBitmap())
$results = @()
foreach ($exe in ($env:BE_EXE_LIST -split '\\|')) {
  $actual = Get-Pixels ([System.Drawing.Icon]::ExtractAssociatedIcon($exe).ToBitmap())
  $different = 0
  for ($i = 0; $i -lt 1024; $i++) {
    $a = [System.Drawing.Color]::FromArgb($expected[$i]); $b = [System.Drawing.Color]::FromArgb($actual[$i])
    if ([Math]::Abs($a.A - $b.A) + [Math]::Abs($a.R - $b.R) + [Math]::Abs($a.G - $b.G) + [Math]::Abs($a.B - $b.B) -gt 24) { $different++ }
  }
  $results += [pscustomobject]@{ exe = $exe; differentPixels = $different }
}
ConvertTo-Json -InputObject @($results) -Compress
`;

function compareEmbeddedIcons(expectedIco, executables) {
  const output = execFileSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(COMPARE_SCRIPT, "utf16le").toString("base64"),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, BE_EXPECTED_ICO: expectedIco, BE_EXE_LIST: executables.join("|") },
    },
  );
  return JSON.parse(output.trim());
}

function verifyWindowsEmbeddedIcons(appDir, label = "app", executables = null) {
  if (process.platform !== "win32") {
    return;
  }
  const expectedIco = verifyWindowsIconAsset(appDir, label);
  const targets = executables || findWindowsExecutables(path.join(appDir, "out"));
  if (!targets.length) {
    throw new Error(`No Windows executables found under ${path.join(appDir, "out")} to verify the ${label} icon.`);
  }
  const failures = [];
  for (const result of compareEmbeddedIcons(expectedIco, targets)) {
    // Allow a few pixels of resampling noise; a wrong or generic icon differs in hundreds.
    if (result.differentPixels > 20) {
      failures.push(`${result.exe} (${result.differentPixels}/1024 pixels differ)`);
    } else {
      console.log(`✅ Embedded icon verified for ${label}: ${result.exe}`);
    }
  }
  if (failures.length) {
    throw new Error(`Windows ${label} executables do not embed ${expectedIco}:\n  ${failures.join("\n  ")}`);
  }
}

module.exports = {
  REQUIRED_ICO_SIZES,
  readIcoSizes,
  verifyWindowsIconAsset,
  findWindowsExecutables,
  verifyWindowsEmbeddedIcons,
};

if (require.main === module) {
  const [appDir = process.cwd(), ...executables] = process.argv.slice(2);
  try {
    verifyWindowsEmbeddedIcons(path.resolve(appDir), path.basename(path.resolve(appDir)), executables.length ? executables : null);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}
