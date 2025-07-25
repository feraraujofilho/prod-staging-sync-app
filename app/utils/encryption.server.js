import crypto from "crypto";

// Use environment variable for encryption key, or generate one
const ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString("hex");

console.log(
  "ENCRYPTION_KEY from env:",
  process.env.ENCRYPTION_KEY ? "loaded" : "not loaded",
);
console.log("ENCRYPTION_KEY length:", ENCRYPTION_KEY.length);

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
