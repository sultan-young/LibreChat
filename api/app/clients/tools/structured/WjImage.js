const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { fetch } = require('undici');
const { logger } = require('@librechat/data-schemas');
const { Tool } = require('@librechat/agents/langchain/tools');
const {
  getImageBasename,
  getEnvProxyDispatcher,
  createMinimalRetentionRequest,
} = require('@librechat/api');
const { FileContext, ContentTypes } = require('librechat-data-provider');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { getFiles } = require('~/models');

/**
 * Thin LibreChat tool wrapping WJ image generation:
 *   POST {WJ_SERVER}/api/v1/proxy/ai/generate/image
 */

const DEFAULT_WJ_SERVER_URL = 'https://wj.zaowuwujie.ltd';
const WJ_IMAGE_PATH = '/api/v1/proxy/ai/generate/image';
const DEFAULT_MODEL = 'gpt-image-2';
const DEFAULT_TIMEOUT_MS = 330000;
const ALLOWED_MODELS = ['gpt-image-2', 'nano-banana-2'];
const ALLOWED_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];
const ALLOWED_RESOLUTIONS = ['1K', '2K', '4K'];

const wjImageJsonSchema = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      maxLength: 8000,
      description: 'WJ `prompt`: text description for image generation or editing.',
    },
    model: {
      type: 'string',
      enum: ALLOWED_MODELS,
      description:
        'WJ `model`. Default gpt-image-2. Pass nano-banana-2 only when the user asks for banana.',
    },
    aspect_ratio: {
      type: 'string',
      enum: ALLOWED_ASPECT_RATIOS,
      description: 'WJ `output.aspect_ratio`. Default 1:1.',
    },
    resolution: {
      type: 'string',
      enum: ALLOWED_RESOLUTIONS,
      description: 'WJ `output.resolution`. Default 1K for gpt-image-2, 2K for nano-banana-2.',
    },
    image_ids: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 10,
      description:
        'LibreChat uploaded/generated image IDs to edit (from tool context). Required for image editing.',
    },
    input_images: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 10,
      description:
        'Optional HTTPS or data-URL images for image-to-image. Prefer image_ids for chat uploads.',
    },
  },
  required: ['prompt'],
};

const displayMessage =
  "WJ displayed an image. All generated images are already plainly visible, so don't repeat the descriptions in detail. Do not list download links as they are available in the UI already. The user may download the images by clicking on them, but do not mention anything about downloading to the user.";

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function unwrapWjImagePayload(body) {
  let current = body;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isRecord(current)) {
      break;
    }
    if (Array.isArray(current.assets)) {
      return current;
    }
    if (current.success === true && isRecord(current.data)) {
      current = current.data;
      continue;
    }
    break;
  }
  return isRecord(current) && Array.isArray(current.assets) ? current : null;
}

function pickImageUrl(payload) {
  const asset = payload?.assets?.find(
    (item) => item && (item.type === 'image' || item.url || item.b64_json),
  );
  const url = typeof asset?.url === 'string' ? asset.url.trim() : '';
  return { asset, url };
}

function extractWjErrorMessage(body, status) {
  if (!isRecord(body)) {
    return `WJ image request failed with HTTP ${status}`;
  }
  const error = body.error;
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof body.message === 'string' && body.message.trim()) {
    return body.message.trim();
  }
  return `WJ image request failed with HTTP ${status}`;
}

function defaultResolutionForModel(model) {
  return model === 'nano-banana-2' ? '2K' : '1K';
}

