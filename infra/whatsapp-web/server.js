import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import QRCode from "qrcode";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  normalizeMessageContent,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

const PORT = Number(process.env.PORT || 3030);
const DATA_DIR = process.env.DATA_DIR || "/data/auth";
const API_URL = (process.env.RAKAZO_API_URL || "http://api:3100").replace(/\/$/, "");
const TOKEN = process.env.WHATSAPP_WEB_TOKEN || "";
const APP_SECRET = process.env.WHATSAPP_WEB_APP_SECRET || "";
const PHONE_NUMBER_ID = process.env.WHATSAPP_WEB_PHONE_NUMBER_ID || "rakazo-web";
const VERIFY_TOKEN = process.env.WHATSAPP_WEB_VERIFY_TOKEN || "";
if (!TOKEN || !APP_SECRET || !VERIFY_TOKEN) throw new Error("WhatsApp Web gateway secrets are required");

let socket;
let status = "starting";
let qrDataUrl = null;
let connectedPhone = null;
let retryTimer;
let starting = false;
let explicitLogout = false;
const sentMessageIds = new Set();
const logger = pino({ level: process.env.LOG_LEVEL || "info", base: { service: "rakazo-whatsapp-web" } });

function authorized(req) {
  const value = req.headers.authorization || "";
  const expected = `Bearer ${TOKEN}`;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function reply(res, statusCode, value) {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
}
async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new Error("request too large");
  }
  return JSON.parse(body || "{}");
}
function socketText(message) {
  const content = normalizeMessageContent(message.message || {});
  if (!content) return "";
  return content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || content.documentMessage?.caption || "";
}
async function postInbound({ id, from, name, text, timestamp }) {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "rakazo-web", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: connectedPhone || "", phone_number_id: PHONE_NUMBER_ID },
      contacts: [{ profile: { name: name || from }, wa_id: from }],
      messages: [{ from, id, timestamp: String(timestamp || Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
    } }] }],
  });
  const signature = createHmac("sha256", APP_SECRET).update(body).digest("hex");
  const response = await fetch(`${API_URL}/api/v1/messaging/webhook/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${signature}` },
    body,
  });
  if (!response.ok) throw new Error(`Rakazo inbound returned HTTP ${response.status}`);
}
async function startSocket() {
  if (starting || (socket && status === "connected")) return;
  starting = true;
  explicitLogout = false;
  status = "connecting";
  try {
    await mkdir(DATA_DIR, { recursive: true });
    const { state: auth, saveCreds } = await useMultiFileAuthState(DATA_DIR);
    const version = await fetchLatestBaileysVersion().catch(() => undefined);
    socket = makeWASocket({
      ...(version ? { version: version.version } : {}),
      auth,
      logger: logger.child({ component: "baileys" }, { level: "silent" }),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      shouldSyncHistoryMessage: () => false,
      browser: Browsers.macOS("Rakazo"),
    });
    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("connection.update", async (update) => {
      if (update.qr) {
        qrDataUrl = await QRCode.toDataURL(update.qr, { width: 280, margin: 2, errorCorrectionLevel: "M" });
        status = "qr";
      }
      if (update.connection === "open") {
        status = "connected";
        qrDataUrl = null;
        connectedPhone = socket?.user?.id?.split(":")[0]?.split("@")[0] || null;
        logger.info({ connectedPhone }, "WhatsApp Web session connected");
      }
      if (update.connection === "close") {
        const code = update.lastDisconnect?.error?.output?.statusCode;
        socket = undefined;
        connectedPhone = null;
        qrDataUrl = null;
        if (explicitLogout || code === DisconnectReason.loggedOut) {
          status = "logged_out";
          return;
        }
        status = "reconnecting";
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => void startSocket(), 2500);
      }
    });
    socket.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const message of messages) {
        try {
          const remote = message.key.remoteJidAlt || message.key.remoteJid || "";
          const remoteNumber = remote.split("@")[0].split(":")[0];
          const ownNumber = socket?.user?.id?.split(":")[0]?.split("@")[0] || "";
          const selfChat = Boolean(ownNumber && remoteNumber === ownNumber);
          if (message.key.fromMe && (!selfChat || sentMessageIds.has(message.key.id || ""))) continue;
          if (message.key.remoteJid?.endsWith("@g.us") || message.key.remoteJid?.endsWith("@broadcast")) continue;
          const text = socketText(message);
          if (!text.trim()) continue;
          const from = message.key.fromMe ? ownNumber : remoteNumber;
          if (!/^\d{5,20}$/.test(from)) {
            logger.warn({ remote }, "Ignoring message without a routable phone number");
            continue;
          }
          await postInbound({ id: message.key.id || `${Date.now()}`, from, name: message.pushName, text, timestamp: message.messageTimestamp });
        } catch (error) {
          logger.error({ err: error }, "Failed to forward WhatsApp inbound message");
        }
      }
    });
  } catch (error) {
    status = "error";
    logger.error({ err: error }, "WhatsApp Web startup failed");
    throw error;
  } finally {
    starting = false;
  }
}
async function sendText(to, text) {
  if (!socket || status !== "connected") throw new Error("WhatsApp Web is not connected");
  const target = `${String(to).replace(/\D/g, "")}@s.whatsapp.net`;
  if (!/^\d{5,20}@s\.whatsapp\.net$/.test(target)) throw new Error("Invalid WhatsApp recipient");
  const sent = await socket.sendMessage(target, { text });
  const id = sent.key.id || "rakazo-" + Date.now();
  sentMessageIds.add(id);
  const cleanup = setTimeout(() => sentMessageIds.delete(id), 60_000);
  cleanup.unref?.();
  return id;
}

