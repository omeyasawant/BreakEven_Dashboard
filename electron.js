const { app, BrowserWindow, ipcMain, dialog, screen } = require("electron");
try {
  if (require("electron-squirrel-startup")) {
    app.quit();
    return;
  }
} catch (_) {
  // module not found in packaged builds — safe to ignore
  console.log("[Electron] electron-squirrel-startup catch case");
}
const path = require("path");
const fs = require("fs");
const http = require("http");
const os = require("os");
const childProcess = require("child_process");
const crypto = require("crypto");
const bs58 = require("bs58");
const nacl = require("tweetnacl");

const FALLBACK_CLIENT_CONFIG_PATH = path.resolve(
  __dirname,
  "..",
  "client_config.json",
);
const WINDOWS_APP_USER_MODEL_ID = "com.breakeventx.breakevendashboard";
const WINDOWS_STARTUP_STABILIZE_DELAY_MS = 3500;
const PRODUCTION_PHANTOM_REDIRECT_PORT = 3015;
const DEFAULT_PHANTOM_REDIRECT_URL = "http://localhost:3000/";
const PRODUCTION_PHANTOM_REDIRECT_URL = "http://127.0.0.1:3015/";
const SLAVE_SIGNATURES = [
  "breakeven_slave",
  "breakeven-slave",
  "slave.py",
  "slave.exe",
];
const SLAVE_TERMINATION_SIGNATURES = [
  "breakeven_slave",
  "breakeven-slave",
  "breakeven_slave.py",
  "breakeven_slave.exe",
];
const SLAVE_PARENT_ALLOWLIST = [
  "breakevenslaveservicehost.exe",
  "python.exe",
  "py.exe",
];
const SLAVE_PARENT_CMD_TOKENS = [
  "tray_app.py",
  "updater.py",
  "client_service.py",
];
const TRAY_SIGNATURES = [
  "tray_app",
  "breakeven_tray",
  "breakevenclienttray",
  "breakeven-tray",
  "tray.exe",
];
const UPDATER_SIGNATURES = [
  "updater.py",
  "updater.exe",
  "breakeven_updater",
  "breakevenclientupdater",
];

let cachedPythonCommand = null;
let psListLoader = null;
let activeClientConfigPath = null;
let mainWindow = null;

if (process.platform === "win32") {
  app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

const WALLET_VERIFY_NONCE_TTL_MS = 5 * 60 * 1000;
const walletVerificationNonces = new Map();
let bundledRendererServer = null;

function getEffectivePhantomRedirectUrl(value) {
  const candidate = String(value || "").trim();
  if (candidate) {
    return candidate;
  }
  return app.isPackaged
    ? PRODUCTION_PHANTOM_REDIRECT_URL
    : DEFAULT_PHANTOM_REDIRECT_URL;
}

function resolveBundledRendererIndexPath() {
  const bundledIndexCandidates = [
    path.join(__dirname, "index.html"),
    path.join(__dirname, "build", "index.html"),
    path.join(process.resourcesPath || "", "app", "index.html"),
    path.join(process.resourcesPath || "", "app", "build", "index.html"),
  ];

  return (
    bundledIndexCandidates.find((candidate) => {
      try {
        return candidate && fs.existsSync(candidate);
      } catch {
        return false;
      }
    }) || null
  );
}

function getBundledRendererContentType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    default:
      return "application/octet-stream";
  }
}

function sendBundledRendererResponse(response, statusCode, body, contentType) {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function injectWalletReturnPageMarker(indexHtml, requestUrl) {
  try {
    const parsedUrl = new URL(requestUrl || "/", PRODUCTION_PHANTOM_REDIRECT_URL);
    if (!parsedUrl.search) {
      return indexHtml;
    }
  } catch {
    return indexHtml;
  }

  const markerScript = '<script>try{sessionStorage.setItem("be:returnPage","wallets");sessionStorage.setItem("be:returnPageAfterConnect","wallets");}catch(_){}</script>';
  if (indexHtml.includes(markerScript)) {
    return indexHtml;
  }

  if (/<head>/i.test(indexHtml)) {
    return indexHtml.replace(/<head>/i, "<head>" + markerScript);
  }

  return markerScript + indexHtml;
}

function serveBundledRendererRequest(indexPath, requestUrl, response) {
  const rendererRoot = path.dirname(indexPath);
  const requestPathname = new URL(
    requestUrl || "/",
    PRODUCTION_PHANTOM_REDIRECT_URL,
  ).pathname;
  const relativePath = decodeURIComponent(requestPathname).replace(/^\/+/, "");

  if (relativePath) {
    const candidatePath = path.resolve(rendererRoot, relativePath);
    const relativeCandidatePath = path.relative(rendererRoot, candidatePath);
    const isInsideRendererRoot =
      !relativeCandidatePath.startsWith("..") &&
      !path.isAbsolute(relativeCandidatePath);

    if (isInsideRendererRoot) {
      try {
        const stats = fs.statSync(candidatePath);
        if (stats.isFile()) {
          sendBundledRendererResponse(
            response,
            200,
            fs.readFileSync(candidatePath),
            getBundledRendererContentType(candidatePath),
          );
          return;
        }
      } catch (_) {}
    }
  }

  let indexHtml = fs.readFileSync(indexPath, "utf8");
  indexHtml = injectWalletReturnPageMarker(indexHtml, requestUrl);

  sendBundledRendererResponse(
    response,
    200,
    indexHtml,
    "text/html; charset=utf-8",
  );
}

function ensureBundledRendererServer(indexPath) {
  if (bundledRendererServer) {
    return Promise.resolve(PRODUCTION_PHANTOM_REDIRECT_URL);
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      try {
        serveBundledRendererRequest(indexPath, request.url, response);
      } catch (error) {
        console.error(
          "[Electron] Failed to serve OAuth callback renderer request:",
          error.message,
        );
        sendBundledRendererResponse(
          response,
          500,
          "Renderer bootstrap failed",
          "text/plain; charset=utf-8",
        );
      }
    });

    server.once("error", (error) => {
      reject(error);
    });

    server.listen(PRODUCTION_PHANTOM_REDIRECT_PORT, "127.0.0.1", () => {
      bundledRendererServer = server;
      resolve(PRODUCTION_PHANTOM_REDIRECT_URL);
    });
  });
}

function focusMainWindow() {
  const candidate =
    mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : BrowserWindow.getAllWindows()[0] || null;

  if (!candidate) {
    return;
  }

  if (candidate.isMinimized()) {
    candidate.restore();
  }

  candidate.show();
  candidate.focus();
}

