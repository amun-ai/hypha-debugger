/**
 * Screenshot capture service using html-to-image.
 *
 * Images are downscaled before being returned so agents don't receive
 * multi-megabyte base64 payloads that can crash their context window.
 */
import { toPng, toJpeg } from "html-to-image";

/**
 * Resize an image data URL via a canvas. Returns a new data URL at the
 * requested format/quality. Maintains aspect ratio: fits within
 * (maxWidth × maxHeight) without distortion.
 */
async function resizeDataUrl(
  dataUrl: string,
  maxWidth: number,
  maxHeight: number,
  format: "png" | "jpeg",
  quality: number,
): Promise<{ dataUrl: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const srcW = img.naturalWidth;
      const srcH = img.naturalHeight;
      // Compute scale to fit within bounds (but never upscale)
      const scale = Math.min(maxWidth / srcW, maxHeight / srcH, 1);
      const dstW = Math.max(1, Math.round(srcW * scale));
      const dstH = Math.max(1, Math.round(srcH * scale));

      const canvas = document.createElement("canvas");
      canvas.width = dstW;
      canvas.height = dstH;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Could not get 2D canvas context"));
        return;
      }
      // Fill white background for JPEG (no alpha support)
      if (format === "jpeg") {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, dstW, dstH);
      }
      ctx.drawImage(img, 0, 0, dstW, dstH);
      const mime = format === "jpeg" ? "image/jpeg" : "image/png";
      const out = canvas.toDataURL(mime, quality);
      resolve({ dataUrl: out, width: dstW, height: dstH });
    };
    img.onerror = () => reject(new Error("Failed to load image for resizing"));
    img.src = dataUrl;
  });
}

export async function takeScreenshot(
  selector?: string,
  format?: "png" | "jpeg",
  quality?: number,
  max_width?: number,
  max_height?: number,
  full_page?: boolean,
): Promise<
  | {
      data: string;
      format: string;
      width: number;
      height: number;
      size_kb: number;
    }
  | { error: string }
> {
  // Agent-friendly defaults: JPEG, moderate quality, capped at 1024px,
  // viewport-only (not the entire scrollable page).
  const fmt = format ?? "jpeg";
  const qual = quality ?? 0.75;
  const maxW = max_width ?? 1024;
  const maxH = max_height ?? 1024;
  const capturePage = full_page ?? false;

  // Pick target:
  //   - explicit selector → that element
  //   - full_page=true → document.documentElement (the entire scrollable page)
  //   - default → viewport-sized region (clipped to window size)
  let target: Element | null;
  if (selector) {
    target = document.querySelector(selector);
    if (!target) {
      return { error: `No element found for selector: ${selector}` };
    }
  } else if (capturePage) {
    target = document.documentElement;
  } else {
    target = document.body;
  }

  try {
    const node = target as HTMLElement;

    // For viewport-only captures, limit html-to-image's output size
    // to the viewport dimensions.
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    const captureOptions: any = {
      quality: qual,
      pixelRatio: 1, // always capture at 1x — we'll resize after
      cacheBust: true,
      skipAutoScale: true,
      filter: (el: HTMLElement) => {
        // Exclude the debugger overlay and cursor from screenshots
        return (
          el.id !== "hypha-debugger-host" &&
          el.id !== "hypha-debugger-cursor" &&
          el.id !== "playwright-highlight-container"
        );
      },
    };

    if (!selector && !capturePage) {
      // Viewport-only capture: constrain canvas to window size
      captureOptions.width = viewportW;
      captureOptions.height = viewportH;
    }

    let dataUrl: string;
    if (fmt === "jpeg") {
      dataUrl = await toJpeg(node, captureOptions);
    } else {
      dataUrl = await toPng(node, captureOptions);
    }

    // Resize down to fit within (maxW × maxH) and re-encode
    const resized = await resizeDataUrl(dataUrl, maxW, maxH, fmt, qual);
    const sizeKb = Math.round((resized.dataUrl.length * 0.75) / 1024); // rough base64 → bytes

    return {
      data: resized.dataUrl,
      format: fmt,
      width: resized.width,
      height: resized.height,
      size_kb: sizeKb,
    };
  } catch (err: any) {
    return { error: `Screenshot failed: ${err.message ?? err}` };
  }
}

takeScreenshot.__schema__ = {
  name: "takeScreenshot",
  description:
    "Capture a screenshot of the current viewport, a specific element, or the full page. " +
    "Returns a base64-encoded data URL, downscaled to fit within max_width × max_height " +
    "(default 1024px) to keep the payload small enough for AI agents. Defaults to JPEG " +
    "format at 0.75 quality for reasonable file size.",
  parameters: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description:
          "CSS selector of the element to capture. Omit to capture the viewport (or full page if full_page=true).",
      },
      format: {
        type: "string",
        enum: ["png", "jpeg"],
        description:
          'Image format. Default: "jpeg" (much smaller than PNG). Use "png" for sharp text.',
      },
      quality: {
        type: "number",
        description:
          "JPEG quality (0–1). Default: 0.75. Ignored for PNG. Lower = smaller payload.",
      },
      max_width: {
        type: "number",
        description:
          "Maximum output width in pixels. Default: 1024. Image is scaled down preserving aspect ratio.",
      },
      max_height: {
        type: "number",
        description:
          "Maximum output height in pixels. Default: 1024. Image is scaled down preserving aspect ratio.",
      },
      full_page: {
        type: "boolean",
        description:
          "If true, capture the entire scrollable page instead of just the viewport. Default: false.",
      },
    },
  },
};
