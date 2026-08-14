/*
 * Scene Composition Player
 *
 * Presents an ordered list of pre-fragmented MP4 scenes through one
 * HTMLMediaElement + MediaSource timeline. The HTMLMediaElement keeps its
 * native browser controls; this class only owns the media pipeline.
 */

import * as EventEmitter from 'events';
import {InvalidArgumentException, IllegalStateException} from '../utils/exception';

const SceneCompositionEvents = Object.freeze({
    ERROR: 'scene_error',
    MANIFEST_LOADED: 'scene_manifest_loaded',
    READY: 'scene_ready',
    SCENE_CHANGE: 'scene_change',
    TIME_UPDATE: 'scene_time_update',
    SEGMENT_BUFFERED: 'scene_segment_buffered',
    BUFFER_EVICTED: 'scene_buffer_evicted'
});

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

function isEditableTarget(target) {
    if (!target || !target.tagName) {
        return false;
    }
    const tag = String(target.tagName).toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true;
}

function asResource(value) {
    if (typeof value === 'string') {
        return {url: value};
    }
    return value;
}

function resourceIdentity(resource) {
    if (!resource) {
        return '';
    }
    const range = resource.byteRange || null;
    return [
        resource.url || '',
        range && range.start != null ? range.start : '',
        range && range.end != null ? range.end : ''
    ].join('|');
}

class SceneCompositionPlayer {

    constructor(mediaDataSource, config) {
        if (!mediaDataSource || typeof mediaDataSource !== 'object') {
            throw new InvalidArgumentException('SceneCompositionPlayer requires a MediaDataSource object.');
        }

        const type = String(mediaDataSource.type || '').toLowerCase();
        if (type !== 'scene' && type !== 'scenes' && type !== 'compilation') {
            throw new InvalidArgumentException('SceneCompositionPlayer requires type scene/scenes/compilation.');
        }

        this.TAG = 'SceneCompositionPlayer';
        this._type = 'SceneCompositionPlayer';
        this._media_data_source = mediaDataSource;
        this._config = Object.assign({
            withCredentials: mediaDataSource.withCredentials === true,
            headers: mediaDataSource.headers || {},
            preloadAheadSeconds: 45,
            preloadNextSceneThreshold: 25,
            preloadNextSceneSeconds: 12,
            maxBufferBehindSeconds: 180,
            cleanupIntervalSeconds: 2,
            keyboardSceneNavigation: true,
            showSceneTitles: false,
            sceneTitleCueDuration: 4,
            sceneTitleLanguage: 'en',
            fetcher: null
        }, config || {});

        this._emitter = new EventEmitter();
        this._emitter.setMaxListeners(0);

        this._media_element = null;
        this._media_source = null;
        this._source_buffer = null;
        this._object_url = null;
        this._manifest = null;
        this._scenes = [];
        this._duration = 0;
        this._load_promise = null;
        this._load_error = null;
        this._destroyed = false;
        this._ready = false;

        this._loaded_segments = new Set();
        this._pending_segments = new Map();
        this._init_cache = new Map();
        this._append_chain = Promise.resolve();
        this._active_mime_type = null;
        this._active_init_key = null;
        this._last_scene_index = -1;
        this._last_cleanup_clock = 0;
        this._title_track = null;

        this.e = {
            onTimeUpdate: this._onTimeUpdate.bind(this),
            onSeeking: this._onSeeking.bind(this),
            onWaiting: this._onWaiting.bind(this),
            onKeyDown: this._onKeyDown.bind(this)
        };
    }

    destroy() {
        if (this._destroyed) {
            return;
        }
        this.unload();
        this.detachMediaElement();
        this._emitter.removeAllListeners();
        this._destroyed = true;
    }

    on(event, listener) {
        this._emitter.on(event, listener);
    }

    off(event, listener) {
        this._emitter.removeListener(event, listener);
    }