function buildWalletVerificationMessage(address, nonce, issuedAtIso) {
  return `BreakEvenClient wallet verification\nAddress: ${address}\nNonce: ${nonce}\nIssuedAt: ${issuedAtIso}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSquirrelLaunchFlags() {
  return process.argv
    .slice(1)
    .map((value) => String(value || "").toLowerCase())
    .filter((value) => value.startsWith("--squirrel-"));
}

function isLikelyInstalledSquirrelPath() {
  if (process.platform !== "win32") {
    return false;
  }

  const exeDir = path.dirname(process.execPath || "");
  const appFolder = path.basename(exeDir);
  const updateExePath = path.resolve(exeDir, "..", "Update.exe");

  return /^app-[\w.-]+$/i.test(appFolder) && fs.existsSync(updateExePath);
}

function isLikelyTransientBootstrapPath() {
  if (process.platform !== "win32") {
    return false;
  }

  const normalizedExecPath = String(process.execPath || "").toLowerCase();
  const normalizedCwd = String(process.cwd() || "").toLowerCase();
  const candidateText = `${normalizedExecPath} ${normalizedCwd}`;

  if (candidateText.includes("\\squirreltemp\\")) {
    return true;
  }

  if (candidateText.includes("\\temp\\") && !isLikelyInstalledSquirrelPath()) {
    return true;
  }

  return false;
}

async function classifyWindowsStartupLaunch() {
  if (process.platform !== "win32" || !app.isPackaged) {
    return { shouldExit: false, shouldDelay: false, reason: "not-packaged" };
  }

  const squirrelFlags = getSquirrelLaunchFlags();
  if (
    squirrelFlags.some(
      (flag) =>
        flag === "--squirrel-install" ||
        flag === "--squirrel-updated" ||
        flag === "--squirrel-uninstall" ||
        flag === "--squirrel-obsolete",
    )
  ) {
    return {
      shouldExit: true,
      shouldDelay: false,
      reason: `squirrel-event:${squirrelFlags.join(",")}`,
    };
  }

  if (isLikelyTransientBootstrapPath()) {
    return {
      shouldExit: true,
      shouldDelay: false,
      reason: "transient-bootstrap-path",
    };
  }

  if (
    squirrelFlags.includes("--squirrel-firstrun") ||
    isLikelyInstalledSquirrelPath()
  ) {
    return {
      shouldExit: false,
      shouldDelay: true,
      reason: squirrelFlags.includes("--squirrel-firstrun")
        ? "squirrel-firstrun"
        : "installed-squirrel-layout",
    };
  }

  return { shouldExit: false, shouldDelay: false, reason: "standard-launch" };
}

async function getPsList() {
  if (!psListLoader) {
    psListLoader = import("ps-list")
      .then((mod) => mod.default || mod)
      .catch((err) => {
        psListLoader = null;
        throw err;
      });
  }
  return psListLoader;
}

function execCommand(command, args = [], options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let spawned;

    try {
      spawned = childProcess.spawn(command, args, {
        windowsHide: process.platform === "win32",
        shell: false,
        ...options,
      });
    } catch (spawnErr) {
      resolve({
        stdout,
        stderr: spawnErr.message,
        exitCode: null,
        error: spawnErr,
      });
      return;
    }

    if (spawned.stdout) {
      spawned.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
    }

    if (spawned.stderr) {
      spawned.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }

    spawned.on("error", (err) => {
      resolve({
        stdout,
        stderr: stderr || err.message,
        exitCode: null,
        error: err,
      });
    });

    spawned.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: typeof code === "number" ? code : null,
        error: code === 0 ? null : undefined,
      });
    });
  });
}

function execPowerShell(script) {
  if (process.platform !== "win32") {
    return Promise.resolve({
      stdout: "",
      stderr: "PowerShell unavailable on this platform",
      exitCode: null,
      error: new Error("PowerShell unavailable"),
    });
  }
  return execCommand("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-Command",
    script,
  ]);
}

async function taskkillImage(imageName) {
  if (process.platform !== "win32") {
    return { exitCode: null, stdout: "", stderr: "" };
  }
  return execCommand("taskkill", ["/F", "/T", "/IM", imageName]);
}

async function getWindowsProcessDetails(pids) {
  if (process.platform !== "win32") {
    return [];
  }
  const unique = Array.from(new Set(pids || [])).filter((pid) =>
    Number.isInteger(pid),
  );
  if (!unique.length) {
    return [];
  }

  const script = `
$pids = @(${unique.join(",")})
$results = @()
foreach ($pid in $pids) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$pid" -ErrorAction SilentlyContinue
  if ($null -ne $p) {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue
    $results += [PSCustomObject]@{
      pid = $p.ProcessId
      name = $p.Name
      parentPid = $p.ParentProcessId
      parentName = $parent.Name
      commandLine = $p.CommandLine
      parentCommandLine = $parent.CommandLine
    }
  }
}
$results | ConvertTo-Json -Compress
`;
  const result = await execPowerShell(script);
  if (result.exitCode !== 0) {
    return [];
  }
  const raw = (result.stdout || "").trim();
  if (!raw || raw === "null") {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    return [];
  }
}

function collectResultText(result) {
  if (!result) return "";
  return `${result.stderr || ""} ${result.stdout || ""}`.toLowerCase();
}

function indicatesServiceMissing(result) {
  const text = collectResultText(result);
  return (
    text.includes("service") &&
    (text.includes("not found") ||
      text.includes("cannot find") ||
      text.includes("does not exist") ||
      text.includes("was not found"))
  );
}

function shouldAttemptElevation(result) {
  if (process.platform !== "win32") {
    return false;
  }
  const text = collectResultText(result);
  return (
    text.includes("access is denied") ||
    text.includes("cannot open") ||
    text.includes("requires elevation") ||
    text.includes("privilege") ||
    text.includes("permission")
  );
}

async function execPowerShellWithElevationFallback(script, options = {}) {
  const { alwaysElevateOnFailure = false } = options;
  const direct = await execPowerShell(script);
  if (direct.exitCode === 0) {
    return direct;
  }

  const directMessage =
    (direct.stderr && direct.stderr.trim()) ||
    (direct.stdout && direct.stdout.trim()) ||
    "PowerShell command failed";

  if (
    (!alwaysElevateOnFailure && !shouldAttemptElevation(direct)) ||
    (alwaysElevateOnFailure && indicatesServiceMissing(direct))
  ) {
    throw new Error(directMessage);
  }

  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const wrapper = `
$encoded = "${encoded}"
$bytes = [System.Convert]::FromBase64String($encoded)
$cmd = [System.Text.Encoding]::Unicode.GetString($bytes)
$process = Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoLogo','-NoProfile','-Command',$cmd -PassThru -Wait
exit $process.ExitCode
`;
  const elevated = await execPowerShell(wrapper);
  if (elevated.exitCode === 0) {
    return elevated;
  }

  throw new Error(
    (elevated.stderr && elevated.stderr.trim()) ||
      (elevated.stdout && elevated.stdout.trim()) ||
      "Elevated PowerShell command failed",
  );
}

async function enforceWindowsSlaveServiceStop(options = {}) {
  if (process.platform !== "win32") {
    return;
  }
  const { allowElevation = true } = options;
  const serviceName =
    SLAVE_SERVICE_CONTROLLERS.win32?.identifier || "BreakEvenSlave";
  const script = `
$serviceName = '${serviceName}'
$svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($null -ne $svc) {
  try { sc.exe failure $serviceName reset= 0 actions= "" | Out-Null } catch {}
  try { Set-Service -Name $serviceName -StartupType Manual -ErrorAction Stop } catch {}
  if ($svc.Status -ne 'Stopped') { Stop-Service -Name $serviceName -Force -ErrorAction Stop }
}
`;
  try {
    const direct = await execPowerShell(script);
    if (direct.exitCode === 0 || !allowElevation) {
      return;
    }
    await execPowerShellWithElevationFallback(script, {
      alwaysElevateOnFailure: true,
    });
  } catch (err) {
    console.warn(
      "[Electron] Failed to enforce BreakEvenSlave service stop:",
      err.message,
    );
  }
}

async function runWindowsSlaveKillLoop(options = {}) {
  if (process.platform !== "win32") {
    return;
  }
  const { durationSeconds = 20 } = options;
  const script = `
$deadline = (Get-Date).AddSeconds(${durationSeconds})
while ((Get-Date) -lt $deadline) {
  $targets = Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -like '*Breakeven_Slave*') -or
    ($_.Name -like '*BreakEvenSlaveServiceHost*') -or
    ($_.CommandLine -match 'Breakeven_Slave')
  }
  foreach ($t in $targets) {
    try { Stop-Process -Id $t.ProcessId -Force -ErrorAction Stop } catch {}
  }
  Start-Sleep -Milliseconds 800
}
`;
  try {
    await execPowerShellWithElevationFallback(script, {
      alwaysElevateOnFailure: true,
    });
  } catch (err) {
    console.warn("[Electron] Failed to run slave kill loop:", err.message);
  }
}

function createWindowsServiceController(identifier) {
  return {
    source: "windows-service",
    identifier,
    async status() {
      const script = `
$serviceName = '${identifier}'
$svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($null -eq $svc) { Write-Output '__MISSING__'; exit 1 }
Write-Output $svc.Status
`;
      const result = await execPowerShell(script);
      if (result.exitCode === 0) {
        const raw = (result.stdout || "").trim();
        const running = raw.toLowerCase() === "running";
        return {
          running,
          state: running ? "running" : "stopped",
          source: "windows-service",
          detail: `Service status: ${raw || "Unknown"}`,
        };
      }
      if ((result.stdout || "").includes("__MISSING__")) {
        return {
          running: false,
          state: "stopped",
          source: "windows-service",
          detail: `Service '${identifier}' not installed`,
        };
      }
      return {
        running: false,
        state: "unknown",
        source: "windows-service",
        detail:
          (result.stderr && result.stderr.trim()) ||
          (result.stdout && result.stdout.trim()) ||
          "Unable to query service",
      };
    },
    async start() {
      const script = `
$serviceName = '${identifier}'
$svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($null -eq $svc) { throw "Service '${identifier}' not found" }
try { Set-Service -Name $serviceName -StartupType Automatic -ErrorAction Stop } catch {}
try { sc.exe failure $serviceName reset= 60 actions= restart/5000 | Out-Null } catch {}
if ($svc.Status -ne 'Running') { Start-Service -Name $serviceName -ErrorAction Stop }
`;
      await execPowerShellWithElevationFallback(script, {
        alwaysElevateOnFailure: true,
      });
    },
    async stop() {
      const script = `
