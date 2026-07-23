export async function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {

  const buf = bytes instanceof Uint8Array
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    : bytes;

  const digest = await crypto.subtle.digest('SHA-256', buf as ArrayBuffer);

  //convert hash to string
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
