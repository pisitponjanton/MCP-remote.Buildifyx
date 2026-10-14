import { AgentError } from '../core/errors.js';

const MAX_PIXELS = 16_000_000;
const MAX_SIDE = 8192;
const MAX_BYTES = 16 * 1024 * 1024;
function fault(message) { return new AgentError('BROWSER_SCREENSHOT_LIMIT', message); }

// An existing persistent Chromium context cannot change its DPR via the normal
// Playwright viewport API. CDP temporarily emulates metrics on ONE selected
// page, without creating a second browser/profile or copying its cookies.
export async function captureConfiguredPage(page, {
  viewport, deviceScaleFactor = 1, mobile = false, scale = 'css',
  mode = 'viewport', format = 'png', timeoutMs = 15000
} = {}) {
  const original = page.viewportSize();
  const target = viewport ?? original;
  if (!original || !target
    || !Number.isInteger(target.width) || !Number.isInteger(target.height)
    || target.width < 240 || target.height < 240
    || target.width > 4096 || target.height > 4096
    || !Number.isFinite(deviceScaleFactor) || deviceScaleFactor < 1 || deviceScaleFactor > 3
    || !['css','device'].includes(scale) || !['viewport','fullPage'].includes(mode)
    || !Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30000
    || !['png','jpeg'].includes(format)) throw fault('Invalid screenshot device configuration.');
  const ratio = scale === 'device' ? deviceScaleFactor : 1;
  if (target.width * ratio > MAX_SIDE || target.height * ratio > MAX_SIDE
    || target.width * target.height * ratio * ratio > MAX_PIXELS) throw fault('Screenshot dimensions exceed the pixel limit.');
  const changed = target.width !== original.width || target.height !== original.height;
  let cdp;
  try {
    if (changed) await page.setViewportSize(target);
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: target.width, height: target.height, deviceScaleFactor, mobile,
      screenWidth: target.width, screenHeight: target.height
    });
    // The override must be active for the *screenshot itself*. Playwright's
    // screenshot() temporarily resets device metrics in some versions; use CDP.
    const dims = await page.evaluate(full => {
      const d=document.documentElement;
      return {width:full?Math.max(d.scrollWidth,window.innerWidth):window.visualViewport?.width??window.innerWidth,
        height:full?Math.max(d.scrollHeight,window.innerHeight):window.visualViewport?.height??window.innerHeight};
    },mode==='fullPage');
    // For a viewport capture, output dimensions are the requested viewport
    // even if an HTML page without a viewport meta tag uses a 980px mobile
    // layout viewport. Full-page mode instead uses the scrollable layout.
    const width = mode === 'viewport' ? target.width : Math.ceil(dims.width);
    const height = mode === 'viewport' ? target.height : Math.ceil(dims.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)
      || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE
      || width * ratio > MAX_SIDE || height * ratio > MAX_SIDE
      || width * height * ratio * ratio > MAX_PIXELS) throw fault('Page exceeds screenshot pixel limits.');
    let deadline;
    let screenshot;
    try {
      screenshot = await Promise.race([
        cdp.send('Page.captureScreenshot', {
          format, ...(format==='jpeg'?{quality:85}:{}),
          fromSurface:true, captureBeyondViewport:mode==='fullPage',
          clip:{x:0,y:0,width,height,scale:scale==='css'?1/deviceScaleFactor:1}
        }),
        new Promise((_,reject)=>{
          deadline=setTimeout(()=>reject(new AgentError('BROWSER_SCREENSHOT_TIMEOUT','Screenshot capture timed out.')),timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(deadline);
    }
    const buffer=Buffer.from(screenshot.data,'base64');
    if (buffer.length===0 || buffer.length>MAX_BYTES) throw fault('Screenshot is empty or exceeds the image size limit.');
    return {buffer,layoutViewport:target,deviceScaleFactor,mobileLayout:mobile};
  } finally {
    try {
      if (cdp) {
        await cdp.send('Emulation.clearDeviceMetricsOverride');
        await cdp.detach();
      }
    } finally {
      if (changed) await page.setViewportSize(original);
    }
  }
}