$serviceName = '${identifier}'
$svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($null -eq $svc) { throw "Service '${identifier}' not found" }
try { sc.exe failure $serviceName reset= 0 actions= "" | Out-Null } catch {}
try { Set-Service -Name $serviceName -StartupType Manual -ErrorAction Stop } catch {}
if ($svc.Status -ne 'Stopped') { Stop-Service -Name $serviceName -Force -ErrorAction Stop }
`;
      await execPowerShellWithElevationFallback(script, {
        alwaysElevateOnFailure: true,
      });
    },
  };
}

function createSystemdServiceController(identifier) {
  return {
    source: "systemd-user-service",
    identifier,
    async status() {
      const result = await execCommand("systemctl", [
        "--user",
        "is-active",
        identifier,
      ]);
      if (result.exitCode === 0) {
        return {
          running: true,
          state: "running",
          source: "systemd-user-service",
          detail: "systemd reports service is active",
        };
      }
      if (result.exitCode === 3) {
        return {
          running: false,
          state: "stopped",
          source: "systemd-user-service",
          detail: "systemd reports service is inactive",
        };
      }
      return {
        running: false,
        state: "unknown",
        source: "systemd-user-service",
        detail:
          (result.stderr && result.stderr.trim()) ||
          (result.stdout && result.stdout.trim()) ||
          "systemctl unavailable",
      };
    },
    async start() {
      const result = await execCommand("systemctl", [
        "--user",
        "start",
        identifier,
      ]);
      if (result.exitCode !== 0) {
        throw new Error(
          (result.stderr && result.stderr.trim()) ||
            (result.stdout && result.stdout.trim()) ||
            "systemctl start failed",
        );
      }
    },
    async enable() {
      const result = await execCommand("systemctl", [
        "--user",
        "enable",
        identifier,
      ]);
      if (result.exitCode !== 0) {
        throw new Error(
          (result.stderr && result.stderr.trim()) ||
            (result.stdout && result.stdout.trim()) ||
            "systemctl enable failed",
        );
      }
    },
    async stop() {
      const result = await execCommand("systemctl", [
        "--user",
        "stop",
        identifier,
      ]);
      if (result.exitCode !== 0) {
        throw new Error(
          (result.stderr && result.stderr.trim()) ||
            (result.stdout && result.stdout.trim()) ||
            "systemctl stop failed",
        );
      }
    },
    async disable() {
      const result = await execCommand("systemctl", [
        "--user",
        "disable",
        identifier,
      ]);
      if (result.exitCode !== 0) {
        throw new Error(
          (result.stderr && result.stderr.trim()) ||
            (result.stdout && result.stdout.trim()) ||
            "systemctl disable failed",
        );
      }
    },
  };
}

function createLaunchctlServiceController(identifier) {
  return {
    source: "launchctl",
    identifier,
    async status() {
      const result = await execCommand("launchctl", ["list", identifier]);
      if (result.exitCode === 0) {
        const running = /"PID"\s*=\s*\d+/i.test(result.stdout);
        return {
          running,
          state: running ? "running" : "stopped",
          source: "launchctl",
          detail: running
            ? "launchctl reports agent is running"
            : "launchctl loaded but no PID present",
        };
      }
      if (result.exitCode === 113) {
        return {
          running: false,
          state: "stopped",
          source: "launchctl",
          detail: "launchctl label not found",
        };
      }
      return {
        running: false,
        state: "unknown",
        source: "launchctl",
        detail:
          (result.stderr && result.stderr.trim()) ||
          (result.stdout && result.stdout.trim()) ||
          "launchctl unavailable",
      };
    },
    async start() {
      const result = await execCommand("launchctl", ["start", identifier]);
      if (result.exitCode !== 0) {
        throw new Error(
          (result.stderr && result.stderr.trim()) ||
            (result.stdout && result.stdout.trim()) ||
            "launchctl start failed",
        );
      }
    },
    async enable() {
      const domain = getLaunchctlDomain();
      if (!domain) {
        throw new Error("launchctl domain unavailable");
      }
      const result = await execCommand("launchctl", [
        "enable",
        `${domain}/${identifier}`,
      ]);
      if (result.exitCode !== 0) {
        throw new Error(
          (result.stderr && result.stderr.trim()) ||
            (result.stdout && result.stdout.trim()) ||
            "launchctl enable failed",
        );
      }
    },
    async stop() {
      const result = await execCommand("launchctl", ["stop", identifier]);
      if (result.exitCode !== 0) {
        throw new Error(
          (result.stderr && result.stderr.trim()) ||
            (result.stdout && result.stdout.trim()) ||
            "launchctl stop failed",
        );
      }
    },
    async disable() {
      const domain = getLaunchctlDomain();
      if (!domain) {
        throw new Error("launchctl domain unavailable");
      }
      const result = await execCommand("launchctl", [
        "disable",
        `${domain}/${identifier}`,
      ]);
      if (result.exitCode !== 0) {
        throw new Error(
          (result.stderr && result.stderr.trim()) ||
            (result.stdout && result.stdout.trim()) ||
            "launchctl disable failed",
        );
      }
    },
  };
}

const SLAVE_SERVICE_CONTROLLERS = {
  win32: createWindowsServiceController("BreakEvenSlave"),
  linux: createSystemdServiceController("breakeven-slave.service"),
  darwin: createLaunchctlServiceController("com.breakeven.slave"),
};

const UPDATER_SERVICE_CONTROLLERS = {
  win32: createWindowsServiceController("BreakEvenUpdater"),
  linux: createSystemdServiceController("breakeven-updater.service"),
  darwin: createLaunchctlServiceController("com.breakeven.updater"),
};

const TRAY_SERVICE_CONTROLLERS = {
  win32: createWindowsServiceController("BreakEvenTray"),
  linux: createSystemdServiceController("breakeven-tray.service"),
  darwin: createLaunchctlServiceController("com.breakeven.tray"),
};

function getSlaveController() {
  return SLAVE_SERVICE_CONTROLLERS[process.platform] || null;
}

function getUpdaterController() {
  return UPDATER_SERVICE_CONTROLLERS[process.platform] || null;
}

function getTrayController() {
  return TRAY_SERVICE_CONTROLLERS[process.platform] || null;
}

function getSystemServiceRoot() {
  if (process.platform === "win32") {
    const programData =
      process.env.ProgramData ||
      (process.env.SystemDrive
        ? path.join(process.env.SystemDrive, "ProgramData")
        : "C:/ProgramData");
    return path.join(programData, "BreakEvenClient");
  }
  if (process.platform === "darwin") {
    return path.join("/Library", "Application Support", "BreakEvenClient");
  }
  if (process.platform === "linux") {
    return path.join("/opt", "breakeven-client");
  }
  return null;
}

function getClientConfigCandidates(extraCandidates = []) {
  const execDir = path.dirname(process.execPath || "");
  const resourcesParent = process.resourcesPath
    ? path.dirname(process.resourcesPath)
    : null;
  const systemRoot = getSystemServiceRoot();

  return dedupePaths([
    activeClientConfigPath,
    ...extraCandidates,
    FALLBACK_CLIENT_CONFIG_PATH,
    path.join(__dirname, "client_config.json"),
    path.join(process.cwd(), "client_config.json"),
    execDir && path.join(execDir, "..", "client_config.json"),
    execDir && path.join(execDir, "client_config.json"),
    resourcesParent && path.join(resourcesParent, "client_config.json"),
    systemRoot && path.join(systemRoot, "client_config.json"),
  ]);
}

function readClientConfig() {
  const candidates = getClientConfigCandidates();
  const failures = [];

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      const raw = fs.readFileSync(candidate, "utf-8");
      const parsed = JSON.parse(raw);
      activeClientConfigPath = candidate;
      return parsed;
    } catch (err) {
      failures.push(`${candidate}: ${err.message}`);
    }
  }

  if (failures.length) {
    failures.forEach((failure) => {
      console.warn("[Electron] Failed to load client_config.json:", failure);
    });
  } else {
    console.warn(
      "[Electron] Failed to load client_config.json: no candidate file found",
      candidates,
    );
  }
  return null;
}

function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
  if (value === null || value === undefined) {
    return fallback;
  }

  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  const intValue = Math.trunc(numeric);
  return intValue >= 0 ? intValue : fallback;
}

const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

function normalizeWalletAddress(value, fallback = null) {
  if (value === undefined) {
    return fallback;
  }
  if (value === null) {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return fallback;
  }
  if (!BASE58_ADDRESS_RE.test(text)) {
    return fallback;
  }
  return text;
}

function normalizeWalletLabel(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  const text = String(value).trim();
  return text ? text.slice(0, 48) : fallback;
}

function normalizeWalletSource(value, fallback = "unknown") {
  if (value === undefined || value === null) {
    return fallback;
  }
  const text = String(value).trim();
  if (!text) {
    return fallback;
  }
  const allowed = new Set([
    "phantom_extension",
    "phantom_embedded",
    "manual",
    "unknown",
  ]);
  return allowed.has(text) ? text : fallback;
}

function normalizeWalletChain(value, fallback = "solana") {
  if (value === undefined || value === null) {
    return fallback;
  }
  const text = String(value).trim();
  return text ? text.slice(0, 24) : fallback;
}

function normalizeWalletVerifiedAt(value, fallback = null) {
  if (value === undefined) {
    return fallback;
  }
  if (value === null) {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return fallback;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function normalizePhantomAppId(value, fallback = null) {
  if (value === undefined) {
    return fallback;
  }
  if (value === null) {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return fallback;
  }
  return text.slice(0, 128);
}

function normalizeWalletEntry(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const address = normalizeWalletAddress(value.address, null);
  if (!address) {
    return null;
  }
  return {
    address,
    label: normalizeWalletLabel(value.label, "Wallet"),
    source: normalizeWalletSource(value.source, "unknown"),
    chain: normalizeWalletChain(value.chain, "solana"),
    verified_at: normalizeWalletVerifiedAt(value.verified_at, null),
  };
}

function normalizeWalletList(value, fallback = []) {
  if (value === undefined) {
    return Array.isArray(fallback) ? fallback : [];
  }
  if (!Array.isArray(value)) {
    return Array.isArray(fallback) ? fallback : [];
  }

  const next = [];
  const seen = new Set();
  for (const entry of value) {
    const normalized = normalizeWalletEntry(entry);
    if (!normalized) continue;
    if (seen.has(normalized.address)) continue;
    seen.add(normalized.address);
    next.push(normalized);
  }
  return next;
}

function dedupeFilePaths(paths) {
  const seen = new Set();
  return (paths || [])
    .filter(Boolean)
    .map((candidate) => path.normalize(candidate))
    .filter((candidate) => {
      if (seen.has(candidate)) {
        return false;
      }
      seen.add(candidate);
      return true;
    });
}

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function shouldAttemptElevatedWrite(err) {
  if (!err || process.platform !== "win32") {
    return false;
  }
  const message = String(err.message || err).toLowerCase();
  return (
    message.includes("eperm") ||
    message.includes("access is denied") ||
    message.includes("permission")
  );
}

async function writeClientConfigFile(targetPath, config) {
  try {
    ensureDirForFile(targetPath);
    fs.writeFileSync(targetPath, JSON.stringify(config, null, 2));
    return { ok: true, path: targetPath };
  } catch (err) {
    if (shouldAttemptElevatedWrite(err)) {
      const payload = Buffer.from(
        JSON.stringify(config, null, 2),
        "utf8",
      ).toString("base64");
      const safePath = String(targetPath).replace(/'/g, "''");
      const script = `
