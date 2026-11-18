const utf8 = new TextEncoder();

export async function deriveKey(password, salt) {
  const material = await crypto.subtle.importKey(
    "raw",
    utf8.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bytes = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new Uint8Array(salt),
      iterations: 600000,
    },
    material,
    256,
  );
  return Array.from(new Uint8Array(bytes));
}

async function aes(bytes) {
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(bytes),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

export async function seal(entries, secret, { salt, deviceKey }) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await aes(secret),
    utf8.encode(JSON.stringify(entries)),
  );
  return {
    version: 1,
    ...(deviceKey ? { deviceKey } : { salt }),
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(ciphertext)),
  };
}

export async function protect(entries, password) {
  if (password === null) {
    const deviceKey = Array.from(crypto.getRandomValues(new Uint8Array(32)));
    return { record: await seal(entries, deviceKey, { deviceKey }) };
  }
  if (typeof password !== "string" || password.length < 12)
    throw Error("Use at least 12 characters for your master password.");
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)));
  const key = await deriveKey(password, salt);
  return { record: await seal(entries, key, { salt }), key };
}

export async function unseal(record, secret) {
  if (record.version !== 1)
    throw Error("This vault requires a newer version of Aprion.");
  try {
    const bytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(record.iv) },
      await aes(secret),
      new Uint8Array(record.data),
    );
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw Error(
      record.deviceKey
        ? "Could not read the local vault."
        : "Could not unlock this vault. Check your master password.",
    );
  }
}