    attachMediaElement(mediaElement) {
        if (!mediaElement) {
            throw new InvalidArgumentException('mediaElement is required.');
        }

        if (this._media_element && this._media_element !== mediaElement) {
            this.detachMediaElement();
        }

        this._media_element = mediaElement;
        mediaElement.addEventListener('timeupdate', this.e.onTimeUpdate);
        mediaElement.addEventListener('seeking', this.e.onSeeking);
        mediaElement.addEventListener('waiting', this.e.onWaiting);

        if (this._config.keyboardSceneNavigation && typeof document !== 'undefined') {
            document.addEventListener('keydown', this.e.onKeyDown, true);
        }
    }

    detachMediaElement() {
        if (!this._media_element) {
            return;
        }

        this._media_element.removeEventListener('timeupdate', this.e.onTimeUpdate);
        this._media_element.removeEventListener('seeking', this.e.onSeeking);
        this._media_element.removeEventListener('waiting', this.e.onWaiting);

        if (typeof document !== 'undefined') {
            document.removeEventListener('keydown', this.e.onKeyDown, true);
        }

        this._media_element = null;
    }

    load() {
        if (this._destroyed) {
            throw new IllegalStateException('SceneCompositionPlayer has been destroyed.');
        }
        if (!this._media_element) {
            throw new IllegalStateException('Attach an HTMLMediaElement before calling load().');
        }
        if (this._load_promise) {
            return;
        }

        this._load_error = null;
        this._load_promise = this._loadInternal().catch((error) => {
            this._load_error = error;
            this._emitError('LOAD_FAILED', error);
        });
    }

    unload() {
        this._ready = false;
        this._load_promise = null;
        this._load_error = null;
        this._loaded_segments.clear();
        this._pending_segments.clear();
        this._init_cache.clear();
        this._append_chain = Promise.resolve();
        this._active_mime_type = null;
        this._active_init_key = null;
        this._last_scene_index = -1;

        if (this._source_buffer) {
            try {
                if (this._source_buffer.updating) {
                    this._source_buffer.abort();
                }
            } catch (e) {
                // Ignore teardown races.
            }
        }

        if (this._media_source && this._media_source.readyState === 'open') {
            try {
                this._media_source.endOfStream();
            } catch (e) {
                // Ignore teardown races.
            }
        }

        this._source_buffer = null;
        this._media_source = null;

        if (this._object_url) {
            try {
                URL.revokeObjectURL(this._object_url);
            } catch (e) {
                // Ignore unsupported URL implementations.
            }
            this._object_url = null;
        }

        if (this._media_element) {
            try {
                this._media_element.pause();
                this._media_element.removeAttribute('src');
                this._media_element.load();
            } catch (e) {
                // Ignore detached media elements.
            }
        }

        this._removeTitleTrack();
    }

    play() {
        if (!this._media_element) {
            return Promise.reject(new IllegalStateException('No HTMLMediaElement is attached.'));
        }
        if (!this._load_promise) {
            this.load();
        }
        return this._load_promise.then(() => {
            if (this._load_error) {
                return Promise.reject(this._load_error);
            }
            return this._media_element.play();
        });
    }

    pause() {
        if (this._media_element) {
            this._media_element.pause();
        }
    }

    seek(seconds) {
        if (!this._media_element || !this._scenes.length) {
            return;
        }
        const target = clamp(Number(seconds) || 0, 0, Math.max(0, this._duration - 0.001));
        this._ensureWindow(target, true).catch((error) => this._emitError('SEEK_BUFFER_FAILED', error));
        this._media_element.currentTime = target;
    }

    goToScene(index, offsetSeconds) {
        if (!this._scenes.length) {
            return;
        }
        const safeIndex = clamp(Math.floor(index), 0, this._scenes.length - 1);
        const scene = this._scenes[safeIndex];
        const offset = clamp(Number(offsetSeconds) || 0, 0, Math.max(0, scene.duration - 0.001));
        this.seek(scene.timelineStart + offset);
    }

    nextScene() {
        if (!this._scenes.length) {
            return;
        }
        const current = this.currentSceneIndex;
        this.goToScene(Math.min(this._scenes.length - 1, current + 1), 0);
    }