$path = '${safePath}'
$dir = Split-Path -Parent $path
if ($dir -and !(Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bytes = [System.Convert]::FromBase64String('${payload}')
$text = [System.Text.Encoding]::UTF8.GetString($bytes)
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $text, $utf8NoBom)
`;
      try {
        await execPowerShellWithElevationFallback(script, {
          alwaysElevateOnFailure: true,
        });
        return { ok: true, path: targetPath, elevated: true };
      } catch (elevatedErr) {
        return {
          ok: false,
          path: targetPath,
          error: elevatedErr.message || err.message,
        };
      }
    }
    return { ok: false, path: targetPath, error: err.message };
  }
}

async function writeClientConfigToTargets(config) {
  const { installPath, serviceInstallPath } = resolveInstallContext();
  const effectiveInstallPath = config?.installPath || installPath;
  const effectiveServicePath = config?.serviceInstallPath || serviceInstallPath;
  const primaryTarget =
    getClientConfigCandidates([
      effectiveInstallPath &&
        path.join(effectiveInstallPath, "client_config.json"),
      effectiveServicePath &&
        path.join(effectiveServicePath, "client_config.json"),
    ]).find((candidate) => {
      try {
        return fs.existsSync(candidate);
      } catch {
        return false;
      }
    }) ||
    (effectiveInstallPath &&
      path.join(effectiveInstallPath, "client_config.json")) ||
    (effectiveServicePath &&
      path.join(effectiveServicePath, "client_config.json")) ||
    FALLBACK_CLIENT_CONFIG_PATH;

  const secondaryTargets = dedupePaths([
    effectiveInstallPath &&
      path.join(effectiveInstallPath, "client_config.json"),
    effectiveServicePath &&
      path.join(effectiveServicePath, "client_config.json"),
  ]).filter(
    (candidate) => path.resolve(candidate) !== path.resolve(primaryTarget),
  );

  const results = [await writeClientConfigFile(primaryTarget, config)];
  if (results[0]?.ok) {
    activeClientConfigPath = primaryTarget;
  }
  for (const target of secondaryTargets) {
    results.push(await writeClientConfigFile(target, config));
  }
  return results;
}

async function maybeWriteWindowsTempConfig(config) {
  if (process.platform !== "win32") {
    return null;
  }
  if (!normalizeBoolean(config?.runSlaveOnStartup, false)) {
    return null;
  }
  const systemTemp = path.join(
    process.env.SystemRoot || "C:/Windows",
    "Temp",
    "client_config.json",
  );
  return writeClientConfigFile(systemTemp, config);
}

function quoteArg(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (!/[\s"]/g.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '\\"')}"`;
}

function getStartupEntryPath(name) {
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || os.homedir(),
      "Microsoft\\Windows\\Start Menu\\Programs\\Startup",
      `${name}.bat`,
    );
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "LaunchAgents", `${name}.plist`);
  }
  return path.join(os.homedir(), ".config", "autostart", `${name}.desktop`);
}

function buildLaunchAgentPlist({ label, command, args = [], workingDir }) {
  const payload = [command, ...(args || [])]
    .map((arg) => `<string>${arg.replace(/&/g, "&amp;")}</string>`)
    .join("");
  const workingDirNode = workingDir
    ? `<key>WorkingDirectory</key><string>${workingDir.replace(
        /&/g,
        "&amp;",
      )}</string>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>${payload}</array>
  ${workingDirNode}
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>`;
}

function enableStartupEntry({ name, command, args = [], workingDir }) {
  const entryPath = getStartupEntryPath(name);
  if (process.platform === "win32") {
    ensureDirForFile(entryPath);
    const quotedArgs = (args || []).map((arg) => quoteArg(arg)).join(" ");
    const bat = `@echo off\r\ncd /d ${quoteArg(workingDir || ".")}\r\nstart "" ${quoteArg(command)} ${quotedArgs}\r\n`;
    fs.writeFileSync(entryPath, bat);
    return { ok: true, path: entryPath };
  }
  if (process.platform === "darwin") {
    ensureDirForFile(entryPath);
    const label = `com.breakeven.${name}`;
    const needsEnv = !command.startsWith("/");
    const plist = buildLaunchAgentPlist({
      label,
      command: needsEnv ? "/usr/bin/env" : command,
      args: needsEnv ? [command, ...(args || [])] : args,
      workingDir,
    });
    fs.writeFileSync(entryPath, plist);
    return { ok: true, path: entryPath };
  }
  ensureDirForFile(entryPath);
  const execLine = [command, ...(args || [])]
    .map((arg) => quoteArg(arg))
    .join(" ");
  const content = `[Desktop Entry]
Type=Application
Exec=${execLine}
Path=${workingDir || ""}
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
Name=${name}
Comment=Autostart ${name}
`;
  fs.writeFileSync(entryPath, content);
  return { ok: true, path: entryPath };
}

function disableStartupEntry(name) {
  const entryPath = getStartupEntryPath(name);
  try {
    if (fs.existsSync(entryPath)) {
      fs.unlinkSync(entryPath);
    }
    return { ok: true, path: entryPath };
  } catch (err) {
    return { ok: false, path: entryPath, error: err.message };
  }
}

function resolveServiceScript(filename) {
  const serviceDir = resolveClientServiceDir();
  if (!serviceDir) return null;
  const scriptPath = path.join(serviceDir, filename);
  return fs.existsSync(scriptPath) ? scriptPath : null;
}

function resolveStartupPythonCommand() {
  return (
    resolvePythonInterpreter() ||
    (process.platform === "win32" ? "python" : "python3")
  );
}

async function setLaunchAutoStart(enabled, name, launch) {
  if (!launch?.command || !fs.existsSync(launch.command)) {
    throw new Error(`Launch target not found for ${name}`);
  }
  const workingDir = launch.workingDir || path.dirname(launch.command);
  if (enabled) {
    return enableStartupEntry({
      name,
      command: launch.command,
      args: launch.args || [],
      workingDir,
    });
  }
  return disableStartupEntry(name);
}

function getLaunchctlDomain() {
  try {
    if (typeof process.getuid === "function") {
      return `gui/${process.getuid()}`;
    }
  } catch (_) {
    return null;
  }
  return null;
}

