export function decodeJwtPayload(token: string): any {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }
    const payloadBase64Url = parts[1];
    // Base64Url to Base64
    const payloadBase64 = payloadBase64Url.replace(/-/g, '+').replace(/_/g, '/');
    const payloadJson = Buffer.from(payloadBase64, 'base64').toString('utf8');
    return JSON.parse(payloadJson);
  } catch (error) {
    throw new Error('Failed to decode JWT payload: ' + (error as Error).message);
  }
}
