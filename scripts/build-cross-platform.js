const { execSync } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { pipeline } = require("stream/promises");

const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const isCI = process.env.GITHUB_ACTIONS === "true";
const dashboardDir = process.cwd();
const MAC_ARCH_OVERRIDES = new Set(["x64", "arm64", "universal"]);

const assetsToDownload = [
  {
    name: "animebg.mp4",
    downloadButtonUrl:
      "https://socket.breakeventx.com/download?kind=file&path=beta%2Fanimebg.mp4",
    listingUrl: "https://socket.breakeventx.com/?prefix=beta/",
    staticUrls: [
      "https://data.breakeventx.com:64444/content-cache/updates/beta/animebg.mp4",
      "https://socket.breakeventx.com/beta/animebg.mp4",
    ],
    envVar: "ANIMEBG_URL",
  },
];

const LISTING_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const MIN_VALID_ASSET_BYTES = 5 * 1024 * 1024;

function resolveMacArch() {
  const requestedArch = String(process.env.DASHBOARD_MAC_ARCH || "universal")
    .trim()
    .toLowerCase();

  if (!MAC_ARCH_OVERRIDES.has(requestedArch)) {
    throw new Error(
      "Unsupported DASHBOARD_MAC_ARCH '" +
        requestedArch +
        "'. Expected one of: " +
        Array.from(MAC_ARCH_OVERRIDES).join(", "),
    );
  }

  return requestedArch;
}

function configureMacCodeSigning(packagerConfig, changeNotes) {
  const signingIdentity = String(process.env.APPLE_SIGNING_IDENTITY || "")
    .trim();
  const certificateImported =
    String(process.env.APPLE_CERTIFICATE_IMPORTED || "")
      .trim()
      .toLowerCase() === "true";
  const appleId = String(process.env.APPLE_ID || "").trim();
  const appleAppSpecificPassword = String(
    process.env.APPLE_APP_SPECIFIC_PASSWORD || "",
  ).trim();
  const appleTeamId = String(process.env.APPLE_TEAM_ID || "").trim();

  const hasSigningIdentity = Boolean(signingIdentity);
  const hasAnyNotaryInput = Boolean(
    appleId || appleAppSpecificPassword || appleTeamId,
  );
  const hasCompleteNotaryConfig = Boolean(
    appleId && appleAppSpecificPassword && appleTeamId,
  );

  delete packagerConfig.osxSign;
  delete packagerConfig.osxNotarize;

  if (!hasSigningIdentity || !certificateImported) {
    const missingInputs = [];
    if (!hasSigningIdentity) {
      missingInputs.push("APPLE_SIGNING_IDENTITY");
    }
    if (!certificateImported) {
      missingInputs.push("Apple signing certificate import");
    }
    console.warn(
      "⚠️ Missing " +
        missingInputs.join(" and ") +
        ". Building unsigned, non-notarized macOS distributables.",
    );
    return;
  }

  packagerConfig.osxSign = {
    identity: signingIdentity,
    hardenedRuntime: true,
    gatekeeperAssess: false,
  };
  changeNotes.push("enabled macOS code signing");

  if (!hasAnyNotaryInput) {
    console.warn(
      "⚠️ Apple notarization secrets are not configured. Building signed, non-notarized macOS distributables.",
    );
    return;
  }

  if (!hasCompleteNotaryConfig) {
    console.warn(
      "⚠️ Incomplete macOS notarization configuration. APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID are all required to notarize. Building signed, non-notarized macOS distributables.",
    );
    return;
  }

  packagerConfig.osxNotarize = {
    appleId,
    appleIdPassword: appleAppSpecificPassword,
    teamId: appleTeamId,
  };
  changeNotes.push("enabled macOS notarization");
}

function verifyMacBuildIconAsset() {
  const macIconPath = path.join(dashboardDir, "assets", "icon.icns");
  if (!fs.existsSync(macIconPath)) {
    throw new Error(
      "Missing macOS icon asset at " +
        macIconPath +
        ". The dashboard app/DMG would show a generic icon.",
    );
  }
}

function applyDarwinPackagerOverrides() {
  const packageJsonPath = path.join(dashboardDir, "package.json");
  const originalPackageJson = fs.readFileSync(packageJsonPath, "utf8");
  const packageJson = JSON.parse(originalPackageJson);
  const packagerConfig = packageJson?.config?.forge?.packagerConfig;
  if (!packagerConfig) {
    throw new Error(
      "Unable to locate forge.packagerConfig in package.json for macOS packaging.",
    );
  }

  const changeNotes = [];
  configureMacCodeSigning(packagerConfig, changeNotes);

  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify(packageJson, null, 2) + os.EOL,
  );

  if (changeNotes.length) {
    console.log(
      "📦 Applied macOS packaging overrides: " + changeNotes.join("; ") + ".",
    );
  } else {
    console.log(
      "📦 macOS packaging will continue without code signing or notarization overrides.",
    );
  }

  return () => {
    fs.writeFileSync(packageJsonPath, originalPackageJson);
  };
}

function normalizeCandidateUrl(rawHref, listingUrl) {
  try {
    return new URL(rawHref, listingUrl).href;
  } catch {
    return null;
  }
}

