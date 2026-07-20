// ==UserScript==
// @name         BetterDouyinPlayer
// @namespace    https://www.douyin.com/
// @version      1.3.5.18
// @description  美化一些选项，并在某些设备上使用更高的画质观看或下载视频
// @author       none
// @match        *://*.douyin.com/*
// @match        *://douyin.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // ============================================================
    // 0. 基础检测与初始化
    // ============================================================
    const urlMatch = location.pathname.match(/\/(video|photo)\/(\d{19})/);
    if (!urlMatch) return;
    const CURRENT_VIDEO_ID = urlMatch[2];
    console.log('[BDP] 当前视频ID:', CURRENT_VIDEO_ID);
    console.log('[BDP] v1.3.5.18 启动');

    // ============================================================
    // 1. 用户设置管理
    // ============================================================
    const SETTINGS_KEY = 'douyin_settings';
    const DEFAULT_SETTINGS = {
        codecPreference: 'HEVC',
        qualityPreference: '1440P',
        showMoreStreams: false,
        blurEffect: true,
        debugMode: false,
        useIndependentAudio: false
    };
    let settings = loadSettings();
    let autoSwitchDone = false;
    let autoSwitchNotified = false;

    function loadSettings() {
        let s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (raw) {
                const p = JSON.parse(raw);
                Object.keys(s).forEach(k => {
                    if (p[k] !== undefined) s[k] = p[k];
                });
            }
        } catch (e) {}
        return s;
    }

    function saveSettings() {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
    }

    // ============================================================
    // 2. 全局变量
    // ============================================================
    let currentMode = 'watch';
    let isSwitching = false;
    let qualityButton = null;
    let currentPanel = null;
    let lastFormats = null;
    let nw, ni, nc, ncb, nti;
    let styleEl = null;
    let interceptedDetail = null;
    let detailResolve = null;
    let debugOverlay = null;
    let debugLogContainer = null;
    let debugInterval = null;
    let debugLogs = [];
    let isSettingsMode = false;
    let currentPlayingFormat = null;
    let currentPageVideoId = CURRENT_VIDEO_ID;
    let globalClosePanel = null;
    let buttonTextObserver = null;
    let isUpdatingButtonText = false;
    let expectedButtonText = null;
    let audioElement = null;
    let videoVolumeBeforeMute = 1;
    let loadStartTime = 0;
    let lastLoadedTime = 0;
    let lastLoadedMB = 0;
    let currentSpeedKB = 0;
    let speedIsComplete = false;

    // ============================================================
    // 3. 辅助函数
    // ============================================================
    function addDebugLog(msg) {
        if (!settings.debugMode) return;
        const ts = new Date().toLocaleTimeString();
        const entry = '[' + ts + '] ' + msg;
        debugLogs.push(entry);
        if (debugLogs.length > 50) debugLogs.shift();
        if (debugLogContainer) {
            debugLogContainer.innerHTML = debugLogs.join('<br>');
            debugLogContainer.scrollTop = debugLogContainer.scrollHeight;
        }
    }

    function updateQualityButtonText(text) {
        if (!text) {
            console.warn('[BDP] 忽略空文字更新');
            return;
        }
        let btn = qualityButton || document.querySelector('xg-icon.xgplayer-playclarity-setting');
        if (!btn) return;
        if (btn.textContent.trim() === text) return;
        isUpdatingButtonText = true;
        let target = btn.querySelector('.btn');
        if (target) {
            target.textContent = text;
        } else {
            btn.innerHTML = '';
            btn.appendChild(document.createTextNode(text));
        }
        setTimeout(() => {
            isUpdatingButtonText = false;
        }, 200);
        console.log('[BDP] 更新按钮文字为:', text);
    }

    // ============================================================
    // 4. 按钮文字持久化
    // ============================================================
    function setupButtonTextPersistence(expText) {
        if (!expText) {
            console.warn('[BDP] 忽略空持久化文字');
            return;
        }
        expectedButtonText = expText;
        if (!qualityButton) qualityButton = document.querySelector('xg-icon.xgplayer-playclarity-setting');
        if (!qualityButton) return;
        updateQualityButtonText(expText);
        clearButtonTextPersistence();

        const container = document.querySelector('.xgplayer-controls');
        const observer = function() {
            if (isUpdatingButtonText) return;
            if (!qualityButton) qualityButton = document.querySelector('xg-icon.xgplayer-playclarity-setting');
            if (!qualityButton) return;
            let ct = qualityButton.textContent.trim();
            if (ct !== expectedButtonText && expectedButtonText) {
                console.log('[BDP] 检测到按钮文字被重置，恢复为:', expectedButtonText);
                updateQualityButtonText(expectedButtonText);
            }
        };
        if (container) {
            buttonTextObserver = new MutationObserver(observer);
            buttonTextObserver.observe(container, {
                childList: true,
                subtree: true,
                characterData: true,
                attributes: true
            });
        } else {
            const target = qualityButton.parentElement || qualityButton;
            buttonTextObserver = new MutationObserver(observer);
            buttonTextObserver.observe(target, {
                childList: true,
                subtree: true,
                characterData: true,
                attributes: true
            });
        }

        const video = document.querySelector('video');
        if (video) {
            const handler = function() {
                setTimeout(() => {
                    if (qualityButton && qualityButton.textContent.trim() !== expectedButtonText && expectedButtonText) {
                        updateQualityButtonText(expectedButtonText);
                    }
                }, 300);
                video.removeEventListener('loadeddata', handler);
                video.removeEventListener('canplay', handler);
            };
            video.addEventListener('loadeddata', handler);
            video.addEventListener('canplay', handler);
        }
    }

    function clearButtonTextPersistence() {
        if (buttonTextObserver) {
            buttonTextObserver.disconnect();
            buttonTextObserver = null;
        }
    }

    function handleFullscreenChange() {
        if (!expectedButtonText) return;
        setTimeout(() => {
            if (!qualityButton) qualityButton = document.querySelector('xg-icon.xgplayer-playclarity-setting');
            if (qualityButton && qualityButton.textContent.trim() !== expectedButtonText) {
                console.log('[BDP] 全屏切换修正文字');
                updateQualityButtonText(expectedButtonText);
            }
        }, 500);
    }

    // ============================================================
    // 5. 独立音频管理
    // ============================================================
    function playIndependentAudio(musicUrl, videoElement) {
        if (!musicUrl || !videoElement) return;
        if (!settings.useIndependentAudio) {
            cleanupIndependentAudio(videoElement);
            if (videoElement.volume === 0 && videoVolumeBeforeMute !== undefined) {
                videoElement.volume = videoVolumeBeforeMute;
            }
            return;
        }
        if (audioElement && audioElement.src === musicUrl && !audioElement.paused) {
            if (videoElement.volume !== 0) {
                videoVolumeBeforeMute = videoElement.volume;
                videoElement.volume = 0;
            }
            return;
        }
        cleanupIndependentAudio(videoElement);
        if (videoElement.volume !== 0) {
            videoVolumeBeforeMute = videoElement.volume;
            videoElement.volume = 0;
        }
        audioElement = document.createElement('audio');
        audioElement.src = musicUrl;
        audioElement.preload = 'auto';
        audioElement.volume = videoVolumeBeforeMute || 1;
        audioElement.addEventListener('loadedmetadata', function() {
            audioElement.currentTime = videoElement.currentTime;
            if (!videoElement.paused) {
                audioElement.play().catch(e => console.warn('[BDP] 独立音频播放失败:', e));
            }
        });
        const syncHandler = function() {
            if (audioElement && !audioElement.paused) {
                const diff = Math.abs(audioElement.currentTime - videoElement.currentTime);
                if (diff > 0.5) {
                    audioElement.currentTime = videoElement.currentTime;
                }
            }
        };
        videoElement.addEventListener('timeupdate', syncHandler);
        videoElement._audioSyncHandler = syncHandler;

        const playHandler = function() {
            if (audioElement && videoElement) {
                audioElement.currentTime = videoElement.currentTime;
                audioElement.play().catch(() => {});
            }
        };
        const pauseHandler = function() {
            if (audioElement) {
                audioElement.pause();
                audioElement.currentTime = videoElement.currentTime;
            }
        };
        const seekingHandler = function() {
            if (audioElement && !videoElement.paused) {
                audioElement.currentTime = videoElement.currentTime;
            }
        };
        videoElement.addEventListener('play', playHandler);
        videoElement.addEventListener('pause', pauseHandler);
        videoElement.addEventListener('seeking', seekingHandler);
        videoElement._audioPlayHandler = playHandler;
        videoElement._audioPauseHandler = pauseHandler;
        videoElement._audioSeekingHandler = seekingHandler;
        audioElement.load();
    }

    function cleanupIndependentAudio(videoElement) {
        if (audioElement) {
            audioElement.pause();
            audioElement.src = '';
            audioElement.remove();
            audioElement = null;
        }
        if (videoElement) {
            if (videoElement._audioSyncHandler) {
                videoElement.removeEventListener('timeupdate', videoElement._audioSyncHandler);
                delete videoElement._audioSyncHandler;
            }
            if (videoElement._audioPlayHandler) {
                videoElement.removeEventListener('play', videoElement._audioPlayHandler);
                delete videoElement._audioPlayHandler;
            }
            if (videoElement._audioPauseHandler) {
                videoElement.removeEventListener('pause', videoElement._audioPauseHandler);
                delete videoElement._audioPauseHandler;
            }
            if (videoElement._audioSeekingHandler) {
                videoElement.removeEventListener('seeking', videoElement._audioSeekingHandler);
                delete videoElement._audioSeekingHandler;
            }
            if (videoElement.volume === 0 && videoVolumeBeforeMute !== undefined) {
                videoElement.volume = videoVolumeBeforeMute;
            }
        }
    }

    function getMusicUrl() {
        if (!interceptedDetail || !interceptedDetail.music) return null;
        const music = interceptedDetail.music;
        if (music.play_url && music.play_url.url_list && music.play_url.url_list.length > 0) {
            return music.play_url.url_list[0];
        }
        return null;
    }

    // ============================================================
    // 6. 清晰度标签生成
    // ============================================================
    function getShortLabel(w, h) {
        const s = Math.min(w, h);
        if (s >= 1441) return '4K';
        if (s >= 1081) return '2K';
        if (s >= 721) return '1080P';
        if (s >= 577) return '720P';
        if (s >= 541) return '576P';
        return s + 'P';
    }

    function getFullLabel(w, h, fps) {
        const s = Math.min(w, h);
        let label = getShortLabel(w, h);
        let desc = '';
        if (s >= 1441) desc = '超高清';
        else if (s >= 1081) desc = '超高清';
        else if (s >= 721) desc = '高清';
        else if (s >= 577) desc = '准高清';
        else if (s >= 541) desc = '标清';
        else desc = '流畅';
        label += ' ' + desc;
        if (fps && parseInt(fps) >= 31) label += ' 高帧率';
        return label;
    }

    function extractBitrateFromUrl(url) {
        if (!url) return null;
        const m = url.match(/[?&]br=(\d+)/);
        if (m) return parseInt(m[1], 10);
        return null;
    }

    // ============================================================
    // 7. 构建画质列表
    // ============================================================
    function buildQualityList(brs) {
        let all = brs.map(br => {
            const url = br.play_addr?.url_list?.[0] || '';
            const size = br.play_addr?.data_size || 0;
            let sizeDisplay = '';
            if (size > 0) {
                const mb = size / (1024 * 1024);
                sizeDisplay = mb >= 1 ? mb.toFixed(2) + 'MB' : (size / 1024).toFixed(2) + 'KB';
            }
            let bitrate = '';
            if (br.bit_rate) {
                bitrate = Math.round(br.bit_rate / 1000) + 'kbps';
            } else {
                const brVal = extractBitrateFromUrl(url);
                if (brVal) bitrate = brVal + 'kbps';
            }
            const gearName = br.gear_name || '';
            return {
                url: url,
                uri: br.play_addr?.uri || '',
                bitrate: bitrate,
                codec: br.is_h265 ? 'HEVC' : 'AVC',
                fps: br.FPS || '?',
                width: br.play_addr?.width || 0,
                height: br.play_addr?.height || 0,
                sizeDisplay: sizeDisplay,
                is_h265: br.is_h265 || 0,
                gear_name: gearName,
                _raw: br
            };
        });

        let filtered = all;
        if (settings.codecPreference === 'HEVC') {
            filtered = all.filter(f => f.is_h265 === 1);
        } else if (settings.codecPreference === 'AVC') {
            filtered = all.filter(f => f.is_h265 === 0);
        }
        if (filtered.length === 0) {
            filtered = all;
        }
        if (!settings.showMoreStreams) {
            const map = new Map();
            filtered.forEach(f => {
                const key = f.height + '_' + f.fps;
                if (!map.has(key) || parseInt(f.bitrate) > parseInt(map.get(key).bitrate)) {
                    map.set(key, f);
                }
            });
            filtered = Array.from(map.values());
        }
        filtered.sort((a, b) => {
            return (b.height || 0) - (a.height || 0) ||
                (parseInt(b.fps) || 0) - (parseInt(a.fps) || 0) ||
                (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0);
        });
        return filtered;
    }

    // ============================================================
    // 8. 切换画质
    // ============================================================
    function switchQuality(format, musicUrl) {
        return new Promise((resolve, reject) => {
            if (isSwitching) {
                reject('正在切换中');
                return;
            }
            isSwitching = true;
            const video = document.querySelector('video');
            if (!video) {
                isSwitching = false;
                reject('无视频元素');
                return;
            }
            const t = video.currentTime;
            const vol = video.volume;
            const wasPlaying = !video.paused;
            let url = format.url;
            if (url && !url.includes('#')) url += '#t=' + t;
            video.pause();
            cleanupIndependentAudio(video);
            video.src = '';
            video.src = url;
            video.load();

            const fullLabel = getFullLabel(format.width, format.height, format.fps);
            const shortLabel = getShortLabel(format.width, format.height);
            const fpsNum = parseInt(format.fps);
            const isHighFps = fpsNum && fpsNum >= 31;
            const fpsStr = isHighFps ? String(fpsNum) : '';

            let resolved = false;
            let loadTimeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    video.removeEventListener('canplay', onCanPlay);
                    video.removeEventListener('error', onError);
                    isSwitching = false;
                    reject('加载超时');
                }
            }, 30000);

            function onCanPlay() {
                if (resolved) return;
                resolved = true;
                clearTimeout(loadTimeout);
                video.removeEventListener('canplay', onCanPlay);
                video.removeEventListener('error', onError);
                video.currentTime = t;
                video.volume = vol;
                video.muted = true;
                if (wasPlaying) {
                    video.play().then(() => video.muted = false).catch(() => video.muted = false);
                } else {
                    video.muted = false;
                }
                isSwitching = false;
                currentPlayingFormat = format;
                setupVideoMetadataListener(video);

                if (musicUrl && settings.useIndependentAudio) {
                    playIndependentAudio(musicUrl, video);
                } else {
                    cleanupIndependentAudio(video);
                    if (video.volume === 0 && videoVolumeBeforeMute !== undefined) {
                        video.volume = videoVolumeBeforeMute;
                    }
                }
                resolve({ fullLabel: fullLabel, shortLabel: shortLabel, fps: fpsStr, isHighFps: isHighFps });
            }

            function onError(e) {
                if (resolved) return;
                resolved = true;
                clearTimeout(loadTimeout);
                video.removeEventListener('canplay', onCanPlay);
                video.removeEventListener('error', onError);
                isSwitching = false;
                reject('加载失败: ' + (video.error ? video.error.message : '未知错误'));
            }
            video.addEventListener('canplay', onCanPlay);
            video.addEventListener('error', onError);
        });
    }

    function setupVideoMetadataListener(video) {
        if (!video) return;
        video.removeEventListener('loadedmetadata', video._metadataHandler);
        video._metadataHandler = function() {
            if (currentPlayingFormat) {
                currentPlayingFormat.width = video.videoWidth || 0;
                currentPlayingFormat.height = video.videoHeight || 0;
            }
        };
        video.addEventListener('loadedmetadata', video._metadataHandler);
        if (video.readyState >= 1) video.dispatchEvent(new Event('loadedmetadata'));
    }

    // ============================================================
    // 9. 下载功能（仅视频，文件名：标题[ID].mp4，进度条左上对齐，进度条宽度 270px）
    // ============================================================
    function sanitizeFileName(name) {
        return name.replace(/[\\/:*?"<>|]/g, '').trim();
    }

    function downloadWithProgress(fileUrl, filename) {
        return new Promise(function(resolve, reject) {
            const container = getPlayerContainer() || document.body;
            if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
            const progressWrapper = document.createElement('div');
            progressWrapper.style.cssText = 'position:absolute; top:10px; left:10px; z-index:99999; display:flex; align-items:center;';
            container.appendChild(progressWrapper);
            const progressContainer = document.createElement('div');
            progressContainer.style.cssText = 'width:0; overflow:hidden; background:rgba(0,0,0,0.5); backdrop-filter:blur(6px); border-radius:8px; border:1px solid rgba(255,255,255,0.08); box-shadow:0 2px 10px rgba(0,0,0,0.3); box-sizing:border-box; transition:width 0.4s cubic-bezier(0.25,0.1,0.25,1);';
            progressWrapper.appendChild(progressContainer);
            const inner = document.createElement('div');
            inner.style.cssText = 'padding:12px 18px; white-space:nowrap; color:#fff; font-size:16px; font-family:sans-serif;';
            progressContainer.appendChild(inner);

            function showProgress(percent, text) {
                const barWidth = Math.round(270 * percent / 100);
                inner.innerHTML = '<div style="margin-bottom:4px;">' + text + '</div><div style="width:270px; height:4px; background:rgba(255,255,255,0.2); border-radius:2px; overflow:hidden;"><div style="width:' + barWidth + 'px; height:100%; background:#4caf50; border-radius:2px; transition:width 0.2s;"></div></div>';
            }
            requestAnimationFrame(function() {
                progressContainer.style.width = '300px';
                showProgress(0, '下载中 0%');
            });
            fetch(fileUrl, {
                headers: { 'Referer': 'https://www.douyin.com/', 'User-Agent': navigator.userAgent }
            }).then(function(resp) {
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const total = parseInt(resp.headers.get('content-length')) || 0;
                const reader = resp.body.getReader();
                let received = 0;
                const chunks = [];

                function read() {
                    return reader.read().then(function(result) {
                        if (result.done) {
                            const blob = new Blob(chunks);
                            const downloadUrl = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = downloadUrl;
                            a.download = filename;
                            a.style.display = 'none';
                            document.body.appendChild(a);
                            a.click();
                            setTimeout(function() {
                                document.body.removeChild(a);
                                URL.revokeObjectURL(downloadUrl);
                            }, 5000);
                            inner.innerHTML = '下载完成';
                            progressContainer.style.transition = 'width 0.3s cubic-bezier(0.42,0,0.58,1)';
                            progressContainer.style.width = '0';
                            setTimeout(function() {
                                if (progressWrapper.parentNode) progressWrapper.parentNode.removeChild(progressWrapper);
                            }, 350);
                            resolve();
                            return;
                        }
                        received += result.value.length;
                        chunks.push(result.value);
                        const percent = total ? Math.round(received / total * 100) : 0;
                        showProgress(percent, '下载中 ' + percent + '%');
                        return read();
                    });
                }
                return read();
            }).catch(function(err) {
                inner.innerHTML = '下载失败';
                progressContainer.style.transition = 'width 0.3s cubic-bezier(0.42,0,0.58,1)';
                setTimeout(function() {
                    progressContainer.style.width = '0';
                    setTimeout(function() {
                        if (progressWrapper.parentNode) progressWrapper.parentNode.removeChild(progressWrapper);
                    }, 350);
                }, 1500);
                reject(err);
            });
        });
    }

    // ============================================================
    // 10. 获取播放器容器
    // ============================================================
    function getPlayerContainer() {
        const video = document.querySelector('video');
        if (!video) return null;
        let c = document.querySelector('xg-video-container');
        if (c) return c;
        c = video.closest('xg-video-container, .xg-video-container, [class*="xgplayer"][class*="video-container"], [class*="player"][class*="container"]');
        if (c) return c;
        let p = video.parentElement;
        while (p && p !== document.body) {
            if (p.className && (p.className.includes('basePlayerContainer') || p.className.includes('playerContainer') || p.className.includes('slider-video'))) {
                return p;
            }
            p = p.parentElement;
        }
        return video.parentElement || document.body;
    }

    // ============================================================
    // 11. 通知系统
    // ============================================================
    function initNotification(container) {
        if (!container) container = document.body;
        if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
        if (!nw) {
            nw = document.createElement('div');
            nw.style.cssText = 'position:absolute;bottom:20px;left:20px;z-index:9999;display:flex;align-items:center;pointer-events:auto;';
            container.appendChild(nw);
            ni = document.createElement('div');
            ni.style.cssText = 'width:0;overflow:hidden;background:rgba(0,0,0,0.5);backdrop-filter:blur(6px);border-radius:8px;border:1px solid rgba(255,255,255,0.08);box-shadow:0 2px 10px rgba(0,0,0,0.3);box-sizing:border-box;display:flex;align-items:stretch;';
            nw.appendChild(ni);
            ncb = document.createElement('span');
            ncb.style.cssText = 'display:none;width:4px;flex-shrink:0;border-radius:8px 0 0 8px;';
            ni.appendChild(ncb);
            nc = document.createElement('div');
            nc.style.cssText = 'padding:12px 18px;white-space:nowrap;color:#fff;font-size:16px;';
            ni.appendChild(nc);
            nw.addEventListener('mouseenter', function() {
                ni.style.opacity = '0.6';
                ni.style.backdropFilter = 'none';
            });
            nw.addEventListener('mouseleave', function() {
                ni.style.opacity = '1';
                ni.style.backdropFilter = 'blur(6px)';
            });
        }
        return nw;
    }

    function showNotification(text, type, container, isReplacement) {
        return new Promise(function(resolve) {
            initNotification(container);
            if (nti) { clearTimeout(nti);
                nti = null; }
            ni.style.display = 'flex';
            let cw = parseFloat(ni.style.width) || 0;
            let sd = 0.35,
                ed = 0.4;
            if (isReplacement) { sd = 0.2;
                ed = 0.25; }
            const colors = { success: '#4caf50', error: '#f44336', loading: '#ff9800' };
            const bg = colors[type] || 'transparent';
            if (cw > 0) {
                ncb.style.display = 'none';
                ni.style.transition = 'width ' + sd + 's cubic-bezier(0.42,0,0.58,1)';
                ni.style.width = '0';
                setTimeout(function() {
                    nc.textContent = text;
                    ncb.style.backgroundColor = bg;
                    ncb.style.display = 'block';
                    ni.style.transition = 'width ' + ed + 's cubic-bezier(0.25,0.1,0.25,1)';
                    const tw = nc.scrollWidth + 4 + 36;
                    ni.style.width = tw + 'px';
                    resolve();
                    clearNotification(5000);
                }, sd * 1000 + 50);
            } else {
                nc.textContent = text;
                ncb.style.backgroundColor = bg;
                ncb.style.display = 'block';
                ni.style.transition = 'width ' + ed + 's cubic-bezier(0.25,0.1,0.25,1)';
                const tw = nc.scrollWidth + 4 + 36;
                ni.style.width = tw + 'px';
                resolve();
                clearNotification(5000);
            }
        });
    }

    function clearNotification(delay) {
        if (nti) { clearTimeout(nti);
            nti = null; }
        nti = setTimeout(function() {
            if (ni && parseFloat(ni.style.width) > 0) {
                ncb.style.display = 'none';
                ni.style.transition = 'width 0.35s cubic-bezier(0.42,0,0.58,1)';
                ni.style.width = '0';
                setTimeout(function() {
                    ni.style.display = 'none';
                }, 350);
            }
            nti = null;
        }, delay || 5000);
    }

    // ============================================================
    // 12. XHR拦截
    // ============================================================
    function setupXHRInterceptor() {
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url, ...args) {
            this._url = url;
            if (typeof url === 'string' && url.includes('/aweme/v1/web/aweme/detail/')) {
                this._isDetail = true;
                const msg = '[BDP] 拦截到 detail 请求: ' + url;
                console.log(msg);
                addDebugLog(msg);
            }
            return originalOpen.call(this, method, url, ...args);
        };
        XMLHttpRequest.prototype.send = function(body) {
            if (this._isDetail) {
                this.addEventListener('load', function() {
                    if (this.status >= 200 && this.status < 300) {
                        try {
                            const data = JSON.parse(this.responseText);
                            if (data && data.aweme_detail) {
                                const newId = data.aweme_detail.aweme_id;
                                if (newId && newId !== currentPageVideoId) {
                                    console.log('[BDP] 视频ID变化:', currentPageVideoId, '->', newId);
                                    currentPageVideoId = newId;
                                    lastFormats = null;
                                    autoSwitchDone = false;
                                    autoSwitchNotified = false;
                                    if (currentPanel && globalClosePanel) globalClosePanel();
                                    clearButtonTextPersistence();
                                    if (qualityButton) updateQualityButtonText('智能');
                                    cleanupIndependentAudio(document.querySelector('video'));
                                }
                                interceptedDetail = data.aweme_detail;
                                const msg = '[BDP] 成功拦截 detail 响应，视频ID: ' + data.aweme_detail.aweme_id;
                                console.log(msg);
                                addDebugLog(msg);
                                if (detailResolve) {
                                    detailResolve(interceptedDetail);
                                    detailResolve = null;
                                }
                                try { localStorage.setItem('douyin_video_cache', JSON.stringify(interceptedDetail)); } catch (e) {}
                                if (interceptedDetail && interceptedDetail.video && interceptedDetail.video.bit_rate) {
                                    lastFormats = buildQualityList(interceptedDetail.video.bit_rate);
                                    if (!autoSwitchDone && !isSwitching && lastFormats.length > 0) {
                                        console.log('[BDP] 拦截到 detail，立即尝试自动切换');
                                        addDebugLog('[BDP] 拦截到 detail，立即尝试自动切换');
                                        attemptAutoSwitch(lastFormats);
                                    }
                                }
                            } else {
                                console.warn('[BDP] 拦截响应缺少 aweme_detail');
                            }
                        } catch (e) {
                            console.error('[BDP] 拦截响应 JSON 解析失败:', e);
                        }
                    } else {
                        console.warn('[BDP] detail 请求状态码非 2xx:', this.status);
                    }
                });
            }
            return originalSend.call(this, body);
        };
    }

    function fetchDetail(id) {
        return new Promise(function(resolve, reject) {
            const cached = localStorage.getItem('douyin_video_cache');
            if (cached) {
                try {
                    const data = JSON.parse(cached);
                    if (data.aweme_id === id) {
                        console.log('[BDP] 使用 localStorage 缓存');
                        resolve(data);
                        return;
                    }
                } catch (e) {}
            }
            if (interceptedDetail && interceptedDetail.aweme_id === id) {
                console.log('[BDP] 使用内存拦截数据');
                resolve(interceptedDetail);
                return;
            }
            console.log('[BDP] 等待拦截器捕获 detail...');
            const timeout = setTimeout(function() {
                if (detailResolve) {
                    detailResolve = null;
                    reject(new Error('等待拦截超时（10秒）'));
                }
            }, 10000);
            detailResolve = function(data) {
                clearTimeout(timeout);
                resolve(data);
            };
        });
    }

    // ============================================================
    // 13. 调试面板
    // ============================================================
    function createDebugOverlay() {
        if (debugOverlay) return;
        const container = getPlayerContainer();
        if (!container) return;
        if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

        debugOverlay = document.createElement('div');
        debugOverlay.id = 'debug-overlay';
        const blurStyle = settings.blurEffect ? 'blur(8px)' : 'none';
        debugOverlay.style.cssText = 'position:absolute; top:10px; left:10px; z-index:999999; background:rgba(0,0,0,0.65); backdrop-filter:' + blurStyle + '; border-radius:10px; padding:14px; min-width:320px; max-width:420px; color:#0f0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size:12px; line-height:1.5; border:1px solid rgba(255,255,255,0.1); box-shadow:0 4px 20px rgba(0,0,0,0.8); max-height:80vh; overflow-y:auto; pointer-events:auto; cursor:move;';

        debugOverlay.innerHTML = '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;"><span style="font-weight:bold; font-size:14px; color:#fff;">调试信息</span><button id="debug-close-btn" style="background:transparent; border:none; color:#ff6b6b; font-size:18px; cursor:pointer; padding:0 4px;">✕</button></div><div id="debug-content"><div><span style="color:#888;">视频ID:</span> <span id="debug-video-id">-</span></div><div><span style="color:#888;">视频画质:</span> <span id="debug-resolution">-</span></div><div><span style="color:#888;">格式ID:</span> <span id="debug-gear-name">-</span></div><div style="display:flex; align-items:center; margin-top:4px;"><span style="color:#888;">视频域名:</span><span id="debug-domain" style="margin:0 6px;">-</span><button id="debug-copy-domain" style="background:rgba(255,255,255,0.1); border:none; color:#0f0; border-radius:4px; padding:1px 8px; font-size:11px; cursor:pointer;">复制</button></div><div><span style="color:#888;">视频码率:</span> <span id="debug-bitrate">-</span></div><div><span style="color:#888;">加载速度:</span> <span id="debug-speed">-</span></div><div><span style="color:#888;">已预加载时长:</span> <span id="debug-buffer">-</span></div><div style="margin-top:8px; border-top:1px solid #333; padding-top:6px;"><div style="display:flex; justify-content:space-between; align-items:center;"><span style="color:#888;">日志</span><button id="debug-copy-log" style="background:rgba(255,255,255,0.1); border:none; color:#0f0; border-radius:4px; padding:2px 10px; font-size:11px; cursor:pointer;">复制日志</button></div><div id="debug-log-container" style="max-height:150px; overflow-y:auto; background:rgba(0,0,0,0.3); border-radius:4px; padding:6px 8px; margin-top:4px; font-size:11px; color:#aaa; user-select:text; cursor:text; white-space:pre-wrap; word-break:break-all;"></div></div></div>';

        container.appendChild(debugOverlay);

        document.getElementById('debug-close-btn').addEventListener('click', function() {
            settings.debugMode = false;
            saveSettings();
            destroyDebugOverlay();
        });

        document.getElementById('debug-copy-domain').addEventListener('click', function() {
            const video = document.querySelector('video');
            if (video && video.src) {
                navigator.clipboard.writeText(video.src).then(function() {
                    showNotification('已复制完整视频地址', 'success', getPlayerContainer(), true);
                }).catch(function() {
                    const ta = document.createElement('textarea');
                    ta.value = video.src;
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    ta.remove();
                    showNotification('已复制完整视频地址', 'success', getPlayerContainer(), true);
                });
            }
        });

        document.getElementById('debug-copy-log').addEventListener('click', function() {
            const logText = debugLogs.join('\n');
            if (!logText) {
                showNotification('暂无日志', 'error', getPlayerContainer(), true);
                return;
            }
            navigator.clipboard.writeText(logText).then(function() {
                showNotification('已复制全部日志 (' + debugLogs.length + ' 行)', 'success', getPlayerContainer(), true);
            }).catch(function() {
                const ta = document.createElement('textarea');
                ta.value = logText;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
                showNotification('已复制全部日志 (' + debugLogs.length + ' 行)', 'success', getPlayerContainer(), true);
            });
        });

        let isDragging = false;
        let startX, startY, origLeft, origTop;

        debugOverlay.addEventListener('mousedown', function(e) {
            if (e.target.closest('button') || e.target.closest('input') || e.target.closest('a')) return;
            isDragging = true;
            const rect = debugOverlay.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            origLeft = rect.left - containerRect.left;
            origTop = rect.top - containerRect.top;
            debugOverlay.style.cursor = 'grabbing';
            e.preventDefault();
        });

        document.addEventListener('mousemove', function(e) {
            if (!isDragging) return;
            const containerRect = container.getBoundingClientRect();
            let newLeft = origLeft + (e.clientX - startX);
            let newTop = origTop + (e.clientY - startY);
            const maxLeft = containerRect.width - debugOverlay.offsetWidth;
            const maxTop = containerRect.height - debugOverlay.offsetHeight;
            newLeft = Math.max(0, Math.min(maxLeft, newLeft));
            newTop = Math.max(0, Math.min(maxTop, newTop));
            debugOverlay.style.left = newLeft + 'px';
            debugOverlay.style.top = newTop + 'px';
            debugOverlay.style.right = 'auto';
            debugOverlay.style.bottom = 'auto';
        });

        document.addEventListener('mouseup', function() {
            if (isDragging) {
                isDragging = false;
                debugOverlay.style.cursor = 'move';
            }
        });

        debugLogContainer = document.getElementById('debug-log-container');
        updateDebugInfo();
        if (debugInterval) clearInterval(debugInterval);
        debugInterval = setInterval(updateDebugInfo, 1000);
    }

    function destroyDebugOverlay() {
        if (debugOverlay) {
            debugOverlay.remove();
            debugOverlay = null;
        }
        if (debugInterval) {
            clearInterval(debugInterval);
            debugInterval = null;
        }
        debugLogContainer = null;
    }

    // ============================================================
    // 14. 更新调试信息
    // ============================================================
    function updateDebugInfo() {
        const video = document.querySelector('video');
        const idEl = document.getElementById('debug-video-id');
        const resolutionEl = document.getElementById('debug-resolution');
        const gearNameEl = document.getElementById('debug-gear-name');
        const domainEl = document.getElementById('debug-domain');
        const bitrateEl = document.getElementById('debug-bitrate');
        const speedEl = document.getElementById('debug-speed');
        const bufferEl = document.getElementById('debug-buffer');
        if (!idEl || !resolutionEl || !gearNameEl || !domainEl || !bitrateEl || !speedEl || !bufferEl) return;

        idEl.textContent = currentPageVideoId || '-';

        let resText = '-';
        if (currentPlayingFormat && currentPlayingFormat.width > 0 && currentPlayingFormat.height > 0) {
            resText = currentPlayingFormat.width + 'x' + currentPlayingFormat.height + '@' + (currentPlayingFormat.fps || '?');
        } else if (video && video.videoWidth > 0 && video.videoHeight > 0) {
            resText = video.videoWidth + 'x' + video.videoHeight + '@?';
        }
        resolutionEl.textContent = resText;

        let gearText = currentPlayingFormat?.gear_name || '-';
        gearNameEl.textContent = gearText;

        let domain = '-';
        if (video && video.src) {
            try { domain = new URL(video.src).hostname || '-'; } catch (e) { domain = '-'; }
        }
        domainEl.textContent = domain;

        let bitrateText = '-';
        if (currentPlayingFormat) {
            if (currentPlayingFormat.bitrate) {
                bitrateText = currentPlayingFormat.bitrate;
                if (currentPlayingFormat.codec && currentPlayingFormat.codec !== '未知') {
                    bitrateText += '[' + currentPlayingFormat.codec + ']';
                }
            }
        } else if (lastFormats && lastFormats.length > 0 && video && video.src) {
            const currentFormat = lastFormats.find(f => f.url === video.src || f.uri && video.src.includes(f.uri));
            if (currentFormat) {
                bitrateText = currentFormat.bitrate || '-';
                if (currentFormat.codec && currentFormat.codec !== '未知') {
                    bitrateText += '[' + currentFormat.codec + ']';
                }
            }
        }
        bitrateEl.textContent = bitrateText;

        // ---------- 加载速度（基于 buffered + 真实码率，无平滑） ----------
        let speedText = '-';
        if (video && video.buffered && video.buffered.length > 0) {
            const now = performance.now();
            const buffered = video.buffered;
            const bufferedEnd = buffered.end(buffered.length - 1);
            const duration = video.duration || 1;

            // ---- 获取码率（kbps） ----
            let bitrateKbps = 0;
            if (currentPlayingFormat && currentPlayingFormat.bitrate) {
                const match = currentPlayingFormat.bitrate.match(/(\d+)/);
                if (match) bitrateKbps = parseInt(match[1], 10);
            }
            // 若未获取到，根据分辨率估算
            if (bitrateKbps === 0) {
                const w = video.videoWidth || 1920;
                const h = video.videoHeight || 1080;
                const pixels = w * h;
                if (pixels >= 3840 * 2160) bitrateKbps = 20000; // 4K
                else if (pixels >= 2560 * 1440) bitrateKbps = 8000;  // 2K
                else if (pixels >= 1920 * 1080) bitrateKbps = 4000;  // 1080p
                else if (pixels >= 1280 * 720) bitrateKbps = 2000;   // 720p
                else bitrateKbps = 1000;
            }

            // 计算总大小 (MB) = 码率(kbps) * 时长(秒) / 8 / 1024
            const totalMB = (bitrateKbps * duration) / 8 / 1024;
            // 已加载部分 (MB)
            const loadedMB = (bufferedEnd / duration) * totalMB;

            // 判断是否预加载完成：缓冲覆盖 ≥ 95% 或剩余 < 2 秒
            const remaining = duration - bufferedEnd;
            if (bufferedEnd >= duration * 0.95 || remaining < 2) {
                if (!speedIsComplete) {
                    speedIsComplete = true;
                    console.log(`[BDP] 预加载已完成 (缓冲至 ${bufferedEnd.toFixed(1)}s)`);
                }
                speedText = '已完成';
            } else {
                speedIsComplete = false;
                // 计算实时速度（无平滑）
                const dt = (now - lastLoadedTime) / 1000;
                let speed = 0;
                if (dt > 0.1 && lastLoadedMB > 0) {
                    const deltaMB = loadedMB - lastLoadedMB;
                    if (deltaMB > 0.001) {
                        speed = (deltaMB * 1024) / dt; // KB/s
                    }
                }
                // 直接赋值，不进行平滑
                currentSpeedKB = speed;

                // 更新上次记录（必须在计算之后）
                lastLoadedMB = loadedMB;
                lastLoadedTime = now;

                if (currentSpeedKB > 0) {
                    speedText = currentSpeedKB >= 1024 ? (currentSpeedKB / 1024).toFixed(2) + ' MB/s' : currentSpeedKB.toFixed(2) + ' KB/s';
                } else {
                    // 如果速度为0，显示 "0 KB/s" 或 "加载中..."
                    if (loadedMB > 0.01) {
                        speedText = '0 KB/s';
                    } else {
                        speedText = '加载中...';
                    }
                }
            }
        } else {
            if (video && video.src) {
                speedText = '加载中...';
            } else {
                speedText = '0 KB/s';
            }
            // 重置状态
            lastLoadedTime = 0;
            lastLoadedMB = 0;
            currentSpeedKB = 0;
            speedIsComplete = false;
        }
        speedEl.textContent = speedText;

        // ---------- 已预加载时长 ----------
        if (bufferEl && video) {
            const buffered = video.buffered;
            if (buffered.length > 0) {
                const end = buffered.end(buffered.length - 1);
                const current = video.currentTime || 0;
                const remaining = Math.max(0, end - current);
                if (remaining > 60) {
                    const mins = Math.floor(remaining / 60);
                    const secs = Math.floor(remaining % 60);
                    bufferEl.textContent = mins + 'm ' + secs + 's';
                } else {
                    bufferEl.textContent = remaining.toFixed(1) + 's';
                }
            } else {
                bufferEl.textContent = '-';
            }
        } else {
            bufferEl.textContent = '-';
        }
    }

    // ============================================================
    // 15. 样式与模糊效果
    // ============================================================
    function toggleBlurEffect(enable) {
        if (!styleEl) return;
        const blurStyle = enable ? 'blur(8px)' : 'none';
        const bgColor = enable ? 'rgba(20,20,20,0.6)' : 'rgba(0,0,0,0.75)';
        styleEl.textContent =
            '.xgplayer-controls [class*="popup"], .xgplayer-controls [class*="dropdown"], .xgplayer-controls [class*="menu"], .xgplayer-controls [class*="list"], [class*="xg-popup"], [class*="xg-dropdown"], [class*="playclarity-setting"] [class*="virtual"] { display: none !important; } .custom-quality-panel { backdrop-filter: ' + blurStyle + ' !important; -webkit-backdrop-filter: ' + blurStyle + ' !important; background: ' + bgColor + ' !important; } .custom-quality-panel .setting-item { background: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border-bottom-color: rgba(255,255,255,0.08) !important; } #debug-overlay { backdrop-filter: ' + blurStyle + ' !important; -webkit-backdrop-filter: ' + blurStyle + ' !important; background: rgba(0,0,0,0.65) !important; } .settings-panel, .dropdown-menu { backdrop-filter: ' + blurStyle + ' !important; -webkit-backdrop-filter: ' + blurStyle + ' !important; background: ' + bgColor + ' !important; }';
        if (debugOverlay) {
            debugOverlay.style.backdropFilter = blurStyle;
            debugOverlay.style.background = enable ? 'rgba(0,0,0,0.65)' : 'rgba(0,0,0,0.75)';
        }
        if (currentPanel) {
            currentPanel.style.backdropFilter = blurStyle;
            currentPanel.style.background = bgColor;
        }
    }

    function addHideNativeStyle() {
        if (styleEl) return;
        styleEl = document.createElement('style');
        styleEl.id = 'quality-enhancer-hide-native';
        document.head.appendChild(styleEl);
        toggleBlurEffect(settings.blurEffect);
    }

    function removeHideNativeStyle() {
        if (styleEl) {
            styleEl.remove();
            styleEl = null;
        }
    }

    // ============================================================
    // 16. 设置面板
    // ============================================================
    function showAboutDialog() {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:999999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);';
        const container = document.createElement('div');
        container.style.cssText = 'background:rgba(30,30,30,0.95);border-radius:16px;padding:24px 28px;max-width:480px;width:90%;max-height:80vh;overflow-y:auto;color:#eee;box-shadow:0 8px 40px rgba(0,0,0,0.8);border:1px solid rgba(255,255,255,0.1);position:relative;';

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = 'position:absolute;top:12px;right:16px;background:transparent;border:none;color:#aaa;font-size:20px;cursor:pointer;transition:color 0.2s;';
        closeBtn.onmouseenter = function() { this.style.color = '#fff'; };
        closeBtn.onmouseleave = function() { this.style.color = '#aaa'; };
        closeBtn.onclick = function() { document.body.removeChild(overlay); };
        container.appendChild(closeBtn);

        // 标题
        const title = document.createElement('h1');
        title.textContent = 'BetterDouyinPlayer';
        title.style.cssText = 'font-size:22px;font-weight:bold;text-align:center;color:#fff;margin:0 0 16px 0;';
        container.appendChild(title);

        // 作者的话
        const storyText = document.createElement('p');
        storyText.style.cssText = 'color:#ccc;font-size:14px;line-height:1.6;margin:0 0 12px 0;';
        storyText.textContent = '用AI写的JavaScript脚本，美化一些选项，并在某些设备上使用更高的画质观看或下载视频';
        container.appendChild(storyText);

        // 版本信息
        const version = document.createElement('p');
        version.textContent = '版本 v1.3.5.18';
        version.style.cssText = 'text-align:center;color:#666;font-size:12px;margin:16px 0 0 0;';
        container.appendChild(version);

        // 脚本地址
        const btnContainer = document.createElement('div');
        btnContainer.style.cssText = 'text-align:center;margin-top:12px;';
        const linkBtn = document.createElement('a');
        linkBtn.href = 'https://github.com/Wednesxuan/wednesxuan.github.io/tree/main/Better/BDP';
        linkBtn.target = '_blank';
        linkBtn.textContent = '存放地';
        linkBtn.style.cssText = `
            display:inline-block;
            padding:8px 30px;
            background:#4caf50;
            color:#fff;
            border-radius:8px;
            text-decoration:none;
            font-size:14px;
            font-weight:500;
            transition:background 0.2s;
            cursor:pointer;
        `;
        linkBtn.onmouseenter = function() { this.style.background = '#388e3c'; };
        linkBtn.onmouseleave = function() { this.style.background = '#4caf50'; };
        btnContainer.appendChild(linkBtn);
        container.appendChild(btnContainer);

        overlay.appendChild(container);
        document.body.appendChild(overlay);

        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) {
                document.body.removeChild(overlay);
            }
        });
    }

    // ---------- 设置面板 ----------
    function enterSettingsMode() {
        if (!currentPanel) return;
        if (isSettingsMode) return;
        isSettingsMode = true;
        const header = currentPanel.querySelector('.panel-header');
        const listContainer = currentPanel.querySelector('.quality-list');
        if (!header || !listContainer) return;
        header._originalTitle = header.querySelector('.panel-title').textContent;
        header.querySelector('.panel-title').textContent = '设置';
        const modeGroup = header.querySelector('.mode-group');
        if (modeGroup) modeGroup.style.display = 'none';
        listContainer.innerHTML = '';
        renderSettingsContent(listContainer);
    }

    function exitSettingsMode() {
        if (!currentPanel) return;
        if (!isSettingsMode) return;
        isSettingsMode = false;
        const header = currentPanel.querySelector('.panel-header');
        const listContainer = currentPanel.querySelector('.quality-list');
        if (!header || !listContainer) return;
        header.querySelector('.panel-title').textContent = header._originalTitle || '选择画质';
        const modeGroup = header.querySelector('.mode-group');
        if (modeGroup) modeGroup.style.display = 'flex';
        applySettingsAndRefresh();
        if (lastFormats) renderQualityList(listContainer, lastFormats);
    }

    function renderSettingsContent(container) {
        container.innerHTML = '';
        container.style.overflowY = 'auto';
        container.style.paddingRight = '4px';

        const items = [
            { label: '编码方式偏好', hint: '优先播放/下载此编码格式，若无则回退。HEVC(H.265) 压缩率更高，AVC(H.264) 兼容性更好。\n如果你使用的是较新的设备建议使用HEVC格式，抖音2K及以上与高帧率视频仅提供HEVC格式', type: 'codec', value: settings.codecPreference },
            { label: '视频画质偏好', hint: '脚本将在页面加载时自动切换到该画质（优先高帧率、高码率）。', type: 'quality', value: settings.qualityPreference },
            { label: '显示更多视频流', hint: '开启后展示分辨率、编码方式一致但码率不同的多个视频流。', type: 'switch', key: 'showMoreStreams', value: settings.showMoreStreams },
            { label: '模糊效果', hint: '启用该设置后，控制面板与通知栏将会有模糊效果，可能影响性能', type: 'switch', key: 'blurEffect', value: settings.blurEffect },
            { label: '调试模式', hint: '启用该设置后，播放器左上角会显示调试信息，以供于专业人员查看，不建议普通用户开启', type: 'switch', key: 'debugMode', value: settings.debugMode },
            { label: '播放独立音频流', hint: '启用该设置后，会使用抖音提供的单独音频流，可间接解决部分视频流音质较低的问题，可能会有播放异常的现象', type: 'switch', key: 'useIndependentAudio', value: settings.useIndependentAudio }
        ];

        items.forEach(function(item) {
            const div = document.createElement('div');
            div.className = 'setting-item';
            div.style.cssText = 'padding:5px 0; border-bottom:1px solid rgba(255,255,255,0.08); display:flex; flex-direction:column; gap:4px;';

            const labelDiv = document.createElement('div');
            labelDiv.style.cssText = 'display:flex; align-items:center; gap:6px;';
            const labelSpan = document.createElement('span');
            labelSpan.textContent = item.label;
            if (item.hint) labelSpan.title = item.hint;
            labelDiv.appendChild(labelSpan);
            if (item.hint) {
                const hintIcon = document.createElement('span');
                hintIcon.textContent = 'ⓘ';
                hintIcon.style.cssText = 'cursor:help; color:#ffaa00; font-weight:bold; font-size:14px; margin-left:4px; text-shadow:0 0 8px rgba(255,170,0,0.3);';
                hintIcon.title = item.hint;
                labelDiv.appendChild(hintIcon);
            }
            div.appendChild(labelDiv);

            if (item.type === 'codec') {
                const btnGroup = document.createElement('div');
                btnGroup.style.cssText = 'display:flex; background:rgba(255,255,255,0.08); border-radius:6px; overflow:hidden;';
                ['HEVC', 'AVC'].forEach(function(codec) {
                    const btn = document.createElement('button');
                    btn.textContent = codec;
                    btn.dataset.value = codec;
                    btn.style.cssText = 'flex:1; padding:4px 8px; border:none; background:' + (item.value === codec ? '#4caf50' : 'transparent') + '; color:#fff; cursor:pointer; font-size:12px; transition:background 0.2s;';
                    btn.addEventListener('click', function() {
                        const val = this.dataset.value;
                        settings.codecPreference = val;
                        saveSettings();
                        btnGroup.querySelectorAll('button').forEach(function(b) {
                            b.style.background = b.dataset.value === val ? '#4caf50' : 'transparent';
                        });
                        addDebugLog('编码偏好改为: ' + val);
                    });
                    btnGroup.appendChild(btn);
                });
                div.appendChild(btnGroup);
            } else if (item.type === 'quality') {
                const dropdown = document.createElement('div');
                dropdown.style.cssText = 'position:relative;';
                const toggle = document.createElement('button');
                toggle.textContent = item.value + ' ▾';
                toggle.style.cssText = 'width:100%; padding:4px 8px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); border-radius:6px; color:#fff; cursor:pointer; text-align:left; display:flex; justify-content:space-between; align-items:center; font-size:12px;';
                const menu = document.createElement('ul');
                menu.style.cssText = 'display:none; position:absolute; top:100%; left:0; width:100%; margin-top:4px; background:rgba(30,30,30,0.95); backdrop-filter:blur(8px); border-radius:6px; padding:4px 0; list-style:none; border:1px solid rgba(255,255,255,0.08); z-index:100001; max-height:150px; overflow-y:auto;';
                ['2160P', '1440P', '1080P', '720P', '576P'].forEach(function(res) {
                    const li = document.createElement('li');
                    li.textContent = res;
                    li.dataset.value = res;
                    li.style.cssText = 'padding:4px 12px; cursor:pointer; ' + (item.value === res ? 'background:rgba(76,175,80,0.2);' : '');
                    li.addEventListener('click', function() {
                        const val = this.dataset.value;
                        settings.qualityPreference = val;
                        saveSettings();
                        toggle.textContent = val + ' ▾';
                        menu.style.display = 'none';
                        menu.querySelectorAll('li').forEach(function(li2) {
                            li2.style.background = li2.dataset.value === val ? 'rgba(76,175,80,0.2)' : '';
                        });
                        addDebugLog('画质偏好改为: ' + val);
                    });
                    menu.appendChild(li);
                });
                toggle.addEventListener('click', function(e) {
                    e.stopPropagation();
                    const isOpen = menu.style.display === 'block';
                    if (isOpen) {
                        menu.style.display = 'none';
                        toggle.textContent = item.value + ' ▾';
                    } else {
                        menu.style.display = 'block';
                        toggle.textContent = item.value + ' ▴';
                    }
                });
                document.addEventListener('click', function closeMenu(e) {
                    if (!dropdown.contains(e.target)) {
                        menu.style.display = 'none';
                        toggle.textContent = item.value + ' ▾';
                    }
                }, { once: false });
                dropdown.appendChild(toggle);
                dropdown.appendChild(menu);
                div.appendChild(dropdown);
            } else if (item.type === 'switch') {
                const btnGroup = document.createElement('div');
                btnGroup.style.cssText = 'display:flex; background:rgba(255,255,255,0.08); border-radius:6px; overflow:hidden; width:fit-content;';
                const options = [{ label: '开', value: true }, { label: '关', value: false }];
                options.forEach(function(opt) {
                    const btn = document.createElement('button');
                    btn.textContent = opt.label;
                    btn.dataset.value = opt.value;
                    btn.style.cssText = 'flex:0; padding:4px 12px; border:none; background:' + (item.value === opt.value ? '#4caf50' : 'transparent') + '; color:#fff; cursor:pointer; font-size:12px; transition:background 0.2s;';
                    btn.addEventListener('click', function() {
                        const val = this.dataset.value === 'true';
                        const key = item.key;
                        settings[key] = val;
                        saveSettings();
                        btnGroup.querySelectorAll('button').forEach(function(b) {
                            b.style.background = (b.dataset.value === String(val)) ? '#4caf50' : 'transparent';
                        });
                        if (key === 'blurEffect') {
                            toggleBlurEffect(settings.blurEffect);
                        } else if (key === 'debugMode') {
                            if (settings.debugMode) { createDebugOverlay();
                                addDebugLog('调试模式已开启'); } else { destroyDebugOverlay(); }
                        } else if (key === 'showMoreStreams') {
                            if (lastFormats && currentPanel) {
                                const id = currentPageVideoId;
                                if (id) {
                                    fetchDetail(id).then(function(detail) {
                                        if (detail && detail.video && detail.video.bit_rate) {
                                            lastFormats = buildQualityList(detail.video.bit_rate);
                                        }
                                    });
                                }
                            }
                        } else if (key === 'useIndependentAudio') {
                            const video = document.querySelector('video');
                            if (video && currentPlayingFormat) {
                                const musicUrl = getMusicUrl();
                                if (musicUrl) {
                                    if (val) playIndependentAudio(musicUrl, video);
                                    else cleanupIndependentAudio(video);
                                }
                            }
                        }
                        addDebugLog(key + ' 改为: ' + val);
                    });
                    btnGroup.appendChild(btn);
                });
                div.appendChild(btnGroup);
            }
            container.appendChild(div);
        });

        // 关于
        const aboutRow = document.createElement('div');
        aboutRow.style.cssText = 'padding:8px 0 4px 0; display:flex; justify-content:center;';
        const aboutBtn = document.createElement('button');
        aboutBtn.textContent = '关于';
        aboutBtn.style.cssText = 'padding:6px 20px; background:rgba(255,255,255,0.08); color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:13px; transition:background 0.2s;';
        aboutBtn.onmouseenter = function() { this.style.background = 'rgba(255,255,255,0.16)'; };
        aboutBtn.onmouseleave = function() { this.style.background = 'rgba(255,255,255,0.08)'; };
        aboutBtn.onclick = showAboutDialog;
        aboutRow.appendChild(aboutBtn);
        container.appendChild(aboutRow);

        const saveHint = document.createElement('div');
        saveHint.textContent = '设置自动保存，修改立即生效';
        saveHint.style.cssText = 'text-align:center; font-size:11px; color:#ddd; font-weight:bold; padding-top:6px;';
        container.appendChild(saveHint);
    }

    function applySettingsAndRefresh() {
        toggleBlurEffect(settings.blurEffect);
        if (settings.debugMode) createDebugOverlay();
        else destroyDebugOverlay();
        if (currentPanel && lastFormats) {
            const id = currentPageVideoId;
            if (id) {
                fetchDetail(id).then(function(detail) {
                    if (detail && detail.video && detail.video.bit_rate) {
                        lastFormats = buildQualityList(detail.video.bit_rate);
                        const listContainer = currentPanel.querySelector('.quality-list');
                        if (listContainer) renderQualityList(listContainer, lastFormats);
                    }
                }).catch(function(e) { console.warn('[BDP] 刷新列表失败:', e); });
            }
        }
    }

    // ============================================================
    // 17. 自动切换
    // ============================================================
    function attemptAutoSwitch(formats) {
        if (!formats && lastFormats) formats = lastFormats;
        if (!formats || formats.length === 0) return;
        if (autoSwitchDone) return;
        if (isSwitching) return;

        const pref = settings.qualityPreference;
        const target = parseInt(pref, 10);
        let candidates = [];
        if (!isNaN(target)) {
            candidates = formats.map(function(f) {
                return { ...f, short: Math.min(f.width, f.height) };
            }).filter(function(f) {
                return Math.abs(f.short - target) < 50;
            }).sort(function(a, b) {
                const fpsA = parseInt(a.fps) || 0;
                const fpsB = parseInt(b.fps) || 0;
                if (fpsA !== fpsB) return fpsB - fpsA;
                const bitA = parseInt(a.bitrate) || 0;
                const bitB = parseInt(b.bitrate) || 0;
                return bitB - bitA;
            });
        }

        if (candidates.length === 0) {
            const sorted = [...formats].map(function(f) {
                return { ...f, short: Math.min(f.width, f.height) };
            }).sort(function(a, b) {
                if (b.short !== a.short) return b.short - a.short;
                const fpsA = parseInt(a.fps) || 0;
                const fpsB = parseInt(b.fps) || 0;
                if (fpsA !== fpsB) return fpsB - fpsA;
                const bitA = parseInt(a.bitrate) || 0;
                const bitB = parseInt(b.bitrate) || 0;
                return bitB - bitA;
            });
            if (sorted.length > 0) {
                candidates = [sorted[0]];
                console.log('[BDP] 无匹配偏好，退级到最高画质:', sorted[0].short + 'P');
                addDebugLog('[BDP] 无匹配偏好，退级到最高画质: ' + sorted[0].short + 'P');
            }
        }

        if (candidates.length === 0) {
            if (!autoSwitchNotified) {
                autoSwitchNotified = true;
                showNotification('未找到任何画质，保持当前', 'error', getPlayerContainer(), true);
            }
            addDebugLog('无可用画质');
            return;
        }

        const selected = candidates[0];
        console.log('[BDP] 自动切换到偏好画质: ' + pref + ' (短边' + selected.short + ', ' + selected.fps + 'fps)');
        addDebugLog('[BDP] 自动切换到偏好画质: ' + pref + ' (短边' + selected.short + ', ' + selected.fps + 'fps)');

        const musicUrl = getMusicUrl();
        switchQuality(selected, musicUrl).then(function(result) {
            autoSwitchDone = true;
            clearButtonTextPersistence();
            setupButtonTextPersistence(result.shortLabel);
            let msg = '已自动切换至 ' + result.fullLabel;
            if (result.isHighFps && result.fps) msg += ' (' + result.fps + '帧)';
            showNotification(msg, 'success', getPlayerContainer(), true);
            console.log('[BDP] ' + msg);
            addDebugLog('[BDP] ' + msg);
            updateActiveHighlight();
        }).catch(function(err) {
            console.warn('[BDP] 自动切换失败:', err);
            addDebugLog('[BDP] 自动切换失败: ' + err);
            setTimeout(function() {
                if (!autoSwitchDone && !isSwitching) {
                    switchQuality(selected, musicUrl).then(function(result) {
                        autoSwitchDone = true;
                        clearButtonTextPersistence();
                        setupButtonTextPersistence(result.shortLabel);
                        let msg = '已自动切换至 ' + result.fullLabel;
                        if (result.isHighFps && result.fps) msg += ' (' + result.fps + '帧)';
                        showNotification(msg, 'success', getPlayerContainer(), true);
                        console.log('[BDP] ' + msg);
                        addDebugLog('[BDP] ' + msg);
                        updateActiveHighlight();
                    }).catch(function(e) { console.warn('[BDP] 重试切换失败:', e); });
                }
            }, 2000);
        });
    }

    function updateActiveHighlight() {
        if (!currentPanel) return;
        const listContainer = currentPanel.querySelector('.quality-list');
        if (!listContainer) return;
        const items = listContainer.children;
        if (!items.length) return;
        const video = document.querySelector('video');
        const currentSrc = video ? video.src : '';
        for (let item of items) {
            if (item.dataset && item.dataset.uri) {
                const isActive = currentSrc && (item.dataset.url === currentSrc ||
                    (item.dataset.uri && currentSrc.includes(item.dataset.uri)) ||
                    (item.dataset.url && currentSrc.includes(item.dataset.url)));
                if (isActive) {
                    item.style.background = 'rgba(0, 255, 150, 0.3)';
                    item.style.borderLeft = '3px solid #00ff88';
                    item.style.fontWeight = 'bold';
                    const label = item.querySelector('div:first-child');
                    if (label) label.style.color = '#00ff88';
                } else {
                    item.style.background = '';
                    item.style.borderLeft = '';
                    item.style.fontWeight = '';
                    const label = item.querySelector('div:first-child');
                    if (label) label.style.color = '';
                }
            }
        }
    }

    // ============================================================
    // 18. 画质面板渲染
    // ============================================================
    function renderQualityList(containerEl, data) {
        containerEl.innerHTML = '';

        const video = document.querySelector('video');
        const currentSrc = video ? video.src : '';
        const musicUrl = getMusicUrl();

        data.forEach(function(f) {
            const item = document.createElement('div');
            const isActive = currentSrc && (f.url === currentSrc || (f.uri && currentSrc.includes(f.uri)) || (f.url && currentSrc.includes(f.url)));
            item.dataset.url = f.url || '';
            item.dataset.uri = f.uri || '';
            item.style.cssText = 'padding:5px 6px;margin:3px 0;border-radius:4px;cursor:pointer;' + (isActive ? 'background:rgba(0, 255, 150, 0.3);border-left:3px solid #00ff88;font-weight:bold;color:#00ff88;' : '');
            item.onmouseenter = function() { if (!isActive) item.style.background = 'rgba(255,255,255,0.12)'; };
            item.onmouseleave = function() { if (!isActive) item.style.background = ''; };
            const fullLabel = getFullLabel(f.width, f.height, f.fps);
            let detail = f.width + 'x' + f.height + ' | ' + f.fps + 'fps | ' + f.bitrate;
            if (settings.showMoreStreams && f.codec && f.codec !== '未知') detail += ' | ' + f.codec;
            if (currentMode === 'download' && f.sizeDisplay) detail += ' | ' + f.sizeDisplay;
            item.innerHTML = '<div style="font-weight:bold;">' + fullLabel + '</div><div style="font-size:11px;color:#aaa;">' + detail + '</div>';
            item.onclick = function() {
                if (currentMode === 'watch') {
                    showNotification('切换中...', 'loading', getPlayerContainer(), false).then(function() {
                        const audio = musicUrl;
                        switchQuality(f, audio).then(function(result) {
                            clearButtonTextPersistence();
                            setupButtonTextPersistence(result.shortLabel);
                            let msg = '你已成功切换至 ' + result.fullLabel;
                            if (result.isHighFps && result.fps) msg += ' (' + result.fps + '帧)';
                            showNotification(msg, 'success', getPlayerContainer(), true);
                            clearNotification(5000);
                            updateActiveHighlight();
                            if (globalClosePanel) globalClosePanel();
                        }).catch(function(e) {
                            showNotification('切换失败: ' + e, 'error', getPlayerContainer(), true);
                            if (globalClosePanel) globalClosePanel();
                        });
                    });
                } else {
                    // 下载模式：仅下载视频，文件名 = 标题[ID].mp4
                    const id = currentPageVideoId;
                    if (id) {
                        fetchDetail(id).then(function(detail) {
                            if (detail) {
                                const videoUrl = f.url || (f.uri ? 'https://www.douyin.com/aweme/v1/play/?video_id=' + f.uri : '');
                                if (videoUrl) {
                                    let title = detail.desc || '抖音视频';
                                    title = sanitizeFileName(title);
                                    const filename = title + '[' + detail.aweme_id + '].mp4';
                                    downloadWithProgress(videoUrl, filename).then(function() {
                                        showNotification('视频下载完成', 'success', getPlayerContainer(), true);
                                    }).catch(function(err) {
                                        showNotification('下载失败: ' + err.message, 'error', getPlayerContainer(), true);
                                    });
                                } else {
                                    showNotification('无法获取视频链接', 'error', getPlayerContainer(), true);
                                }
                            }
                        }).catch(function() { showNotification('获取详情失败', 'error', getPlayerContainer(), true); });
                    } else {
                        showNotification('无视频ID，无法下载', 'error', getPlayerContainer(), false);
                    }
                }
            };
            containerEl.appendChild(item);
        });

        if (!autoSwitchDone && data.length > 0 && !isSwitching) {
            attemptAutoSwitch(data);
        }
    }

    // ============================================================
    // 19. 画质面板显示
    // ============================================================
    function showCustomPanel(btn, formats) {
        const old = document.querySelector('.custom-quality-panel');
        if (old) old.remove();

        const container = getPlayerContainer() || document.body;
        if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

        const panel = document.createElement('div');
        panel.className = 'custom-quality-panel';
        const blurStyle = settings.blurEffect ? 'blur(8px)' : 'none';
        const bgColor = settings.blurEffect ? 'rgba(20,20,20,0.6)' : 'rgba(0,0,0,0.75)';

        const btnRect = btn.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const bottom = containerRect.bottom - btnRect.top + 10;
        const right = containerRect.right - btnRect.right;

        panel.style.cssText = 'position:absolute; bottom:' + bottom + 'px; right:' + right + 'px; z-index:99999; background:' + bgColor + '; backdrop-filter:' + blurStyle + '; border-radius:12px; padding:10px 14px; min-width:240px; max-width:320px; max-height:60vh; overflow-y:auto; color:#fff; font-size:13px; box-shadow:0 4px 20px rgba(0,0,0,0.6); border:1px solid rgba(255,255,255,0.1);';

        const header = document.createElement('div');
        header.className = 'panel-header';
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.1);padding-bottom:6px;';
        const title = document.createElement('span');
        title.className = 'panel-title';
        title.textContent = '选择画质';
        title.style.fontWeight = 'bold';
        title.style.fontSize = '14px';
        header.appendChild(title);

        const rightGroup = document.createElement('div');
        rightGroup.className = 'panel-right-group';
        rightGroup.style.display = 'flex';
        rightGroup.style.alignItems = 'center';
        rightGroup.style.gap = '6px';

        const modeGroup = document.createElement('div');
        modeGroup.className = 'mode-group';
        modeGroup.style.cssText = 'display:flex;background:rgba(255,255,255,0.1);border-radius:4px;overflow:hidden;align-items:center;cursor:pointer;user-select:none;';
        const watchBtn = document.createElement('span');
        watchBtn.textContent = '观看';
        watchBtn.style.cssText = 'padding:2px 10px;font-size:12px;transition:background 0.2s;flex:1;text-align:center;';
        const downloadBtn = document.createElement('span');
        downloadBtn.textContent = '下载';
        downloadBtn.style.cssText = 'padding:2px 10px;font-size:12px;transition:background 0.2s;flex:1;text-align:center;';

        function updateModeButtons() {
            if (currentMode === 'watch') {
                watchBtn.style.background = '#4caf50';
                downloadBtn.style.background = 'transparent';
            } else {
                watchBtn.style.background = 'transparent';
                downloadBtn.style.background = '#4caf50';
            }
            if (!isSettingsMode) {
                const listContainer = panel.querySelector('.quality-list');
                if (listContainer && formats) {
                    listContainer.innerHTML = '';
                    renderQualityList(listContainer, formats);
                }
            }
        }
        updateModeButtons();

        watchBtn.onclick = function(e) { e.stopPropagation();
            currentMode = 'watch';
            updateModeButtons(); };
        downloadBtn.onclick = function(e) { e.stopPropagation();
            currentMode = 'download';
            updateModeButtons(); };
        modeGroup.appendChild(watchBtn);
        modeGroup.appendChild(downloadBtn);
        rightGroup.appendChild(modeGroup);

        const settingsBtn = document.createElement('span');
        settingsBtn.textContent = '⚙️';
        settingsBtn.style.cssText = 'cursor:pointer;font-size:16px;opacity:0.6;transition:opacity 0.2s;padding:0 4px;';
        settingsBtn.title = '设置';
        settingsBtn.onmouseenter = function() { settingsBtn.style.opacity = '1'; };
        settingsBtn.onmouseleave = function() { settingsBtn.style.opacity = '0.6'; };
        settingsBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            if (isSettingsMode) exitSettingsMode();
            else enterSettingsMode();
        });
        rightGroup.appendChild(settingsBtn);

        const closeBtn = document.createElement('span');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = 'cursor:pointer;font-size:14px;color:#aaa;';
        closeBtn.onclick = function() {
            if (isSettingsMode) exitSettingsMode();
            else closePanel();
        };
        rightGroup.appendChild(closeBtn);

        header.appendChild(rightGroup);
        panel.appendChild(header);

        const listContainer = document.createElement('div');
        listContainer.className = 'quality-list';
        listContainer.style.cssText = 'flex:1;overflow-y:auto;padding-right:4px;';
        panel.appendChild(listContainer);
        renderQualityList(listContainer, formats);

        container.appendChild(panel);

        function closePanel() {
            if (panel.parentNode) panel.parentNode.removeChild(panel);
            document.removeEventListener('click', outsideClick);
            if (qualityButton) qualityButton.style.pointerEvents = '';
            removeHideNativeStyle();
            currentPanel = null;
            isSettingsMode = false;
            globalClosePanel = null;
        }
        globalClosePanel = closePanel;

        const outsideClick = function(e) {
            if (!panel.contains(e.target) && e.target !== btn && e.target !== settingsBtn) {
                if (isSettingsMode) exitSettingsMode();
                else closePanel();
            }
        };
        setTimeout(function() { document.addEventListener('click', outsideClick); }, 100);

        addHideNativeStyle();
        currentPanel = panel;
        applySettingsAndRefresh();
        addDebugLog('画质面板已打开，共 ' + formats.length + ' 个选项');
    }

    // ============================================================
    // 20. 透明度同步与全局点击代理
    // ============================================================
    function setupOpacitySync() {
        const controls = document.querySelector('.xgplayer-controls');
        if (controls && qualityButton) {
            const sync = function() {
                qualityButton.style.opacity = getComputedStyle(controls).opacity;
            };
            new MutationObserver(sync).observe(controls, { attributes: true, attributeFilter: ['style', 'class'] });
            sync();
        } else {
            setTimeout(setupOpacitySync, 500);
        }
    }

    function setupGlobalHandler() {
        document.addEventListener('click', function(e) {
            const btn = e.target.closest('xg-icon.xgplayer-playclarity-setting');
            if (!btn) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            qualityButton = btn;
            btn.style.pointerEvents = 'none';

            const id = currentPageVideoId;
            if (!id) {
                showNotification('未找到视频ID', 'error', getPlayerContainer(), false);
                btn.style.pointerEvents = '';
                return;
            }
            const container = getPlayerContainer() || document.body;
            showNotification('获取画质列表...', 'loading', container, false);
            fetchDetail(id).then(function(detail) {
                if (!detail || !detail.video || !detail.video.bit_rate) {
                    showNotification('无画质信息', 'error', container, true);
                    btn.style.pointerEvents = '';
                    removeHideNativeStyle();
                    return;
                }
                lastFormats = buildQualityList(detail.video.bit_rate);
                showCustomPanel(btn, lastFormats);
                if (ni) {
                    ni.style.width = '0';
                    setTimeout(function() { if (ni) ni.style.display = 'none'; }, 350);
                }
                setupOpacitySync();
            }).catch(function(err) {
                showNotification('错误: ' + err.message, 'error', container, true);
                btn.style.pointerEvents = '';
                removeHideNativeStyle();
            });
        }, true);
    }

    // ============================================================
    // 21. 初始化
    // ============================================================
    function init() {
        setupXHRInterceptor();
        setupGlobalHandler();
        applySettingsAndRefresh();
        if (settings.debugMode) setTimeout(createDebugOverlay, 2000);
        console.log('[BDP] v1.3.5.18 初始化完成');
        localStorage.removeItem('douyin_video_cache');
        addDebugLog('脚本初始化完成');
        document.addEventListener('fullscreenchange', handleFullscreenChange);

        setTimeout(function() {
            const id = currentPageVideoId;
            if (id) {
                fetchDetail(id).then(function(detail) {
                    if (detail && detail.video && detail.video.bit_rate) {
                        if (!lastFormats) lastFormats = buildQualityList(detail.video.bit_rate);
                        if (!autoSwitchDone && lastFormats && lastFormats.length > 0) {
                            attemptAutoSwitch(lastFormats);
                        }
                    }
                }).catch(function(e) { addDebugLog('后备自动获取失败: ' + e); });
            }
        }, 500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