    previousScene() {
        if (!this._scenes.length) {
            return;
        }
        const current = this.currentSceneIndex;
        this.goToScene(Math.max(0, current - 1), 0);
    }

    preloadScene(index) {
        if (!this._scenes.length) {
            return Promise.resolve();
        }
        const safeIndex = clamp(Math.floor(index), 0, this._scenes.length - 1);
        const scene = this._scenes[safeIndex];
        return this._ensureSceneRange(scene, scene.timelineStart, scene.timelineEnd);
    }

    setSceneTitleVisibility(visible) {
        this._config.showSceneTitles = visible === true;
        if (this._title_track) {
            this._title_track.mode = this._config.showSceneTitles ? 'showing' : 'hidden';
        } else if (this._ready && this._config.showSceneTitles) {
            this._installTitleTrack();
        }
    }

    getSceneAtTime(seconds) {
        const index = this._sceneIndexAtTime(Number(seconds) || 0);
        return index >= 0 ? this._publicScene(this._scenes[index]) : null;
    }

    getTimeline() {
        return this._scenes.map((scene) => this._publicScene(scene));
    }

    get type() {
        return this._type;
    }

    get buffered() {
        return this._media_element ? this._media_element.buffered : null;
    }

    get duration() {
        return this._duration || (this._media_element ? this._media_element.duration : 0);
    }

    get volume() {
        return this._media_element ? this._media_element.volume : 1;
    }

    set volume(value) {
        if (this._media_element) {
            this._media_element.volume = value;
        }
    }

    get muted() {
        return this._media_element ? this._media_element.muted : false;
    }

    set muted(value) {
        if (this._media_element) {
            this._media_element.muted = value;
        }
    }

    get currentTime() {
        return this._media_element ? this._media_element.currentTime : 0;
    }

    set currentTime(seconds) {
        this.seek(seconds);
    }

    get currentSceneIndex() {
        return this._sceneIndexAtTime(this.currentTime);
    }

    get currentScene() {
        const index = this.currentSceneIndex;
        return index >= 0 ? this._publicScene(this._scenes[index]) : null;
    }

    get sceneCount() {
        return this._scenes.length;
    }

    get mediaInfo() {
        const scene = this.currentScene;
        return {
            mimeType: scene ? scene.mimeType : (this._scenes[0] ? this._scenes[0].mimeType : ''),
            duration: this._duration,
            width: this._media_element ? this._media_element.videoWidth : undefined,
            height: this._media_element ? this._media_element.videoHeight : undefined,
            sceneCount: this._scenes.length
        };
    }

    get statisticsInfo() {
        return {
            playerType: this._type,
            currentSceneIndex: this.currentSceneIndex,
            sceneCount: this._scenes.length,
            loadedSegmentCount: this._loaded_segments.size,
            duration: this._duration
        };
    }

    async _loadInternal() {
        const manifest = await this._resolveManifest();
        this._manifest = manifest;
        this._normaliseManifest(manifest);
        this._emitter.emit(SceneCompositionEvents.MANIFEST_LOADED, {
            duration: this._duration,
            sceneCount: this._scenes.length,
            scenes: this.getTimeline()
        });

        await this._openMediaSource();
        this._installTitleTrack();
        await this._ensureWindow(0, true);
        this._ready = true;
        this._emitSceneChange(true);
        this._emitter.emit(SceneCompositionEvents.READY, {
            duration: this._duration,
            sceneCount: this._scenes.length
        });
    }

    async _resolveManifest() {
        if (this._media_data_source.manifest && typeof this._media_data_source.manifest === 'object') {
            return this._media_data_source.manifest;
        }
        if (Array.isArray(this._media_data_source.scenes)) {
            return this._media_data_source;
        }

        const manifestUrl = typeof this._media_data_source.manifest === 'string'
            ? this._media_data_source.manifest
            : this._media_data_source.url;

        if (!manifestUrl) {
            throw new InvalidArgumentException('Scene MediaDataSource requires manifest, scenes, or url.');
        }

        const response = await fetch(manifestUrl, {
            credentials: this._config.withCredentials ? 'include' : 'same-origin',
            headers: this._config.headers || {}
        });
        if (!response.ok) {
            throw new Error('Scene manifest request failed with HTTP ' + response.status);
        }
        return response.json();
    }

