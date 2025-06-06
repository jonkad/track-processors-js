import * as vision from '@mediapipe/tasks-vision';
import { dependencies } from '../../package.json';
import VideoTransformer from './VideoTransformer';
import { VideoTransformerInitOptions } from './types';

export type SegmenterOptions = Partial<vision.ImageSegmenterOptions['baseOptions']>;

export interface FrameProcessingStats {
  processingTimeMs: number;
  segmentationTimeMs: number;
  filterTimeMs: number;
}

export type BackgroundOptions = {
  blurRadius?: number;
  imagePath?: string;
  /** cannot be updated through the `update` method, needs a restart */
  segmenterOptions?: SegmenterOptions;
  /** cannot be updated through the `update` method, needs a restart */
  assetPaths?: { tasksVisionFileSet?: string; modelAssetPath?: string };
  /** called when a new frame is processed */
  onFrameProcessed?: (stats: FrameProcessingStats) => void;
};

export default class BackgroundProcessor extends VideoTransformer<BackgroundOptions> {
  static get isSupported() {
    return (
      typeof OffscreenCanvas !== 'undefined' &&
      typeof VideoFrame !== 'undefined' &&
      typeof createImageBitmap !== 'undefined' &&
      !!document.createElement('canvas').getContext('webgl2')
    );
  }

  imageSegmenter?: vision.ImageSegmenter;

  segmentationResults: vision.ImageSegmenterResult | undefined;

  backgroundImage: ImageBitmap | null = null;

  options: BackgroundOptions;

  constructor(opts: BackgroundOptions) {
    super();
    this.options = opts;
    this.update(opts);
  }

  async init({ outputCanvas, inputElement: inputVideo }: VideoTransformerInitOptions) {
    // Initialize WebGL with appropriate options based on our current state

    await super.init({ outputCanvas, inputElement: inputVideo });

    const fileSet = await vision.FilesetResolver.forVisionTasks(
      this.options.assetPaths?.tasksVisionFileSet ??
        `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${dependencies['@mediapipe/tasks-vision']}/wasm`,
    );

    this.imageSegmenter = await vision.ImageSegmenter.createFromOptions(fileSet, {
      baseOptions: {
        modelAssetPath:
          this.options.assetPaths?.modelAssetPath ??
          'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
        delegate: 'GPU',
        ...this.options.segmenterOptions,
      },
      canvas: this.canvas,
      runningMode: 'VIDEO',
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });

    // Skip loading the image here if update already loaded the image below
    if (this.options?.imagePath && !this.backgroundImage) {
      await this.loadBackground(this.options.imagePath).catch((err) =>
        console.error('Error while loading processor background image: ', err),
      );
    }
    if (this.options.blurRadius) {
      this.gl?.setBlurRadius(this.options.blurRadius);
    }
  }

  async destroy() {
    await super.destroy();
    await this.imageSegmenter?.close();
    this.backgroundImage = null;
  }

  async loadBackground(path: string) {
    const img = new Image();

    await new Promise((resolve, reject) => {
      img.crossOrigin = 'Anonymous';
      img.onload = () => resolve(img);
      img.onerror = (err) => reject(err);
      img.src = path;
    });
    const imageData = await createImageBitmap(img);
    this.gl?.setBackgroundImage(imageData);
  }

  async transform(frame: VideoFrame, controller: TransformStreamDefaultController<VideoFrame>) {
    try {
      if (!(frame instanceof VideoFrame) || frame.codedWidth === 0 || frame.codedHeight === 0) {
        console.debug('empty frame detected, ignoring');
        return;
      }

      if (this.isDisabled) {
        controller.enqueue(frame);
        return;
      }
      if (!this.canvas) {
        throw TypeError('Canvas needs to be initialized first');
      }
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
      let startTimeMs = performance.now();

      this.imageSegmenter?.segmentForVideo(frame, startTimeMs, (result) => {
        const segmentationTimeMs = performance.now() - startTimeMs;
        this.segmentationResults = result;
        this.drawFrame(frame);
        if (this.canvas && this.canvas.width > 0 && this.canvas.height > 0) {
          const newFrame = new VideoFrame(this.canvas, {
            timestamp: frame.timestamp || Date.now(),
          });
          const filterTimeMs = performance.now() - startTimeMs - segmentationTimeMs;
          const stats: FrameProcessingStats = {
            processingTimeMs: performance.now() - startTimeMs,
            segmentationTimeMs,
            filterTimeMs,
          };
          this.options.onFrameProcessed?.(stats);

          controller.enqueue(newFrame);
        } else {
          controller.enqueue(frame);
        }
        frame.close();
      });
    } catch (e) {
      console.error('Error while processing frame: ', e);
      frame?.close();
    }
  }

  async update(opts: BackgroundOptions) {
    this.options = { ...this.options, ...opts };
    if (opts.blurRadius) {
      this.gl?.setBlurRadius(opts.blurRadius);
    } else if (opts.imagePath) {
      await this.loadBackground(opts.imagePath);
    }
  }

  async drawFrame(frame: VideoFrame) {
    if (!this.canvas || !this.gl || !this.segmentationResults || !this.inputVideo) return;

    const mask = this.segmentationResults.categoryMask;
    if (mask) {
      this.gl.render(frame, mask);
    }
  }
}
