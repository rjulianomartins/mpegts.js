export interface SceneResource {
    url: string;
    byteRange?: { start: number; end?: number };
    headers?: { [key: string]: string };
}

export interface SceneSegment extends SceneResource {
    start: number;
    duration: number;
}

export interface AcademicScene {
    id: string;
    title: string;
    sourceId?: string;
    /** Actual prepared source boundary used by playback. */
    sourceStart?: number;
    /** Actual prepared source boundary derived from the prepared Scene duration. */
    sourceEnd?: number;
    /** User-requested source boundary before keyframe snapping. */
    requestedSourceStart?: number;
    /** User-requested source end before stream-copy preparation. */
    requestedSourceEnd?: number;
    /** Accepted keyframe-aligned source boundary. */
    actualSourceStart?: number;
    /** Actual end represented by the prepared Scene. */
    actualSourceEnd?: number;
    /** actualSourceStart - requestedSourceStart. */
    startBoundaryDelta?: number;
    mediaStart?: number;
    duration: number;
    mimeType: string;
    initSegment?: SceneResource;
    segments: SceneSegment[];
    metadata?: { [key: string]: any };
}

export interface SceneManifest {
    type: 'scene' | 'scenes' | 'compilation';
    title?: string;
    mimeType?: string;
    scenes: AcademicScene[];
}

export interface ScenePlayerConfig {
    withCredentials?: boolean;
    headers?: { [key: string]: string };
    preloadAheadSeconds?: number;
    preloadNextSceneThreshold?: number;
    preloadNextSceneSeconds?: number;
    maxBufferBehindSeconds?: number;
    cleanupIntervalSeconds?: number;
    keyboardSceneNavigation?: boolean;
    showSceneTitles?: boolean;
    sceneTitleCueDuration?: number;
    sceneTitleLanguage?: string;
    fetcher?: (resource: SceneResource) => Promise<ArrayBuffer>;
}

export interface SceneTimelineItem {
    index: number;
    id: string;
    title: string;
    sourceId: string;
    sourceStart: number;
    sourceEnd: number;
    duration: number;
    timelineStart: number;
    timelineEnd: number;
    mimeType: string;
    runIndex: number;
    metadata: { [key: string]: any };
}

export class SceneCompositionPlayer {
    constructor(mediaDataSource: SceneManifest | {type: string; url?: string; manifest?: string | SceneManifest; scenes?: AcademicScene[]}, config?: ScenePlayerConfig);
    attachMediaElement(mediaElement: HTMLMediaElement): void;
    detachMediaElement(): void;
    load(): void;
    unload(): void;
    destroy(): void;
    play(): Promise<void>;
    pause(): void;
    seek(seconds: number): void;
    goToScene(index: number, offsetSeconds?: number): void;
    nextScene(): void;
    previousScene(): void;
    preloadScene(index: number): Promise<void>;
    setSceneTitleVisibility(visible: boolean): void;
    getSceneAtTime(seconds: number): SceneTimelineItem | null;
    getTimeline(): SceneTimelineItem[];
    on(event: string, listener: (...args: any[]) => void): void;
    off(event: string, listener: (...args: any[]) => void): void;
    currentTime: number;
    readonly duration: number;
    readonly currentSceneIndex: number;
    readonly currentScene: SceneTimelineItem | null;
    readonly sceneCount: number;
    volume: number;
    muted: boolean;
}

export const Events: {
    ERROR: string;
    MANIFEST_LOADED: string;
    READY: string;
    SCENE_CHANGE: string;
    TIME_UPDATE: string;
    SEGMENT_BUFFERED: string;
    BUFFER_EVICTED: string;
};