    _normaliseManifest(manifest) {
        if (!manifest || !Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {
            throw new InvalidArgumentException('Scene manifest must contain at least one scene.');
        }

        const globalMimeType = manifest.mimeType || this._media_data_source.mimeType || null;
        let timelineCursor = 0;
        let runIndex = -1;
        let previousScene = null;
        const normalised = [];

        manifest.scenes.forEach((inputScene, sceneIndex) => {
            const scene = Object.assign({}, inputScene);
            const mimeType = scene.mimeType || globalMimeType;
            if (!mimeType) {
                throw new InvalidArgumentException('Scene ' + sceneIndex + ' is missing mimeType.');
            }

            let sourceSegments = Array.isArray(scene.segments) ? scene.segments.slice() : [];
            if (sourceSegments.length === 0 && scene.url) {
                sourceSegments = [{
                    url: scene.url,
                    duration: scene.duration
                }];
            }
            if (sourceSegments.length === 0) {
                throw new InvalidArgumentException('Scene ' + sceneIndex + ' has no media segments.');
            }

            let segmentCursor = 0;
            const segments = sourceSegments.map((inputSegment, segmentIndex) => {
                const segment = Object.assign({}, asResource(inputSegment));
                if (!segment.url) {
                    throw new InvalidArgumentException('Scene ' + sceneIndex + ' segment ' + segmentIndex + ' has no url.');
                }
                const start = segment.start != null ? Number(segment.start) : segmentCursor;
                let duration = segment.duration != null ? Number(segment.duration) : NaN;
                if (!isFinite(duration) || duration <= 0) {
                    if (sourceSegments.length === 1 && scene.duration != null) {
                        duration = Number(scene.duration);
                    } else {
                        throw new InvalidArgumentException('Scene segment durations are required for seeking/buffering.');
                    }
                }
                segmentCursor = Math.max(segmentCursor, start + duration);
                return Object.assign(segment, {
                    index: segmentIndex,
                    start: start,
                    duration: duration,
                    end: start + duration
                });
            });

            const duration = scene.duration != null ? Number(scene.duration) : segmentCursor;
            if (!isFinite(duration) || duration <= 0) {
                throw new InvalidArgumentException('Scene ' + sceneIndex + ' has invalid duration.');
            }

            const sourceStart = scene.sourceStart != null ? Number(scene.sourceStart) : 0;
            const sourceEnd = scene.sourceEnd != null ? Number(scene.sourceEnd) : sourceStart + duration;
            const mediaStart = scene.mediaStart != null ? Number(scene.mediaStart) : 0;
            const initSegment = scene.initSegment ? Object.assign({}, asResource(scene.initSegment)) : null;
            const initKey = initSegment ? resourceIdentity(initSegment) : '';
            const sourceId = scene.sourceId != null ? String(scene.sourceId) : '';

            const contiguousWithPrevious = previousScene &&
                sourceId && previousScene.sourceId === sourceId &&
                previousScene.mimeType === mimeType &&
                previousScene.initKey === initKey &&
                Math.abs(previousScene.sourceEnd - sourceStart) < 0.050;

            if (!contiguousWithPrevious) {
                runIndex += 1;
            }

            const timelineStart = timelineCursor;
            const timelineEnd = timelineStart + duration;
            const normalisedScene = {
                index: sceneIndex,
                id: scene.id != null ? String(scene.id) : 'scene-' + (sceneIndex + 1),
                title: scene.title != null ? String(scene.title) : 'Scene ' + (sceneIndex + 1),
                metadata: scene.metadata || {},
                sourceId: sourceId,
                sourceStart: sourceStart,
                sourceEnd: sourceEnd,
                mediaStart: mediaStart,
                mimeType: mimeType,
                initSegment: initSegment,
                initKey: initKey,
                segments: segments,
                duration: duration,
                timelineStart: timelineStart,
                timelineEnd: timelineEnd,
                runIndex: runIndex
            };

            normalisedScene.segments.forEach((segment) => {
                segment.timelineStart = timelineStart + segment.start;
                segment.timelineEnd = Math.min(timelineEnd, timelineStart + segment.end);
            });

            normalised.push(normalisedScene);
            previousScene = normalisedScene;
            timelineCursor = timelineEnd;
        });

        this._scenes = normalised;
        this._duration = timelineCursor;
    }

    _openMediaSource() {
        return new Promise((resolve, reject) => {
            if (typeof MediaSource === 'undefined') {
                reject(new Error('MediaSource is not available in this browser.'));
                return;
            }
            if (!this._scenes.length) {
                reject(new Error('No scenes are available.'));
                return;
            }

            const initialMimeType = this._scenes[0].mimeType;
            if (!MediaSource.isTypeSupported(initialMimeType)) {
                reject(new Error('MSE does not support ' + initialMimeType));
                return;
            }

            const mediaSource = new MediaSource();
            this._media_source = mediaSource;

            const onSourceOpen = () => {
                mediaSource.removeEventListener('sourceopen', onSourceOpen);
                try {
                    this._source_buffer = mediaSource.addSourceBuffer(initialMimeType);
                    this._source_buffer.mode = 'segments';
                    this._active_mime_type = initialMimeType;
                    mediaSource.duration = this._duration;
                    resolve();
                } catch (error) {
                    reject(error);
                }
            };

            mediaSource.addEventListener('sourceopen', onSourceOpen);
            this._object_url = URL.createObjectURL(mediaSource);
            this._media_element.src = this._object_url;
            this._media_element.load();
        });
    }

    async _ensureWindow(time, urgent) {
        if (!this._source_buffer || !this._scenes.length) {
            return;
        }

        const sceneIndex = this._sceneIndexAtTime(time);
        if (sceneIndex < 0) {
            return;
        }

        const from = Math.max(0, time - (urgent ? 0.25 : 0));
        const to = Math.min(this._duration, time + this._config.preloadAheadSeconds);
        const targets = [];

        for (let index = sceneIndex; index < this._scenes.length; index += 1) {
            const scene = this._scenes[index];
            if (scene.timelineStart > to && index > sceneIndex) {
                break;
            }
            const rangeStart = Math.max(from, scene.timelineStart);
            const rangeEnd = Math.min(to, scene.timelineEnd);
            if (rangeEnd > rangeStart || index === sceneIndex) {
                targets.push({scene: scene, from: rangeStart, to: Math.max(rangeStart + 0.001, rangeEnd)});
            }
        }

        const currentScene = this._scenes[sceneIndex];
        const remaining = currentScene.timelineEnd - time;
        if (sceneIndex + 1 < this._scenes.length && remaining <= this._config.preloadNextSceneThreshold) {
            const nextScene = this._scenes[sceneIndex + 1];
            targets.push({
                scene: nextScene,
                from: nextScene.timelineStart,
                to: Math.min(nextScene.timelineEnd, nextScene.timelineStart + this._config.preloadNextSceneSeconds)
            });
        }

        for (let i = 0; i < targets.length; i += 1) {
            await this._ensureSceneRange(targets[i].scene, targets[i].from, targets[i].to);
        }
    }

    async _ensureSceneRange(scene, absoluteFrom, absoluteTo) {
        const relativeFrom = Math.max(0, absoluteFrom - scene.timelineStart);
        const relativeTo = Math.min(scene.duration, absoluteTo - scene.timelineStart);
        let matches = scene.segments.filter((segment) => segment.end > relativeFrom - 0.010 && segment.start < relativeTo + 0.010);

        if (matches.length === 0) {
            matches = [scene.segments.reduce((best, segment) => {
                if (!best) {
                    return segment;
                }
                const bestDistance = Math.abs(best.start - relativeFrom);
                const candidateDistance = Math.abs(segment.start - relativeFrom);
                return candidateDistance < bestDistance ? segment : best;
            }, null)];
        }

        for (let i = 0; i < matches.length; i += 1) {
            await this._ensureSegment(scene, matches[i]);
        }
    }

    _ensureSegment(scene, segment) {
        const key = scene.index + ':' + segment.index;
        if (this._loaded_segments.has(key)) {
            return Promise.resolve();
        }
        if (this._pending_segments.has(key)) {
            return this._pending_segments.get(key);
        }

        const promise = this._loadAndAppendSegment(scene, segment).then(() => {
            this._loaded_segments.add(key);
            this._pending_segments.delete(key);
            this._emitter.emit(SceneCompositionEvents.SEGMENT_BUFFERED, {
                sceneIndex: scene.index,
                sceneId: scene.id,
                segmentIndex: segment.index,
                timelineStart: segment.timelineStart,
                timelineEnd: segment.timelineEnd
            });
        }).catch((error) => {
            this._pending_segments.delete(key);
            throw error;
        });

        this._pending_segments.set(key, promise);
        return promise;
    }

    async _loadAndAppendSegment(scene, segment) {
        const initData = scene.initSegment ? await this._getInitData(scene.initSegment) : null;
        const mediaData = await this._fetchArrayBuffer(segment);

        return this._enqueueAppend(async () => {
            await this._ensureSourceBufferType(scene.mimeType);
            const desiredOffset = scene.timelineStart - scene.mediaStart;
            if (Math.abs(this._source_buffer.timestampOffset - desiredOffset) > 0.0001) {
                this._source_buffer.timestampOffset = desiredOffset;
            }

            if (initData && this._active_init_key !== scene.initKey) {
                await this._appendBuffer(initData);
                this._active_init_key = scene.initKey;
            }

            await this._appendBuffer(mediaData);
            this._restoreLogicalDuration();
        });
    }

    _getInitData(resource) {
        const key = resourceIdentity(resource);
        if (this._init_cache.has(key)) {
            return this._init_cache.get(key);
        }
        const promise = this._fetchArrayBuffer(resource);
        this._init_cache.set(key, promise);
        return promise;
    }

    async _fetchArrayBuffer(resource) {
        if (typeof this._config.fetcher === 'function') {
            const custom = await this._config.fetcher(resource);
            if (!(custom instanceof ArrayBuffer)) {
                throw new Error('Scene fetcher must resolve to an ArrayBuffer.');
            }
            return custom;
        }

        const headers = Object.assign({}, this._config.headers || {}, resource.headers || {});
        if (resource.byteRange && resource.byteRange.start != null) {
            const end = resource.byteRange.end != null ? resource.byteRange.end : '';
            headers.Range = 'bytes=' + resource.byteRange.start + '-' + end;
        }

        const response = await fetch(resource.url, {
            credentials: this._config.withCredentials ? 'include' : 'same-origin',
            headers: headers
        });
        if (!response.ok && response.status !== 206) {
            throw new Error('Scene media request failed with HTTP ' + response.status);
        }
        return response.arrayBuffer();
    }

    _enqueueAppend(operation) {
        const next = this._append_chain.then(operation, operation);
        this._append_chain = next.catch(() => undefined);
        return next;
    }

    async _ensureSourceBufferType(mimeType) {
        if (this._active_mime_type === mimeType) {
            return;
        }
        if (!MediaSource.isTypeSupported(mimeType)) {
            throw new Error('MSE does not support scene codec type ' + mimeType);
        }
        if (typeof this._source_buffer.changeType !== 'function') {
            throw new Error('SourceBuffer.changeType() is required for this scene codec transition.');
        }
        this._source_buffer.changeType(mimeType);
        this._active_mime_type = mimeType;
        this._active_init_key = null;
    }

    _appendBuffer(data) {
        return new Promise((resolve, reject) => {
            const sourceBuffer = this._source_buffer;
            if (!sourceBuffer) {
                reject(new Error('SourceBuffer is not available.'));
                return;
            }

            const onUpdateEnd = () => {
                cleanup();
                resolve();
            };
            const onError = () => {
                cleanup();
                reject(new Error('SourceBuffer append failed.'));
            };
            const cleanup = () => {
                sourceBuffer.removeEventListener('updateend', onUpdateEnd);
                sourceBuffer.removeEventListener('error', onError);
            };

            sourceBuffer.addEventListener('updateend', onUpdateEnd);
            sourceBuffer.addEventListener('error', onError);
            try {
                sourceBuffer.appendBuffer(data);
            } catch (error) {
                cleanup();
                reject(error);
            }
        });
    }

    _removeBuffer(start, end) {
        return new Promise((resolve, reject) => {
            const sourceBuffer = this._source_buffer;
            if (!sourceBuffer || end <= start) {
                resolve();
                return;
            }

            const onUpdateEnd = () => {
                cleanup();
                resolve();
            };
            const onError = () => {
                cleanup();
                reject(new Error('SourceBuffer remove failed.'));
            };
            const cleanup = () => {
                sourceBuffer.removeEventListener('updateend', onUpdateEnd);
                sourceBuffer.removeEventListener('error', onError);
            };

            sourceBuffer.addEventListener('updateend', onUpdateEnd);
            sourceBuffer.addEventListener('error', onError);
            try {
                sourceBuffer.remove(start, end);
            } catch (error) {
                cleanup();
                reject(error);
            }
        });
    }

    _restoreLogicalDuration() {
        if (!this._media_source || this._media_source.readyState !== 'open' || this._source_buffer.updating) {
            return;
        }
        try {
            if (Math.abs(this._media_source.duration - this._duration) > 0.050) {
                this._media_source.duration = this._duration;
            }
        } catch (e) {
            // Appended media may temporarily make duration immutable until updateend.
        }
    }

    _cleanupOldBuffer() {
        if (!this._source_buffer || !this._media_element || !this._config.maxBufferBehindSeconds) {
            return;
        }

        const nowClock = Date.now() / 1000;
        if (nowClock - this._last_cleanup_clock < this._config.cleanupIntervalSeconds) {
            return;
        }
        this._last_cleanup_clock = nowClock;

        const cutoff = this._media_element.currentTime - this._config.maxBufferBehindSeconds;
        if (cutoff <= 1) {
            return;
        }

        let hasOldData = false;
        const buffered = this._source_buffer.buffered;
        for (let i = 0; i < buffered.length; i += 1) {
            if (buffered.start(i) < cutoff - 1) {
                hasOldData = true;
                break;
            }
        }
        if (!hasOldData) {
            return;
        }

        this._enqueueAppend(async () => {
            await this._removeBuffer(0, cutoff);
            const evicted = [];
            this._loaded_segments.forEach((key) => {
                const parts = key.split(':');
                const scene = this._scenes[Number(parts[0])];
                const segment = scene && scene.segments[Number(parts[1])];
                if (segment && segment.timelineEnd <= cutoff + 0.010) {
                    evicted.push(key);
                }
            });
            evicted.forEach((key) => this._loaded_segments.delete(key));
            this._emitter.emit(SceneCompositionEvents.BUFFER_EVICTED, {
                before: cutoff,
                segmentCount: evicted.length
            });
        }).catch((error) => this._emitError('BUFFER_CLEANUP_FAILED', error));
    }

    _sceneIndexAtTime(seconds) {
        if (!this._scenes.length) {
            return -1;
        }
        const time = clamp(Number(seconds) || 0, 0, Math.max(0, this._duration - 0.000001));
        let low = 0;
        let high = this._scenes.length - 1;
        while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            const scene = this._scenes[middle];
            if (time < scene.timelineStart) {
                high = middle - 1;
            } else if (time >= scene.timelineEnd && middle < this._scenes.length - 1) {
                low = middle + 1;
            } else {
                return middle;
            }
        }
        return this._scenes.length - 1;
    }

