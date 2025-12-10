const { execSync } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const isWin = os.platform() === "win32";
const isCI = process.env.GITHUB_ACTIONS === "true";
const dashboardDir = process.cwd();

const assetsToDownload = [
    {
        name: "video-bg.mp4",
        url: "https://socket.breakeventx.com/beta/video-bg.mp4"
    }
];

async function downloadLargeAssetsIfCI() {
    if (!isCI) {
        console.log("💻 Local environment detected. Skipping asset download.");
        return;
    }
    else {
        console.log("💻 GIT CI environment detected. Proceeding with asset download.");
    }

    console.log("🌐 CI detected. Downloading required assets from VPS...");
    for (const { name, url } of assetsToDownload) {
        const destPath = path.join(dashboardDir, name);
        if (fs.existsSync(destPath)) {
            if (isCI) {
                console.log(`♻️ ${ name } exists.Overwriting with fresh copy from VPS...`);
            } else {
                console.log(`✅ ${ name } already exists locally.Skipping download.`);
                continue;
            }
        }

        console.log(`📥 Downloading ${ url }...`);
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${ res.status }: ${ res.statusText } `);
            const buffer = await res.buffer();
            fs.writeFileSync(destPath, buffer);
            console.log(`✅ Saved ${ name } to ${ destPath } `);
        } catch (err) {
            console.error(`❌ Failed to fetch ${ name }:`, err.message);
            process.exit(1);
        }
    }
}

async function runBuild() {
    const platform = process.platform;
    console.log("🖥️ Detected platform:", platform);

    let forgeCmd = "npx electron-forge make";

    if (platform === "win32") {
        forgeCmd += " --platform win32";
    } else if (platform === "darwin") {
        forgeCmd += " --platform darwin";
    } else if (platform === "linux") {
        forgeCmd += " --platform linux";
    }

    await downloadLargeAssetsIfCI();

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
    }
}

runBuild().catch(err => {
    console.error("❌ Build failed:", err.message);
    process.exit(1);
});
