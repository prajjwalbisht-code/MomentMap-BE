"use strict";

const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const config = require("../config");

const s3Client = new S3Client({
    region: config.aws.region,
    credentials: {
        accessKeyId: config.aws.accessKeyId,
        secretAccessKey: config.aws.secretAccessKey,
    },
});

/**
 * Upload a string body to S3.
 * @param {string} key         - S3 object key (path inside the bucket)
 * @param {string} body        - File content as a string
 * @param {string} contentType - MIME type (e.g. "application/json")
 */
async function uploadToS3(key, body, contentType) {
    const bucket = config.aws.bucketName;

    if (!bucket || bucket === "YOUR_BUCKET_NAME") {
        console.warn("⚠️  S3 upload skipped — bucket name not configured.");
        return null;
    }

    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
    });

    await s3Client.send(command);
    return `s3://${bucket}/${key}`;
}

/**
 * Lists all objects under a specific prefix (folder).
 * @param {string} prefix - The folder path in S3 (e.g. "2026-03/")
 * @returns {Promise<Array>} - List of object summaries
 */
async function listObjectsInS3(prefix) {
    const bucket = config.aws.bucketName;
    if (!bucket || bucket === "YOUR_BUCKET_NAME") return [];

    try {
        const command = new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
        });
        const response = await s3Client.send(command);
        return response.Contents || [];
    } catch (err) {
        console.error(`❌ Failed to list objects at prefix "${prefix}":`, err.message);
        return [];
    }
}

/**
 * Downloads an object from S3 and returns its body as a string.
 * @param {string} key - S3 object key
 * @returns {Promise<string|null>} - Object content as string
 */
async function getObjectFromS3(key) {
    const bucket = config.aws.bucketName;
    if (!bucket || bucket === "YOUR_BUCKET_NAME") return null;

    try {
        const command = new GetObjectCommand({
            Bucket: bucket,
            Key: key,
        });
        const response = await s3Client.send(command);
        const body = await response.Body.transformToString();
        return body;
    } catch (err) {
        if (err.name === "NoSuchKey") return null;
        console.error(`❌ Failed to get object "${key}":`, err.message);
        return null;
    }
}

module.exports = { uploadToS3, listObjectsInS3, getObjectFromS3 };