function isDownloadButtonUrl(url) {
  return /\/download\?kind=(file|folder)/i.test(url);
}

function hasUsableLocalAsset(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.isFile() && stats.size >= MIN_VALID_ASSET_BYTES;
  } catch {
    return false;
  }
}

async function resolvePresignedUrl(listingUrl, assetName) {
  console.log("🔍 Looking for " + assetName + " inside " + listingUrl);
  const response = await fetch(listingUrl, {
    signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(
      "Listing request failed (" +
        response.status +
        " " +
        response.statusText +
        ")",
    );
  }

  const html = await response.text();
  const hrefPattern = /href="([^"]+)"/gi;
  const allHrefs = [];
  let hrefMatch;
  while ((hrefMatch = hrefPattern.exec(html)) !== null) {
    allHrefs.push(hrefMatch[1]);
  }

  const assetToken = assetName.toLowerCase();
  const candidates = allHrefs
    .map((href) => normalizeCandidateUrl(href, listingUrl))
    .filter(Boolean)
    .filter((url) => url.toLowerCase().includes(assetToken));

  if (!candidates.length) {
    throw new Error("No listing links found for " + assetName + ".");
  }

  const presigned = candidates.find(
    (url) =>
      /[?&](AWSAccessKeyId|Signature|Expires)=/i.test(url) &&
      !isDownloadButtonUrl(url),
  );
  const directFile = candidates.find((url) => !isDownloadButtonUrl(url));
  const fallback = candidates.find((url) => isDownloadButtonUrl(url));
  const resolvedUrl = presigned || directFile || fallback;

  if (!resolvedUrl) {
    throw new Error("Unable to resolve download URL from listing.");
  }

  console.log("🔗 Resolved presigned URL for " + assetName);
  return resolvedUrl;
}

async function resolveDownloadCandidates(asset) {
  const candidates = [];

  if (asset.envVar && process.env[asset.envVar]) {
    candidates.push(process.env[asset.envVar]);
  }

  if (asset.downloadButtonUrl) {
    candidates.push(asset.downloadButtonUrl);
  }

  if (asset.listingUrl) {
    try {
      const presigned = await resolvePresignedUrl(asset.listingUrl, asset.name);
      candidates.push(presigned);
    } catch (err) {
      console.warn(
        "⚠️ Unable to resolve presigned URL for " +
          asset.name +
          ": " +
          err.message,
      );
    }
  }

  if (Array.isArray(asset.staticUrls)) {
    candidates.push(...asset.staticUrls);
  }

  return [...new Set(candidates.filter(Boolean))];
}

async function downloadFromUrl(url, destPath, assetName) {
  console.log("📥 Downloading " + assetName + " from " + url + " ...");
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error("HTTP " + response.status + ": " + response.statusText);
  }

  const fileStream = fs.createWriteStream(destPath);
  await pipeline(response.body, fileStream);
  console.log("✅ Saved " + assetName + " to " + destPath);
}

async function downloadAsset(asset) {
  const destPath = path.join(dashboardDir, asset.name);
  if (hasUsableLocalAsset(destPath)) {
    console.log(
      "✅ " + asset.name + " already exists locally. Skipping download.",
    );
    return;
  }

  const candidates = await resolveDownloadCandidates(asset);
  if (!candidates.length) {
    throw new Error("No download sources configured for " + asset.name);
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      await downloadFromUrl(candidate, destPath, asset.name);
      return;
    } catch (err) {
      lastError = err;
      console.warn(
        "⚠️ Download attempt failed via " + candidate + ": " + err.message,
      );
    }
  }

  throw lastError || new Error("Unable to download " + asset.name);
}

async function downloadLargeAssetsIfCI() {
  if (!isCI) {
    console.log("💻 Local environment detected. Skipping asset download.");
    return;
  }

  console.log(
    "🌐 CI detected. Downloading required assets from remote storage...",
  );
  for (const asset of assetsToDownload) {
    await downloadAsset(asset);
  }
}

async function runBuild() {
  const platform = process.platform;
  console.log("🖥️ Detected platform:", platform);

  await downloadLargeAssetsIfCI();

  let forgeCmd = "npx electron-forge make";
  let restorePackageJson = null;

  if (platform === "win32") {
    forgeCmd += " --platform win32";
  } else if (platform === "darwin") {
    verifyMacBuildIconAsset();
    restorePackageJson = applyDarwinPackagerOverrides();
    forgeCmd += " --platform darwin --arch " + resolveMacArch();
  } else if (platform === "linux") {
    forgeCmd += " --platform linux --arch x64";
  }

  console.log("🚀 Running:", forgeCmd);
  try {
    execSync(forgeCmd, {
      cwd: dashboardDir,
      stdio: "inherit",
      shell: true,
    });
  } catch (err) {
    console.error("❌ electron-forge make failed:", err.message);
    process.exit(1);
  } finally {
    if (restorePackageJson) {
      restorePackageJson();
    }
  }
}

runBuild().catch((err) => {
  console.error("❌ Build failed:", err.message);
  process.exit(1);
});
