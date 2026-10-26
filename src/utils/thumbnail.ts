import { api } from '@/api/client';

/**
 * 缩略图生成
 *
 * 上传时（以及历史文件首次进入视口时）在浏览器里把原图缩到 400px 再上传，
 * 列表页因此只下载几十 KB 的小图，而不是 10MB 的原图。
 *
 * 三个实现细节：
 * 1. 逐级折半降采样 —— 4000px 一步缩到 400px 会有明显锯齿，先反复折半到目标 2 倍以内再收尾；
 * 2. 优先 WebP，浏览器不支持时回退 JPEG；
 * 3. 任何一步失败都返回 null，调用方退回图标，不影响上传主流程。
 */

/** 目标最长边。卡片显示区约 96px，2x/3x 屏幕下 400px 足够清晰 */
const MAX_DIMENSION = 400;

const WEBP_QUALITY = 0.82;
const JPEG_QUALITY = 0.85;

/** WebP 结果超过这个体积就改投 JPEG（照片类素材偶有反超） */
const WEBP_SIZE_LIMIT = 120 * 1024;

/** 源图超过这个体积不做前端解码，避免一张巨图把标签页内存打满 */
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

/** 与服务端 ALLOWED_THUMB_TYPES 保持一致的输入白名单 */
const SUPPORTED_MIME = /^image\/(jpeg|png|webp|gif|bmp|avif)$/i;

export function isThumbnailableImage(mime: string | null | undefined): boolean {
  return !!mime && SUPPORTED_MIME.test(mime);
}

interface Size {
  width: number;
  height: number;
}

interface Surface {
  ctx: CanvasRenderingContext2D;
  toBlob: (type: string, quality: number) => Promise<Blob | null>;
}

function fitInside(width: number, height: number, max: number): Size {
  if (width <= max && height <= max) {
    return { width: Math.max(1, width), height: Math.max(1, height) };
  }
  const scale = max / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function createSurface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      return {
        ctx: ctx as unknown as CanvasRenderingContext2D,
        toBlob: (type, quality) => canvas.convertToBlob({ type, quality }),
      };
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  return {
    ctx,
    toBlob: (type, quality) =>
      new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality)),
  };
}

/**
 * 逐级折半降采样。
 *
 * 直接把 4000×3000 画进 400×300 时，浏览器为了速度只采样少量像素，边缘会糊或出锯齿；
 * 每次缩一半重复若干次，等效于面积平均，质量接近专业缩放库。
 */
function renderTo(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  target: Size
): Surface {
  let current: CanvasImageSource = source;
  let currentWidth = sourceWidth;
  let currentHeight = sourceHeight;

  // 先反复折半，直到当前尺寸不超过目标的两倍
  while (currentWidth > target.width * 2 && currentHeight > target.height * 2) {
    const nextWidth = Math.max(target.width, Math.round(currentWidth / 2));
    const nextHeight = Math.max(target.height, Math.round(currentHeight / 2));

    const step = createSurface(nextWidth, nextHeight);
    step.ctx.imageSmoothingEnabled = true;
    step.ctx.imageSmoothingQuality = 'high';
    step.ctx.drawImage(current, 0, 0, currentWidth, currentHeight, 0, 0, nextWidth, nextHeight);

    current = step.ctx.canvas as unknown as CanvasImageSource;
    currentWidth = nextWidth;
    currentHeight = nextHeight;
  }

  const final = createSurface(target.width, target.height);
  final.ctx.imageSmoothingEnabled = true;
  final.ctx.imageSmoothingQuality = 'high';
  final.ctx.drawImage(current, 0, 0, currentWidth, currentHeight, 0, 0, target.width, target.height);

  return final;
}

async function decode(
  source: Blob
): Promise<{ image: CanvasImageSource; width: number; height: number; release: () => void } | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      // from-image：按 EXIF 方向摆正，手机拍的照片不会躺倒
      const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
      return {
        image: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      try {
        const bitmap = await createImageBitmap(source);
        return {
          image: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          release: () => bitmap.close(),
        };
      } catch {
        /* 继续走 <img> 回退 */
      }
    }
  }

  const url = URL.createObjectURL(source);
  const img = await new Promise<HTMLImageElement | null>((resolve) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => resolve(null);
    element.src = url;
  });

  if (!img) {
    URL.revokeObjectURL(url);
    return null;
  }

  return {
    image: img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    release: () => URL.revokeObjectURL(url),
  };
}

/** 生成缩略图；不支持的格式或解码失败返回 null */
export async function createThumbnail(source: Blob): Promise<Blob | null> {
  if (!isThumbnailableImage(source.type)) return null;
  if (source.size === 0 || source.size > MAX_SOURCE_BYTES) return null;

  const decoded = await decode(source);
  if (!decoded) return null;

  try {
    if (!decoded.width || !decoded.height) return null;

    const surface = renderTo(
      decoded.image,
      decoded.width,
      decoded.height,
      fitInside(decoded.width, decoded.height, MAX_DIMENSION)
    );

    const webp = await surface.toBlob('image/webp', WEBP_QUALITY);
    if (webp && webp.type === 'image/webp' && webp.size > 0) {
      if (webp.size <= WEBP_SIZE_LIMIT) return webp;
      return (await surface.toBlob('image/jpeg', JPEG_QUALITY)) ?? webp;
    }

    // Safari 老版本 toBlob 会静默返回 PNG（体积反而更大），明确改走 JPEG
    const jpeg = await surface.toBlob('image/jpeg', JPEG_QUALITY);
    if (jpeg && jpeg.type === 'image/jpeg' && jpeg.size > 0) return jpeg;

    return webp && webp.size > 0 ? webp : null;
  } catch {
    return null;
  } finally {
    decoded.release();
  }
}

/**
 * 把生成的缩略图回传给服务端，返回可直接使用的地址。
 * 失败不是致命错误：当前会话仍能用本地 objectURL 显示，下次进目录会重新回填。
 */
export async function uploadThumbnail(fileId: string, thumb: Blob): Promise<string | null> {
  const ext = thumb.type === 'image/jpeg' ? 'jpg' : 'webp';
  const formData = new FormData();
  formData.append('thumb', thumb, `thumb.${ext}`);

  try {
    const data = await api.put<{ thumb_url: string | null }>(`/files/${fileId}/thumb`, formData);
    return data.thumb_url;
  } catch {
    return null;
  }
}
