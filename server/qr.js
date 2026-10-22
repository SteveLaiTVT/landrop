"use strict";

const qrcode = require("./vendor/qrcode.js");

const DARK = "#0f1512";

/**
 * 生成紧凑、可缩放的二维码 SVG。
 * 用 path 描述所有暗色模块，避免几百个 <rect>。
 */
function qrSvg(text, options = {}) {
  // QR 规范要求至少 4 个模块的静默区，手机相机才稳定识别
  const margin = options.margin ?? 4;
  const qr = qrcode(0, "M");
  qr.addData(String(text), "Byte");
  qr.make();
  const count = qr.getModuleCount();
  const size = count + margin * 2;
  let path = "";
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.isDark(row, col)) continue;
      path += `M${col + margin} ${row + margin}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="100%" height="100%" role="img" aria-label="连接二维码" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#ffffff"/><path d="${path}" fill="${DARK}"/></svg>`;
}

module.exports = { qrSvg };
