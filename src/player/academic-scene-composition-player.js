import SceneCompositionPlayer from './scene-composition-player.js';
import {InvalidArgumentException, IllegalStateException} from '../utils/exception.js';

function documentBaseURL() {
    if (typeof document !== 'undefined' && document.baseURI) {
        return document.baseURI;
    }
    if (typeof location !== 'undefined' && location.href) {
        return location.href;
    }
    return null;
}

function resolveURL(value, baseURL) {
    if (!value || !baseURL || typeof URL === 'undefined') {
        return value;
    }
    try {
        return new URL(value, baseURL).href;
    } catch (e) {
        return value;
    }
}

function makeAbortError(message) {
    const error = new Error(message || 'Scene request was cancelled.');
    error.name = 'AbortError';
    error._academicStale = true;
    return error;
}

function mimeTopology(mimeType) {
    const value = String(mimeType || '').toLowerCase();
    return {
        audio: /mp4a\.|ac-3|ec-3|opus|flac|mp3/.test(value),
        video: /avc1\.|avc3\.|hev1\.|hvc1\.|av01\.|vp09\./.test(value)
    };
}

class AcademicSceneCompositionPlayer extends SceneCompositionPlayer {

    constructor(mediaDataSource, config) {
        super(mediaDataSource, config);
        this._manifest_base_url = null;
        this._academic_generation = 0;
        this._academic_abort_controller = null;
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

        const generation = this._beginAcademicGeneration();
        this._load_error = null;
        this._load_promise = this._loadInternal().catch((error) => {
            if (generation !== this._academic_generation || this._isAcademicAbort(error)) {
                return;
            }
            this._load_error = error;
            this._emitError('LOAD_FAILED', error);
        });
    }

    unload() {
        this._cancelAcademicGeneration();
        super.unload();
    }

    _beginAcademicGeneration() {
        this._cancelAcademicGeneration();
        const generation = this._academic_generation;
        if (typeof AbortController !== 'undefined') {
            this._academic_abort_controller = new AbortController();
        }
        return generation;
    }

    _cancelAcademicGeneration() {
        this._academic_generation += 1;
        if (this._academic_abort_controller) {
            try {
                this._academic_abort_controller.abort();
            } catch (e) {
                // Ignore teardown races.
            }
        }
        this._academic_abort_controller = null;
    }

    _assertAcademicGeneration(generation) {
        if (generation !== this._academic_generation) {
            throw makeAbortError('Stale Scene request ignored.');
        }
    }

    _isAcademicAbort(error) {
        return !!error && (error.name === 'AbortError' || error._academicStale === true);
    }

    _normaliseManifest(manifest) {
        super._normaliseManifest(manifest);
        if (!this._scenes.length) {
            return;
        }

        const expected = mimeTopology(this._scenes[0].mimeType);
        for (let index = 1; index < this._scenes.length; index += 1) {
            const actual = mimeTopology(this._scenes[index].mimeType);
            if (actual.audio !== expected.audio || actual.video !== expected.video) {
                throw new InvalidArgumentException(
                    'All Scenes in one Compilation must use the same audio/video track topology.'
                );
            }
        }
    }

    async _resolveManifest() {
        const generation = this._academic_generation;
        if (this._media_data_source.manifest && typeof this._media_data_source.manifest === 'object') {
            this._manifest_base_url = documentBaseURL();
            return this._media_data_source.manifest;
        }
        if (Array.isArray(this._media_data_source.scenes)) {
            this._manifest_base_url = documentBaseURL();
            return this._media_data_source;
        }

        const manifestUrl = typeof this._media_data_source.manifest === 'string'
            ? this._media_data_source.manifest
            : this._media_data_source.url;

        if (!manifestUrl) {
            throw new InvalidArgumentException('Scene MediaDataSource requires manifest, scenes, or url.');
        }

        const requestUrl = resolveURL(manifestUrl, documentBaseURL());
        const options = {
            credentials: this._config.withCredentials ? 'include' : 'same-origin',
            headers: this._config.headers || {}
        };
        if (this._academic_abort_controller) {
            options.signal = this._academic_abort_controller.signal;
        }

        const response = await fetch(requestUrl, options);
        this._assertAcademicGeneration(generation);
        if (!response.ok) {
            throw new Error('Scene manifest request failed with HTTP ' + response.status);
        }

        this._manifest_base_url = response.url || requestUrl || documentBaseURL();
        const manifest = await response.json();
        this._assertAcademicGeneration(generation);
        return manifest;
    }

