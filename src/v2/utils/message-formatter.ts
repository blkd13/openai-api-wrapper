// src/utils/message-formatter.ts
import { Observable, forkJoin, of, map } from 'rxjs';
import * as fs from 'fs';
import sizeOf from 'image-size';
import { detect } from 'jschardet';
import {
    ChatCompletionCreateParamsStreaming,
    ChatCompletionContentPart,
    ChatCompletionMessageParam,
    ChatCompletionContentPartImage,
    ChatCompletionContentPartRefusal
} from 'openai/resources/chat/completions';

// Lists of supported file extensions
import {
    audioExtensions,
    videoExtensions,
    imageExtensions,
    plainExtensions,
    plainMime,
    disabledMimeList,
    disabledFilenameList,
    extensionLanguageMap
} from '../config/file-extensions.js';

/**
 * Metadata about the content counts
 */
export interface ContentCountObject {
    image: number;
    audio: number;
    video: number;
}

/**
 * Calculate token cost for an image based on dimensions
 * @param width Image width
 * @param height Image height
 * @param detail Detail level
 * @returns Token count estimate
 */
function calculateImageTokenCost(
    width: number,
    height: number,
    detail: 'low' | 'high' | 'auto' = 'high'
): number {
    if (detail === 'low') {
        return 85;
    }

    // Scale down the image to fit within 2048x2048 square if necessary
    if (width > 2048 || height > 2048) {
        const scaleFactor = Math.min(2048 / width, 2048 / height);
        width *= scaleFactor;
        height *= scaleFactor;
    }

    // Scale the image such that the shortest side is 768px
    const scaleFactor = 768 / Math.min(width, height);
    width *= scaleFactor;
    height *= scaleFactor;

    // Count how many 512px squares the image consists of
    const numSquares = Math.ceil(width / 512) * Math.ceil(height / 512);

    // Each square costs 170 tokens, with an additional 85 tokens flat cost
    return 170 * numSquares + 85;
}

/**
 * Clean and normalize messages for AI providers
 * @param args Chat completion parameters
 * @param allowLocalFiles Whether to allow loading local files
 * @returns Observable with normalized arguments and content counts
 */
export function normalizeMessages(
    args: ChatCompletionCreateParamsStreaming,
    allowLocalFiles: boolean
): Observable<{
    args: ChatCompletionCreateParamsStreaming;
    countObject: ContentCountObject;
}> {
    const countObject: ContentCountObject = { image: 0, audio: 0, video: 0 };
    const normalizedArgs = { ...args };

    // Process each message
    return forkJoin(
        normalizedArgs.messages.map(message => {
            if (Array.isArray(message.content)) {
                // Process content parts in each message
                return forkJoin(
                    message.content.map(content => processContentPart(content, countObject, allowLocalFiles))
                ).pipe(
                    map(contents => {
                        message.content = contents as ChatCompletionContentPart[];
                        return message;
                    })
                );
            }
            return of(message);
        })
    ).pipe(
        map(() => {
            // Clean up messages by removing empty ones
            normalizedArgs.messages = normalizedArgs.messages.filter(message =>
                hasContent(message)
            );

            // Combine consecutive messages from the same role
            normalizedArgs.messages = combineConsecutiveMessages(normalizedArgs.messages);

            return { args: normalizedArgs, countObject };
        })
    );
}

/**
 * Process an individual content part, handling files and media
 * @param content Content part to process
 * @param countObject Object to track token counts
 * @param allowLocalFiles Whether to allow loading local files
 * @returns Observable with processed content
 */
function processContentPart(
    content: ChatCompletionContentPart | ChatCompletionContentPartRefusal,
    countObject: ContentCountObject,
    allowLocalFiles: boolean
): Observable<ChatCompletionContentPart | ChatCompletionContentPartRefusal> {
    if (content.type === 'image_url' && content.image_url && content.image_url.url) {
        // Handle image URLs
        if (content.image_url.url.startsWith('file:///')) {
            if (allowLocalFiles) {
                return processLocalImage(content, countObject);
            } else {
                throw new Error('Local file access is forbidden');
            }
        } else if (content.image_url.url.startsWith('data:')) {
            return processDataUrl(content, countObject);
        }
    }

    return of(content);
}

/**
 * Process a local image file
 * @param content Content part with the image
 * @param countObject Object to track token counts
 * @returns Observable with processed content
 */
function processLocalImage(
    content: ChatCompletionContentPartImage,
    countObject: ContentCountObject
): Observable<ChatCompletionContentPart> {
    // Remove file:// prefix
    const filePath = content.image_url!.url.substring('file://'.length);
    const data = fs.readFileSync(filePath);
    const metaInfo = sizeOf(data);

    // Convert to data URL
    content.image_url!.url = `data:image/${metaInfo.type === 'jpg' ? 'jpeg' : metaInfo.type
        };base64,${data.toString('base64')}`;

    // Calculate token cost
    countObject.image += calculateImageTokenCost(
        metaInfo.width || 0,
        metaInfo.height || 0
    );

    return of(content);
}

/**
 * Process a data URL (base64 encoded file)
 * @param content Content part with data URL
 * @param countObject Object to track token counts
 * @returns Observable with processed content
 */