    _publicScene(scene) {
        if (!scene) {
            return null;
        }
        return {
            index: scene.index,
            id: scene.id,
            title: scene.title,
            metadata: scene.metadata,
            sourceId: scene.sourceId,
            sourceStart: scene.sourceStart,
            sourceEnd: scene.sourceEnd,
            duration: scene.duration,
            timelineStart: scene.timelineStart,
            timelineEnd: scene.timelineEnd,
            mimeType: scene.mimeType,
            runIndex: scene.runIndex
        };
    }

    _emitSceneChange(force) {
        const index = this.currentSceneIndex;
        if (index < 0 || (!force && index === this._last_scene_index)) {
            return;
        }
        this._last_scene_index = index;
        const scene = this._scenes[index];
        this._emitter.emit(SceneCompositionEvents.SCENE_CHANGE, {
            scene: this._publicScene(scene),
            sceneIndex: index,
            sceneCount: this._scenes.length,
            compilationTime: this.currentTime,
            compilationDuration: this._duration,
            sceneTime: Math.max(0, this.currentTime - scene.timelineStart)
        });
    }

    _onTimeUpdate() {
        if (!this._ready) {
            return;
        }
        this._emitSceneChange(false);
        const time = this.currentTime;
        const sceneIndex = this.currentSceneIndex;
        const scene = sceneIndex >= 0 ? this._scenes[sceneIndex] : null;
        this._emitter.emit(SceneCompositionEvents.TIME_UPDATE, {
            scene: scene ? this._publicScene(scene) : null,
            sceneIndex: sceneIndex,
            sceneCount: this._scenes.length,
            sceneTime: scene ? Math.max(0, time - scene.timelineStart) : 0,
            compilationTime: time,
            compilationDuration: this._duration
        });
        this._ensureWindow(time, false).catch((error) => this._emitError('PRELOAD_FAILED', error));
        this._cleanupOldBuffer();
    }

