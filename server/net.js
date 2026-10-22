"use strict";

const os = require("node:os");

function isPrivateIPv4(ip) {
  if (!ip) return false;
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isPrivateAddress(addr) {
  if (!addr) return false;
  const clean = String(addr).replace(/^::ffff:/, "");
  if (clean === "::1" || clean === "localhost") return true;
  if (clean.startsWith("fe80:") || clean.startsWith("fc") || clean.startsWith("fd")) return true;
  return isPrivateIPv4(clean);
}

function localIPv4() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const item of list || []) {
      if (item.family !== "IPv4" || item.internal) continue;
      candidates.push({ name, address: item.address });
    }
  }
  const preferred = candidates.find((c) => c.address.startsWith("192.168.")) ||
    candidates.find((c) => c.address.startsWith("10.")) ||
    candidates.find((c) => /^172\.(1[6-9]|2\d|3[01])\./.test(c.address)) ||
    candidates[0];
  return preferred || { name: "loopback", address: "127.0.0.1" };
}

function localAddresses() {
  const set = new Set(["127.0.0.1", "::1"]);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === "IPv4" && !item.internal) set.add(item.address);
    }
  }
  return set;
}

function normalizeAddress(addr) {
  return String(addr || "").replace(/^::ffff:/, "");
}

/** 本机（含通过局域网地址访问本机）判定，用于保护控制台与 admin API。 */
function isLocalRequest(req) {
  const addr = normalizeAddress(req.socket.remoteAddress);
  if (addr === "127.0.0.1" || addr === "::1") return true;
  return localAddresses().has(addr);
}

function originFor(req) {
  const host = req.headers.host || "";
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${host}`;
}

module.exports = {
  isPrivateIPv4,
  isPrivateAddress,
  localIPv4,
  localAddresses,
  normalizeAddress,
  isLocalRequest,
  originFor
};