const server = createServer(async (req, res) => {
  try {
    if (req.url === "/healthz" && req.method === "GET") return reply(res, 200, { ok: true, status });
    if (!authorized(req)) return reply(res, 401, { error: "unauthorized" });
    if (req.url === "/_rakazo/status" && req.method === "GET") return reply(res, 200, { enabled: true, status, qrDataUrl, phone: connectedPhone });
    if (req.url === "/_rakazo/connect" && req.method === "POST") {
      if (status === "logged_out" || status === "error") void startSocket().catch(() => undefined);
      return reply(res, 200, { accepted: true });
    }
    if (req.url === "/_rakazo/logout" && req.method === "POST") {
      explicitLogout = true;
      clearTimeout(retryTimer);
      const current = socket;
      socket = undefined;
      status = "logged_out";
      qrDataUrl = null;
      connectedPhone = null;
      if (current) await current.logout().catch(() => undefined);
      await rm(DATA_DIR, { recursive: true, force: true });
      return reply(res, 200, { ok: true });
    }
    const url = new URL(req.url || "/", "http://localhost");
    const match = url.pathname.match(/^\/v\d+\.\d+\/([^/]+)\/messages$/);
    if (match && req.method === "POST") {
      const payload = await readJson(req);
      if (payload.messaging_product !== "whatsapp" || !payload.to) return reply(res, 400, { error: { message: "Unsupported WhatsApp payload" } });
      const text = payload.text?.body || payload.template?.components?.map((x) => x.parameters?.map((p) => p.text).join(" ")).join(" ") || "";
      if (!text) return reply(res, 400, { error: { message: "Only text messages are supported over WhatsApp Web" } });
      const id = await sendText(payload.to, text);
      return reply(res, 200, { messaging_product: "whatsapp", contacts: [{ input: String(payload.to), wa_id: String(payload.to) }], messages: [{ id }] });
    }
    if (match && req.method === "GET") return reply(res, 200, { id: PHONE_NUMBER_ID, display_phone_number: connectedPhone || "", verified_name: "Rakazo WhatsApp Web" });
    return reply(res, 404, { error: "not found" });
  } catch (error) {
    logger.error({ err: error }, "WhatsApp gateway request failed");
    return reply(res, 500, { error: "internal error" });
  }
});
server.listen(PORT, "0.0.0.0", () => {
  logger.info({ port: PORT }, "WhatsApp Web gateway listening");
  void startSocket().catch(() => undefined);
});
process.on("SIGTERM", () => { clearTimeout(retryTimer); server.close(); void socket?.end(undefined); });