    _onSeeking() {
        if (!this._ready) {
            return;
        }
        const time = this.currentTime;
        this._emitSceneChange(false);
        this._ensureWindow(time, true).catch((error) => this._emitError('SEEK_BUFFER_FAILED', error));
    }

    _onWaiting() {
        if (!this._ready) {
            return;
        }
        this._ensureWindow(this.currentTime, true).catch((error) => this._emitError('STALL_BUFFER_FAILED', error));
    }

    _onKeyDown(event) {
        if (!this._ready || !this._config.keyboardSceneNavigation || isEditableTarget(event.target)) {
            return;
        }
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
            return;
        }
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') {
            event.stopImmediatePropagation();
        }

        if (event.key === 'ArrowRight') {
            this.nextScene();
        } else {
            this.previousScene();
        }
    }

    _installTitleTrack() {
        if (!this._media_element || !this._scenes.length || this._title_track) {
            return;
        }
        try {
            const track = this._media_element.addTextTrack('subtitles', 'Scenes', this._config.sceneTitleLanguage || 'en');
            track.mode = this._config.showSceneTitles ? 'showing' : 'hidden';
            this._scenes.forEach((scene) => {
                const configuredDuration = Number(this._config.sceneTitleCueDuration);
                const cueEnd = configuredDuration > 0
                    ? Math.min(scene.timelineEnd, scene.timelineStart + configuredDuration)
                    : scene.timelineEnd;
                const cue = new VTTCue(scene.timelineStart, Math.max(scene.timelineStart + 0.050, cueEnd), scene.title);
                cue.id = scene.id;
                track.addCue(cue);
            });
            this._title_track = track;
        } catch (error) {
            this._emitError('TEXT_TRACK_FAILED', error);
        }
    }

    _removeTitleTrack() {
        if (!this._title_track) {
            return;
        }
        try {
            const cues = this._title_track.cues;
            if (cues) {
                const list = [];
                for (let i = 0; i < cues.length; i += 1) {
                    list.push(cues[i]);
                }
                list.forEach((cue) => this._title_track.removeCue(cue));
            }
            this._title_track.mode = 'disabled';
        } catch (e) {
            // Ignore cue cleanup races.
        }
        this._title_track = null;
    }

    _emitError(code, error) {
        this._emitter.emit(SceneCompositionEvents.ERROR, {
            code: code,
            message: error && error.message ? error.message : String(error || code),
            error: error || null
        });
    }
}

export {SceneCompositionEvents};
export default SceneCompositionPlayer;