function resolveInstallContext() {
  const config = readClientConfig();
  if (!config) {
    return { config: null, installPath: null, serviceInstallPath: null };
  }

  const normalize = (value) => (value ? path.normalize(value) : null);

  return {
    config,
    installPath: normalize(config.installPath),
    serviceInstallPath: normalize(config.serviceInstallPath),
  };
}

function dedupePaths(paths) {
  const seen = new Set();
  return paths
    .filter(Boolean)
    .map((candidate) => path.normalize(candidate))
    .filter((candidate) => {
      if (seen.has(candidate)) {
        return false;
      }
      seen.add(candidate);
      return true;
    });
}

function resolveClientServiceDir() {
  const { installPath, serviceInstallPath } = resolveInstallContext();
  const candidates = dedupePaths([
    serviceInstallPath && path.join(serviceInstallPath, "client_service"),
    serviceInstallPath,
    installPath && path.join(installPath, "client_service"),
    installPath,
  ]);

  for (const candidate of candidates) {
    try {
      if (
        fs.existsSync(path.join(candidate, "Breakeven_Slave.exe")) ||
        fs.existsSync(path.join(candidate, "Breakeven_Slave.py"))
      ) {
        return candidate;
      }
    } catch (err) {
      console.warn(`[Electron] Unable to inspect ${candidate}:`, err.message);
    }
  }

  return candidates[0] || null;
}

function resolveSlaveLogPath() {
  const serviceDir = resolveClientServiceDir();
  if (!serviceDir) return null;
  return path.join(serviceDir, "logs", "slave.log");
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
    return mainWindow;
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const width = Math.floor(primaryDisplay.size.width * 0.75);
  const height = Math.floor(primaryDisplay.size.height * 0.75);

  mainWindow = new BrowserWindow({
    width,
    height,
    frame: false,
    resizable: true,
    movable: true,
    fullscreenable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  const bundledIndex = resolveBundledRendererIndexPath();
  if (app.isPackaged && bundledIndex) {
    ensureBundledRendererServer(bundledIndex)
      .then((rendererOrigin) => {
        console.log("[Electron] OAuth callback server ready:", rendererOrigin);
      })
      .catch((error) => {
        console.error(
          "[Electron] Failed to start OAuth callback server:",
          error.message,
        );
      });
  }

  if (!app.isPackaged) {
    mainWindow.loadURL("http://localhost:3000");
    console.log("[Electron] Dashboard window launched in development mode");
  } else if (bundledIndex) {
    mainWindow.loadFile(bundledIndex);
    console.log("[Electron] Dashboard window launched in production mode");
    console.log("[Electron] Renderer entry:", bundledIndex);
  } else {
    console.error(
      "[Electron] Could not locate bundled index.html. Checked:",
      bundledIndexCandidates,
    );
  }

  mainWindow.webContents.on("did-fail-load", (_event, code, desc, url) => {
    console.error(
      `[Electron] Renderer failed to load (code=${code}) ${desc} at ${url}`,
    );
  });

  // Start streaming Breakeven_Slave log to renderer
  startSlaveLogTail(mainWindow);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.removeMenu();
  return mainWindow;
}

function startSlaveLogTail(win) {
  const logPath = resolveSlaveLogPath();
  if (!logPath) {
    console.warn(
      "[Electron] No install path available; slave log tail disabled",
    );
    return;
  }

  const logDir = path.dirname(logPath);
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  } catch (mkdirErr) {
    console.warn(
      "[Electron] Unable to create log directory:",
      mkdirErr.message,
    );
  }

  console.log("[Electron] Watching slave log at:", logPath);

  let lastSize = 0;
  let firstRead = true; // <─ important: we want to read existing content once
  const MAX_BYTES_ON_FIRST_READ = 1024 * 64; // 64 KB safety cap for huge logs

  const readNewData = () => {
    fs.stat(logPath, (err, stats) => {
      if (err) {
        // File may not exist yet, just skip this tick
        return;
      }

      // Handle truncation / rotation
      if (stats.size < lastSize) {
        lastSize = 0;
      }

      if (stats.size === lastSize && !firstRead) {
        // No new data
        return;
      }

      // Decide where to start reading from
      let startPos;
      if (firstRead) {
        // On the first read, send existing content too (up to MAX_BYTES_ON_FIRST_READ)
        startPos = Math.max(0, stats.size - MAX_BYTES_ON_FIRST_READ);
      } else {
        // After that, just read from the last known size
        startPos = lastSize;
      }

      if (stats.size <= startPos) {
        firstRead = false;
        lastSize = stats.size;
        return;
      }

      const stream = fs.createReadStream(logPath, {
        start: startPos,
        end: stats.size - 1,
      });

      let buffer = "";
      stream.on("data", (chunk) => {
        buffer += chunk.toString();
      });

      stream.on("end", () => {
        lastSize = stats.size;
        firstRead = false;

        const lines = buffer
          .split(/\r?\n/)
          .map((l) => l.trimEnd())
          .filter((l) => l.length > 0);

        if (lines.length > 0 && !win.isDestroyed()) {
          win.webContents.send("slave-log-lines", lines);
        }
      });
    });
  };

  // Kick off immediately so you see existing logs right away
  readNewData();

  // Then keep polling for new data
  const intervalId = setInterval(readNewData, 1000);

  win.on("closed", () => {
    clearInterval(intervalId);
  });
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    focusMainWindow();
  });

  app.whenReady().then(async () => {
    const startupState = await classifyWindowsStartupLaunch();
    if (startupState.shouldExit) {
      console.log(
        `[Electron] Exiting before UI for transient Windows launch: ${startupState.reason}`,
      );
      app.quit();
      return;
    }

    if (startupState.shouldDelay) {
      console.log(
        `[Electron] Delaying dashboard window for startup stabilization: ${startupState.reason}`,
      );
      await delay(WINDOWS_STARTUP_STABILIZE_DELAY_MS);
    }

    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
        return;
      }

      focusMainWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// IPC handlers

ipcMain.handle("get-slave-log", async () => {
  try {
    const logPath = resolveSlaveLogPath();
    if (!logPath || !fs.existsSync(logPath)) {
      return [];
    }

    const data = await fs.promises.readFile(logPath, "utf-8");

    return data
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0)
      .slice(-1000);
  } catch (err) {
    console.error("[Electron] get-slave-log error:", err);
    return [];
  }
});

ipcMain.handle("select-folder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return result.filePaths[0];
});

ipcMain.handle("get-client-config", () => {
  const fallback = {
    name: "Guest",
    email: null,
    installPath: "Unknown",
  };

  const config = readClientConfig();
  const base = config || fallback;

  // Read the version from the service-side client_config.json if available
  let service_version = null;
  try {
    const svcPath = base.serviceInstallPath;
    if (svcPath) {
      const candidates = [
        path.join(svcPath, "client_config.json"),
        path.join(svcPath, "client_service", "client_config.json"),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          const parsed = JSON.parse(fs.readFileSync(candidate, "utf-8"));
          if (parsed?.version) {
            service_version = parsed.version;
          }
          break;
        }
      }
    }
  } catch (err) {
    console.warn(
      "[Electron] Failed to read service config version:",
      err.message,
    );
  }

  return {
    ...base,
    service_version,
    // Intentionally do NOT inject a default App ID.
    // The App ID must match the Phantom Portal app you configured, otherwise Phantom returns 403.
    phantom_app_id: base.phantom_app_id || null,
    phantom_redirect_url: getEffectivePhantomRedirectUrl(
      base.phantom_redirect_url || process.env.PHANTOM_REDIRECT_URL,
    ),
  };
});

ipcMain.handle("wallet-get-nonce", async (_event, payload = {}) => {
  const address = normalizeWalletAddress(payload?.address, null);
  if (!address) {
    return { ok: false, error: "Invalid wallet address" };
  }

  const now = Date.now();
  const nonce = crypto.randomBytes(16).toString("hex");
  const issuedAtIso = new Date(now).toISOString();
  const expiresAt = now + WALLET_VERIFY_NONCE_TTL_MS;
  const message = buildWalletVerificationMessage(address, nonce, issuedAtIso);

  walletVerificationNonces.set(address, {
    nonce,
    message,
    expiresAt,
  });

  return {
    ok: true,
    nonce,
    message,
    expiresAt,
  };
});