    async _fetchArrayBuffer(resource) {
        if (!resource || typeof resource !== 'object') {
            return super._fetchArrayBuffer(resource);
        }

        const generation = this._academic_generation;
        const resolvedResource = Object.assign({}, resource, {
            url: resolveURL(resource.url, this._manifest_base_url || documentBaseURL())
        });

        if (typeof this._config.fetcher === 'function') {
            const custom = await this._config.fetcher(resolvedResource);
            this._assertAcademicGeneration(generation);
            if (!(custom instanceof ArrayBuffer)) {
                throw new Error('Scene fetcher must resolve to an ArrayBuffer.');
            }
            return custom;
        }

        const headers = Object.assign({}, this._config.headers || {}, resolvedResource.headers || {});
        if (resolvedResource.byteRange && resolvedResource.byteRange.start != null) {
            const end = resolvedResource.byteRange.end != null ? resolvedResource.byteRange.end : '';
            headers.Range = 'bytes=' + resolvedResource.byteRange.start + '-' + end;
        }

        const options = {
            credentials: this._config.withCredentials ? 'include' : 'same-origin',
            headers: headers
        };
        if (this._academic_abort_controller) {
            options.signal = this._academic_abort_controller.signal;
        }

        const response = await fetch(resolvedResource.url, options);
        this._assertAcademicGeneration(generation);
        if (!response.ok && response.status !== 206) {
            throw new Error('Scene media request failed with HTTP ' + response.status);
        }
        const data = await response.arrayBuffer();
        this._assertAcademicGeneration(generation);
        return data;
    }

    async _loadAndAppendSegment(scene, segment) {
        const initData = scene.initSegment ? await this._getInitData(scene.initSegment) : null;
        const mediaData = await this._fetchArrayBuffer(segment);

        return this._enqueueAppend(async () => {
            await this._ensureSourceBufferType(scene.mimeType);
            const sourceBuffer = this._source_buffer;
            const desiredOffset = scene.timelineStart - scene.mediaStart;
            if (Math.abs(sourceBuffer.timestampOffset - desiredOffset) > 0.0001) {
                sourceBuffer.timestampOffset = desiredOffset;
            }

            // Keep each Scene's coded frames inside its authored logical range.
            // This prevents codec delay or fragment tails from extending the native
            // Firefox Compilation timeline beyond the declared Scene duration.
            sourceBuffer.appendWindowStart = Math.max(0, scene.timelineStart);
            sourceBuffer.appendWindowEnd = Math.max(scene.timelineStart + 0.001, scene.timelineEnd);

            try {
                if (initData && this._active_init_key !== scene.initKey) {
                    await this._appendBuffer(initData);
                    this._active_init_key = scene.initKey;
                }

                await this._appendBuffer(mediaData);
                this._restoreLogicalDuration();
            } finally {
                if (this._source_buffer && !this._source_buffer.updating) {
                    try {
                        this._source_buffer.appendWindowStart = 0;
                        this._source_buffer.appendWindowEnd = Number.POSITIVE_INFINITY;
                    } catch (e) {
                        // Ignore teardown/changeType races.
                    }
                }
            }
        });
    }

    _installTitleTrack() {
        if (!this._config.showSceneTitles) {
            return;
        }
        super._installTitleTrack();
    }

    _emitError(code, error) {
        if (this._isAcademicAbort(error)) {
            return;
        }
        super._emitError(code, error);
    }
}

export default AcademicSceneCompositionPlayer;