function processDataUrl(
    content: ChatCompletionContentPartImage,
    countObject: ContentCountObject
): Observable<ChatCompletionContentPart> {
    const url = content.image_url!.url;
    const label = (content.image_url as any)['label'] as string;
    const ext = label?.toLowerCase().replace(/.*\./g, '');
    const mimeType = url.substring(5, url.indexOf(';'));

    // Handle different file types based on MIME type or extension
    if (
        (url.startsWith('data:image/') || imageExtensions.includes(ext)) &&
        !url.startsWith('data:image/svg') &&
        !url.startsWith('data:image/tiff')
    ) {
        // Process images
        try {
            const data = Buffer.from(url.substring(url.indexOf(',') + 1), 'base64');
            const metaInfo = sizeOf(data);
            countObject.image += calculateImageTokenCost(
                metaInfo.width || 0,
                metaInfo.height || 0
            );
        } catch (e) {
            console.error('Error processing image metadata', e);
        }
    } else if (url.startsWith('data:audio/')) {
        // Process audio files (simplified - actual implementation would extract duration)
        countObject.audio += 60; // Placeholder value
    } else if (url.startsWith('data:video/')) {
        // Process video files (simplified - actual implementation would extract duration)
        countObject.video += 60; // Placeholder value
    } else if (
        url.startsWith('data:text/') ||
        plainExtensions.includes(ext) ||
        plainMime.includes(mimeType) ||
        mimeType.endsWith('+xml')
    ) {
        // Convert text-based files to actual text content
        return of(convertDataUrlToText(content, url, ext));
    }

    return of(content);
}

/**
 * Convert a data URL containing text to a text content part
 * @param content The original content part
 * @param url The data URL
 * @param ext File extension
 * @returns Modified content part
 */
function convertDataUrlToText(
    content: ChatCompletionContentPart,
    url: string,
    ext: string
): ChatCompletionContentPart {
    (content.type as any) = 'text';
    const base64String = url.substring(url.indexOf(',') + 1);

    if (base64String) {
        const data = Buffer.from(base64String, 'base64');
        const detectedEncoding = detect(data);
        let encodingName = detectedEncoding.encoding;

        // Handle encoding detection edge cases
        if (encodingName === 'ISO-8859-2') {
            encodingName = 'Windows-31J'; // SJIS can be misdetected as ISO-8859-2
        } else if (!encodingName) {
            encodingName = 'Windows-31J'; // Default fallback
        }

        const decoder = new TextDecoder(encodingName);
        const decodedString = decoder.decode(data);

        // Format code with language if applicable
        if ('label' in ((content as ChatCompletionContentPartImage).image_url as any) && !ext.endsWith('.md')) {
            const label = ((content as ChatCompletionContentPartImage).image_url as any).label as string;
            const langExt = label.replace(/.*\./g, '');
            const langName = getLanguageFromExtension(langExt);
            (content as any).text = '```' + langName + ' ' + label + '\n' + decodedString + '\n```';
        } else {
            (content as any).text = decodedString;
        }

        delete (content as any).image_url;
    } else {
        (content as any).text = '';
        delete (content as any).image_url;
    }

    return content;
}

/**
 * Check if a message has non-empty content
 * @param message The message to check
 * @returns Whether the message has content
 */
function hasContent(message: ChatCompletionMessageParam): boolean {
    if (!message.content) {
        // Tool calls may have no content
        return !!(message as any).tool_calls;
    }

    if (typeof message.content === 'string') {
        return message.content.trim().length > 0;
    }

    if (Array.isArray(message.content)) {
        // Filter out empty content parts
        message.content = message.content.filter(part => {
            if (part.type === 'text') {
                return part.text.trim().length > 0;
            } else if (part.type === 'image_url') {
                return part.image_url.url.trim().length > 0;
            } else if ((part.type as any) === 'tool_result') {
                return true;
            }
            return false;
        }) as ChatCompletionContentPart[];

        return message.content.length > 0;
    }

    return false;
}

/**
 * Combine consecutive messages from the same role
 * @param messages Array of messages
 * @returns Combined messages
 */
function combineConsecutiveMessages(
    messages: ChatCompletionMessageParam[]
): ChatCompletionMessageParam[] {
    return messages.reduce((result, current) => {
        // Check if this message can be combined with the previous one
        const prev = result[result.length - 1];
        const canCombine = prev &&
            prev.role === current.role &&
            !(prev as any).tool_call_id &&
            !(current as any).tool_call_id;

        if (!canCombine) {
            result.push(current);
            return result;
        }

        // Combine messages
        combineMessageContent(prev, current);
        return result;
    }, [] as ChatCompletionMessageParam[]);
}

/**
 * Combine content from two messages
 * @param target Target message
 * @param source Source message
 */
function combineMessageContent(
    target: ChatCompletionMessageParam,
    source: ChatCompletionMessageParam
): void {
    // Handle different content formats
    if (typeof target.content === 'string') {
        if (typeof source.content === 'string') {
            target.content += '\n' + source.content;
        } else if (Array.isArray(source.content)) {
            // Convert target to array format and append source
            target.content = [
                { type: 'text', text: target.content || '' },
                ...source.content as ChatCompletionContentPart[]
            ];
        }
    } else if (Array.isArray(target.content) && source.content) {
        if (typeof source.content === 'string') {
            target.content.push({ type: 'text', text: source.content });
        } else if (Array.isArray(source.content)) {
            (target.content as ChatCompletionContentPart[]).push(...source.content as ChatCompletionContentPart[]);
        }
    }
}

/**
 * Get programming language name from file extension
 * @param ext File extension
 * @returns Language name for syntax highlighting
 */
function getLanguageFromExtension(ext: string): string {
    return extensionLanguageMap[ext] || ext;
}