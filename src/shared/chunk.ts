const CHUNK_BYTES = 1024 * 1024;

export function bytesToChunks(bytes: Uint8Array): string[] {

  const chunks: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {

    const subarray = bytes.subarray(offset, offset + CHUNK_BYTES);
    let binary = '';

    //razdelimo na kose po 2 ^ 15 elementov zato da ne presezemo Maximum call stack size
    for (let i = 0; i < subarray.length; i += 0x8000) {
      binary += String.fromCharCode(...subarray.subarray(i, i + 0x8000));
    }

    //btoa() : string -> base64 string
    chunks.push(btoa(binary));
  }
  return chunks.length > 0 ? chunks : [''];
}

export function chunksToBytes(chunks: string[]): Uint8Array {

  const parts = chunks.map((chunk) => {

    //atob() : base64 string -> string
    const binary = atob(chunk);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  });

  const totalSize = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(totalSize);

  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}