ipcMain.handle("wallet-verify-signature", async (_event, payload = {}) => {
  const address = normalizeWalletAddress(payload?.address, null);
  const message = typeof payload?.message === "string" ? payload.message : "";
  const signatureBase64 =
    typeof payload?.signature === "string" ? payload.signature : "";

  if (!address) {
    return { ok: false, error: "Invalid wallet address" };
  }
  if (!message) {
    return { ok: false, error: "Missing message" };
  }
  if (!signatureBase64) {
    return { ok: false, error: "Missing signature" };
  }

  const record = walletVerificationNonces.get(address);
  if (!record) {
    return {
      ok: false,
      error: "No active verification request. Start verification again.",
    };
  }
  if (record.message !== message) {
    return { ok: false, error: "Verification message mismatch" };
  }
  if (Date.now() > record.expiresAt) {
    walletVerificationNonces.delete(address);
    return { ok: false, error: "Verification request expired" };
  }

  let pubKeyBytes;
  let sigBytes;
  try {
    pubKeyBytes = bs58.decode(address);
    sigBytes = Buffer.from(signatureBase64, "base64");
  } catch (err) {
    return { ok: false, error: "Unable to decode address/signature" };
  }

  if (!(pubKeyBytes instanceof Uint8Array) || pubKeyBytes.length !== 32) {
    return { ok: false, error: "Invalid Solana public key length" };
  }
  if (sigBytes.length !== 64) {
    return { ok: false, error: "Invalid signature length" };
  }

  const msgBytes = Buffer.from(message, "utf8");
  const verified = nacl.sign.detached.verify(msgBytes, sigBytes, pubKeyBytes);
  if (!verified) {
    return { ok: false, error: "Signature did not verify" };
  }

  walletVerificationNonces.delete(address);
  return { ok: true };
});

ipcMain.handle("update-client-config", async (_event, updates = {}) => {
  const current = readClientConfig();
  if (!current) {
    return { ok: false, error: "Unable to read client_config.json" };
  }

  const currentBufferCores = normalizeNonNegativeInteger(
    current.buffer_cores,
    0,
  );

  const currentWallets = Array.isArray(current.wallets) ? current.wallets : [];
  const nextWallets = normalizeWalletList(updates.wallets, currentWallets);
  const requestedDefaultPayout = normalizeWalletAddress(
    updates.default_payout_wallet,
    current.default_payout_wallet ?? null,
  );
  const nextDefaultPayoutWallet = requestedDefaultPayout
    ? nextWallets.some((wallet) => wallet.address === requestedDefaultPayout)
      ? requestedDefaultPayout
      : null
    : requestedDefaultPayout;

  const nextPhantomAppId = normalizePhantomAppId(
    updates.phantom_app_id,
    current.phantom_app_id,
  );

  const nextConfig = {
    ...current,
    name: updates.name ?? current.name,
    email: updates.email ?? current.email,
    buffer_cores: normalizeNonNegativeInteger(
      updates.buffer_cores,
      currentBufferCores,
    ),
    runTrayOnStartup: normalizeBoolean(
      updates.runTrayOnStartup,
      current.runTrayOnStartup,
    ),
    runSlaveOnStartup: normalizeBoolean(
      updates.runSlaveOnStartup,
      current.runSlaveOnStartup,
    ),
    autoUpdate: normalizeBoolean(updates.autoUpdate, current.autoUpdate),
    wallets: nextWallets,
    default_payout_wallet: nextDefaultPayoutWallet,
  };

  if (nextPhantomAppId !== undefined) {
    nextConfig.phantom_app_id = nextPhantomAppId;
  }

  const writeResults = await writeClientConfigToTargets(nextConfig);
  const warnings = [];

  const primaryWrite = writeResults[0];
  const writeFailures = writeResults.filter((result) => !result.ok);
  if (writeFailures.length) {
    writeFailures.forEach((failure) => {
      console.warn(
        "[Electron] Failed to write client_config.json:",
        failure.path,
        failure.error,
      );
      warnings.push({
        setting: "client_config.json",
        error: `${failure.path}: ${failure.error}`,
      });
    });
  }

  const tempResult = await maybeWriteWindowsTempConfig(nextConfig);
  if (tempResult && tempResult.ok === false) {
    console.warn(
      "[Electron] Failed to write client_config.json to Windows temp:",
      tempResult.path,
      tempResult.error,
    );
    warnings.push({
      setting: "windows-temp",
      error: `${tempResult.path}: ${tempResult.error}`,
    });
  }

  const startupResult = await applyStartupConfigChanges(current, nextConfig);
  if (startupResult.warnings?.length) {
    warnings.push(...startupResult.warnings);
  }

  if (!primaryWrite?.ok) {
    return {
      ok: false,
      error:
        "Failed to write client_config.json to the primary dashboard path.",
      warnings,
      config: nextConfig,
    };
  }

  return {
    ok: true,
    config: nextConfig,
    warnings,
  };
});

ipcMain.handle("window-close", () => {
  const win = BrowserWindow.getFocusedWindow();
  if (win) win.close();
});

ipcMain.handle("window-minimize", () => {
  const win = BrowserWindow.getFocusedWindow();
  if (win) win.minimize();
});

ipcMain.handle("get-service-status", async () => buildServiceStatus());