function isHttpOrDataUrl(value) {
  return /^https?:\/\//i.test(value) || value.startsWith('data:');
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

class WjImage extends Tool {
  constructor(fields = {}) {
    super();
    this.returnMetadata = fields.returnMetadata ?? false;
    this.userId = fields.userId;
    this.req = fields.req;
    this.tenantId = fields.req?.user?.tenantId;
    this.retentionRequest = createMinimalRetentionRequest(fields.req);
    this.fileStrategy = fields.fileStrategy;
    this.imageFiles = Array.isArray(fields.imageFiles) ? fields.imageFiles : [];
    this.isAgent = fields.isAgent;
    if (this.isAgent) {
      this.responseFormat = 'content_and_artifact';
    }
    if (fields.processFileURL) {
      this.processFileURL = fields.processFileURL.bind(this);
    }

    this.apiKey = fields.WJ_INFERENCE_API_KEY ?? this.getApiKey();
    this.serverUrl = (process.env.WJ_SERVER_URL || DEFAULT_WJ_SERVER_URL).trim().replace(/\/+$/, '');
    this.timeoutMs = Number.parseInt(process.env.WJ_IMAGE_TIMEOUT_MS || '', 10);
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      this.timeoutMs = DEFAULT_TIMEOUT_MS;
    }
    this.defaultModel = DEFAULT_MODEL;

    this.name = 'wj_image';
    this.description = `Generate or edit images via WJ (POST /api/v1/proxy/ai/generate/image).
Default model is gpt-image-2. Pass model "nano-banana-2" only when the user asks for banana.
For editing chat uploads, pass image_ids from the tool context. Optional: aspect_ratio, resolution, input_images.`;
    this.schema = wjImageJsonSchema;
  }

  getApiKey() {
    const apiKey = process.env.WJ_INFERENCE_API_KEY ?? '';
    if (!apiKey) {
      throw new Error('Missing WJ_INFERENCE_API_KEY environment variable.');
    }
    return apiKey;
  }

  returnValue(value) {
    if (this.isAgent === true && typeof value === 'string') {
      return [value, {}];
    }
    if (this.isAgent === true && typeof value === 'object') {
      return [displayMessage, value];
    }
    return value;
  }

  buildGenerateUrl() {
    return `${this.serverUrl}${WJ_IMAGE_PATH}`;
  }

  async resolveImageIdsToDataUrls(imageIds) {
    if (!Array.isArray(imageIds) || imageIds.length === 0) {
      return [];
    }

    const requestFilesMap = Object.fromEntries(this.imageFiles.map((f) => [f.file_id, { ...f }]));
    const orderedFiles = new Array(imageIds.length);
    const idsToFetch = [];
    const indexOfMissing = Object.create(null);

    for (let i = 0; i < imageIds.length; i++) {
      const id = imageIds[i];
      const file = requestFilesMap[id];
      if (file) {
        orderedFiles[i] = file;
      } else {
        idsToFetch.push(id);
        indexOfMissing[id] = i;
      }
    }

    if (idsToFetch.length && this.req?.user?.id) {
      const fetchedFiles = await getFiles(
        {
          user: this.req.user.id,
          file_id: { $in: idsToFetch },
          height: { $exists: true },
          width: { $exists: true },
        },
        {},
        {},
      );
      for (const file of fetchedFiles) {
        requestFilesMap[file.file_id] = file;
        orderedFiles[indexOfMissing[file.file_id]] = file;
      }
    }

    const streamMethods = {};
    const urls = [];
    for (const imageFile of orderedFiles) {
      if (!imageFile) {
        continue;
      }
      const filepath = typeof imageFile.filepath === 'string' ? imageFile.filepath.trim() : '';
      if (isHttpOrDataUrl(filepath)) {
        urls.push(filepath);
        continue;
      }

      const source = imageFile.source || this.fileStrategy;
      if (!source) {
        continue;
      }
      let getDownloadStream = streamMethods[source];
      if (!getDownloadStream) {
        ({ getDownloadStream } = getStrategyFunctions(source));
        streamMethods[source] = getDownloadStream;
      }
      if (!getDownloadStream) {
        continue;
      }
      const stream = await getDownloadStream(this.req, imageFile.filepath);
      if (!stream) {
        continue;
      }
      const buffer = await streamToBuffer(stream);
      const mime = imageFile.type && imageFile.type.includes('/') ? imageFile.type : 'image/png';
      urls.push(`data:${mime};base64,${buffer.toString('base64')}`);
    }
    return urls;
  }

  async buildRequestBody(data) {
    const prompt = typeof data?.prompt === 'string' ? data.prompt.trim() : '';
    if (!prompt) {
      throw new Error('Missing required field: prompt');
    }

    const model = ALLOWED_MODELS.includes(data?.model) ? data.model : this.defaultModel;
    const aspectRatio = ALLOWED_ASPECT_RATIOS.includes(data?.aspect_ratio)
      ? data.aspect_ratio
      : '1:1';
    const resolution = ALLOWED_RESOLUTIONS.includes(data?.resolution)
      ? data.resolution
      : defaultResolutionForModel(model);

    const explicitUrls = Array.isArray(data?.input_images)
      ? data.input_images.map((url) => String(url).trim()).filter(isHttpOrDataUrl)
      : [];
    const fromIds = await this.resolveImageIdsToDataUrls(
      Array.isArray(data?.image_ids) ? data.image_ids.map((id) => String(id).trim()) : [],
    );
    const inputUrls = [...explicitUrls, ...fromIds];

    return {
      model,
      prompt,
      ...(inputUrls.length ? { input_images: inputUrls.map((url) => ({ url })) } : {}),
      output: {
        aspect_ratio: aspectRatio,
        resolution,
      },
      response_format: 'url',
      media_options: {
        persist_input_images: inputUrls.length > 0,
        persist_output_images: true,
      },
    };
  }

  async requestWjImage(body) {
    const fetchOptions = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey.replace(/^Bearer\s+/i, '').trim()}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    const dispatcher = getEnvProxyDispatcher();
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher;
    }
    const response = await fetch(this.buildGenerateUrl(), fetchOptions);
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new Error('WJ returned a non-JSON image response');
    }
    if (!response.ok || json?.success === false) {
      throw new Error(extractWjErrorMessage(json, response.status));
    }
    const payload = unwrapWjImagePayload(json);
    if (!payload) {
      throw new Error('WJ returned an invalid image response');
    }
    const { asset, url } = pickImageUrl(payload);
    if (!url) {
      throw new Error(
        asset?.b64_json
          ? 'WJ generated an image but returned base64 only (no URL)'
          : 'WJ completed without an image URL',
      );
    }
    return { url, mimeType: asset?.mime_type || 'image/png' };
  }

  async downloadAsDataUrl(imageUrl, mimeType) {
    const fetchOptions = {};
    const dispatcher = getEnvProxyDispatcher();
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher;
    }
    const imageResponse = await fetch(imageUrl, {
      ...fetchOptions,
      signal: AbortSignal.timeout(Math.min(this.timeoutMs, 60000)),
    });
    if (!imageResponse.ok) {
      throw new Error(`Failed to download generated image (HTTP ${imageResponse.status})`);
    }
    const arrayBuffer = await imageResponse.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    const mime = mimeType && mimeType.includes('/') ? mimeType : 'image/png';
    return `data:${mime};base64,${base64}`;
  }

  async _call(data) {
    let requestBody;
    try {
      requestBody = await this.buildRequestBody(data);
    } catch (error) {
      return this.returnValue(error instanceof Error ? error.message : 'Invalid tool input');
    }

    let generated;
    try {
      generated = await this.requestWjImage(requestBody);
    } catch (error) {
      logger.error('[wj_image] Problem generating the image:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return this.returnValue(
        timedOut
          ? 'WJ image generation timed out. Please try again.'
          : `Something went wrong when trying to generate the image with WJ: ${message}`,
      );
    }

    if (this.isAgent) {
      try {
        const dataUrl = await this.downloadAsDataUrl(generated.url, generated.mimeType);
        const file_ids = [uuidv4()];
        const content = [
          {
            type: ContentTypes.IMAGE_URL,
            image_url: { url: dataUrl },
          },
        ];
        const response = [
          {
            type: ContentTypes.TEXT,
            text: `${displayMessage}\n\ngenerated_image_id: "${file_ids[0]}"`,
          },
        ];
        return [response, { content, file_ids }];
      } catch (error) {
        logger.error('[wj_image] Failed to download generated image:', error);
        return this.returnValue(
          `WJ generated an image but it could not be loaded into chat: ${error.message}`,
        );
      }
    }

    const imageBasename = getImageBasename(generated.url);
    const imageExt = path.extname(imageBasename) || '.png';
    const extension = imageExt.startsWith('.') ? imageExt.slice(1) : imageExt;
    const imageName = `img-${uuidv4()}.${extension}`;

    try {
      const result = await this.processFileURL({
        URL: generated.url,
        basePath: 'images',
        userId: this.userId,
        fileName: imageName,
        fileStrategy: this.fileStrategy,
        context: FileContext.image_generation,
        tenantId: this.tenantId,
        req: this.retentionRequest,
      });
      this.result = this.returnMetadata ? result : `![generated image](${result.filepath})`;
    } catch (error) {
      logger.error('[wj_image] Error while saving the image:', error);
      this.result = `Failed to save the image locally. ${error.message}`;
    }

    return this.returnValue(this.result);
  }
}

module.exports = WjImage;
