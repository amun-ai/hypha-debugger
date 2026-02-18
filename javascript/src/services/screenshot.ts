/**
 * Screenshot capture service using html-to-image.
 */
import { toPng, toJpeg } from "html-to-image";

export async function takeScreenshot(options?: {
  selector?: string;
  format?: "png" | "jpeg";
  quality?: number;
  scale?: number;
  max_width?: number;
  max_height?: number;
}): Promise<{ data: string; format: string; width: number; height: number } | { error: string }> {
  const selector = options?.selector;
  const format = options?.format ?? "png";
  const quality = options?.quality ?? 0.92;
  const scale = options?.scale ?? 1;

  const target = selector ? document.querySelector(selector) : document.body;
  if (!target) {
    return { error: `No element found for selector: ${selector}` };
  }

  try {
    const node = target as HTMLElement;
    const captureOptions = {
      quality,
      pixelRatio: scale,
      cacheBust: true,
      skipAutoScale: true,
      // Filter out the debugger overlay itself
      filter: (el: HTMLElement) => {
        return el.id !== "hypha-debugger-host";
      },
    };

    let dataUrl: string;
    if (format === "jpeg") {
      dataUrl = await toJpeg(node, captureOptions);
    } else {
      dataUrl = await toPng(node, captureOptions);
    }

    // Get dimensions
    const rect = node.getBoundingClientRect();
    let width = Math.round(rect.width * scale);
    let height = Math.round(rect.height * scale);

    // Optionally resize if too large
    const maxW = options?.max_width;
    const maxH = options?.max_height;
    if (maxW && width > maxW) {
      const ratio = maxW / width;
      width = maxW;
      height = Math.round(height * ratio);
    }
    if (maxH && height > maxH) {
      const ratio = maxH / height;
      height = maxH;
      width = Math.round(width * ratio);
    }

    return {
      data: dataUrl,
      format,
      width,
      height,
    };
  } catch (err: any) {
    return { error: `Screenshot failed: ${err.message ?? err}` };
  }
}

takeScreenshot.__schema__ = {
  name: "takeScreenshot",
  description:
    "Capture a screenshot of the entire page or a specific element. Returns a base64-encoded data URL.",
  parameters: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description:
          "CSS selector of the element to capture. Omit to capture the entire page body.",
      },
      format: {
        type: "string",
        enum: ["png", "jpeg"],
        description: 'Image format. Default: "png".',
      },
      quality: {
        type: "number",
        description: "Image quality (0-1) for JPEG. Default: 0.92.",
      },
      scale: {
        type: "number",
        description: "Pixel ratio / scale factor. Default: 1. Use 2 for retina.",
      },
      max_width: {
        type: "number",
        description: "Maximum width in pixels. Image will be scaled down if larger.",
      },
      max_height: {
        type: "number",
        description: "Maximum height in pixels. Image will be scaled down if larger.",
      },
    },
  },
};
