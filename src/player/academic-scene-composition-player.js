import SceneCompositionPlayer from './scene-composition-player.js';
import {InvalidArgumentException} from '../utils/exception.js';

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

class AcademicSceneCompositionPlayer extends SceneCompositionPlayer {

    constructor(mediaDataSource, config) {
        super(mediaDataSource, config);
        this._manifest_base_url = null;
    }

    async _resolveManifest() {
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
        const response = await fetch(requestUrl, {
            credentials: this._config.withCredentials ? 'include' : 'same-origin',
            headers: this._config.headers || {}
        });
        if (!response.ok) {
            throw new Error('Scene manifest request failed with HTTP ' + response.status);
        }

        this._manifest_base_url = response.url || requestUrl || documentBaseURL();
        return response.json();
    }

    async _fetchArrayBuffer(resource) {
        if (!resource || typeof resource !== 'object') {
            return super._fetchArrayBuffer(resource);
        }

        const resolvedResource = Object.assign({}, resource, {
            url: resolveURL(resource.url, this._manifest_base_url || documentBaseURL())
        });
        return super._fetchArrayBuffer(resolvedResource);
    }

    _installTitleTrack() {
        if (!this._config.showSceneTitles) {
            return;
        }
        super._installTitleTrack();
    }
}

export default AcademicSceneCompositionPlayer;