ipcMain.handle("start-slave-service", async () => {
  try {
    await startSlaveProcess();
    return { ok: true };
  } catch (err) {
    console.error("[Electron] Failed to start slave:", err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("stop-slave-service", async () => {
  try {
    await stopSlaveProcess();
    return { ok: true };
  } catch (err) {
    console.error("[Electron] Failed to stop slave:", err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("start-updater-service", async () => {
  try {
    await startUpdaterService();
    return { ok: true };
  } catch (err) {
    console.error("[Electron] Failed to start updater:", err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("stop-updater-service", async () => {
  try {
    await stopUpdaterService();
    return { ok: true };
  } catch (err) {
    console.error("[Electron] Failed to stop updater:", err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("start-tray-service", async () => {
  try {
    await startTrayProcess();
    return { ok: true };
  } catch (err) {
    console.error("[Electron] Failed to start tray:", err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("stop-tray-service", async () => {
  try {
    await stopTrayProcess();
    return { ok: true };
  } catch (err) {
    console.error("[Electron] Failed to stop tray:", err.message);
    return { ok: false, error: err.message };
  }
});

async function captureProcessSnapshot() {
  try {
    const psList = await getPsList();
    const processes = await psList({ all: true });
    return {
      healthy: true,
      list: processes.map((proc) => ({
        pid: proc.pid,
        name: (proc.name || "").toLowerCase(),
        cmd: (proc.cmd || "").toLowerCase(),
      })),
    };
  } catch (err) {
    console.warn("[Electron] Unable to enumerate processes:", err.message);
    return { healthy: false, list: [] };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function matchProcess(processes, tokens) {
  if (!Array.isArray(processes) || !tokens?.length) {
    return null;
  }
  const lowered = tokens.map((token) => token.toLowerCase());
  return processes.find((proc) =>
    lowered.some(
      (token) =>
        (proc.name && proc.name.includes(token)) ||
        (proc.cmd && proc.cmd.includes(token)),
    ),
  );
}

function shouldKillRespawnParent(detail) {
  const parentName = (detail.parentName || "").toLowerCase();
  const parentCmd = (detail.parentCommandLine || "").toLowerCase();
  if (!parentName || !SLAVE_PARENT_ALLOWLIST.includes(parentName)) {
    return false;
  }
  if (parentName === "breakevenslaveservicehost.exe") {
    return true;
  }
  return SLAVE_PARENT_CMD_TOKENS.some((token) => parentCmd.includes(token));
}

function filterProcesses(processes, tokens) {
  if (!Array.isArray(processes) || !tokens?.length) {
    return [];
  }
  const lowered = tokens.map((token) => token.toLowerCase());
  return processes.filter((proc) =>
    lowered.some(
      (token) =>
        (proc.name && proc.name.includes(token)) ||
        (proc.cmd && proc.cmd.includes(token)),
    ),
  );
}

function deriveProcessStatus(key, { label, tokens, snapshot }) {
  const match = matchProcess(snapshot.list, tokens);
  const running = Boolean(match);
  let state;
  if (running) {
    state = "running";
  } else if (!snapshot.healthy) {
    state = "unknown";
  } else {
    state = "stopped";
  }

  return {
    label,
    running,
    state,
    source: "process-list",
    detail: match?.cmd || null,
  };
}

async function getTrayStatus(snapshot) {
  const controller = getTrayController();

  if (controller) {
    let status = null;
    try {
      status = await controller.status();
    } catch (err) {
      console.warn("[Electron] Tray service status check failed:", err.message);
      // Controller failed — fall through to process scan below
    }

    // If the controller gave a definitive running/stopped answer, trust it
    // entirely. Do NOT let the process scan override it; a stale Python process
    // or startup-registered script can match TRAY_SIGNATURES even when the
    // service is stopped.
    if (status && status.state !== "unknown") {
      return { label: "Tray", ...status };
    }
  }

  // No controller, or controller returned unknown — fall back to process scan
  const processFallback = deriveProcessStatus("tray", {
    label: "Tray",
    tokens: TRAY_SIGNATURES,
    snapshot,
  });
  return {
    ...processFallback,
    detail:
      processFallback.state === "running"
        ? "Service status: Running"
        : processFallback.state === "stopped"
          ? "Service status: Stopped"
          : processFallback.detail,
  };
}

async function buildServiceStatus() {
  const snapshot = await captureProcessSnapshot();
  return {
    tray: await getTrayStatus(snapshot),
    slave: await getSlaveStatus(snapshot),
    updater: await getUpdaterStatus(snapshot),
  };
}

async function getSlaveStatus(snapshot) {
  const controller = getSlaveController();
  let status = null;

  if (controller) {
    try {
      status = await controller.status();
    } catch (err) {
      console.warn(
        "[Electron] Slave service status check failed:",
        err.message,
      );
      status = {
        running: false,
        state: "unknown",
        source: controller.source,
        detail: err.message,
      };
    }
  }

  const processFallback = deriveProcessStatus("slave", {
    label: "Slave",
    tokens: SLAVE_SIGNATURES,
    snapshot,
  });

  if (!status) {
    return processFallback;
  }

  if (!status.running && processFallback.running) {
    return {
      label: "Slave",
      running: true,
      state: "running",
      source: status.source || processFallback.source,
      detail: status.detail
        ? `${status.detail}; detected active process`
        : "Detected active slave process",
    };
  }

  return { label: "Slave", ...status };
}

async function getUpdaterStatus(snapshot) {
  const controller = getUpdaterController();
  let status = null;

  if (controller) {
    try {
      status = await controller.status();
    } catch (err) {
      console.warn(
        "[Electron] Updater service status check failed:",
        err.message,
      );
      status = {
        running: false,
        state: "unknown",
        source: controller.source,
        detail: err.message,
      };
    }
  }

  const processFallback = deriveProcessStatus("updater", {
    label: "Updater",
    tokens: UPDATER_SIGNATURES,
    snapshot,
  });

  if (!status) {
    return processFallback;
  }

  if (!status.running && processFallback.running) {
    return {
      label: "Updater",
      running: true,
      state: "running",
      source: status.source || processFallback.source,
      detail: status.detail
        ? `${status.detail}; detected active process`
        : "Detected active updater process",
    };
  }

  return { label: "Updater", ...status };
}

function resolvePythonInterpreter() {
  if (cachedPythonCommand) {
    return cachedPythonCommand;
  }

  const candidates =
    process.platform === "win32"
      ? ["py", "python", "python3"]
      : ["python3", "python"];

  for (const candidate of candidates) {
    try {
      childProcess.execFileSync(candidate, ["--version"], { stdio: "ignore" });
      cachedPythonCommand = candidate;
      return candidate;
    } catch (err) {
      // keep trying
    }
  }

  return null;
}

function resolveSlaveLaunchCommand(serviceDir) {
  if (!serviceDir) {
    return null;
  }

  const exePath = path.join(serviceDir, "Breakeven_Slave.exe");
  if (fs.existsSync(exePath)) {
    return { command: exePath, args: [], shell: false };
  }

  const pyPath = path.join(serviceDir, "Breakeven_Slave.py");
  if (fs.existsSync(pyPath)) {
    const python = resolvePythonInterpreter();
    if (!python) {
      return null;
    }
    return { command: python, args: [pyPath], shell: false };
  }

  const appImagePath = path.join(serviceDir, "Breakeven_Slave-x86_64.AppImage");
  if (fs.existsSync(appImagePath)) {
    return { command: appImagePath, args: [], shell: false };
  }

  return null;
}

function resolveManagedLaunchCommand(serviceDir, binaryNames, scriptName) {
  if (!serviceDir) {
    return null;
  }

  for (const binaryName of binaryNames) {
    const binaryPath = path.join(serviceDir, binaryName);
    if (fs.existsSync(binaryPath)) {
      return { command: binaryPath, args: [], shell: false };
    }
  }

  const scriptPath = path.join(serviceDir, scriptName);
  if (fs.existsSync(scriptPath)) {
    const python = resolveStartupPythonCommand();
    if (!python) {
      return null;
    }
    return { command: python, args: [scriptPath], shell: false };
  }

  return null;
}

function resolveTrayLaunchCommand(serviceDir) {
  return resolveManagedLaunchCommand(
    serviceDir,
    ["tray_app.exe", "Breakeven_Tray.exe", "Breakeven_Tray-x86_64.AppImage"],
    "tray_app.py",
  );
}

function resolveUpdaterLaunchCommand(serviceDir) {
  return resolveManagedLaunchCommand(
    serviceDir,
    ["updater.exe", "Breakeven_Updater.exe", "Breakeven_Updater-x86_64.AppImage"],
    "updater.py",
  );
}

function resolveSlaveStartupCommand() {
  const serviceDir = resolveClientServiceDir();
  const launch = resolveSlaveLaunchCommand(serviceDir);
  if (!launch) {
    return null;
  }
  return {
    command: launch.command,
    args: launch.args || [],
    workingDir: serviceDir,
  };
}

async function setSlaveStartupEnabled(enabled) {
  const controller = getSlaveController();
  let controllerError = null;
  if (controller) {
    try {
      if (enabled) {
        if (controller.enable) {
          await controller.enable();
        }
        if (controller.start) {
          await controller.start();
        }
      } else {
        if (controller.stop) {
          await controller.stop();
        }
        if (controller.disable) {
          await controller.disable();
        }
      }
      return { ok: true, method: controller.source };
    } catch (err) {
      controllerError = err;
    }
  }

  const launch = resolveSlaveStartupCommand();
  if (!launch) {
    throw controllerError || new Error("No slave startup command available");
  }

  const fallbackResult = enabled
    ? enableStartupEntry({
        name: "slave_bot",
        command: launch.command,
        args: launch.args,
        workingDir: launch.workingDir,
      })
    : disableStartupEntry("slave_bot");

  if (controllerError) {
    return {
      ok: fallbackResult.ok !== false,
      warning: controllerError.message,
      method: "startup-entry",
      path: fallbackResult.path,
      error: fallbackResult.error,
    };
  }

  return fallbackResult;
}

async function setTrayStartupEnabled(enabled) {
  const serviceDir = resolveClientServiceDir();
  const launch = resolveTrayLaunchCommand(serviceDir);
  return setLaunchAutoStart(enabled, "tray_app", launch);
}

async function setUpdaterStartupEnabled(enabled) {
  const serviceDir = resolveClientServiceDir();
  const launch = resolveUpdaterLaunchCommand(serviceDir);
  return setLaunchAutoStart(enabled, "updater_service", launch);
}

async function applyStartupConfigChanges(previousConfig, nextConfig) {
  const warnings = [];
  const tasks = [];

  if (
    normalizeBoolean(previousConfig?.runTrayOnStartup, false) !==
    normalizeBoolean(nextConfig?.runTrayOnStartup, false)
  ) {
    tasks.push({
      name: "runTrayOnStartup",
      action: () => setTrayStartupEnabled(nextConfig.runTrayOnStartup),
    });
  }

  if (
    normalizeBoolean(previousConfig?.runSlaveOnStartup, false) !==
    normalizeBoolean(nextConfig?.runSlaveOnStartup, false)
  ) {
    tasks.push({
      name: "runSlaveOnStartup",
      action: () => setSlaveStartupEnabled(nextConfig.runSlaveOnStartup),
    });
  }

  if (
    normalizeBoolean(previousConfig?.autoUpdate, false) !==
    normalizeBoolean(nextConfig?.autoUpdate, false)
  ) {
    tasks.push({
      name: "autoUpdate",
      action: () => setUpdaterStartupEnabled(nextConfig.autoUpdate),
    });
  }

  for (const task of tasks) {
    try {
      const result = await task.action();
      if (result && result.ok === false) {
        warnings.push({
          setting: task.name,
          error: result.error || "Unable to update startup entry",
        });
      } else if (result?.warning) {
        warnings.push({
          setting: task.name,
          error: result.warning,
        });
      }
    } catch (err) {
      warnings.push({
        setting: task.name,
        error: err.message || "Unable to update startup entry",
      });
    }
  }

  return { ok: warnings.length === 0, warnings };
}

async function startSlaveProcess() {
  const controller = getSlaveController();
  if (controller?.start) {
    await controller.start();
    return;
  }
  await launchSlaveBinaryFallback();
}

async function stopSlaveProcess() {
  const controller = getSlaveController();
  if (!controller?.stop) {
    await terminateSlaveProcessesFallback();
    return;
  }

  let controllerError = null;
  try {
    await controller.stop();
  } catch (err) {
    controllerError = err;
  }

  try {
    await terminateSlaveProcessesFallback({ allowNoProcess: true });
  } catch (cleanupErr) {
    if (controllerError) {
      const message = `${controllerError.message}; ${cleanupErr.message}`;
      throw new Error(message);
    }
    throw cleanupErr;
  }

  if (controllerError) {
    throw controllerError;
  }
}

async function startUpdaterService() {
  const controller = getUpdaterController();
  if (!controller?.start) {
    throw new Error("Updater service control unavailable on this platform");
  }
  await controller.start();
}

async function stopUpdaterService() {
  const controller = getUpdaterController();
  if (!controller?.stop) {
    throw new Error("Updater service control unavailable on this platform");
  }
  await controller.stop();
}

async function startTrayProcess() {
  const controller = getTrayController();
  if (controller?.start) {
    await controller.start();
    return;
  }
  await launchTrayBinaryFallback();
}

async function stopTrayProcess() {
  const controller = getTrayController();
  if (!controller?.stop) {
    await terminateTrayProcessesFallback();
    return;
  }

  let controllerError = null;
  try {
    await controller.stop();
  } catch (err) {
    controllerError = err;
  }

  try {
    await terminateTrayProcessesFallback({ allowNoProcess: true });
  } catch (cleanupErr) {
    if (controllerError) {
      throw new Error(`${controllerError.message}; ${cleanupErr.message}`);
    }
    throw cleanupErr;
  }

  if (controllerError) {
    throw controllerError;
  }

  // Wait up to 3 seconds for the tray process to fully exit so the next
  // status poll reflects the stopped state correctly.
  for (let i = 0; i < 6; i++) {
    await sleep(500);
    const snapshot = await captureProcessSnapshot();
    const remaining = filterProcesses(snapshot.list, TRAY_SIGNATURES);
    if (!remaining.length) break;
  }
}

async function launchTrayBinaryFallback() {
  const serviceDir = resolveClientServiceDir();
  if (!serviceDir || !fs.existsSync(serviceDir)) {
    throw new Error(
      "Client service directory not found. Check client_config.json paths.",
    );
  }

  const candidates = [
    path.join(serviceDir, "tray_app.exe"),
    path.join(serviceDir, "Breakeven_Tray.exe"),
    path.join(serviceDir, "Breakeven_Tray-x86_64.AppImage"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const child = childProcess.spawn(candidate, [], {
        cwd: serviceDir,
        detached: true,
        stdio: "ignore",
        shell: false,
      });
      child.unref();
      return;
    }
  }

  const pyPath = path.join(serviceDir, "tray_app.py");
  if (fs.existsSync(pyPath)) {
    const python = resolvePythonInterpreter();
    if (!python) {
      throw new Error("Python interpreter not found to launch tray_app.py");
    }
    const child = childProcess.spawn(python, [pyPath], {
      cwd: serviceDir,
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.unref();
    return;
  }

  throw new Error(
    "No Tray binary or tray_app.py found in the service directory.",
  );
}

async function terminateTrayProcessesFallback(options = {}) {
  const { allowNoProcess = false } = options;
  const snapshot = await captureProcessSnapshot();
  const matches = filterProcesses(snapshot.list, TRAY_SIGNATURES);

  if (!matches.length) {
    if (allowNoProcess) return;
    throw new Error("Tray process is not running.");
  }

  if (process.platform === "win32") {
    try {
      const pidList = matches.map((p) => p.pid).join(",");
      const script = `
$targetPids = @(${pidList})
foreach ($pid in $targetPids) {
  try { Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue } catch {}
}
`;
      await execPowerShellWithElevationFallback(script, {
        alwaysElevateOnFailure: true,
      });
    } catch {
      // ignore
    }
    await taskkillImage("tray_app.exe");
    await taskkillImage("Breakeven_Tray.exe");
  } else {
    for (const proc of matches) {
      try {
        process.kill(proc.pid, "SIGTERM");
      } catch (err) {
        console.warn(
          `[Electron] Failed to kill tray pid ${proc.pid}:`,
          err.message,
        );
      }
    }
  }
}

async function launchSlaveBinaryFallback() {
  const serviceDir = resolveClientServiceDir();
  if (!serviceDir || !fs.existsSync(serviceDir)) {
    throw new Error(
      "Client service directory not found. Check client_config.json paths.",
    );
  }

  const launch = resolveSlaveLaunchCommand(serviceDir);
  if (!launch) {
    throw new Error(
      "No Breakeven_Slave binary found in the service directory.",
    );
  }

  const child = childProcess.spawn(launch.command, launch.args, {
    cwd: serviceDir,
    detached: true,
    stdio: "ignore",
    shell: launch.shell || false,
  });

  child.unref();
}

async function terminateSlaveProcessesFallback(options = {}) {
  const {
    allowNoProcess = false,
    retryDelayMs = 5000,
    retryAttempts = 3,
    signatures = SLAVE_TERMINATION_SIGNATURES,
  } = options;
  const snapshot = await captureProcessSnapshot();
  const matches = filterProcesses(snapshot.list, signatures);

  if (!matches.length) {
    if (allowNoProcess) {
      return;
    }
    throw new Error("Slave process is not running.");
  }

  const errors = [];
  if (process.platform === "win32") {
    await enforceWindowsSlaveServiceStop({ allowElevation: true });
    const killByPidList = async (processes, options = {}) => {
      const { allowElevation = true } = options;
      if (!processes.length) {
        return;
      }
      const pidList = processes.map((proc) => proc.pid).join(",");
      const script = `
$targetPids = @(${pidList})
$errors = @()
foreach ($pid in $targetPids) {
  try {
    $proc = Get-Process -Id $pid -ErrorAction Stop
    Stop-Process -Id $pid -Force -ErrorAction Stop
  } catch {
    $errors += $_.Exception.Message
  }
}
$remaining = @()
foreach ($pid in $targetPids) {
  try {
    Get-Process -Id $pid -ErrorAction Stop | Out-Null
    $remaining += $pid
  } catch {}
}
  if ($remaining.Count -gt 0) {
  throw "Unable to terminate slave processes: $($remaining -join ', ')"
}
`;
      try {
        const direct = await execPowerShell(script);
        if (direct.exitCode === 0 || !allowElevation) {
          return;
        }
        await execPowerShellWithElevationFallback(script, {
          alwaysElevateOnFailure: true,
        });
      } catch (err) {
        throw new Error(err.message || "Unable to terminate slave processes");
      }
    };

    const killByImageFallback = async () => {
      await taskkillImage("Breakeven_Slave.exe");
      await taskkillImage("BreakEvenSlaveServiceHost.exe");
    };

    try {
      await killByPidList(matches, { allowElevation: true });
    } catch (err) {
      await killByImageFallback();
    }

    if (retryDelayMs > 0 && retryAttempts > 0) {
      for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
        await sleep(retryDelayMs);
        const retrySnapshot = await captureProcessSnapshot();
        const retryMatches = filterProcesses(retrySnapshot.list, signatures);
        if (!retryMatches.length) {
          break;
        }
        await enforceWindowsSlaveServiceStop({ allowElevation: false });
        await killByImageFallback();
        const respawnDetails = await getWindowsProcessDetails(
          retryMatches.map((proc) => proc.pid),
        );
        const parentPids = respawnDetails
          .filter(shouldKillRespawnParent)
          .map((detail) => detail.parentPid)
          .filter((pid) => Number.isInteger(pid));
        if (parentPids.length) {
          await killByPidList(
            parentPids.map((pid) => ({ pid })),
            {
              allowElevation: false,
            },
          );
        }
        try {
          await killByPidList(retryMatches, { allowElevation: false });
        } catch (err) {
          await killByImageFallback();
        }
        if (attempt === retryAttempts - 1) {
          await runWindowsSlaveKillLoop({ durationSeconds: 20 });
          const finalSnapshot = await captureProcessSnapshot();
          const finalMatches = filterProcesses(finalSnapshot.list, signatures);
          if (finalMatches.length) {
            const finalDetails = await getWindowsProcessDetails(
              finalMatches.map((proc) => proc.pid),
            );
            const detailSummary = finalDetails
              .map((detail) => {
                const parentName = detail.parentName || "unknown";
                const parentPid = Number.isInteger(detail.parentPid)
                  ? detail.parentPid
                  : "?";
                return `pid ${detail.pid} parent ${parentName} (${parentPid})`;
              })
              .join("; ");
            const suffix = detailSummary ? ` ${detailSummary}` : "";
            throw new Error(
              `Slave process reopened after stop attempt.${suffix}`,
            );
          }
        }
      }
    }

    return;
  }

  for (const proc of matches) {
    try {
      process.kill(proc.pid, "SIGTERM");
    } catch (err) {
      errors.push(err.message);
    }
  }

  if (errors.length === matches.length) {
    throw new Error(errors[0] || "Unable to terminate slave processes");
  }
}
