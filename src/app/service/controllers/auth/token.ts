// utils/token.ts
import argon2 from "argon2";
import { getRandomValues } from "crypto";

const REFRESH_PEPPER = process.env.REFRESH_PEPPER ?? "";

export async function hashRefresh(token: string, salt: string): Promise<string> {
    return argon2.hash(token + REFRESH_PEPPER + salt, { type: argon2.argon2id });
}

export async function verifyRefresh(token: string, salt: string, hash: string): Promise<boolean> {
    return argon2.verify(hash, token + REFRESH_PEPPER + salt);
}

const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function generateRefreshToken(length: number = 64): string {
    let token = '';
    const array = new Uint32Array(length);
    getRandomValues(array); // ブラウザ / Deno の場合
    // Node.js の場合は: require('crypto').randomFillSync(array);

    for (let i = 0; i < length; i++) {
        token += chars[array[i] % chars.length];
    }
    return token;
}

export async function genTokenSet(): Promise<{ jti: string, verifier: string, salt: string, hash: string }> {
    const jti = generateRefreshToken(22);
    const verifier = generateRefreshToken(43);
    const salt = generateRefreshToken(22);

    // saltは任意。ここでは使わずにH(verifier||pepper)だけでもOK
    const hash = await hashRefresh(verifier, salt);

    return { jti, verifier, salt, hash };
}