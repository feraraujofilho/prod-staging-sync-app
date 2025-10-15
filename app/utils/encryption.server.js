import crypto from "crypto";

// Use environment variable for encryption key; require it in non-test environments
const ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ||
  (process.env.NODE_ENV === "test"
    ? crypto.randomBytes(32).toString("hex")
    : null);

if (!ENCRYPTION_KEY) {
  throw new Error(
    "ENCRYPTION_KEY environment variable is required for token encryption.",
  );
}

// Convert hex string to Buffer for use with crypto functions
const getKeyBuffer = () => {
  // If the key is 64 characters, it's likely a hex string (32 bytes = 64 hex chars)
  if (ENCRYPTION_KEY.length === 64) {
    return Buffer.from(ENCRYPTION_KEY, "hex");
  }
  // Otherwise, treat it as a UTF-8 string and ensure it's 32 bytes
  return Buffer.from(ENCRYPTION_KEY.padEnd(32, "0").slice(0, 32), "utf-8");
};

const IV_LENGTH = 16; // For AES, this is always 16

function isHex(str) {
  return /^[0-9a-fA-F]+$/.test(str);
}

function isProbablyEncrypted(text) {
  if (typeof text !== "string") return false;
  const idx = text.indexOf(":");
  if (idx === -1) return false;
  const ivHex = text.slice(0, idx);
  return ivHex.length === IV_LENGTH * 2 && isHex(ivHex);
}

export function encrypt(text) {
  if (!text) return null;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-cbc", getKeyBuffer(), iv);

  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);

  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

export function decrypt(text) {
  if (!text) return null;

  try {
    // Backward compatibility: if value doesn't look encrypted, treat it as plaintext
    if (!isProbablyEncrypted(text)) {
      return text;
    }

    const textParts = text.split(":");
    const iv = Buffer.from(textParts.shift(), "hex");
    const encryptedText = Buffer.from(textParts.join(":"), "hex");

    const decipher = crypto.createDecipheriv("aes-256-cbc", getKeyBuffer(), iv);

    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString();
  } catch (error) {
    console.error("Decryption error:", error);
    console.error(
      "This usually means the encryption key has changed. Please update the store connection.",
    );
    return null;
  }
}
