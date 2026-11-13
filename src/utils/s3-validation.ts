/**
  People Portal Server
  Copyright (C) 2026  Atheesh Thirumalairajan
  Copyright (C) 2025  Ian Coutinho

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { CopyObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "crypto";
import { s3Client, BUCKET_NAME } from "../clients/AWSClient/S3Client";

export const FILE_SIGNATURES = {
    PNG: "89504e47",
    JPEG: "ffd8ff",
    GIF: "47494638",
    WEBP: "52494646", // RIFF
    PDF: "25504446"  // %PDF
};

/**
 * Validates the file signature (magic numbers) of a file stored in S3.
 * 
 * @param key The S3 key of the file to validate.
 * @param allowedSignatures An array of allowed hexadecimal signatures.
 * @returns Promise<boolean> True if the file signature matches any of the allowed signatures, false otherwise.
 */
export async function validateS3FileSignature(key: string, allowedSignatures: string[]): Promise<boolean> {
    try {
        const { Body } = await s3Client.send(new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            Range: "bytes=0-7"
        }));

        if (!Body) return false;

        const byteArray = await Body.transformToByteArray();
        let header = "";
        for (let i = 0; i < byteArray.length; i++) {
            const byte = byteArray[i];
            if (byte !== undefined) {
                header += byte.toString(16).padStart(2, '0');
            }
        }

        return allowedSignatures.some(sig => header.startsWith(sig.toLowerCase()));
    } catch (e) {
        console.error(`Signature check failed for key: ${key}`, e);
        return false;
    }
}

/**
 * Computes the SHA-256 of an S3 object's full contents. Used to fingerprint
 * resumes (10MB max) so identical files can share one set of ATS scores.
 * Unlike the S3 ETag, this is always a true content hash regardless of
 * upload method or bucket encryption.
 *
 * @param key The S3 key of the object to hash.
 * @returns Hex-encoded SHA-256 digest. Throws if the object cannot be read.
 */
export async function getS3ObjectSha256(key: string): Promise<string> {
    const { Body } = await s3Client.send(new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key
    }));

    if (!Body) throw new Error(`S3 object has no body: ${key}`);
    const bytes = await Body.transformToByteArray();
    return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Copies an object within the configured bucket. Used to give each
 * application its own immutable copy of the applicant's resume.
 *
 * @param sourceKey Key of the object to copy.
 * @param destinationKey Key to copy it to (overwritten if it exists).
 */
export async function copyS3Object(sourceKey: string, destinationKey: string): Promise<void> {
    await s3Client.send(new CopyObjectCommand({
        Bucket: BUCKET_NAME,
        CopySource: `${BUCKET_NAME}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`,
        Key: destinationKey
    }));
}
