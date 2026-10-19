import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { chromium } from "../apps/web/node_modules/@playwright/test/index.mjs";

const publicDir = "/Users/felix/workspace/lixionary/lixionary-whistleblower/apps/web/public";
const appDir = "/Users/felix/workspace/lixionary/lixionary-whistleblower/apps/web/src/app";
const fontsDir = path.join(appDir, "fonts");

const cormorantBase64 = fs.readFileSync(path.join(fontsDir, "cormorant-garamond-latin-400-normal.woff2")).toString("base64");
const interBase64 = fs.readFileSync(path.join(fontsDir, "inter-latin-500-normal.woff2")).toString("base64");

// 1. Logo Mark SVG
function getLogoMarkSvg({ includeBackground = false, bgRadius = 112 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%" fill="none">
  <defs>
    <linearGradient id="tile-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1f2130" />
      <stop offset="50%" stop-color="#141520" />
      <stop offset="100%" stop-color="#0c0d14" />
    </linearGradient>

    <linearGradient id="shield-rim-left" x1="102" y1="54" x2="256" y2="462" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#38bdf8" />
      <stop offset="25%" stop-color="#6366f1" />
      <stop offset="65%" stop-color="#4338ca" />
      <stop offset="100%" stop-color="#312e81" />
    </linearGradient>

    <linearGradient id="shield-rim-right" x1="410" y1="54" x2="256" y2="462" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#fbbf24" />
      <stop offset="25%" stop-color="#f59e0b" />
      <stop offset="45%" stop-color="#b45309" />
      <stop offset="75%" stop-color="#4338ca" />
      <stop offset="100%" stop-color="#1e1b4b" />
    </linearGradient>

    <linearGradient id="inner-left" x1="138" y1="92" x2="256" y2="420" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#2a2e4a" />
      <stop offset="50%" stop-color="#181b2f" />
      <stop offset="100%" stop-color="#0e101d" />
    </linearGradient>

    <linearGradient id="inner-right" x1="374" y1="92" x2="256" y2="420" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#1d1f30" />
      <stop offset="50%" stop-color="#131422" />
      <stop offset="100%" stop-color="#0a0b12" />
    </linearGradient>

    <linearGradient id="wave-grad-1" x1="184" y1="332" x2="216" y2="232" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#4f46e5" />
      <stop offset="50%" stop-color="#6366f1" />
      <stop offset="100%" stop-color="#38bdf8" />
    </linearGradient>

    <linearGradient id="wave-grad-2" x1="216" y1="368" x2="270" y2="188" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#4338ca" />
      <stop offset="40%" stop-color="#6366f1" />
      <stop offset="85%" stop-color="#38bdf8" />
      <stop offset="100%" stop-color="#a5f3fc" />
    </linearGradient>

    <linearGradient id="wave-grad-3" x1="250" y1="404" x2="336" y2="156" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#3730a3" />
      <stop offset="35%" stop-color="#4f46e5" />
      <stop offset="70%" stop-color="#6366f1" />
      <stop offset="90%" stop-color="#38bdf8" />
      <stop offset="100%" stop-color="#fde68a" />
    </linearGradient>

    <filter id="shield-shadow" x="-20%" y="-10%" width="140%" height="130%">
      <feDropShadow dx="0" dy="16" stdDeviation="22" flood-color="#000000" flood-opacity="0.55" />
      <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#4f46e5" flood-opacity="0.3" />
    </filter>
  </defs>

  ${includeBackground ? `<rect x="24" y="24" width="464" height="464" rx="${bgRadius}" fill="url(#tile-bg)" stroke="#2b2d40" stroke-width="2" />` : ""}

  <g filter="url(#shield-shadow)">
    <path d="M 256,54 L 102,118 L 102,266 C 102,342 166,412 256,462 L 256,420 C 188,376 138,318 138,256 L 138,142 L 256,92 Z"
          fill="url(#shield-rim-left)" />

    <path d="M 256,54 L 410,118 L 410,266 C 410,342 346,412 256,462 L 256,420 C 324,376 374,318 374,256 L 374,142 L 256,92 Z"
          fill="url(#shield-rim-right)" />

    <path d="M 234,63 L 256,54 L 278,63 L 268,70 L 256,65 L 244,70 Z"
          fill="#ffffff" opacity="0.95" />

    <path d="M 256,92 L 138,142 L 138,256 C 138,318 188,376 256,420 Z"
          fill="url(#inner-left)" />

    <path d="M 256,92 L 374,142 L 374,256 C 374,318 324,376 256,420 Z"
          fill="url(#inner-right)" />

    <line x1="256" y1="92" x2="256" y2="420" stroke="#373d60" stroke-width="1.5" opacity="0.6" />
    <line x1="256" y1="54" x2="256" y2="92" stroke="#f1f5f9" stroke-width="2" opacity="0.85" />

    <path d="M 184,332 C 182,292 195,254 216,232"
          fill="none" stroke="url(#wave-grad-1)" stroke-width="26" stroke-linecap="round" />

    <path d="M 216,368 C 218,300 240,230 270,188"
          fill="none" stroke="url(#wave-grad-2)" stroke-width="26" stroke-linecap="round" />

    <path d="M 250,404 C 258,312 290,214 336,156"
          fill="none" stroke="url(#wave-grad-3)" stroke-width="26" stroke-linecap="round" />
  </g>
</svg>`;
}

// 2. Full Horizontal Logo SVG
function getFullLogoSvg({ isDark = false, width = 540, height = 100 } = {}) {
  const inkColor = isDark ? "#faf9f5" : "#141413";
  const mutedColor = isDark ? "#a09d96" : "#63615b";
  const dividerColor = isDark ? "#3b3730" : "#e6dfd8";
  const dotColor = "#4f46e5";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 540 100" width="${width}" height="${height}" fill="none">
  <defs>
    <style>
      @font-face {
        font-family: 'Cormorant Garamond';
        font-style: normal;
        font-weight: 400;
        src: url(data:font/woff2;base64,${cormorantBase64}) format('woff2');
      }
      @font-face {
        font-family: 'Inter';
        font-style: normal;
        font-weight: 500;
        src: url(data:font/woff2;base64,${interBase64}) format('woff2');
      }
      .logo-wordmark {
        font-family: 'Cormorant Garamond', Georgia, serif;
        font-size: 46px;
        font-weight: 400;
        letter-spacing: -0.5px;
        fill: ${inkColor};
      }
      .logo-dot {
        fill: ${dotColor};
      }
      .logo-caption {
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 14px;
        font-weight: 500;
        letter-spacing: 2px;
        text-transform: uppercase;
        fill: ${mutedColor};
      }
    </style>

    <linearGradient id="shield-rim-left" x1="102" y1="54" x2="256" y2="462" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#38bdf8" />
      <stop offset="25%" stop-color="#6366f1" />
      <stop offset="65%" stop-color="#4338ca" />
      <stop offset="100%" stop-color="#312e81" />
    </linearGradient>

    <linearGradient id="shield-rim-right" x1="410" y1="54" x2="256" y2="462" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#fbbf24" />
      <stop offset="25%" stop-color="#f59e0b" />
      <stop offset="45%" stop-color="#b45309" />
      <stop offset="75%" stop-color="#4338ca" />
      <stop offset="100%" stop-color="#1e1b4b" />
    </linearGradient>

    <linearGradient id="inner-left" x1="138" y1="92" x2="256" y2="420" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#2a2e4a" />
      <stop offset="50%" stop-color="#181b2f" />
      <stop offset="100%" stop-color="#0e101d" />
    </linearGradient>

    <linearGradient id="inner-right" x1="374" y1="92" x2="256" y2="420" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#1d1f30" />
      <stop offset="50%" stop-color="#131422" />
      <stop offset="100%" stop-color="#0a0b12" />
    </linearGradient>

    <linearGradient id="wave-grad-1" x1="184" y1="332" x2="216" y2="232" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#4f46e5" />
      <stop offset="50%" stop-color="#6366f1" />
      <stop offset="100%" stop-color="#38bdf8" />
    </linearGradient>

    <linearGradient id="wave-grad-2" x1="216" y1="368" x2="270" y2="188" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#4338ca" />
      <stop offset="40%" stop-color="#6366f1" />
      <stop offset="85%" stop-color="#38bdf8" />
      <stop offset="100%" stop-color="#a5f3fc" />
    </linearGradient>

    <linearGradient id="wave-grad-3" x1="250" y1="404" x2="336" y2="156" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#3730a3" />
      <stop offset="35%" stop-color="#4f46e5" />
      <stop offset="70%" stop-color="#6366f1" />
      <stop offset="90%" stop-color="#38bdf8" />
      <stop offset="100%" stop-color="#fde68a" />
    </linearGradient>

    <filter id="logo-shield-shadow" x="-20%" y="-10%" width="140%" height="130%">
      <feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#000000" flood-opacity="0.3" />
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#4f46e5" flood-opacity="0.25" />
    </filter>
  </defs>

  <g transform="translate(12, 16) scale(0.17)" filter="url(#logo-shield-shadow)">
    <path d="M 256,54 L 102,118 L 102,266 C 102,342 166,412 256,462 L 256,420 C 188,376 138,318 138,256 L 138,142 L 256,92 Z"
          fill="url(#shield-rim-left)" />

    <path d="M 256,54 L 410,118 L 410,266 C 410,342 346,412 256,462 L 256,420 C 324,376 374,318 374,256 L 374,142 L 256,92 Z"
          fill="url(#shield-rim-right)" />

    <path d="M 234,63 L 256,54 L 278,63 L 268,70 L 256,65 L 244,70 Z"
          fill="#ffffff" opacity="0.9" />

    <path d="M 256,92 L 138,142 L 138,256 C 138,318 188,376 256,420 Z"
          fill="url(#inner-left)" />

    <path d="M 256,92 L 374,142 L 374,256 C 374,318 324,376 256,420 Z"
          fill="url(#inner-right)" />

    <line x1="256" y1="92" x2="256" y2="420" stroke="#373d60" stroke-width="1.5" opacity="0.6" />
    <line x1="256" y1="54" x2="256" y2="92" stroke="#f1f5f9" stroke-width="2" opacity="0.85" />

    <path d="M 184,332 C 182,292 195,254 216,232"
          fill="none" stroke="url(#wave-grad-1)" stroke-width="26" stroke-linecap="round" />

    <path d="M 216,368 C 218,300 240,230 270,188"
          fill="none" stroke="url(#wave-grad-2)" stroke-width="26" stroke-linecap="round" />

    <path d="M 250,404 C 258,312 290,214 336,156"
          fill="none" stroke="url(#wave-grad-3)" stroke-width="26" stroke-linecap="round" />
  </g>

  <text x="110" y="68" class="logo-wordmark">Speak Up<tspan class="logo-dot">.</tspan></text>
  <line x1="308" y1="38" x2="308" y2="74" stroke="${dividerColor}" stroke-width="1.5" />
  <text x="326" y="60" class="logo-caption">Lixionary</text>
</svg>`;
}

async function buildAll() {
  console.log("Generating SVG assets...");

  const markSvg = getLogoMarkSvg({ includeBackground: false });
  const tileSvg = getLogoMarkSvg({ includeBackground: true, bgRadius: 108 });
  const logoLightSvg = getFullLogoSvg({ isDark: false });
  const logoDarkSvg = getFullLogoSvg({ isDark: true });

  // Write SVGs
  fs.writeFileSync(path.join(publicDir, "logo-mark.svg"), markSvg);
  fs.writeFileSync(path.join(publicDir, "icon.svg"), markSvg);
  fs.writeFileSync(path.join(publicDir, "favicon.svg"), markSvg);
  fs.writeFileSync(path.join(appDir, "icon.svg"), markSvg);

  fs.writeFileSync(path.join(publicDir, "logo.svg"), logoLightSvg);
  fs.writeFileSync(path.join(publicDir, "logo-dark.svg"), logoDarkSvg);

  // Web manifest
  const webManifest = {
    name: "Speak Up — Confidential Reporting",
    short_name: "Speak Up",
    description: "Secure and confidential whistleblowing reporting platform by Lixionary.",
    start_url: "/",
    display: "standalone",
    background_color: "#faf9f5",
    theme_color: "#4f46e5",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png"
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png"
      },
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml"
      }
    ]
  };
  fs.writeFileSync(path.join(publicDir, "site.webmanifest"), JSON.stringify(webManifest, null, 2));

  console.log("Rendering raster PNG assets using Playwright Chromium...");
  const browser = await chromium.launch();

  // 1. Standalone logo-mark.png (1024x1024)
  {
    const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;background:transparent;display:flex;align-items:center;justify-content:center;height:100vh;">${markSvg}</body></html>`);
    await page.screenshot({ path: path.join(publicDir, "logo-mark.png"), omitBackground: true });
    await page.close();
  }

  // 2. Icon 512x512 with app tile
  {
    const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;background:transparent;display:flex;align-items:center;justify-content:center;height:100vh;">${tileSvg}</body></html>`);
    await page.screenshot({ path: path.join(publicDir, "icon-512.png"), omitBackground: true });
    await page.close();
  }

  // 3. Icon 192x192 with app tile
  {
    const page = await browser.newPage({ viewport: { width: 192, height: 192 }, deviceScaleFactor: 1 });
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;background:transparent;display:flex;align-items:center;justify-content:center;height:100vh;">${tileSvg}</body></html>`);
    await page.screenshot({ path: path.join(publicDir, "icon-192.png"), omitBackground: true });
    await page.close();
  }

  // 4. Apple Touch Icon 180x180 (solid dark surface per Apple specs)
  {
    const page = await browser.newPage({ viewport: { width: 180, height: 180 }, deviceScaleFactor: 1 });
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;background:#141520;display:flex;align-items:center;justify-content:center;height:100vh;">${markSvg}</body></html>`);
    await page.screenshot({ path: path.join(publicDir, "apple-touch-icon.png") });
    await page.close();
  }

  // 5. Full Logo PNG (Light) 1080x200 @ 2x
  {
    const page = await browser.newPage({ viewport: { width: 540, height: 100 }, deviceScaleFactor: 2 });
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;background:transparent;display:flex;align-items:center;padding:0;">${logoLightSvg}</body></html>`);
    await page.screenshot({ path: path.join(publicDir, "logo.png"), omitBackground: true });
    await page.close();
  }

  // 6. Full Logo PNG (Dark) 1080x200 @ 2x
  {
    const page = await browser.newPage({ viewport: { width: 540, height: 100 }, deviceScaleFactor: 2 });
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;background:transparent;display:flex;align-items:center;padding:0;">${logoDarkSvg}</body></html>`);
    await page.screenshot({ path: path.join(publicDir, "logo-dark.png"), omitBackground: true });
    await page.close();
  }

  await browser.close();
  console.log("All vector and PNG assets rendered successfully!");

  // 7. Generate favicon.ico using python PIL
  console.log("Generating multi-resolution favicon.ico via Python PIL...");
  const pyScript = `
from PIL import Image

src_img = Image.open("${path.join(publicDir, "icon-512.png")}")
sizes = [(16, 16), (32, 32), (48, 48)]
src_img.save("${path.join(publicDir, "favicon.ico")}", format="ICO", sizes=sizes)
print("Saved multi-size favicon.ico")
`;
  execSync(`python3 -c '${pyScript}'`);
  console.log("Build completed successfully!");
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
