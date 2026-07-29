// ==UserScript==
// @name         BetterBilibiliPlayer
// @namespace    https://www.bilibili.com/
// @version      1.0.5.12-dev
// @description  对B站播放页的一些界面的美化
// @author       none
// @match        *://*.bilibili.com/video/*
// @match        *://bilibili.com/video/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @connect      api.bilibili.com
// @connect      *.hdslb.com
// @connect      *.bilivideo.com
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    if (!location.pathname.startsWith('/video/')) return;

    function log(m, t) {
        const c = { info: '#00aece', success: '#52c41a', warn: '#faad14', error: '#f5222d', start: '#8b5cf6', done: '#06b6d4' };
        const bc = c[t] || c.info;
        const badge = t === 'start' ? '启动' : t === 'done' ? '完成' : t === 'success' ? '成功' : t === 'warn' ? '⚠️' : t === 'error' ? '❌' : '信息';
        console.log(`%c[BetterBilibiliPlayer]%c ${badge} %c${m}`, `color:#fff;background:${bc};padding:2px 6px;border-radius:3px 0 0 3px;font-weight:bold;`, `color:#fff;background:${bc};padding:2px 4px;border-radius:0 3px 3px 0;font-weight:bold;opacity:.8;`, `color:currentColor;font-weight:500;`);
    }

    // ========== 设置管理 ==========
    const SETTINGS_KEY = 'bbvs_settings';
    const DEFAULT_SETTINGS = {
        blurEffect: true,
        debugMode: false,
        qualityPreference: '1080P 高清',
        audioPreference: '杜比全景声',
        edgeGlow: false,
        glowWidth: 10,
        ambientEnabled: true,
        ambientQuality: '中',
        blackBarFill: true,
    };
    let settings = loadSettings();

    function loadSettings() {
        let s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (raw) {
                const p = JSON.parse(raw);
                Object.keys(s).forEach(k => { if (p[k] !== undefined) s[k] = p[k]; });
                log('本地配置已加载', 'success');
            }
        } catch (e) {}
        if (s.edgeGlow === undefined) s.edgeGlow = false;
        if (s.glowWidth === undefined) s.glowWidth = 10;
        if (s.ambientEnabled === undefined) s.ambientEnabled = true;
        if (s.ambientQuality === undefined) s.ambientQuality = '中';
        if (s.blackBarFill === undefined) s.blackBarFill = true;
        return s;
    }
    function saveSettings() {
        const toSave = { ...settings };
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(toSave)); } catch (e) {}
    }

    // ========== 全局变量 ==========
    let currentMode = 'watch';
    let currentPanel = null;
    let qualityButton = null;
    let currentQuality = null;
    let debugOverlay = null;
    let debugInterval = null;
    let isSettingsMode = false;
    let globalClosePanel = null;
    let downloadStep = 1;
    let selectedVideoQn = null;
    let selectedAudioId = null;
    let selectedDownloadCodec = null;
    let lastLoadedTime = 0;
    let lastLoadedMB = 0;
    let currentSpeedKB = 0;
    let debugLogs = [];
    let debugLogContainer = null;
    let autoSwitchDone = false;
    let currentPageBvid = getBvid();
    let qualityRetryTimer = null;
    let initInProgress = false;
    let domReady = false;

    let nw, ni, nc, ncb, nti;
    let blackBarRunning = false;
    let blackBarLayer = null;
    let blackBarCanvas = null;
    let blackBarCtx = null;
    let blackBarRAFId = null;

    // ---------- 边缘发光 ----------
    let glowCurrentColor = { r: 30, g: 30, b: 30 };
    let glowTargetColor = { r: 30, g: 30, b: 30 };
    let glowProgress = 1;
    let glowStartColor = { r: 30, g: 30, b: 30 };
    let glowStartTime = 0;
    const GLOW_LERP_DURATION = 2000;
    let glowAnimationId = null;

    // ---------- video.src 检测 ----------
    let lastVideoSrc = '';

    // playurl 缓存
    let playurlCache = new Map();

    // ========== 辅助函数 ==========
    function addDebugLog(msg, force) {
        if (!force && !settings.debugMode) return;
        const ts = new Date().toLocaleTimeString();
        const entry = '[' + ts + '] ' + msg;
        debugLogs.push(entry);
        if (debugLogs.length > 200) debugLogs.shift();
        if (debugLogContainer) {
            debugLogContainer.textContent = debugLogs.join('\n');
            debugLogContainer.scrollTop = debugLogContainer.scrollHeight;
        }
    }

    function getPlayerContainer() {
        return document.querySelector('.bpx-player-video-wrap') ||
               document.querySelector('.bpx-player-primary-area') ||
               document.body;
    }

    function getPlayInfo() {
        const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        if (w.__playinfo__) {
            if (w.__playinfo__.data) {
                return w.__playinfo__.data;
            } else {
                return w.__playinfo__;
            }
        }
        return null;
    }

    function getVideoData() {
        const currentBvid = getBvid();
        if (playurlCache.has(currentBvid)) {
            const cached = playurlCache.get(currentBvid);
            if (cached && cached.dash && Array.isArray(cached.dash.video) && cached.dash.video.length > 0) {
                return cached;
            } else {
                playurlCache.delete(currentBvid);
                log('缓存数据无效（无视频流），已移除', 'warn');
            }
        }
        const info = getPlayInfo();
        if (info && info.dash && Array.isArray(info.dash.video) && info.dash.video.length > 0) {
            return info;
        }
        return null;
    }

    function getPlayer() {
        const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        return w.player || null;
    }

    function getCurrentQualityFromPlayer() {
        const player = getPlayer();
        if (!player) return null;
        if (typeof player.getQuality === 'function') {
            try {
                const q = player.getQuality();
                if (q && q.nowQ !== undefined && !isNaN(q.nowQ)) return q.nowQ;
            } catch (_) {}
        }
        const video = document.querySelector('video');
        if (video && video.src) {
            const match = video.src.match(/[?&]qn=(\d+)/);
            if (match) return parseInt(match[1]);
        }
        return null;
    }

    function getCid() {
        const video = document.querySelector('video');
        if (video && video.src) {
            const match = video.src.match(/[?&]cid=(\d+)/);
            if (match) return parseInt(match[1]);
        }
        const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        if (w.__playinfo__) {
            if (w.__playinfo__.cid) return w.__playinfo__.cid;
            if (w.__playinfo__.data && w.__playinfo__.data.cid) return w.__playinfo__.data.cid;
        }
        if (w.__INITIAL_STATE__?.videoData?.cid) {
            return w.__INITIAL_STATE__.videoData.cid;
        }
        const videoData = getVideoData();
        if (videoData && videoData.cid) {
            return videoData.cid;
        }
        const cidAttr = document.querySelector('[data-cid]');
        if (cidAttr) {
            const cidVal = cidAttr.getAttribute('data-cid');
            if (cidVal && !isNaN(cidVal)) return parseInt(cidVal);
        }
        const player = getPlayer();
        if (player && typeof player.getCid === 'function') {
            try { return player.getCid(); } catch (_) {}
        }
        return null;
    }

    function getQualityDescription(qn) {
        const info = getVideoData();
        if (!info) return '未知';
        if (info.support_formats) {
            const fmt = info.support_formats.find(f => f.quality === qn);
            if (fmt && fmt.new_description) {
                if (qn === 116) return '1080P 高帧率';
                return fmt.new_description;
            }
        }
        const idx = info.accept_quality ? info.accept_quality.indexOf(qn) : -1;
        if (idx !== -1 && info.accept_description[idx]) {
            let desc = info.accept_description[idx];
            if (desc === '高清 1080P+') desc = '1080P 高码率';
            else if (desc === '高清 1080P60') desc = '1080P 高帧率';
            else if (desc === '高清 1080P') desc = '1080P 高清';
            else if (desc === '高清 720P') desc = '720P 准高清';
            else if (desc === '清晰 480P') desc = '480P 标清';
            else if (desc === '流畅 360P') desc = '360P 流畅';
            return desc;
        }
        return '未知';
    }

    function getActualCodecFromPlayer() {
        const video = document.querySelector('video');
        let codecStr = null;
        if (video && video.src) {
            const match = video.src.match(/[?&]codec=([^&]+)/);
            if (match) {
                codecStr = match[1];
            }
        }
        if (!codecStr) {
            const player = getPlayer();
            if (player) {
                if (typeof player.getQuality === 'function') {
                    try {
                        const q = player.getQuality();
                        if (q && q.nowCodec) {
                            codecStr = String(q.nowCodec);
                        }
                    } catch (_) {}
                }
                if (!codecStr && typeof player.getPreferCodec === 'function') {
                    try {
                        const val = player.getPreferCodec();
                        if (val === 1) return 'HEVC';
                        if (val === 2) return 'AVC';
                        if (val === 3) return 'AV1';
                    } catch (_) {}
                }
                if (!codecStr && player._preferCodec !== undefined) {
                    const val = player._preferCodec;
                    if (val === 1) return 'HEVC';
                    if (val === 2) return 'AVC';
                    if (val === 3) return 'AV1';
                }
            }
        }
        if (codecStr) {
            return getCodecName(codecStr);
        }
        return null;
    }

    function buildQualityListFromPlayurl(data) {
        if (!data || !data.dash || !data.dash.video) return [];
        const videoList = data.dash.video;
        const duration = data.dash.duration || 0;

        const qnToDesc = {};
        if (data.support_formats) {
            data.support_formats.forEach(f => {
                if (f.quality && f.new_description) {
                    let desc = f.new_description;
                    if (f.quality === 116) desc = '1080P 高帧率';
                    qnToDesc[f.quality] = desc;
                }
            });
        }
        if (Object.keys(qnToDesc).length === 0 && data.accept_quality && data.accept_description) {
            for (let i = 0; i < data.accept_quality.length; i++) {
                let desc = data.accept_description[i];
                if (desc === '高清 1080P+') desc = '1080P 高码率';
                else if (desc === '高清 1080P60') desc = '1080P 高帧率';
                else if (desc === '高清 1080P') desc = '1080P 高清';
                else if (desc === '高清 720P') desc = '720P 准高清';
                else if (desc === '清晰 480P') desc = '480P 标清';
                else if (desc === '流畅 360P') desc = '360P 流畅';
                qnToDesc[data.accept_quality[i]] = desc;
            }
        }

        const result = [];
        const processedQn = new Set();
        videoList.forEach(item => {
            const qn = item.id;
            if (processedQn.has(qn)) return;
            processedQn.add(qn);

            const bandwidth = parseInt(item.bandwidth) || 0;
            const codecs = item.codecs || '';
            const width = parseInt(item.width) || 0;
            const height = parseInt(item.height) || 0;
            let frameRate = item.frame_rate || item.frameRate || 0;
            if (typeof frameRate === 'string') {
                frameRate = parseFloat(frameRate);
                if (isNaN(frameRate)) frameRate = 0;
            } else if (typeof frameRate !== 'number') {
                frameRate = 0;
            }
            const size = parseInt(item.size) || 0;

            let sizeDisplay = '';
            if (size > 0) {
                const mb = size / (1024 * 1024);
                sizeDisplay = mb >= 1 ? mb.toFixed(2) + 'MB' : (size / 1024).toFixed(2) + 'KB';
            } else if (bandwidth > 0 && duration > 0) {
                const estimatedBytes = duration * bandwidth / 8;
                if (estimatedBytes > 0) {
                    const mb = estimatedBytes / (1024 * 1024);
                    sizeDisplay = mb >= 1 ? '~' + mb.toFixed(1) + 'MB' : '~' + (estimatedBytes / 1024).toFixed(1) + 'KB';
                }
            }
            if (!sizeDisplay) sizeDisplay = '--';

            let desc = qnToDesc[qn] || '未知';
            if (desc === '未知' && width > 0 && height > 0) {
                const s = Math.min(width, height);
                desc = s + 'P';
            }

            let fpsDisplay = '?';
            let isHighFps = false;
            if (frameRate > 0) {
                if (Number.isInteger(frameRate)) {
                    fpsDisplay = frameRate + '帧';
                } else {
                    fpsDisplay = frameRate.toFixed(1) + '帧';
                }
                if (frameRate >= 31) isHighFps = true;
            }
            const bitrate = bandwidth ? Math.round(bandwidth / 1000) + 'kbps' : '?kbps';
            const resolution = width + 'x' + height;
            result.push({
                id: qn,
                description: desc,
                resolution: resolution,
                fpsDisplay: fpsDisplay,
                bitrate: bitrate,
                isHighFps: isHighFps,
                codec: getCodecName(codecs),
                bandwidth: bandwidth,
                data_size: size,
                sizeDisplay: sizeDisplay,
                url: item.baseUrl || '',
                _item: item,
            });
        });
        result.sort((a, b) => b.id - a.id);
        return result;
    }

    function getCodecName(codecsStr) {
        if (!codecsStr) return '未知';
        const c = codecsStr.toLowerCase();
        if (c.includes('av01')) return 'AV1';
        if (c.includes('h265') || c.includes('hevc') || c.includes('hvc1') || c.includes('hev1')) {
            if (c.includes('dolby') || c.includes('dvhe')) return 'HEVC (杜比视界)';
            return 'HEVC';
        }
        if (c.includes('avc') || c.includes('h264')) return 'AVC';
        if (c.includes('flac')) return 'FLAC';
        if (c.includes('ec-3')) return '杜比全景声';
        if (c.includes('mp4a')) return 'AAC';
        return codecsStr.slice(0, 10);
    }

    function getAvailableCodecs() {
        const info = getVideoData();
        if (!info?.dash?.video) return [];
        const codecSet = new Set();
        info.dash.video.forEach(v => {
            if (v.codecs) {
                const c = v.codecs.toLowerCase();
                if (c.includes('av01')) codecSet.add('AV1');
                else if (c.includes('h265') || c.includes('hevc') || c.includes('hvc1') || c.includes('hev1')) codecSet.add('HEVC');
                else if (c.includes('avc') || c.includes('h264')) codecSet.add('AVC');
            }
        });
        const order = ['AV1', 'HEVC', 'AVC'];
        return order.filter(c => codecSet.has(c));
    }

    function getVideoUrl(qn, codec) {
        const info = getVideoData();
        if (!info?.dash?.video) return null;
        let matched = null;
        if (codec) {
            const codecMap = {
                'AV1': 'av01',
                'HEVC': ['h265', 'hevc', 'hvc1', 'hev1'],
                'AVC': ['avc', 'h264']
            };
            const targets = Array.isArray(codecMap[codec]) ? codecMap[codec] : [codecMap[codec]];
            for (let item of info.dash.video) {
                if (item.id === qn && item.codecs) {
                    const c = item.codecs.toLowerCase();
                    for (let t of targets) {
                        if (c.includes(t)) {
                            matched = item;
                            break;
                        }
                    }
                    if (matched) break;
                }
            }
        }
        if (!matched) matched = info.dash.video.find(v => v.id === qn);
        return matched?.baseUrl || null;
    }

    function getAudioUrl(audioId) {
        const info = getVideoData();
        if (!info?.dash) return null;
        let audio = info.dash.audio?.find(a => a.id === audioId);
        if (audio) return audio.baseUrl;
        if (info.dash.flac) {
            if (info.dash.flac.audio && typeof info.dash.flac.audio === 'object') {
                if (Array.isArray(info.dash.flac.audio)) {
                    audio = info.dash.flac.audio.find(a => a.id === audioId);
                } else if (info.dash.flac.audio.id === audioId) {
                    audio = info.dash.flac.audio;
                }
                if (audio) return audio.baseUrl;
            } else if (info.dash.flac.id === audioId) {
                return info.dash.flac.baseUrl;
            }
        }
        if (info.dash.dolby && info.dash.dolby.audio) {
            if (Array.isArray(info.dash.dolby.audio)) {
                audio = info.dash.dolby.audio.find(a => a.id === audioId);
            } else if (info.dash.dolby.audio.id === audioId) {
                audio = info.dash.dolby.audio;
            }
            if (audio) return audio.baseUrl;
        }
        return null;
    }

    function getAudioList() {
        const info = getVideoData();
        if (!info?.dash) return [];

        let allAudio = [];

        if (Array.isArray(info.dash.audio)) {
            allAudio = allAudio.concat(info.dash.audio);
        }

        if (info.dash.flac) {
            if (info.dash.flac.audio && typeof info.dash.flac.audio === 'object') {
                if (Array.isArray(info.dash.flac.audio)) {
                    allAudio = allAudio.concat(info.dash.flac.audio);
                } else if (info.dash.flac.audio.id) {
                    allAudio.push(info.dash.flac.audio);
                }
            } else if (info.dash.flac.id) {
                allAudio.push(info.dash.flac);
            }
        }

        if (info.dash.dolby && info.dash.dolby.audio) {
            if (Array.isArray(info.dash.dolby.audio)) {
                allAudio = allAudio.concat(info.dash.dolby.audio);
            } else if (info.dash.dolby.audio.id) {
                allAudio.push(info.dash.dolby.audio);
            }
        }

        const seen = new Set();
        allAudio = allAudio.filter(item => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
        });

        const video = document.querySelector('video');
        let duration = info.duration || 0;
        if (duration === 0 && video) {
            duration = video.duration || 0;
        }

        const idToName = {
            30250: '杜比全景声',
            30251: 'Hi-Res无损',
            30280: '192K',
            30232: '132K',
            30216: '64K'
        };

        return allAudio.map(a => {
            let sizeDisplay = '';
            const bandwidth = a.bandwidth || 0;
            if (bandwidth > 0 && duration > 0) {
                const estimatedBytes = duration * bandwidth / 8;
                if (estimatedBytes > 0) {
                    const mb = estimatedBytes / (1024 * 1024);
                    sizeDisplay = mb >= 1 ? '~' + mb.toFixed(1) + 'MB' : '~' + (estimatedBytes / 1024).toFixed(1) + 'KB';
                }
            }
            const codec = getCodecName(a.codecs);
            let desc = idToName[a.id] || a.id.toString();
            if (codec === 'FLAC' && !idToName[a.id]) {
                desc = 'Hi-Res无损';
            }
            return {
                id: a.id,
                description: desc,
                bandwidth: bandwidth,
                bitrateText: bandwidth ? Math.round(bandwidth / 1000) + 'kbps' : '',
                codec: codec,
                sizeDisplay: sizeDisplay || '--'
            };
        }).sort((a, b) => {
            const order = [30250, 30251, 30280, 30232, 30216];
            const idxA = order.indexOf(a.id);
            const idxB = order.indexOf(b.id);
            return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
        });
    }

    function getBvid() {
        const match = location.pathname.match(/\/video\/([a-zA-Z0-9]+)/);
        return match ? match[1] : '?';
    }

    function waitFor(condition, timeout = 15000, interval = 300) {
        return new Promise(resolve => {
            const start = Date.now();
            const check = () => {
                if (condition()) {
                    resolve(true);
                } else if (Date.now() - start > timeout) {
                    resolve(false);
                } else {
                    setTimeout(check, interval);
                }
            };
            check();
        });
    }

    function getAvailableQualityLabels() {
        const info = getVideoData();
        if (!info) return ['1080P 高清', '自动'];

        let labels = [];
        if (info.support_formats && Array.isArray(info.support_formats)) {
            const sorted = info.support_formats.slice().sort((a, b) => b.quality - a.quality);
            const seen = new Set();
            sorted.forEach(f => {
                let desc = f.new_description || f.display_desc || '';
                if (!desc) return;
                if (f.quality === 116) desc = '1080P 高帧率';
                if (!f.new_description) {
                    if (desc === '高清 1080P+') desc = '1080P 高码率';
                    else if (desc === '高清 1080P60') desc = '1080P 高帧率';
                    else if (desc === '高清 1080P') desc = '1080P 高清';
                    else if (desc === '高清 720P') desc = '720P 准高清';
                    else if (desc === '清晰 480P') desc = '480P 标清';
                    else if (desc === '流畅 360P') desc = '360P 流畅';
                }
                if (!seen.has(desc)) {
                    seen.add(desc);
                    labels.push(desc);
                }
            });
        }

        if (labels.length === 0 && info.accept_quality && info.accept_description) {
            for (let i = 0; i < info.accept_quality.length; i++) {
                let desc = info.accept_description[i];
                if (desc === '高清 1080P+') desc = '1080P 高码率';
                else if (desc === '高清 1080P60') desc = '1080P 高帧率';
                else if (desc === '高清 1080P') desc = '1080P 高清';
                else if (desc === '高清 720P') desc = '720P 准高清';
                else if (desc === '清晰 480P') desc = '480P 标清';
                else if (desc === '流畅 360P') desc = '360P 流畅';
                if (!labels.includes(desc)) labels.push(desc);
            }
        }

        if (labels.length === 0) labels = ['1080P 高清', '自动'];
        if (!labels.includes('自动')) labels.push('自动');
        return labels;
    }

    function getFilteredQualityList(codec) {
        const data = getVideoData();
        if (!data || !data.dash || !data.dash.video || data.dash.video.length === 0) return [];

        let videoList = data.dash.video;

        if (codec) {
            videoList = videoList.filter(item => {
                const codecName = getCodecName(item.codecs);
                return codecName === codec;
            });
            if (videoList.length === 0) return [];
        }

        const filteredData = {
            ...data,
            dash: {
                ...data.dash,
                video: videoList
            }
        };

        return buildQualityListFromPlayurl(filteredData);
    }

    function applyQualityPreference() {
        if (autoSwitchDone) return;
        const player = getPlayer();
        if (!player) {
            setTimeout(() => applyQualityPreference(), 1000);
            return;
        }
        const info = getVideoData();
        if (!info) return;
        const pref = settings.qualityPreference;
        if (pref === '自动' || !pref) {
            autoSwitchDone = true;
            return;
        }
        const currentCodec = getActualCodecFromPlayer();
        const qualityList = getFilteredQualityList(currentCodec);
        let targetQn = null;

        function isMatch(desc, pref) {
            if (desc === pref) return true;
            const highGroup = ['1080P 高码率', '1080P 高帧率', '1080P高码率/高帧率'];
            if (highGroup.includes(pref) && highGroup.includes(desc)) {
                return true;
            }
            if (desc && pref && desc.includes(pref)) return true;
            return false;
        }

        for (let item of qualityList) {
            const desc = item.description;
            if (isMatch(desc, pref)) {
                targetQn = item.id;
                break;
            }
        }

        if (!targetQn) {
            log('偏好画质 "' + pref + '" 不在当前编码(' + (currentCodec || '未知') + ')的可用列表中，不执行自动切换', 'warn');
            autoSwitchDone = true;
            return;
        }
        const currentQn = getCurrentQualityFromPlayer() || currentQuality;
        if (currentQn === targetQn) {
            autoSwitchDone = true;
            return;
        }
        addDebugLog('自动切换至偏好画质: ' + pref, true);
        switchQuality(targetQn).then(() => {
            autoSwitchDone = true;
            addDebugLog('自动切换完成: ' + pref, true);
            if (qualityRetryTimer) { clearTimeout(qualityRetryTimer); qualityRetryTimer = null; }
        }).catch(err => {
            addDebugLog('自动切换失败: ' + err, true);
            if (!autoSwitchDone) {
                if (qualityRetryTimer) clearTimeout(qualityRetryTimer);
                qualityRetryTimer = setTimeout(() => {
                    addDebugLog('重试自动切换: ' + pref, true);
                    applyQualityPreference();
                }, 3000);
            }
        });
    }

    function switchQuality(qn) {
        return new Promise((resolve, reject) => {
            const player = getPlayer();
            if (!player) { reject('播放器对象不存在'); return; }
            const desc = getQualityDescription(qn);
            let success = false;
            showNotification('正在切换至 ' + desc, 'loading');
            if (typeof player.requestQuality === 'function') {
                player.requestQuality(qn, null);
                success = true;
            } else if (typeof player.setQuality === 'function') {
                player.setQuality(qn);
                success = true;
            } else {
                const menuItem = document.querySelector(`.bpx-player-ctrl-quality-menu li[data-value="${qn}"]`);
                if (menuItem) { menuItem.click(); success = true; }
            }
            if (!success) {
                showNotification('切换失败，请重试', 'error');
                reject('切换调用失败');
                return;
            }
            const startTime = Date.now();
            const checkInterval = setInterval(() => {
                const nowQ = getCurrentQualityFromPlayer();
                if (nowQ === qn) {
                    clearInterval(checkInterval);
                    currentQuality = qn;
                    if (settings.debugMode && debugOverlay) updateDebugInfo();
                    if (currentPanel && currentMode === 'watch') {
                        renderListForStep(currentPanel._listContainer, 1, currentPanel);
                    }
                    showNotification('已切换至 ' + desc, 'success');
                    addDebugLog('切换画质至: ' + desc + ' (qn=' + qn + ')');
                    resolve();
                    return;
                }
                if (Date.now() - startTime > 20000) {
                    clearInterval(checkInterval);
                    showNotification('切换超时，请重试', 'error');
                    reject('超时');
                }
            }, 200);
        });
    }

    // ========== 通知系统 ==========
    function initNotification(container) {
        if (!container) container = getPlayerContainer() || document.body;
        if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
        if (nw) return nw;
        nw = document.createElement('div');
        nw.style.cssText = 'position:absolute;bottom:55px;left:20px;z-index:99999;display:flex;align-items:center;pointer-events:auto;';
        container.appendChild(nw);
        ni = document.createElement('div');
        ni.style.cssText = 'width:0;overflow:hidden;background:rgba(0,0,0,0.5);backdrop-filter:blur(6px);border-radius:8px;border:1px solid rgba(255,255,255,0.08);box-shadow:0 2px 10px rgba(0,0,0,0.3);box-sizing:border-box;display:flex;align-items:stretch;transition:width 0.4s cubic-bezier(0.25,0.1,0.25,1);will-change:transform,width;transform:translateZ(0);';
        nw.appendChild(ni);
        ncb = document.createElement('span');
        ncb.style.cssText = 'display:none;width:4px;flex-shrink:0;border-radius:8px 0 0 8px;';
        ni.appendChild(ncb);
        nc = document.createElement('div');
        nc.style.cssText = 'padding:12px 18px;white-space:nowrap;color:#fff;font-size:16px;font-family:sans-serif;';
        ni.appendChild(nc);
        nw.addEventListener('mouseenter', function() {
            ni.style.opacity = '0.6';
            ni.style.backdropFilter = 'none';
        });
        nw.addEventListener('mouseleave', function() {
            ni.style.opacity = '1';
            ni.style.backdropFilter = 'blur(6px)';
        });
        return nw;
    }

    function showNotification(text, type, container, isReplacement) {
        return new Promise(function(resolve) {
            const c = container || getPlayerContainer() || document.body;
            initNotification(c);
            if (nti) { clearTimeout(nti); nti = null; }
            ni.style.display = 'flex';
            let cw = parseFloat(ni.style.width) || 0;
            let sd = 0.35, ed = 0.4;
            if (isReplacement) { sd = 0.2; ed = 0.25; }
            const colors = { success: '#4caf50', error: '#f44336', loading: '#ff9800' };
            const bg = colors[type] || 'transparent';
            const setContent = function() {
                nc.textContent = text;
                ncb.style.backgroundColor = bg;
                ncb.style.display = 'block';
                requestAnimationFrame(function() {
                    ni.style.transition = 'width ' + ed + 's cubic-bezier(0.25,0.1,0.25,1)';
                    const tw = nc.scrollWidth + 4 + 36;
                    ni.style.width = tw + 'px';
                    resolve();
                    clearNotification(5000);
                });
            };
            if (cw > 0) {
                ncb.style.display = 'none';
                ni.style.transition = 'width ' + sd + 's cubic-bezier(0.42,0,0.58,1)';
                ni.style.width = '0';
                setTimeout(function() { setContent(); }, sd * 1000 + 50);
            } else {
                setContent();
            }
        });
    }

    function clearNotification(delay) {
        if (nti) { clearTimeout(nti); nti = null; }
        nti = setTimeout(function() {
            if (ni && parseFloat(ni.style.width) > 0) {
                ncb.style.display = 'none';
                ni.style.transition = 'width 0.35s cubic-bezier(0.42,0,0.58,1)';
                ni.style.width = '0';
                setTimeout(function() { ni.style.display = 'none'; }, 350);
            }
            nti = null;
        }, delay || 5000);
    }

    // ========== 下载功能（带进度条 + 流式回退动画） ==========
    function downloadFile(url, filename, type) {
        return new Promise((resolve, reject) => {
            let safeFilename = filename;
            if (type === 'mp4') {
                if (!safeFilename.endsWith('.mp4')) safeFilename += '.mp4';
            } else {
                if (!safeFilename.endsWith('.m4s')) safeFilename += '.m4s';
            }

            const typeName = type === 'video' ? '视频' : type === 'audio' ? '音频' : type === 'mp4' ? 'MP4' : '文件';
            log('开始下载: ' + safeFilename, 'info');
            const container = getPlayerContainer();
            if (!container) return reject('未找到播放器容器');
            if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

            const progressWrapper = document.createElement('div');
            progressWrapper.style.cssText = 'position:absolute; top:10px; left:10px; z-index:99999; display:flex; align-items:center; opacity:0; transform:translateX(-20px); transition: opacity 0.3s, transform 0.3s;';
            container.appendChild(progressWrapper);
            const progressContainer = document.createElement('div');
            progressContainer.style.cssText = 'width:0; overflow:hidden; background:rgba(0,0,0,0.5); backdrop-filter:blur(6px); border-radius:8px; border:1px solid rgba(255,255,255,0.08); box-shadow:0 2px 10px rgba(0,0,0,0.3); box-sizing:border-box; transition:width 0.4s cubic-bezier(0.25,0.1,0.25,1);';
            progressWrapper.appendChild(progressContainer);
            const inner = document.createElement('div');
            inner.style.cssText = 'padding:12px 18px; white-space:nowrap; color:#fff; font-size:16px; font-family:sans-serif;';
            progressContainer.appendChild(inner);
            const barOuter = document.createElement('div');
            barOuter.style.cssText = 'width:270px; height:4px; background:rgba(255,255,255,0.2); border-radius:2px; overflow:hidden;';
            const barInner = document.createElement('div');
            barInner.style.cssText = 'width:0%; height:100%; background:#00A1D6; border-radius:2px; transition:width 0.15s ease-out;';
            barOuter.appendChild(barInner);
            let textEl = document.createElement('div');
            textEl.style.cssText = 'margin-bottom:4px;';
            inner.appendChild(textEl);
            inner.appendChild(barOuter);
            let currentPercent = 0;
            let rafId = null;
            function updateProgress(percent, text) {
                currentPercent = Math.min(100, Math.max(0, percent));
                textEl.textContent = text;
                if (rafId) cancelAnimationFrame(rafId);
                rafId = requestAnimationFrame(function() {
                    barInner.style.width = currentPercent + '%';
                    rafId = null;
                });
            }
            requestAnimationFrame(() => {
                progressWrapper.style.opacity = '1';
                progressWrapper.style.transform = 'translateX(0)';
                progressContainer.style.width = '300px';
                updateProgress(0, '下载' + typeName + '中 0%');
            });

            let fallbackUsed = false;
            let progressReceived = false;
            let gmRequestCompleted = false;

            const fallbackTimer = setTimeout(() => {
                if (!progressReceived && !gmRequestCompleted && !fallbackUsed) {
                    log('未检测到进度，回退到 GM_download 直接下载', 'warn');
                    fallbackUsed = true;
                    textEl.textContent = '准备下载...';
                    barInner.style.width = '100%';
                    barInner.style.background = 'transparent';
                    barInner.style.overflow = 'hidden';
                    barInner.style.position = 'relative';
                    const oldStyle = document.getElementById('bbvs-progress-style');
                    if (oldStyle) oldStyle.remove();
                    const style = document.createElement('style');
                    style.id = 'bbvs-progress-style';
                    style.textContent = `
                        @keyframes bbvs-progress-strip {
                            0% { left: -30%; opacity: 1; }
                            50% { opacity: 1; }
                            100% { left: 110%; opacity: 0; }
                        }
                    `;
                    document.head.appendChild(style);
                    const createStrip = (delay) => {
                        const strip = document.createElement('div');
                        strip.style.cssText = `
                            position: absolute;
                            height: 100%;
                            width: 30%;
                            background: #00A1D6;
                            border-radius: 4px;
                            top: 0;
                            left: -30%;
                            animation: bbvs-progress-strip ${2.5 + Math.random() * 1.5}s ease-in-out infinite;
                            animation-delay: ${delay}s;
                        `;
                        return strip;
                    };
                    barInner.innerHTML = '';
                    const count = 2 + Math.floor(Math.random() * 2);
                    for (let i = 0; i < count; i++) {
                        const delay = i * (0.8 + Math.random() * 0.6);
                        const strip = createStrip(delay);
                        barInner.appendChild(strip);
                    }
                    barOuter.style.overflow = 'hidden';

                    GM_download({
                        url: url,
                        name: safeFilename,
                        onload: function() {
                            log('回退下载完成: ' + safeFilename, 'success');
                            showNotification(typeName + '下载完成', 'success');
                            progressContainer.style.transition = 'width 0.3s';
                            progressContainer.style.width = '0';
                            setTimeout(() => {
                                progressWrapper.style.opacity = '0';
                                progressWrapper.style.transform = 'translateX(-20px)';
                                setTimeout(() => {
                                    if (progressWrapper.parentNode) progressWrapper.parentNode.removeChild(progressWrapper);
                                }, 300);
                            }, 350);
                            resolve();
                        },
                        onerror: function(e) {
                            log('回退下载失败: ' + (e?.message || '未知错误'), 'error');
                            showNotification('下载失败: ' + (e?.message || '未知错误'), 'error');
                            reject(e);
                        }
                    });
                }
            }, 2000);

            if (typeof GM_xmlhttpRequest !== 'undefined') {
                log('使用 GM_xmlhttpRequest 获取数据...', 'info');
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    responseType: 'blob',
                    withCredentials: true,
                    headers: {
                        'Referer': location.origin + '/',
                        'Origin': location.origin,
                        'User-Agent': navigator.userAgent
                    },
                    onload: function(resp) {
                        gmRequestCompleted = true;
                        clearTimeout(fallbackTimer);
                        if (fallbackUsed) return;
                        if (resp.status >= 200 && resp.status < 300) {
                            const blob = resp.response;
                            const blobUrl = URL.createObjectURL(blob);
                            updateProgress(100, '下载完成，准备保存...');
                            log('数据获取成功，使用 GM_download 下载...', 'info');
                            GM_download({
                                url: blobUrl,
                                name: safeFilename,
                                onload: function() {
                                    URL.revokeObjectURL(blobUrl);
                                    log('下载完成: ' + safeFilename, 'success');
                                    showNotification(typeName + '下载完成', 'success');
                                    progressContainer.style.transition = 'width 0.3s';
                                    progressContainer.style.width = '0';
                                    setTimeout(() => {
                                        progressWrapper.style.opacity = '0';
                                        progressWrapper.style.transform = 'translateX(-20px)';
                                        setTimeout(() => {
                                            if (progressWrapper.parentNode) progressWrapper.parentNode.removeChild(progressWrapper);
                                        }, 300);
                                    }, 350);
                                    resolve();
                                },
                                onerror: function(err) {
                                    URL.revokeObjectURL(blobUrl);
                                    log('GM_download 失败，尝试 a.click 回退', 'warn');
                                    const a = document.createElement('a');
                                    a.href = blobUrl;
                                    a.download = safeFilename;
                                    a.style.display = 'none';
                                    document.body.appendChild(a);
                                    a.click();
                                    setTimeout(() => {
                                        document.body.removeChild(a);
                                        URL.revokeObjectURL(blobUrl);
                                        progressContainer.style.transition = 'width 0.3s';
                                        progressContainer.style.width = '0';
                                        setTimeout(() => {
                                            progressWrapper.style.opacity = '0';
                                            progressWrapper.style.transform = 'translateX(-20px)';
                                            setTimeout(() => {
                                                if (progressWrapper.parentNode) progressWrapper.parentNode.removeChild(progressWrapper);
                                            }, 300);
                                        }, 350);
                                        resolve();
                                    }, 2000);
                                }
                            });
                        } else {
                            reject(new Error('HTTP ' + resp.status));
                        }
                    },
                    onprogress: function(progress) {
                        progressReceived = true;
                        clearTimeout(fallbackTimer);
                        if (fallbackUsed) return;
                        if (progress.total > 0) {
                            const pct = Math.round((progress.loaded / progress.total) * 100);
                            updateProgress(pct, '下载' + typeName + '中 ' + pct + '%');
                        } else {
                            if (progress.loaded > 0) {
                                const loadedMB = (progress.loaded / (1024 * 1024)).toFixed(1);
                                updateProgress(0, '下载' + typeName + '中 ' + loadedMB + 'MB');
                            } else {
                                updateProgress(0, '下载' + typeName + '中 ...');
                            }
                        }
                    },
                    onerror: function(err) {
                        gmRequestCompleted = true;
                        clearTimeout(fallbackTimer);
                        if (fallbackUsed) return;
                        log('GM_xmlhttpRequest 失败，回退到 GM_download 直接下载', 'warn');
                        GM_download({
                            url: url,
                            name: safeFilename,
                            onload: function() {
                                log('回退下载成功: ' + safeFilename, 'success');
                                showNotification(typeName + '下载完成', 'success');
                                progressContainer.style.transition = 'width 0.3s';
                                progressContainer.style.width = '0';
                                setTimeout(() => {
                                    progressWrapper.style.opacity = '0';
                                    progressWrapper.style.transform = 'translateX(-20px)';
                                    setTimeout(() => {
                                        if (progressWrapper.parentNode) progressWrapper.parentNode.removeChild(progressWrapper);
                                    }, 300);
                                }, 350);
                                resolve();
                            },
                            onerror: function(e) { reject(e); }
                        });
                    }
                });
            } else {
                GM_download({
                    url: url,
                    name: safeFilename,
                    onload: resolve,
                    onerror: reject
                });
            }
        });
    }

    function downloadVideoInfoJson(bvid) {
        return new Promise((resolve, reject) => {
            const url = 'https://api.bilibili.com/x/web-interface/view?bvid=' + bvid;
            log('开始获取视频信息 JSON: ' + url, 'info');
            const container = getPlayerContainer();
            if (!container) return reject('未找到播放器容器');
            if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
            const progressWrapper = document.createElement('div');
            progressWrapper.style.cssText = 'position:absolute; top:10px; left:10px; z-index:99999; display:flex; align-items:center; opacity:0; transform:translateX(-20px); transition: opacity 0.3s, transform 0.3s;';
            container.appendChild(progressWrapper);
            const progressContainer = document.createElement('div');
            progressContainer.style.cssText = 'width:0; overflow:hidden; background:rgba(0,0,0,0.5); backdrop-filter:blur(6px); border-radius:8px; border:1px solid rgba(255,255,255,0.08); box-shadow:0 2px 10px rgba(0,0,0,0.3); box-sizing:border-box; transition:width 0.4s cubic-bezier(0.25,0.1,0.25,1);';
            progressWrapper.appendChild(progressContainer);
            const inner = document.createElement('div');
            inner.style.cssText = 'padding:12px 18px; white-space:nowrap; color:#fff; font-size:16px; font-family:sans-serif;';
            progressContainer.appendChild(inner);
            const barOuter = document.createElement('div');
            barOuter.style.cssText = 'width:270px; height:4px; background:rgba(255,255,255,0.2); border-radius:2px; overflow:hidden;';
            const barInner = document.createElement('div');
            barInner.style.cssText = 'width:0%; height:100%; background:#00A1D6; border-radius:2px; transition:width 0.15s ease-out;';
            barOuter.appendChild(barInner);
            let textEl = document.createElement('div');
            textEl.style.cssText = 'margin-bottom:4px;';
            inner.appendChild(textEl);
            inner.appendChild(barOuter);
            let currentPercent = 0;
            let rafId = null;
            function updateProgress(percent, text) {
                currentPercent = Math.min(100, Math.max(0, percent));
                textEl.textContent = text;
                if (rafId) cancelAnimationFrame(rafId);
                rafId = requestAnimationFrame(function() {
                    barInner.style.width = currentPercent + '%';
                    rafId = null;
                });
            }
            requestAnimationFrame(() => {
                progressWrapper.style.opacity = '1';
                progressWrapper.style.transform = 'translateX(0)';
                progressContainer.style.width = '300px';
                updateProgress(0, '获取视频信息中 0%');
            });
            if (typeof GM_xmlhttpRequest !== 'undefined') {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    withCredentials: true,
                    headers: {
                        'Referer': location.origin + '/',
                        'Origin': location.origin,
                        'User-Agent': navigator.userAgent
                    },
                    onload: function(resp) {
                        if (resp.status >= 200 && resp.status < 300) {
                            try {
                                const data = JSON.parse(resp.responseText);
                                if (data.code !== 0) throw new Error('API返回错误: ' + (data.message || '未知错误'));
                                const jsonStr = JSON.stringify(data, null, 2);
                                const blob = new Blob([jsonStr], { type: 'application/json' });
                                const blobUrl = URL.createObjectURL(blob);
                                const filename = bvid + '.json';
                                updateProgress(100, 'JSON 获取完成，准备保存...');
                                log('JSON 数据获取成功，使用 GM_download 下载...', 'info');
                                GM_download({
                                    url: blobUrl,
                                    name: filename,
                                    onload: function() {
                                        URL.revokeObjectURL(blobUrl);
                                        log('JSON 下载完成: ' + filename, 'success');
                                        showNotification('视频信息 JSON 下载完成', 'success');
                                        progressContainer.style.transition = 'width 0.3s';
                                        progressContainer.style.width = '0';
                                        setTimeout(() => {
                                            progressWrapper.style.opacity = '0';
                                            progressWrapper.style.transform = 'translateX(-20px)';
                                            setTimeout(() => {
                                                if (progressWrapper.parentNode) progressWrapper.parentNode.removeChild(progressWrapper);
                                            }, 300);
                                        }, 350);
                                        resolve();
                                    },
                                    onerror: function(err) {
                                        URL.revokeObjectURL(blobUrl);
                                        log('GM_download 失败，尝试 a.click 回退', 'warn');
                                        const a = document.createElement('a');
                                        a.href = blobUrl;
                                        a.download = filename;
                                        a.style.display = 'none';
                                        document.body.appendChild(a);
                                        a.click();
                                        setTimeout(() => {
                                            document.body.removeChild(a);
                                            URL.revokeObjectURL(blobUrl);
                                            progressContainer.style.transition = 'width 0.3s';
                                            progressContainer.style.width = '0';
                                            setTimeout(() => {
                                                progressWrapper.style.opacity = '0';
                                                progressWrapper.style.transform = 'translateX(-20px)';
                                                setTimeout(() => {
                                                    if (progressWrapper.parentNode) progressWrapper.parentNode.removeChild(progressWrapper);
                                                }, 300);
                                            }, 350);
                                            resolve();
                                        }, 2000);
                                    }
                                });
                            } catch (e) { reject(e); }
                        } else {
                            reject(new Error('HTTP ' + resp.status));
                        }
                    },
                    onerror: function(err) {
                        log('GM_xmlhttpRequest 失败: ' + (err?.message || '未知错误'), 'error');
                        reject(err);
                    },
                    ontimeout: function() { reject(new Error('请求超时')); },
                    timeout: 10000
                });
            } else {
                GM_download({
                    url: url,
                    name: bvid + '.json',
                    onload: resolve,
                    onerror: reject
                });
            }
        });
    }

    async function downloadVideoAndAudio() {
        if (!selectedVideoQn || !selectedAudioId) {
            showNotification('请先选择视频和音频', 'error');
            return;
        }
        if (!selectedDownloadCodec) {
            showNotification('请先选择编码', 'error');
            return;
        }
        const videoUrl = getVideoUrl(selectedVideoQn, selectedDownloadCodec);
        const audioUrl = getAudioUrl(selectedAudioId);
        if (!videoUrl || !audioUrl) {
            showNotification('无法获取链接', 'error');
            return;
        }
        const bvid = getBvid();
        const videoFilename = bvid + '.m4s';
        const audioFilename = bvid + '_audio.m4s';
        showNotification('开始下载视频和音频...', 'loading');
        try {
            await downloadFile(videoUrl, videoFilename, 'video');
            await downloadFile(audioUrl, audioFilename, 'audio');
            await downloadVideoInfoJson(bvid);
            showNotification('全部下载完成（视频、音频、JSON）', 'success');
            if (globalClosePanel) globalClosePanel();
        } catch (err) {
            showNotification('下载失败: ' + err.message, 'error');
        }
    }

    async function getBestMp4Url(bvid, cid) {
        const combos = [
            { qn: 112, platform: 'html5' },
            { qn: 80, platform: 'html5' },
            { qn: 80, platform: 'html5', mid: 0 },
            { qn: 64, platform: 'html5' },
            { qn: 64, platform: 'pc' },
        ];
        const fnval = 1;
        const fnver = 0;

        const requests = combos.map(async (combo) => {
            const url = new URL('https://api.bilibili.com/x/player/wbi/playurl');
            url.searchParams.set('bvid', bvid);
            url.searchParams.set('cid', cid);
            url.searchParams.set('qn', combo.qn);
            url.searchParams.set('fnval', fnval);
            url.searchParams.set('fnver', fnver);
            if (combo.platform) url.searchParams.set('platform', combo.platform);
            if (combo.mid !== undefined) url.searchParams.set('mid', combo.mid);
            try {
                const res = await fetch(url, {
                    credentials: 'include',
                    headers: { 'Referer': location.origin }
                });
                if (!res.ok) return null;
                const data = await res.json();
                if (data.code !== 0 || !data.data.durl || !data.data.durl.length) return null;
                const first = data.data.durl[0];
                return {
                    url: first.url,
                    quality: data.data.quality,
                    size: first.size || 0,
                    length: first.length || 0,
                    format: data.data.format || 'mp4'
                };
            } catch {
                return null;
            }
        });

        const results = await Promise.all(requests);
        const valid = results.filter(r => r !== null);
        if (valid.length === 0) return null;
        valid.sort((a, b) => b.quality - a.quality);
        return valid[0];
    }

    async function downloadMp4() {
        const bvid = getBvid();

        let cid = getCid();
        if (!cid) {
            log('首次获取 cid 失败，等待 0.5 秒后重试...', 'warn');
            await new Promise(r => setTimeout(r, 500));
            cid = getCid();
        }
        if (!cid) {
            log('第二次获取 cid 失败，等待 1 秒后重试...', 'warn');
            await new Promise(r => setTimeout(r, 1000));
            cid = getCid();
        }
        if (!cid) {
            log('第三次获取 cid 失败，等待 2 秒后重试...', 'warn');
            await new Promise(r => setTimeout(r, 2000));
            cid = getCid();
        }
        if (!cid) {
            showNotification('无法获取视频 cid，请刷新页面后重试', 'error');
            log('获取 cid 失败，所有来源均未找到', 'error');
            return;
        }
        log('获取到 cid: ' + cid, 'info');
        showNotification('正在获取 MP4 直链...', 'loading');
        try {
            const best = await getBestMp4Url(bvid, cid);
            if (!best) {
                showNotification('该视频不提供 MP4 格式', 'error');
                return;
            }
            const qualityNames = { 80: '1080P', 64: '720P', 32: '480P', 16: '360P', 112: '1080P+', 116: '1080P60', 120: '4K' };
            const qualityLabel = qualityNames[best.quality] || `${best.quality}P`;
            const sizeMB = (best.size / 1024 / 1024).toFixed(2);
            log(`获取到 ${qualityLabel} MP4, 大小 ${sizeMB}MB`, 'info');

            let title = '';
            try {
                const initState = window.__INITIAL_STATE__;
                if (initState?.videoData?.title) {
                    title = initState.videoData.title;
                } else {
                    const titleEl = document.querySelector('.video-title');
                    if (titleEl) title = titleEl.textContent.trim();
                }
            } catch (e) {}
            if (!title) title = 'bilibili_video';
            const safeTitle = title.replace(/[\\/:*?"<>|]/g, '');
            const filename = `${safeTitle} [${bvid}].mp4`;

            showNotification(`正在下载 ${qualityLabel} MP4...`, 'loading');
            await downloadFile(best.url, filename, 'mp4');
            if (globalClosePanel) globalClosePanel();
        } catch (err) {
            showNotification('下载失败: ' + err.message, 'error');
            log('MP4 下载错误: ' + err.message, 'error');
        }
    }

    // ========== 调试面板 ==========
    function createDebugOverlay() {
        if (debugOverlay) return;
        const container = getPlayerContainer();
        if (!container) return;
        if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
        debugOverlay = document.createElement('div');
        debugOverlay.id = 'bbvs-debug-overlay';
        const blurStyle = settings.blurEffect ? 'blur(8px)' : 'none';
        debugOverlay.style.cssText = `position:absolute; top:50px; left:10px; z-index:999999; background:rgba(0,0,0,0.65); backdrop-filter:${blurStyle}; border-radius:10px; padding:14px; min-width:320px; max-width:420px; color:#00A1D6; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size:12px; line-height:1.6; border:1px solid rgba(255,255,255,0.1); box-shadow:0 4px 20px rgba(0,0,0,0.8); max-height:80vh; overflow-y:auto; pointer-events:auto; cursor:move;`;
        debugOverlay.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <span style="font-weight:bold; font-size:14px; color:#fff;">调试信息</span>
                <button id="bbvs-debug-close" style="background:transparent; border:none; color:#ff6b6b; font-size:18px; cursor:pointer; padding:0 4px;">✕</button>
            </div>
            <div id="bbvs-debug-content">
                <div><span style="color:#888;">视频ID:</span> <span id="bbvs-debug-bvid" style="color:#00A1D6;">-</span></div>
                <div><span style="color:#888;">当前画质:</span> <span id="bbvs-debug-quality" style="color:#00A1D6;">-</span></div>
                <div><span style="color:#888;">分辨率:</span> <span id="bbvs-debug-resolution" style="color:#00A1D6;">-</span></div>
                <div><span style="color:#888;">帧率:</span> <span id="bbvs-debug-fps" style="color:#00A1D6;">-</span></div>
                <div><span style="color:#888;">视频码率:</span> <span id="bbvs-debug-video-bitrate" style="color:#00A1D6;">-</span></div>
                <div><span style="color:#888;">音频码率:</span> <span id="bbvs-debug-audio-bitrate" style="color:#00A1D6;">-</span></div>
                <div><span style="color:#888;">加载速度:</span> <span id="bbvs-debug-speed" style="color:#00A1D6;">-</span></div>
                <div><span style="color:#888;">已预加载时长:</span> <span id="bbvs-debug-buffer" style="color:#00A1D6;">-</span></div>
                <div style="margin-top:8px; border-top:1px solid #333; padding-top:6px;">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="color:#888;">日志</span>
                        <button id="bbvs-debug-copy-log" style="background:rgba(255,255,255,0.1); border:none; color:#00A1D6; border-radius:4px; padding:2px 10px; font-size:11px; cursor:pointer;">复制日志</button>
                    </div>
                    <pre id="bbvs-debug-log-container" style="max-height:150px; overflow-y:auto; background:rgba(0,0,0,0.3); border-radius:4px; padding:6px 8px; margin-top:4px; font-size:11px; color:#aaa; user-select:text; cursor:text; white-space:pre-wrap; word-break:break-all; font-family:inherit; margin:4px 0 0 0;">等待日志...</pre>
                </div>
            </div>
        `;
        container.appendChild(debugOverlay);
        document.getElementById('bbvs-debug-close').addEventListener('click', () => {
            settings.debugMode = false;
            saveSettings();
            destroyDebugOverlay();
        });
        document.getElementById('bbvs-debug-copy-log').addEventListener('click', function() {
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
        debugOverlay.addEventListener('mousedown', (e) => {
            if (e.target.closest('button')) return;
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
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const containerRect = container.getBoundingClientRect();
            let newLeft = origLeft + (e.clientX - startX);
            let newTop = origTop + (e.clientY - startY);
            newLeft = Math.max(0, Math.min(newLeft, containerRect.width - debugOverlay.offsetWidth));
            newTop = Math.max(0, Math.min(newTop, containerRect.height - debugOverlay.offsetHeight));
            debugOverlay.style.left = newLeft + 'px';
            debugOverlay.style.top = newTop + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (isDragging) { isDragging = false; debugOverlay.style.cursor = 'move'; }
        });
        debugLogContainer = document.getElementById('bbvs-debug-log-container');
        if (debugLogContainer && debugLogs.length > 0) {
            debugLogContainer.textContent = debugLogs.join('\n');
            debugLogContainer.scrollTop = debugLogContainer.scrollHeight;
        }
        updateDebugInfo();
        if (debugInterval) clearInterval(debugInterval);
        debugInterval = setInterval(updateDebugInfo, 1000);
        addDebugLog('调试面板已开启');
    }

    function destroyDebugOverlay() {
        if (debugOverlay) { debugOverlay.remove(); debugOverlay = null; }
        if (debugInterval) { clearInterval(debugInterval); debugInterval = null; }
        debugLogContainer = null;
    }

    // ---------- 从 performance 获取当前音频 ID ----------
    function getCurrentAudioIdFromPerformance() {
        const entries = performance.getEntriesByType('resource');
        let audioId = null;
        let latestTime = 0;
        // 获取所有可用音频 ID 白名单
        const data = getVideoData();
        if (!data?.dash) return null;
        const audioIds = new Set();
        const collect = (list) => {
            if (Array.isArray(list)) list.forEach(a => audioIds.add(a.id));
            else if (list && list.id) audioIds.add(list.id);
        };
        collect(data.dash.audio);
        if (data.dash.flac) {
            if (data.dash.flac.audio) collect(data.dash.flac.audio);
            else if (data.dash.flac.id) audioIds.add(data.dash.flac.id);
        }
        if (data.dash.dolby && data.dash.dolby.audio) collect(data.dash.dolby.audio);
        if (audioIds.size === 0) return null;

        for (let entry of entries) {
            const url = entry.name;
            // 匹配 .m4s 且不含 video 关键字（避免视频分片干扰）
            if (url.includes('.m4s') && !url.includes('video')) {
                const match = url.match(/-(\d+)\.m4s/);
                if (match) {
                    const id = parseInt(match[1]);
                    if (audioIds.has(id) && entry.startTime > latestTime) {
                        latestTime = entry.startTime;
                        audioId = id;
                    }
                }
            }
        }
        return audioId;
    }

    // ---------- 基于画质映射默认音频 ID（无后缀） ----------
    function getDefaultAudioIdByQuality(qn) {
        // 360p/480p → 30216, 720p → 30232, 1080p+ → 30280
        if (qn <= 32) return 30216;   // 16,32
        if (qn === 64) return 30232;  // 720p
        if (qn >= 80) return 30280;   // 1080p及以上
        return null;
    }

    // ---------- 更新调试信息 ----------
    function updateDebugInfo() {
        const player = getPlayer();
        if (!player) return;
        const info = getVideoData();
        const video = document.querySelector('video');
        const bvid = getBvid();
        let qn = null;
        let desc = '未知';
        if (typeof player.getQuality === 'function') {
            try {
                const q = player.getQuality();
                if (q && q.nowQ !== undefined && !isNaN(q.nowQ)) {
                    qn = q.nowQ;
                    if (info) desc = getQualityDescription(qn);
                }
            } catch (_) {}
        }
        if (qn === null || qn === undefined) {
            if (video && video.src) {
                const match = video.src.match(/[?&]qn=(\d+)/);
                if (match) qn = parseInt(match[1]);
            }
        }
        if (qn === null || qn === undefined) {
            qn = currentQuality;
            if (qn !== null && info) {
                desc = getQualityDescription(qn);
            }
        }
        if (qn === null || qn === undefined) return;
        let codec = '未知';
        if (typeof player.getPreferCodec === 'function') {
            try {
                const val = player.getPreferCodec();
                if (val === 1) codec = 'HEVC';
                else if (val === 2) codec = 'AVC';
                else if (val === 3) codec = 'AV1';
                else codec = '未知(' + val + ')';
            } catch (_) {}
        }
        let actualVideo = null;
        const data = getVideoData();
        if (data?.dash?.video) {
            const qnVal = qn;
            let candidates = data.dash.video.filter(v => v.id === qnVal);
            if (candidates.length > 0) {
                const currentCodec = getActualCodecFromPlayer();
                if (currentCodec) {
                    const matched = candidates.find(v => getCodecName(v.codecs) === currentCodec);
                    if (matched) {
                        actualVideo = matched;
                    } else {
                        actualVideo = candidates.reduce((a, b) => (a.bandwidth > b.bandwidth ? a : b));
                    }
                } else {
                    actualVideo = candidates.reduce((a, b) => (a.bandwidth > b.bandwidth ? a : b));
                }
            }
        }

        // 合并所有音频流
        let allAudio = [];
        if (data?.dash) {
            if (Array.isArray(data.dash.audio)) allAudio = allAudio.concat(data.dash.audio);
            if (data.dash.flac) {
                if (data.dash.flac.audio && typeof data.dash.flac.audio === 'object') {
                    if (Array.isArray(data.dash.flac.audio)) {
                        allAudio = allAudio.concat(data.dash.flac.audio);
                    } else if (data.dash.flac.audio.id) {
                        allAudio.push(data.dash.flac.audio);
                    }
                } else if (data.dash.flac.id) {
                    allAudio.push(data.dash.flac);
                }
            }
            if (data.dash.dolby && data.dash.dolby.audio) {
                if (Array.isArray(data.dash.dolby.audio)) {
                    allAudio = allAudio.concat(data.dash.dolby.audio);
                } else if (data.dash.dolby.audio.id) {
                    allAudio.push(data.dash.dolby.audio);
                }
            }
            const seen = new Set();
            allAudio = allAudio.filter(item => {
                if (seen.has(item.id)) return false;
                seen.add(item.id);
                return true;
            });
            allAudio.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
        }

        document.getElementById('bbvs-debug-bvid').textContent = bvid;
        document.getElementById('bbvs-debug-quality').textContent = qn + ' (' + desc + ')';
        let resText = '-';
        if (actualVideo?.width && actualVideo?.height) {
            resText = actualVideo.width + 'x' + actualVideo.height;
        } else if (video) {
            resText = video.videoWidth + 'x' + video.videoHeight;
        }
        document.getElementById('bbvs-debug-resolution').textContent = resText;
        let fpsText = '-';
        if (actualVideo?.frame_rate) {
            const fpsNum = parseFloat(actualVideo.frame_rate);
            if (!isNaN(fpsNum) && fpsNum > 0) {
                if (Number.isInteger(fpsNum)) {
                    fpsText = fpsNum + '帧';
                } else {
                    fpsText = fpsNum.toFixed(1) + '帧';
                }
            }
        }
        document.getElementById('bbvs-debug-fps').textContent = fpsText;
        let vBitrate = '-';
        if (actualVideo?.bandwidth) {
            vBitrate = (actualVideo.bandwidth / 1000).toFixed(0) + ' kbps';
            let finalCodec = codec;
            if (finalCodec === '未知' && actualVideo.codecs) {
                finalCodec = getCodecName(actualVideo.codecs);
            }
            if (finalCodec && finalCodec !== '未知') {
                vBitrate += ' [' + finalCodec + ']';
            }
        } else if (video && video.src) {
            const bitrate = parseInt(video.src.match(/[?&]br=(\d+)/)?.[1] || '');
            if (bitrate > 0) vBitrate = bitrate + ' kbps';
        }
        document.getElementById('bbvs-debug-video-bitrate').textContent = vBitrate;

        // ----- 音频码率显示：优先从分片获取，失败则回退到画质映射（无后缀） -----
        let aBitrate = '-';
        let targetAudio = null;
        const currentAudioId = getCurrentAudioIdFromPerformance();
        if (currentAudioId !== null) {
            targetAudio = allAudio.find(a => a.id === currentAudioId);
        }
        // 若未从分片获取到，根据画质映射默认ID
        if (!targetAudio) {
            const defaultId = getDefaultAudioIdByQuality(qn);
            if (defaultId !== null) {
                targetAudio = allAudio.find(a => a.id === defaultId);
            }
        }
        if (targetAudio) {
            const codecName = getCodecName(targetAudio.codecs);
            aBitrate = (targetAudio.bandwidth / 1000).toFixed(0) + ' kbps';
            if (codecName && codecName !== '未知') {
                aBitrate += ' [' + codecName + ']';
            }
            // 不加任何后缀
        }
        document.getElementById('bbvs-debug-audio-bitrate').textContent = aBitrate;

        // 加载速度
        let speedText = '-';
        if (video && video.buffered && video.buffered.length > 0) {
            const now = performance.now();
            const buffered = video.buffered;
            const bufferedEnd = buffered.end(buffered.length - 1);
            const duration = video.duration || 1;
            let totalMB = 50;
            if (actualVideo?.size) totalMB = actualVideo.size / (1024 * 1024);
            const loadedMB = (bufferedEnd / duration) * totalMB;
            const remaining = duration - bufferedEnd;
            if (bufferedEnd >= duration * 0.95 || remaining < 2) {
                speedText = '已完成';
            } else {
                const dt = (now - lastLoadedTime) / 1000;
                if (dt > 0.2 && lastLoadedMB > 0) {
                    const deltaMB = loadedMB - lastLoadedMB;
                    if (deltaMB > 0.001) {
                        const speed = (deltaMB * 1024) / dt;
                        currentSpeedKB = speed;
                    }
                }
                lastLoadedMB = loadedMB;
                lastLoadedTime = now;
                if (currentSpeedKB > 0) {
                    speedText = currentSpeedKB >= 1024 ? (currentSpeedKB/1024).toFixed(2) + ' MB/s' : currentSpeedKB.toFixed(2) + ' KB/s';
                } else {
                    speedText = '加载中...';
                }
            }
        } else {
            speedText = '0 KB/s';
            lastLoadedTime = 0;
            lastLoadedMB = 0;
            currentSpeedKB = 0;
        }
        document.getElementById('bbvs-debug-speed').textContent = speedText;
        if (video && video.buffered && video.buffered.length > 0) {
            const end = video.buffered.end(video.buffered.length - 1);
            const current = video.currentTime || 0;
            const remaining = Math.max(0, end - current);
            if (remaining > 60) {
                const mins = Math.floor(remaining / 60);
                const secs = Math.floor(remaining % 60);
                document.getElementById('bbvs-debug-buffer').textContent = mins + 'm ' + secs + 's';
            } else {
                document.getElementById('bbvs-debug-buffer').textContent = remaining.toFixed(1) + 's';
            }
        } else {
            document.getElementById('bbvs-debug-buffer').textContent = '-';
        }
    }

    // ========== 面板渲染 ==========
    function renderListForStep(container, step, panel) {
        container.innerHTML = '';
        if (step === 1) {
            if (currentMode === 'download') {
                const availableCodecs = getAvailableCodecs();
                if (availableCodecs.length === 0) availableCodecs.push('AVC');
                if (!selectedDownloadCodec || !availableCodecs.includes(selectedDownloadCodec)) {
                    const order = ['AV1', 'HEVC', 'AVC'];
                    for (let c of order) {
                        if (availableCodecs.includes(c)) {
                            selectedDownloadCodec = c;
                            break;
                        }
                    }
                }
                const codecBar = document.createElement('div');
                codecBar.style.cssText = 'display:flex; gap:6px; margin-bottom:8px; flex-wrap:wrap;';
                availableCodecs.forEach(codec => {
                    const btn = document.createElement('button');
                    btn.textContent = codec;
                    const isActive = (codec === selectedDownloadCodec);
                    btn.style.cssText = `padding:4px 12px; border-radius:4px; border:1px solid ${isActive ? '#00A1D6' : 'rgba(255,255,255,0.2)'}; background:${isActive ? 'rgba(0,161,214,0.3)' : 'transparent'}; color:#fff; cursor:pointer; font-size:12px; transition:background 0.2s;`;
                    btn.onmouseenter = () => { if (!isActive) btn.style.background = 'rgba(255,255,255,0.1)'; };
                    btn.onmouseleave = () => { if (!isActive) btn.style.background = 'transparent'; };
                    btn.onclick = (e) => {
                        e.stopPropagation();
                        selectedDownloadCodec = codec;
                        const btns = codecBar.querySelectorAll('button');
                        btns.forEach(b => {
                            const nowActive = (b.textContent === codec);
                            b.style.background = nowActive ? 'rgba(0,161,214,0.3)' : 'transparent';
                            b.style.borderColor = nowActive ? '#00A1D6' : 'rgba(255,255,255,0.2)';
                        });
                        renderListForStep(container, step, panel);
                        addDebugLog('下载编码切换为: ' + codec);
                    };
                    codecBar.appendChild(btn);
                });
                container.appendChild(codecBar);
                let qualityData = getFilteredQualityList(selectedDownloadCodec);
                if (qualityData.length === 0) {
                    qualityData = getFilteredQualityList(null);
                }
                renderQualityItems(container, qualityData, panel);
            } else {
                const currentCodec = getActualCodecFromPlayer();
                let qualityData = getFilteredQualityList(currentCodec);
                if (qualityData.length === 0) {
                    qualityData = getFilteredQualityList(null);
                }
                renderQualityItems(container, qualityData, panel);
            }
        } else if (step === 2) {
            const audioList = getAudioList();
            const audioPref = settings.audioPreference;
            const prefMap = {
                '杜比全景声': 30250,
                'Hi-Res': 30251,
                '高': 30280,
                '中': 30232,
                '低': 30216
            };
            let defaultAudioId = prefMap[audioPref] || (audioList.length > 0 ? audioList[0].id : null);
            if (selectedAudioId === null && defaultAudioId) {
                selectedAudioId = defaultAudioId;
            }
            audioList.forEach(item => {
                const div = document.createElement('div');
                div.className = 'bbvs-quality-item';
                div.dataset.audioId = item.id;
                const isActive = (item.id === selectedAudioId);
                div.style.setProperty('padding', '8px 12px', 'important');
                div.style.setProperty('margin', '4px 0', 'important');
                div.style.setProperty('border-radius', '6px', 'important');
                div.style.setProperty('cursor', 'pointer', 'important');
                if (isActive) {
                    div.style.setProperty('background', 'rgba(0,161,214,0.3)', 'important');
                    div.style.setProperty('border-left', '3px solid #00A1D6', 'important');
                } else {
                    div.style.removeProperty('background');
                    div.style.removeProperty('border-left');
                }
                div.onmouseenter = () => { if (!isActive) div.style.background = 'rgba(255,255,255,0.08)'; };
                div.onmouseleave = () => { if (!isActive) div.style.background = ''; };
                div.addEventListener('click', (e) => {
                    e.stopPropagation();
                    selectedAudioId = item.id;
                    renderListForStep(container, step, panel);
                    const downloadBtn = panel.querySelector('.bbvs-step-download');
                    if (downloadBtn) downloadBtn.disabled = false;
                });
                const nameSpan = document.createElement('div');
                nameSpan.className = 'bbvs-quality-name';
                nameSpan.textContent = item.description;
                nameSpan.style.cssText = `font-weight:${isActive ? 'bold' : 'normal'}; color:${isActive ? '#00A1D6' : '#fff'}; font-size:14px;`;
                div.appendChild(nameSpan);
                const detailParts = [];
                if (item.bitrateText) detailParts.push(item.bitrateText);
                if (item.codec && item.codec !== '未知') detailParts.push(item.codec);
                if (item.sizeDisplay && item.sizeDisplay !== '--') detailParts.push(item.sizeDisplay);
                const detailText = detailParts.length ? detailParts.join(' | ') : '';
                if (detailText) {
                    const detailSpan = document.createElement('div');
                    detailSpan.className = 'bbvs-quality-detail';
                    detailSpan.textContent = detailText;
                    detailSpan.style.cssText = `font-size:12px; color:${isActive ? '#88ccff' : '#aaa'}; margin-top:2px;`;
                    div.appendChild(detailSpan);
                }
                container.appendChild(div);
            });
            if (selectedAudioId) {
                const downloadBtn = panel.querySelector('.bbvs-step-download');
                if (downloadBtn) downloadBtn.disabled = false;
            }
        }
    }

    function renderQualityItems(container, qualityData, panel) {
        if (qualityData.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.textContent = '暂无可用画质，请稍后重试';
            emptyMsg.style.cssText = 'color:#aaa;font-size:13px;padding:12px 0;text-align:center;';
            container.appendChild(emptyMsg);
            return;
        }
        qualityData.forEach(item => {
            const div = document.createElement('div');
            div.className = 'bbvs-quality-item';
            div.dataset.qn = item.id;
            const isActive = (currentMode === 'download') ? (item.id === selectedVideoQn) : (item.id === (getCurrentQualityFromPlayer() || currentQuality));
            div.style.setProperty('padding', '8px 12px', 'important');
            div.style.setProperty('margin', '4px 0', 'important');
            div.style.setProperty('border-radius', '6px', 'important');
            div.style.setProperty('cursor', 'pointer', 'important');
            if (isActive) {
                div.style.setProperty('background', 'rgba(0,161,214,0.3)', 'important');
                div.style.setProperty('border-left', '3px solid #00A1D6', 'important');
            } else {
                div.style.removeProperty('background');
                div.style.removeProperty('border-left');
            }
            div.onmouseenter = () => {
                if (div.dataset.active !== 'true') {
                    div.style.background = 'rgba(255,255,255,0.08)';
                }
            };
            div.onmouseleave = () => {
                if (div.dataset.active !== 'true') {
                    div.style.background = '';
                }
            };
            div.addEventListener('click', (e) => {
                e.stopPropagation();
                if (currentMode === 'watch') {
                    switchQuality(item.id).catch(err => {
                        showNotification('切换失败: ' + err, 'error');
                    });
                } else {
                    selectedVideoQn = item.id;
                    renderListForStep(container, 1, panel);
                    const nextBtn = panel.querySelector('.bbvs-step-next');
                    if (nextBtn) nextBtn.disabled = false;
                }
            });
            let displayName = item.description;
            if (item.isHighFps) {
                displayName = displayName.replace(/\d+(\.\d+)?(帧|fps)/g, '');
                displayName = displayName.replace(/P\d+/, 'P');
                displayName = displayName.replace(/\s+/g, ' ').trim();
                if (!displayName.includes('高帧率')) {
                    displayName = displayName + ' 高帧率';
                }
            }
            const nameSpan = document.createElement('div');
            nameSpan.className = 'bbvs-quality-name';
            nameSpan.textContent = displayName;
            nameSpan.style.cssText = `font-weight:${isActive ? 'bold' : 'normal'}; color:${isActive ? '#00A1D6' : '#fff'}; font-size:14px;`;
            div.appendChild(nameSpan);
            const detailParts = [];
            if (item.resolution && item.resolution !== '?x?') detailParts.push(item.resolution);
            if (item.fpsDisplay && item.fpsDisplay !== '?') detailParts.push(item.fpsDisplay);
            if (item.bitrate && item.bitrate !== '?kbps') detailParts.push(item.bitrate);
            if (currentMode === 'download' && item.sizeDisplay) {
                detailParts.push(item.sizeDisplay);
            }
            const detailText = detailParts.length ? detailParts.join(' | ') : '';
            if (detailText) {
                const detailSpan = document.createElement('div');
                detailSpan.className = 'bbvs-quality-detail';
                detailSpan.textContent = detailText;
                detailSpan.style.cssText = `font-size:12px; color:${isActive ? '#88ccff' : '#aaa'}; margin-top:2px;`;
                div.appendChild(detailSpan);
            }
            container.appendChild(div);
        });
        if (currentMode === 'watch') {
            setTimeout(() => {
                const qn = getCurrentQualityFromPlayer() || currentQuality;
                const items = container.querySelectorAll('.bbvs-quality-item');
                items.forEach(el => {
                    const itemQn = parseInt(el.dataset.qn);
                    const isActive = (itemQn === qn);
                    el.style.setProperty('background', isActive ? 'rgba(0,161,214,0.3)' : '', 'important');
                    el.style.setProperty('border-left', isActive ? '3px solid #00A1D6' : '', 'important');
                    const nameSpan = el.querySelector('.bbvs-quality-name');
                    if (nameSpan) nameSpan.style.setProperty('color', isActive ? '#00A1D6' : '#fff', 'important');
                    const detailSpan = el.querySelector('.bbvs-quality-detail');
                    if (detailSpan) detailSpan.style.setProperty('color', isActive ? '#88ccff' : '#aaa', 'important');
                    el.dataset.active = isActive ? 'true' : 'false';
                });
            }, 50);
        }

        if (currentMode === 'download') {
            const divider = document.createElement('div');
            divider.style.cssText = 'border-top:1px solid rgba(255,255,255,0.1); margin:8px 0;';
            container.appendChild(divider);

            const mp4Div = document.createElement('div');
            mp4Div.className = 'bbvs-quality-item';
            mp4Div.style.cssText = `
                padding: 8px 12px;
                margin: 4px 0;
                border-radius: 6px;
                cursor: pointer;
                border: 2px solid #00A1D6;
                background: rgba(0,161,214,0.1);
                transition: background 0.2s, opacity 0.2s, box-shadow 0.2s;
            `;
            mp4Div.title = '如果没有 ffmpeg，可使用该选项直接下载音视频合一的视频（最高 1080P，但普遍为 720P）';

            const nameSpan = document.createElement('div');
            nameSpan.className = 'bbvs-quality-name';
            nameSpan.textContent = '📦 音视频合一 MP4';
            nameSpan.style.cssText = 'font-weight:bold; color:#00A1D6; font-size:14px;';
            mp4Div.appendChild(nameSpan);

            const detailSpan = document.createElement('div');
            detailSpan.className = 'bbvs-quality-detail';
            detailSpan.textContent = '最高 1080P ｜ H.264 ｜ 无需合并';
            detailSpan.style.cssText = 'font-size:12px; color:#88ccff; margin-top:2px;';
            mp4Div.appendChild(detailSpan);

            let isLoading = false;
            const clickHandler = async (e) => {
                e.stopPropagation();
                if (isLoading) return;
                isLoading = true;
                mp4Div.style.opacity = '0.6';
                mp4Div.style.cursor = 'wait';
                try {
                    await downloadMp4();
                } finally {
                    isLoading = false;
                    mp4Div.style.opacity = '1';
                    mp4Div.style.cursor = 'pointer';
                }
            };
            mp4Div.addEventListener('click', clickHandler);

            mp4Div.addEventListener('mouseenter', () => {
                if (!isLoading) {
                    mp4Div.style.background = 'rgba(0,161,214,0.25)';
                    mp4Div.style.boxShadow = 'inset 0 0 12px rgba(0,161,214,0.5)';
                }
            });
            mp4Div.addEventListener('mouseleave', () => {
                if (!isLoading) {
                    mp4Div.style.background = 'rgba(0,161,214,0.1)';
                    mp4Div.style.boxShadow = 'none';
                }
            });

            container.appendChild(mp4Div);
        }
    }

    function updatePanelForStep(panel) {
        const step = downloadStep;
        const title = panel._titleElement;
        if (currentMode === 'download') {
            if (step === 1) {
                title.textContent = '选择视频画质 (1/2)';
                panel._nextBtn.style.display = '';
                panel._downloadBtn.style.display = 'none';
                panel._prevBtn.style.display = 'none';
                panel._nextBtn.disabled = !selectedVideoQn;
            } else {
                title.textContent = '选择音频音质 (2/2)';
                panel._nextBtn.style.display = 'none';
                panel._downloadBtn.style.display = '';
                panel._prevBtn.style.display = '';
                panel._downloadBtn.disabled = !selectedAudioId;
            }
            renderListForStep(panel._listContainer, step, panel);
        } else {
            title.textContent = '选择画质';
            panel._nextBtn.style.display = 'none';
            panel._downloadBtn.style.display = 'none';
            panel._prevBtn.style.display = 'none';
            renderListForStep(panel._listContainer, 1, panel);
        }
    }

    function showCustomPanel(btn) {
        let data = getVideoData();
        if (data && data.dash && data.dash.video && data.dash.video.length > 0) {
            log('数据已存在，直接打开面板', 'info');
            doShowPanel(btn);
            return;
        }

        showNotification('正在获取视频信息...', 'loading');
        log('等待数据就绪...', 'info');
        const maxWait = 5000;
        const start = Date.now();
        const interval = setInterval(() => {
            data = getVideoData();
            if (data && data.dash && data.dash.video && data.dash.video.length > 0) {
                clearInterval(interval);
                log('成功获取视频数据流，打开面板', 'success');
                doShowPanel(btn);
                return;
            }
            if (Date.now() - start > maxWait) {
                clearInterval(interval);
                log('获取视频数据超时', 'error');
                showNotification('无法获取视频信息，请刷新页面', 'error');
            }
        }, 200);
    }

    function doShowPanel(btn) {
        if (currentPanel) {
            if (globalClosePanel) globalClosePanel();
        }
        const old = document.querySelector('.bbvs-quality-panel');
        if (old) old.remove();
        const container = getPlayerContainer();
        if (!container) return;
        if (getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }
        downloadStep = 1;
        selectedVideoQn = null;
        selectedAudioId = null;
        const available = getAvailableCodecs();
        if (available.length > 0) {
            const order = ['AV1', 'HEVC', 'AVC'];
            for (let c of order) {
                if (available.includes(c)) {
                    selectedDownloadCodec = c;
                    break;
                }
            }
        } else {
            selectedDownloadCodec = 'AVC';
        }
        const qn = getCurrentQualityFromPlayer() || currentQuality;
        if (qn !== null && qn !== undefined) {
            currentQuality = qn;
        }
        const btnRect = btn.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const panelWidth = 280;
        let left = btnRect.left - containerRect.left + btnRect.width / 2 - panelWidth / 2;
        let bottom = containerRect.bottom - btnRect.top + 10;
        if (left < 10) left = 10;
        if (left + panelWidth > containerRect.width - 10) {
            left = containerRect.width - panelWidth - 10;
        }
        const panel = document.createElement('div');
        panel._bvid = getBvid();
        panel.className = 'bbvs-quality-panel';
        panel.style.cssText = `position:absolute; bottom:${bottom}px; left:${left}px; z-index:99999; border-radius:12px; padding:12px 16px; min-width:220px; max-width:300px; max-height:60vh; overflow-y:auto; color:#fff; font-size:13px; box-shadow:0 4px 20px rgba(0,0,0,0.6); border:1px solid rgba(255,255,255,0.1); transition: opacity 0.08s ease; opacity:1;`;
        const header = document.createElement('div');
        header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:6px;';
        const title = document.createElement('span');
        title.className = 'bbvs-panel-title';
        title.textContent = currentMode === 'watch' ? '选择画质' : '选择视频画质 (1/2)';
        title.style.fontWeight = 'bold';
        title.style.fontSize = '14px';
        header.appendChild(title);
        const rightGroup = document.createElement('div');
        rightGroup.style.display = 'flex';
        rightGroup.style.alignItems = 'center';
        rightGroup.style.gap = '6px';
        const modeGroup = document.createElement('div');
        modeGroup.style.cssText = 'display:flex; background:rgba(255,255,255,0.1); border-radius:4px; overflow:hidden;';
        const watchBtn = document.createElement('span');
        watchBtn.textContent = '观看';
        watchBtn.style.cssText = 'padding:2px 8px; font-size:12px; cursor:pointer; transition:background 0.2s;';
        const downloadBtnMode = document.createElement('span');
        downloadBtnMode.textContent = '下载';
        downloadBtnMode.style.cssText = 'padding:2px 8px; font-size:12px; cursor:pointer; transition:background 0.2s;';
        function updateModeUI() {
            if (currentMode === 'watch') {
                watchBtn.style.background = '#00A1D6';
                downloadBtnMode.style.background = 'transparent';
                title.textContent = '选择画质';
            } else {
                watchBtn.style.background = 'transparent';
                downloadBtnMode.style.background = '#00A1D6';
                title.textContent = '选择视频画质 (1/2)';
                downloadStep = 1;
                selectedVideoQn = null;
                selectedAudioId = null;
                const avail = getAvailableCodecs();
                if (avail.length > 0) {
                    const order = ['AV1', 'HEVC', 'AVC'];
                    for (let c of order) {
                        if (avail.includes(c)) {
                            selectedDownloadCodec = c;
                            break;
                        }
                    }
                } else {
                    selectedDownloadCodec = 'AVC';
                }
                if (panel._listContainer) {
                    updatePanelForStep(panel);
                }
            }
        }
        updateModeUI();
        watchBtn.onclick = (e) => { e.stopPropagation(); currentMode = 'watch'; updateModeUI(); updatePanelForStep(panel); };
        downloadBtnMode.onclick = (e) => { e.stopPropagation(); currentMode = 'download'; updateModeUI(); updatePanelForStep(panel); };
        modeGroup.appendChild(watchBtn);
        modeGroup.appendChild(downloadBtnMode);
        rightGroup.appendChild(modeGroup);
        const settingsBtn = document.createElement('button');
        settingsBtn.textContent = '⚙️';
        settingsBtn.title = '设置';
        settingsBtn.style.cssText = 'background:transparent; border:none; color:#fff; cursor:pointer; font-size:16px; opacity:0.7; padding:0 4px;';
        settingsBtn.onmouseenter = () => { settingsBtn.style.opacity = '1'; };
        settingsBtn.onmouseleave = () => { settingsBtn.style.opacity = '0.7'; };
        settingsBtn.onclick = (e) => {
            e.stopPropagation();
            if (isSettingsMode) exitSettingsMode(panel);
            else enterSettingsMode(panel);
        };
        rightGroup.appendChild(settingsBtn);
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.title = '关闭';
        closeBtn.style.cssText = 'background:transparent; border:none; color:#aaa; cursor:pointer; font-size:14px; padding:0 4px;';
        closeBtn.onclick = (e) => {
            e.stopPropagation();
            if (isSettingsMode) exitSettingsMode(panel);
            else closePanel();
        };
        rightGroup.appendChild(closeBtn);
        header.appendChild(rightGroup);
        panel.appendChild(header);
        const listContainer = document.createElement('div');
        listContainer.className = 'bbvs-quality-list';
        listContainer.style.cssText = 'max-height:300px; overflow-y:auto; padding-right:4px;';
        panel.appendChild(listContainer);
        panel._listContainer = listContainer;
        panel._titleElement = title;
        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex; justify-content:space-between; margin-top:10px; gap:6px;';
        footer.className = 'bbvs-step-footer';
        const prevBtn = document.createElement('button');
        prevBtn.textContent = '上一步';
        prevBtn.className = 'bbvs-step-prev';
        prevBtn.style.cssText = 'padding:4px 12px; border-radius:4px; border:none; background:rgba(255,255,255,0.15); color:#fff; cursor:pointer; font-size:12px;';
        prevBtn.onclick = (e) => {
            e.stopPropagation();
            if (downloadStep > 1) {
                downloadStep--;
                updatePanelForStep(panel);
            }
        };
        footer.appendChild(prevBtn);
        const nextBtn = document.createElement('button');
        nextBtn.textContent = '下一步';
        nextBtn.className = 'bbvs-step-next';
        nextBtn.style.cssText = 'padding:4px 12px; border-radius:4px; border:none; background:rgba(0,161,214,0.6); color:#fff; cursor:pointer; font-size:12px;';
        nextBtn.disabled = true;
        nextBtn.onclick = (e) => {
            e.stopPropagation();
            if (downloadStep === 1 && selectedVideoQn) {
                downloadStep = 2;
                updatePanelForStep(panel);
            }
        };
        footer.appendChild(nextBtn);
        const downloadBtnAction = document.createElement('button');
        downloadBtnAction.textContent = '下载';
        downloadBtnAction.className = 'bbvs-step-download';
        downloadBtnAction.style.cssText = 'padding:4px 12px; border-radius:4px; border:none; background:rgba(76,175,80,0.7); color:#fff; cursor:pointer; font-size:12px; display:none;';
        downloadBtnAction.disabled = true;
        downloadBtnAction.onclick = (e) => {
            e.stopPropagation();
            if (selectedVideoQn && selectedAudioId) {
                downloadVideoAndAudio();
            } else {
                showNotification('请完成选择', 'error');
            }
        };
        footer.appendChild(downloadBtnAction);
        panel.appendChild(footer);
        panel._prevBtn = prevBtn;
        panel._nextBtn = nextBtn;
        panel._downloadBtn = downloadBtnAction;
        container.appendChild(panel);
        applyBlurEffect();
        updatePanelForStep(panel);
        let hideTimer = null;
        let ctrlObserver = null;
        const playerContainer = document.querySelector('.bpx-player-container');
        if (playerContainer) {
            ctrlObserver = new MutationObserver(() => {
                const hidden = playerContainer.getAttribute('data-ctrl-hidden') === 'true';
                if (hidden && panel.parentNode) {
                    closePanelWithFade();
                }
            });
            ctrlObserver.observe(playerContainer, {
                attributes: true,
                attributeFilter: ['data-ctrl-hidden']
            });
        }
        function startHideTimer() {
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = setTimeout(() => {
                const hoverPanel = panel.matches(':hover');
                const hoverContainer = container.matches(':hover');
                if (!hoverPanel && !hoverContainer && panel.parentNode) {
                    closePanelWithFade();
                }
            }, 500);
        }
        function cancelHideTimer() {
            if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        }
        function closePanelWithFade() {
            if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
            panel.style.opacity = '0';
            setTimeout(() => {
                if (panel.parentNode) panel.parentNode.removeChild(panel);
                document.removeEventListener('click', outsideClick);
                if (qualityButton) qualityButton.style.pointerEvents = '';
                if (ctrlObserver) {
                    ctrlObserver.disconnect();
                    ctrlObserver = null;
                }
                currentPanel = null;
                isSettingsMode = false;
                globalClosePanel = null;
            }, 100);
        }
        container.addEventListener('mouseleave', function(e) {
            if (!panel.contains(e.relatedTarget)) {
                startHideTimer();
            }
        });
        container.addEventListener('mouseenter', cancelHideTimer);
        panel.addEventListener('mouseenter', cancelHideTimer);
        panel.addEventListener('mouseleave', function(e) {
            if (!container.contains(e.relatedTarget)) {
                startHideTimer();
            }
        });
        panel.addEventListener('click', cancelHideTimer);
        function closePanel() {
            closePanelWithFade();
        }
        globalClosePanel = closePanel;
        const outsideClick = (e) => {
            if (!panel.contains(e.target) && e.target !== btn && !e.target.closest('.bbvs-quality-item') && e.target !== settingsBtn) {
                if (isSettingsMode) exitSettingsMode(panel);
                else closePanelWithFade();
            }
        };
        setTimeout(() => document.addEventListener('click', outsideClick), 100);
        currentPanel = panel;
    }

    function enterSettingsMode(panel) {
        if (isSettingsMode) return;
        isSettingsMode = true;
        const listContainer = panel._listContainer;
        const titleElement = panel._titleElement;
        if (!listContainer || !titleElement) return;
        titleElement.textContent = '设置';
        listContainer.innerHTML = '';
        renderSettingsContent(listContainer, panel, titleElement);
        const footer = panel.querySelector('.bbvs-step-footer');
        if (footer) footer.style.display = 'none';
    }

    function exitSettingsMode(panel) {
        if (!isSettingsMode) return;
        isSettingsMode = false;
        const listContainer = panel._listContainer;
        const titleElement = panel._titleElement;
        if (!listContainer || !titleElement) return;
        const footer = panel.querySelector('.bbvs-step-footer');
        if (footer) footer.style.display = 'flex';
        if (currentMode === 'watch') {
            titleElement.textContent = '选择画质';
            panel._nextBtn.style.display = 'none';
            panel._downloadBtn.style.display = 'none';
            panel._prevBtn.style.display = 'none';
            renderListForStep(listContainer, 1, panel);
        } else {
            const step = downloadStep;
            if (step === 1) {
                titleElement.textContent = '选择视频画质 (1/2)';
                panel._nextBtn.style.display = '';
                panel._downloadBtn.style.display = 'none';
                panel._prevBtn.style.display = 'none';
                panel._nextBtn.disabled = !selectedVideoQn;
            } else {
                titleElement.textContent = '选择音频音质 (2/2)';
                panel._nextBtn.style.display = 'none';
                panel._downloadBtn.style.display = '';
                panel._prevBtn.style.display = '';
                panel._downloadBtn.disabled = !selectedAudioId;
            }
            renderListForStep(listContainer, step, panel);
        }
    }

    function createCustomDropdown(options, currentValue, onChange, label) {
        const container = document.createElement('div');
        container.style.cssText = 'position:relative; width:100%; user-select:none;';
        const display = document.createElement('div');
        display.style.cssText = `
            display:flex; justify-content:space-between; align-items:center;
            padding:4px 10px; background:rgba(255,255,255,0.08);
            border:1px solid rgba(255,255,255,0.15); border-radius:4px;
            color:#fff; font-size:13px; cursor:pointer;
            transition:border-color 0.2s;
        `;
        display.textContent = currentValue || options[0] || '';
        const arrow = document.createElement('span');
        arrow.textContent = '▾';
        arrow.style.cssText = `
            font-size:12px; transition:transform 0.25s ease; margin-left:8px;
            color:rgba(255,255,255,0.5);
        `;
        display.appendChild(arrow);
        const menu = document.createElement('div');
        menu.style.cssText = `
            display:none; position:absolute; top:calc(100% + 4px); left:0; width:100%;
            background:rgba(30,30,30,0.95); backdrop-filter:blur(8px);
            border:1px solid rgba(255,255,255,0.1); border-radius:6px;
            padding:4px 0; z-index:100002; max-height:180px; overflow-y:auto;
        `;
        options.forEach(opt => {
            const item = document.createElement('div');
            item.textContent = opt;
            item.style.cssText = `
                padding:6px 12px; color:#ddd; font-size:13px; cursor:pointer;
                transition:background 0.15s;
            `;
            item.onmouseenter = () => { item.style.background = 'rgba(255,255,255,0.08)'; };
            item.onmouseleave = () => { item.style.background = 'transparent'; };
            item.onclick = (e) => {
                e.stopPropagation();
                display.textContent = opt;
                display.appendChild(arrow);
                menu.style.display = 'none';
                arrow.style.transform = 'rotate(0deg)';
                if (onChange) onChange(opt);
            };
            if (opt === currentValue) {
                item.style.background = 'rgba(0,161,214,0.2)';
                item.style.color = '#00A1D6';
            }
            menu.appendChild(item);
        });
        display.onclick = (e) => {
            e.stopPropagation();
            const isOpen = menu.style.display === 'block';
            menu.style.display = isOpen ? 'none' : 'block';
            arrow.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(180deg)';
        };
        container.appendChild(display);
        container.appendChild(menu);
        document.addEventListener('click', function closeDropdown(e) {
            if (!container.contains(e.target)) {
                menu.style.display = 'none';
                arrow.style.transform = 'rotate(0deg)';
            }
        }, { once: false });
        return container;
    }

    function renderSettingsContent(container, panel, titleElement) {
        container.innerHTML = '';
        const qualitySection = document.createElement('div');
        qualitySection.style.cssText = 'margin-bottom:12px;';
        const qualityLabel = document.createElement('div');
        qualityLabel.textContent = '视频画质偏好';
        qualityLabel.style.cssText = 'font-size:13px; margin-bottom:6px; color:#ccc;';
        qualityLabel.title = '首次加载视频时自动切换到的画质';
        qualitySection.appendChild(qualityLabel);
        const qualityOptions = getAvailableQualityLabels();
        const qualityDropdown = createCustomDropdown(
            qualityOptions,
            settings.qualityPreference || qualityOptions[0] || '1080P 高清',
            function(val) {
                settings.qualityPreference = val;
                saveSettings();
                addDebugLog('画质偏好已更新: ' + val);
                autoSwitchDone = false;
                applyQualityPreference();
                showNotification('画质偏好已更新: ' + val, 'success');
            }
        );
        qualityDropdown.title = '选择默认启动的画质等级';
        qualitySection.appendChild(qualityDropdown);
        container.appendChild(qualitySection);
        const audioSection = document.createElement('div');
        audioSection.style.cssText = 'margin-bottom:12px;';
        const audioLabel = document.createElement('div');
        audioLabel.textContent = '音频音质偏好';
        audioLabel.style.cssText = 'font-size:13px; margin-bottom:6px; color:#ccc;';
        audioLabel.title = '下载视频时默认选中的音质等级';
        audioSection.appendChild(audioLabel);
        const audioOptions = ['杜比全景声', 'Hi-Res', '高', '中', '低'];
        const audioDropdown = createCustomDropdown(
            audioOptions,
            settings.audioPreference || '杜比全景声',
            function(val) {
                settings.audioPreference = val;
                saveSettings();
                addDebugLog('音频偏好已更新: ' + val);
                showNotification('音频偏好已更新: ' + val, 'success');
            }
        );
        audioDropdown.title = '选择下载时默认的音频质量';
        audioSection.appendChild(audioDropdown);
        container.appendChild(audioSection);
        const blurItem = document.createElement('div');
        blurItem.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;';
        const blurLabel = document.createElement('span');
        blurLabel.textContent = '界面模糊效果';
        blurLabel.style.color = '#ccc';
        blurLabel.title = '控制播放器控制栏及菜单面板的毛玻璃模糊效果';
        blurItem.appendChild(blurLabel);
        const blurToggle = document.createElement('button');
        blurToggle.textContent = settings.blurEffect ? '开' : '关';
        blurToggle.style.cssText = `padding:2px 12px; border-radius:4px; border:none; background:${settings.blurEffect ? '#00A1D6' : 'rgba(255,255,255,0.2)'}; color:#fff; cursor:pointer;`;
        blurToggle.title = '切换界面毛玻璃效果';
        blurToggle.onclick = (e) => {
            e.stopPropagation();
            settings.blurEffect = !settings.blurEffect;
            saveSettings();
            blurToggle.textContent = settings.blurEffect ? '开' : '关';
            blurToggle.style.background = settings.blurEffect ? '#00A1D6' : 'rgba(255,255,255,0.2)';
            applyBlurEffect();
            showNotification('界面模糊效果已' + (settings.blurEffect ? '启用' : '关闭'), 'success');
            addDebugLog('界面模糊效果: ' + (settings.blurEffect ? '启用' : '关闭'));
        };
        blurItem.appendChild(blurToggle);
        container.appendChild(blurItem);
        const debugItem = document.createElement('div');
        debugItem.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;';
        const debugLabel = document.createElement('span');
        debugLabel.textContent = '调试模式';
        debugLabel.style.color = '#ccc';
        debugLabel.title = '开启后显示播放器调试信息面板';
        debugItem.appendChild(debugLabel);
        const debugToggle = document.createElement('button');
        debugToggle.textContent = settings.debugMode ? '开' : '关';
        debugToggle.style.cssText = `padding:2px 12px; border-radius:4px; border:none; background:${settings.debugMode ? '#00A1D6' : 'rgba(255,255,255,0.2)'}; color:#fff; cursor:pointer;`;
        debugToggle.title = '切换调试面板';
        debugToggle.onclick = (e) => {
            e.stopPropagation();
            settings.debugMode = !settings.debugMode;
            saveSettings();
            debugToggle.textContent = settings.debugMode ? '开' : '关';
            debugToggle.style.background = settings.debugMode ? '#00A1D6' : 'rgba(255,255,255,0.2)';
            if (settings.debugMode) {
                createDebugOverlay();
                addDebugLog('调试模式已启用');
            } else {
                destroyDebugOverlay();
                addDebugLog('调试模式已关闭');
            }
        };
        debugItem.appendChild(debugToggle);
        container.appendChild(debugItem);
        const ambientSection = document.createElement('div');
        ambientSection.style.cssText = 'margin-bottom:12px; border-top:1px solid rgba(255,255,255,0.08); padding-top:10px;';
        const ambientTitle = document.createElement('div');
        ambientTitle.textContent = '背景与环境';
        ambientTitle.style.cssText = 'font-size:13px; margin-bottom:8px; color:#ccc; font-weight:bold;';
        ambientSection.appendChild(ambientTitle);
        const ambientRow = document.createElement('div');
        ambientRow.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;';
        const ambientLabel = document.createElement('span');
        ambientLabel.textContent = '网页背景模糊';
        ambientLabel.style.color = '#aaa';
        ambientLabel.style.fontSize = '12px';
        ambientLabel.title = '将视频内容放大模糊作为网页背景，类似YouTube Ambient Mode';
        ambientRow.appendChild(ambientLabel);
        const ambientToggle = document.createElement('button');
        ambientToggle.textContent = settings.ambientEnabled ? '开' : '关';
        ambientToggle.style.cssText = `padding:2px 12px; border-radius:4px; border:none; background:${settings.ambientEnabled ? '#00A1D6' : 'rgba(255,255,255,0.2)'}; color:#fff; cursor:pointer; font-size:12px;`;
        ambientToggle.title = '开启或关闭网页背景模糊效果（性能敏感）';
        ambientToggle.onclick = (e) => {
            e.stopPropagation();
            settings.ambientEnabled = !settings.ambientEnabled;
            saveSettings();
            ambientToggle.textContent = settings.ambientEnabled ? '开' : '关';
            ambientToggle.style.background = settings.ambientEnabled ? '#00A1D6' : 'rgba(255,255,255,0.2)';
            if (settings.ambientEnabled) {
                startAmbientLight();
            } else {
                stopAmbientLight();
            }
            showNotification('网页背景模糊已' + (settings.ambientEnabled ? '开启' : '关闭'), 'success');
        };
        ambientRow.appendChild(ambientToggle);
        ambientSection.appendChild(ambientRow);
        const qualityRow = document.createElement('div');
        qualityRow.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;';
        const qualityLabel2 = document.createElement('span');
        qualityLabel2.textContent = '背景模糊质量';
        qualityLabel2.style.color = '#aaa';
        qualityLabel2.style.fontSize = '12px';
        qualityLabel2.title = '低=64x36(极省性能)，中=256x144(平衡)，高=640x360(最佳效果)';
        qualityRow.appendChild(qualityLabel2);
        const btnGroup = document.createElement('div');
        btnGroup.style.cssText = 'display:flex; gap:4px;';
        const levels = ['低', '中', '高'];
        levels.forEach(level => {
            const btn = document.createElement('button');
            btn.textContent = level;
            const isActive = settings.ambientQuality === level;
            btn.style.cssText = `padding:2px 10px; border-radius:4px; border:none; background:${isActive ? '#00A1D6' : 'rgba(255,255,255,0.2)'}; color:#fff; cursor:pointer; font-size:12px; transition:background 0.2s;`;
            btn.title = `切换到 ${level} 质量`;
            btn.onclick = (e) => {
                e.stopPropagation();
                if (settings.ambientQuality === level) return;
                settings.ambientQuality = level;
                saveSettings();
                btnGroup.querySelectorAll('button').forEach(b => {
                    b.style.background = b.textContent === level ? '#00A1D6' : 'rgba(255,255,255,0.2)';
                });
                if (settings.ambientEnabled) {
                    stopAmbientLight();
                    setTimeout(() => startAmbientLight(), 200);
                }
                showNotification('背景质量已切换为: ' + level, 'success');
                addDebugLog('背景质量切换为: ' + level);
            };
            btnGroup.appendChild(btn);
        });
        qualityRow.appendChild(btnGroup);
        ambientSection.appendChild(qualityRow);
        const edgeRow = document.createElement('div');
        edgeRow.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;';
        const edgeLabel = document.createElement('span');
        edgeLabel.textContent = '播放器边缘发光';
        edgeLabel.style.color = '#aaa';
        edgeLabel.style.fontSize = '12px';
        edgeLabel.title = '根据视频颜色在播放器边缘生成柔和光晕';
        edgeRow.appendChild(edgeLabel);
        const edgeToggle = document.createElement('button');
        edgeToggle.textContent = settings.edgeGlow ? '开' : '关';
        edgeToggle.style.cssText = `padding:2px 12px; border-radius:4px; border:none; background:${settings.edgeGlow ? '#00A1D6' : 'rgba(255,255,255,0.2)'}; color:#fff; cursor:pointer; font-size:12px;`;
        edgeToggle.title = '切换播放器边缘发光效果';
        edgeToggle.onclick = (e) => {
            e.stopPropagation();
            settings.edgeGlow = !settings.edgeGlow;
            saveSettings();
            edgeToggle.textContent = settings.edgeGlow ? '开' : '关';
            edgeToggle.style.background = settings.edgeGlow ? '#00A1D6' : 'rgba(255,255,255,0.2)';
            if (settings.edgeGlow) {
                updateEdgeGlow();
            } else {
                clearEdgeGlow();
            }
            const sliderRow = ambientSection.querySelector('.glow-slider-row');
            if (sliderRow) {
                const slider = sliderRow.querySelector('input');
                if (slider) slider.disabled = !settings.edgeGlow;
                sliderRow.style.opacity = settings.edgeGlow ? '1' : '0.4';
            }
            showNotification('播放器边缘发光已' + (settings.edgeGlow ? '开启' : '关闭'), 'success');
        };
        edgeRow.appendChild(edgeToggle);
        ambientSection.appendChild(edgeRow);
        const widthRow = document.createElement('div');
        widthRow.className = 'glow-slider-row';
        widthRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;';
        widthRow.style.opacity = settings.edgeGlow ? '1' : '0.4';
        const widthLabel = document.createElement('span');
        widthLabel.textContent = '发光范围';
        widthLabel.style.color = '#aaa';
        widthLabel.style.fontSize = '12px';
        widthLabel.title = '调整边缘发光的光晕扩散范围';
        widthRow.appendChild(widthLabel);
        const widthSlider = document.createElement('input');
        widthSlider.type = 'range';
        widthSlider.min = 5;
        widthSlider.max = 20;
        widthSlider.step = 1;
        widthSlider.value = settings.glowWidth || 10;
        widthSlider.style.cssText = 'width:100px; height:4px; margin:0 8px; accent-color:#00A1D6;';
        if (!settings.edgeGlow) widthSlider.disabled = true;
        widthSlider.title = '滑动调整发光范围';
        const widthValue = document.createElement('span');
        widthValue.textContent = widthSlider.value + 'px';
        widthValue.style.color = '#00A1D6';
        widthValue.style.fontSize = '12px';
        widthValue.style.minWidth = '30px';
        widthSlider.addEventListener('input', function(e) {
            e.stopPropagation();
            const val = parseInt(this.value);
            widthValue.textContent = val + 'px';
            settings.glowWidth = val;
            saveSettings();
            if (settings.edgeGlow) {
                updateEdgeGlow();
            }
        });
        widthRow.appendChild(widthSlider);
        widthRow.appendChild(widthValue);
        ambientSection.appendChild(widthRow);
        const barItem = document.createElement('div');
        barItem.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;';
        const barLabel = document.createElement('span');
        barLabel.textContent = '黑边模糊填充';
        barLabel.style.color = '#aaa';
        barLabel.style.fontSize = '12px';
        barLabel.title = '非16:9视频在黑边区域显示模糊视频';
        barItem.appendChild(barLabel);
        const barToggle = document.createElement('button');
        barToggle.textContent = settings.blackBarFill ? '开' : '关';
        barToggle.style.cssText = `padding:2px 12px; border-radius:4px; border:none; background:${settings.blackBarFill ? '#00A1D6' : 'rgba(255,255,255,0.2)'}; color:#fff; cursor:pointer; font-size:12px;`;
        barToggle.onclick = (e) => {
            e.stopPropagation();
            settings.blackBarFill = !settings.blackBarFill;
            saveSettings();
            barToggle.textContent = settings.blackBarFill ? '开' : '关';
            barToggle.style.background = settings.blackBarFill ? '#00A1D6' : 'rgba(255,255,255,0.2)';
            if (settings.blackBarFill) startBlackBarFill();
            else stopBlackBarFill();
            showNotification('黑边模糊填充已' + (settings.blackBarFill ? '开启' : '关闭'), 'success');
        };
        barItem.appendChild(barToggle);
        ambientSection.appendChild(barItem);
        container.appendChild(ambientSection);
        const aboutItem = document.createElement('div');
        aboutItem.style.cssText = 'text-align:center; margin-top:12px;';
        const aboutBtn = document.createElement('button');
        aboutBtn.textContent = '关于';
        aboutBtn.style.cssText = 'padding:6px 20px; background:rgba(255,255,255,0.08); color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:13px; transition:background 0.2s;';
        aboutBtn.title = '查看脚本信息与版本';
        aboutBtn.onmouseenter = () => { aboutBtn.style.background = 'rgba(255,255,255,0.16)'; };
        aboutBtn.onmouseleave = () => { aboutBtn.style.background = 'rgba(255,255,255,0.08)'; };
        aboutBtn.onclick = (e) => {
            e.stopPropagation();
            showAboutDialog();
        };
        aboutItem.appendChild(aboutBtn);
        container.appendChild(aboutItem);
    }

    function showAboutDialog() {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:999999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
        const box = document.createElement('div');
        box.style.cssText = 'background:rgba(30,30,30,0.95);border-radius:16px;padding:30px 40px;max-width:520px;width:90%;max-height:80vh;overflow-y:auto;color:#eee;box-shadow:0 8px 40px rgba(0,0,0,0.8);border:1px solid rgba(255,255,255,0.1);position:relative;';
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = 'position:absolute;top:12px;right:16px;background:transparent;border:none;color:#aaa;font-size:20px;cursor:pointer;transition:color 0.2s;';
        closeBtn.onmouseenter = function() { this.style.color = '#fff'; };
        closeBtn.onmouseleave = function() { this.style.color = '#aaa'; };
        closeBtn.onclick = function() { document.body.removeChild(overlay); };
        box.appendChild(closeBtn);
        const title = document.createElement('h2');
        title.textContent = 'BetterBilibiliPlayer';
        title.style.cssText = 'font-size:24px;font-weight:bold;text-align:center;color:#00A1D6;margin:0 0 4px 0;';
        box.appendChild(title);
        const subtitle = document.createElement('div');
        subtitle.textContent = '对B站播放页的一些界面的美化';
        subtitle.style.cssText = 'text-align:center;color:#aaa;font-size:14px;margin-bottom:12px;';
        box.appendChild(subtitle);
        const author = document.createElement('div');
        author.textContent = '只是觉得B站播放器原来的一些界面很丑，所以用ai美化了一下，bug很多';
        author.style.cssText = 'text-align:center;color:#ccc;font-size:13px;line-height:1.6;margin-bottom:16px;';
        box.appendChild(author);
        const version = document.createElement('div');
        version.textContent = '当前版本 v1.0.5.12-dev';
        version.style.cssText = 'text-align:center;color:#888;font-size:14px;margin-bottom:12px;';
        box.appendChild(version);
        const btnContainer = document.createElement('div');
        btnContainer.style.cssText = 'text-align:center;margin-top:10px;';
        const linkBtn = document.createElement('a');
        linkBtn.href = 'https://github.com/Wednesxuan/wednesxuan.github.io/tree/main/Better/BBP';
        linkBtn.target = '_blank';
        linkBtn.textContent = '存放地';
        linkBtn.style.cssText = `
            display:inline-block;
            padding:8px 30px;
            background:#00A1D6;
            color:#fff;
            border-radius:8px;
            text-decoration:none;
            font-size:14px;
            font-weight:500;
            transition:background 0.2s;
            cursor:pointer;
        `;
        linkBtn.onmouseenter = function() { this.style.background = '#0088b0'; };
        linkBtn.onmouseleave = function() { this.style.background = '#00A1D6'; };
        btnContainer.appendChild(linkBtn);
        box.appendChild(btnContainer);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) {
                document.body.removeChild(overlay);
            }
        });
    }

    // ========== Ambient Mode ==========
    let sampleTimer = null;
    let ambientRAFIdGlobal = null;
    let ambientLayer = null;
    let ambientCanvasGlobal = null;
    let ambientCtxGlobal = null;
    let currentEdgeColor = { r: 30, g: 30, b: 30 };
    let ambientRunning = false;
    let resizeObserver = null;
    let themeObserver = null;
    const QUALITY_MAP = {
        '低': { w: 64, h: 36 },
        '中': { w: 256, h: 144 },
        '高': { w: 640, h: 360 }
    };

    function getAmbientConfig() {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
                       document.body.classList.contains('dark') ||
                       window.matchMedia('(prefers-color-scheme: dark)').matches;
        return {
            scale: 1.45,
            blur: isDark ? '70px' : '65px',
            brightness: isDark ? '0.85' : '1',
            saturate: '0.8',
            opacity: isDark ? '0.25' : '0.18',
        };
    }

    function applyAmbientStyle() {
        if (!ambientCanvasGlobal) return;
        const config = getAmbientConfig();
        ambientCanvasGlobal.style.transform = `translate(-50%, -50%) scale(${config.scale})`;
        ambientCanvasGlobal.style.filter = `blur(${config.blur}) brightness(${config.brightness}) saturate(${config.saturate})`;
        ambientCanvasGlobal.style.opacity = config.opacity;
    }

    function setupThemeObserver() {
        if (themeObserver) return;
        themeObserver = new MutationObserver(() => {
            if (ambientRunning) applyAmbientStyle();
        });
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
        themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    function resizeCanvasToViewport() {
        if (!ambientCanvasGlobal) return;
        const quality = settings.ambientQuality || '中';
        const size = QUALITY_MAP[quality] || QUALITY_MAP['中'];
        ambientCanvasGlobal.width = size.w;
        ambientCanvasGlobal.height = size.h;
    }

    function startColorSampling() {
        if (sampleTimer) clearInterval(sampleTimer);
        sampleTimer = setInterval(() => {
            const video = document.querySelector('video');
            if (!video || video.videoWidth === 0) return;
            if (!window._sampleCanvas) {
                window._sampleCanvas = document.createElement('canvas');
                window._sampleCanvas.width = 64;
                window._sampleCanvas.height = 36;
                window._sampleCtx = window._sampleCanvas.getContext('2d', { willReadFrequently: true });
            }
            const sampleCtx = window._sampleCtx;
            const sampleCanvas = window._sampleCanvas;
            try {
                sampleCtx.drawImage(video, 0, 0, 64, 36);
                const data = sampleCtx.getImageData(0, 0, 64, 36).data;
                let r = 0, g = 0, b = 0, count = 0;
                for (let i = 0; i < data.length; i += 4) {
                    r += data[i];
                    g += data[i+1];
                    b += data[i+2];
                    count++;
                }
                r = Math.round(r / count);
                g = Math.round(g / count);
                b = Math.round(b / count);
                const newColor = { r, g, b };
                const diff = Math.abs(glowTargetColor.r - r) + Math.abs(glowTargetColor.g - g) + Math.abs(glowTargetColor.b - b);
                if (diff > 30) {
                    glowStartColor = { ...glowCurrentColor };
                    glowTargetColor = { ...newColor };
                    glowProgress = 0;
                    glowStartTime = performance.now();
                    if (!glowAnimationId) {
                        updateEdgeGlow();
                    }
                } else if (diff > 3) {
                    glowTargetColor = { ...newColor };
                }
                if (settings.edgeGlow) updateEdgeGlow();
            } catch (_) {}
        }, 2000);
    }

    function stopColorSampling() {
        if (sampleTimer) { clearInterval(sampleTimer); sampleTimer = null; }
        if (window._sampleCanvas) {
            window._sampleCanvas.remove();
            delete window._sampleCanvas;
            delete window._sampleCtx;
        }
    }

    function updateEdgeGlow() {
        const container = document.querySelector('.bpx-player-container');
        if (!container) return;
        if (!settings.edgeGlow) { clearEdgeGlow(); return; }

        if (glowProgress < 1) {
            if (glowAnimationId) cancelAnimationFrame(glowAnimationId);
            const startTime = glowStartTime || performance.now();
            const startColor = { ...glowStartColor };
            const endColor = { ...glowTargetColor };
            const duration = GLOW_LERP_DURATION;

            function animateGlow(time) {
                const elapsed = time - startTime;
                const t = Math.min(elapsed / duration, 1);
                const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
                const r = Math.round(startColor.r + (endColor.r - startColor.r) * ease);
                const g = Math.round(startColor.g + (endColor.g - startColor.g) * ease);
                const b = Math.round(startColor.b + (endColor.b - startColor.b) * ease);
                glowCurrentColor = { r, g, b };
                const spread = settings.glowWidth || 10;
                container.style.boxShadow = `0 0 ${spread}px ${spread/2}px rgba(${r},${g},${b},0.7)`;
                if (t < 1) {
                    glowAnimationId = requestAnimationFrame(animateGlow);
                } else {
                    glowCurrentColor = { ...endColor };
                    glowProgress = 1;
                    glowAnimationId = null;
                    container.style.boxShadow = `0 0 ${spread}px ${spread/2}px rgba(${endColor.r},${endColor.g},${endColor.b},0.7)`;
                }
            }
            glowAnimationId = requestAnimationFrame(animateGlow);
        } else {
            const { r, g, b } = glowCurrentColor;
            const spread = settings.glowWidth || 10;
            container.style.boxShadow = `0 0 ${spread}px ${spread/2}px rgba(${r},${g},${b},0.7)`;
            if (glowAnimationId) {
                cancelAnimationFrame(glowAnimationId);
                glowAnimationId = null;
            }
        }
        container.style.overflow = 'visible';
    }

    function clearEdgeGlow() {
        const container = document.querySelector('.bpx-player-container');
        if (container) container.style.boxShadow = 'none';
        if (glowAnimationId) { cancelAnimationFrame(glowAnimationId); glowAnimationId = null; }
        glowProgress = 1;
        glowCurrentColor = { ...glowTargetColor };
    }

    function startAmbientLight(retryCount = 0) {
        if (ambientRunning) {
            stopAmbientLight();
        }
        const container = document.querySelector('.bpx-player-primary-area');
        if (!container) {
            if (retryCount < 20) {
                setTimeout(() => startAmbientLight(retryCount + 1), 500);
            }
            return;
        }

        if (!ambientLayer) {
            ambientLayer = document.createElement('div');
            ambientLayer.id = 'bbvs-ambient-layer';
            ambientLayer.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100vw;
                height: 100vh;
                z-index: 0;
                pointer-events: none;
                overflow: hidden;
            `;
            document.body.prepend(ambientLayer);
        }

        if (!ambientCanvasGlobal) {
            ambientCanvasGlobal = document.createElement('canvas');
            ambientCanvasGlobal.id = 'bbvs-ambient-canvas';
            ambientCanvasGlobal.style.cssText = `
                position: absolute;
                left: 50%;
                top: 50%;
                transform-origin: center center;
                width: 100%;
                height: 100%;
                pointer-events: none;
                transition: filter 0.3s, opacity 0.3s;
            `;
            ambientLayer.appendChild(ambientCanvasGlobal);
            ambientCtxGlobal = ambientCanvasGlobal.getContext('2d', { willReadFrequently: true });
        }

        resizeCanvasToViewport();
        applyAmbientStyle();

        ambientRunning = true;

        function drawFrame() {
            if (!ambientRunning) return;
            const video = document.querySelector('video');
            if (video && video.readyState >= 2 && ambientCtxGlobal && ambientCanvasGlobal) {
                const cw = ambientCanvasGlobal.width, ch = ambientCanvasGlobal.height;
                const vw = video.videoWidth, vh = video.videoHeight;
                if (vw > 0 && vh > 0) {
                    const aspect = vw / vh;
                    let drawW, drawH, offsetX = 0, offsetY = 0;
                    if (cw / ch > aspect) {
                        drawH = ch;
                        drawW = ch * aspect;
                        offsetX = (cw - drawW) / 2;
                    } else {
                        drawW = cw;
                        drawH = cw / aspect;
                        offsetY = (ch - drawH) / 2;
                    }
                    ambientCtxGlobal.drawImage(video, offsetX, offsetY, drawW, drawH);
                }
            }
            ambientRAFIdGlobal = requestAnimationFrame(drawFrame);
        }

        drawFrame();

        if (resizeObserver) resizeObserver.disconnect();
        resizeObserver = new ResizeObserver(() => resizeCanvasToViewport());
        resizeObserver.observe(document.documentElement);

        setupThemeObserver();

        log('Ambient Mode 已启动，分辨率: ' + settings.ambientQuality + ' (' + ambientCanvasGlobal.width + 'x' + ambientCanvasGlobal.height + ')', 'success');
    }

    function stopAmbientLight() {
        ambientRunning = false;
        if (ambientRAFIdGlobal) { cancelAnimationFrame(ambientRAFIdGlobal); ambientRAFIdGlobal = null; }
        if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
        if (themeObserver) { themeObserver.disconnect(); themeObserver = null; }
        if (ambientLayer) { ambientLayer.remove(); ambientLayer = null; }
        if (ambientCanvasGlobal) { ambientCanvasGlobal = null; ambientCtxGlobal = null; }
        log('Ambient Mode 已停止', 'info');
    }

    // ========== 黑边模糊填充（比例检测，阈值 0.03） ==========
    let lastBlackBarDrawTime = 0;
    const BLACKBAR_FPS_INTERVAL = 33;

    function startBlackBarFill() {
        if (blackBarRunning || !settings.blackBarFill) return;
        const videoWrap = document.querySelector('.bpx-player-video-wrap');
        if (!videoWrap) {
            setTimeout(startBlackBarFill, 500);
            return;
        }
        if (!blackBarLayer) {
            blackBarLayer = document.createElement('div');
            blackBarLayer.id = 'bbvs-blackbar-bg';
            blackBarLayer.style.cssText = `
                position: absolute;
                inset: 0;
                z-index: 0;
                pointer-events: none;
                overflow: hidden;
                filter: blur(50px) brightness(0.85);
                transform: scale(1.2);
                transform-origin: center center;
                opacity: 0;
            `;
            blackBarCanvas = document.createElement('canvas');
            blackBarCanvas.style.cssText = 'width:100%;height:100%;display:block;';
            blackBarLayer.appendChild(blackBarCanvas);
            videoWrap.insertBefore(blackBarLayer, videoWrap.firstChild);
            blackBarCtx = blackBarCanvas.getContext('2d');
        }
        blackBarRunning = true;
        function update() {
            if (!blackBarRunning) return;
            const video = document.querySelector('video');
            if (!video || video.videoWidth === 0 || !blackBarCtx) {
                if (blackBarLayer) blackBarLayer.style.opacity = '0';
                blackBarRAFId = requestAnimationFrame(update);
                return;
            }
            const rect = videoWrap.getBoundingClientRect();
            const containerRatio = rect.width / rect.height;
            const videoRatio = video.videoWidth / video.videoHeight;
            const isSameRatio = Math.abs(videoRatio - containerRatio) < 0.03;
            if (isSameRatio) {
                if (blackBarLayer) blackBarLayer.style.opacity = '0';
                blackBarRAFId = requestAnimationFrame(update);
                return;
            }
            const now = performance.now();
            if (now - lastBlackBarDrawTime < BLACKBAR_FPS_INTERVAL) {
                blackBarRAFId = requestAnimationFrame(update);
                return;
            }
            lastBlackBarDrawTime = now;

            if (blackBarLayer) blackBarLayer.style.opacity = '1';
            const cw = rect.width, ch = rect.height;
            if (blackBarCanvas.width !== cw || blackBarCanvas.height !== ch) {
                blackBarCanvas.width = cw;
                blackBarCanvas.height = ch;
            }
            blackBarCtx.drawImage(video, 0, 0, cw, ch);
            blackBarRAFId = requestAnimationFrame(update);
        }
        update();
        log('黑边模糊填充已启动', 'success');
    }

    function stopBlackBarFill() {
        blackBarRunning = false;
        if (blackBarRAFId) { cancelAnimationFrame(blackBarRAFId); blackBarRAFId = null; }
        if (blackBarLayer) {
            blackBarLayer.remove();
            blackBarLayer = null;
        }
        blackBarCanvas = null;
        blackBarCtx = null;
        log('黑边模糊填充已停止', 'info');
    }

    function applyBlurEffect() {
        const panels = document.querySelectorAll('.bbvs-quality-panel, .bbvs-notification, #bbvs-debug-overlay');
        const blurStyle = settings.blurEffect ? 'blur(8px)' : 'none';
        const bgColor = settings.blurEffect ? 'rgba(20,20,20,0.65)' : 'rgba(0,0,0,0.85)';
        panels.forEach(el => {
            if (el) {
                el.style.setProperty('backdrop-filter', blurStyle, 'important');
                el.style.setProperty('-webkit-backdrop-filter', blurStyle, 'important');
                el.style.setProperty('background', bgColor, 'important');
            }
        });
    }

    // ========== 全局样式 ==========
    const styleEl = document.createElement('style');
    styleEl.textContent = `
        .bpx-player-ctrl-quality-menu-wrap { display: none !important; }
        .bpx-player-ctrl-quality-bubble { display: none !important; }
        .bpx-player-toast-wrap, .bpx-player-toast-auto, .bpx-player-toast-row, .bpx-player-toast-item, .bpx-player-toast-text { display: none !important; }
        .bpx-player-context-area, .bpx-player-tooltip-area, .bpx-player-dialog-wrap { display: none !important; }
        .bpx-player-info-panel, .bpx-player-info-title, .bpx-player-info-log, .bpx-player-tooltip-item { display: none !important; }
        .bpx-player-video-area,
        .bpx-player-container,
        .bpx-player-video-wrap,
        .bpx-player-primary-area,
        #bbvs-ambient-bg,
        video {
            border-radius: 0 !important;
        }
        .bpx-player-container {
            overflow: visible !important;
            transition: none !important;
        }
        video {
            background: transparent !important;
        }
        body, #app, html {
            background: transparent !important;
        }
        #bbvs-ambient-layer {
            z-index: 0 !important;
        }
        .bpx-player-video-wrap video {
            position: relative !important;
            z-index: 2 !important;
        }
        .bbvs-quality-list::-webkit-scrollbar,
        #bbvs-debug-overlay::-webkit-scrollbar,
        .bbvs-quality-panel::-webkit-scrollbar {
            width: 6px;
            background: transparent;
        }
        .bbvs-quality-list::-webkit-scrollbar-track,
        #bbvs-debug-overlay::-webkit-scrollbar-track,
        .bbvs-quality-panel::-webkit-scrollbar-track {
            background: rgba(255,255,255,0.05);
            border-radius: 3px;
        }
        .bbvs-quality-list::-webkit-scrollbar-thumb,
        #bbvs-debug-overlay::-webkit-scrollbar-thumb,
        .bbvs-quality-panel::-webkit-scrollbar-thumb {
            background: rgba(255,255,255,0.2);
            border-radius: 3px;
        }
        .bbvs-quality-list::-webkit-scrollbar-thumb:hover,
        #bbvs-debug-overlay::-webkit-scrollbar-thumb:hover,
        .bbvs-quality-panel::-webkit-scrollbar-thumb:hover {
            background: rgba(255,255,255,0.3);
        }
        .bbvs-quality-panel {
            position: absolute !important;
            z-index: 99999 !important;
            border-radius: 12px !important;
            padding: 12px 16px !important;
            min-width: 220px !important;
            max-width: 300px !important;
            max-height: 60vh !important;
            overflow-y: auto !important;
            color: #fff !important;
            font-size: 13px !important;
            box-shadow: 0 4px 20px rgba(0,0,0,0.6) !important;
            border: 1px solid rgba(255,255,255,0.1) !important;
            opacity: 1 !important;
            pointer-events: auto !important;
            transition: opacity 0.1s ease !important;
        }
        .bbvs-quality-panel .bbvs-quality-item {
            cursor: pointer !important;
            padding: 8px 12px !important;
            margin: 4px 0 !important;
            border-radius: 6px !important;
            transition: background 0.2s !important;
        }
        .bbvs-quality-panel .bbvs-quality-item:hover {
            background: rgba(255,255,255,0.08) !important;
        }
        .bbvs-quality-panel .bbvs-quality-item.active {
            background: rgba(0,174,236,0.25) !important;
            border-left: 3px solid #00aece !important;
        }
        .bbvs-quality-panel .bbvs-quality-name {
            font-weight: 500 !important;
            font-size: 14px !important;
        }
        .bbvs-quality-panel .bbvs-quality-detail {
            font-size: 12px !important;
            color: #aaa !important;
            margin-top: 2px !important;
        }
        .bbvs-step-footer button {
            padding: 6px 14px;
            border-radius: 6px;
            border: none;
            color: #fff;
            cursor: pointer;
            font-size: 13px;
            background: rgba(255,255,255,0.12);
            transition: background 0.2s;
        }
        .bbvs-step-footer button:hover {
            background: rgba(255,255,255,0.25);
        }
        .bbvs-step-footer button:disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }
        .bbvs-step-footer .bbvs-step-next {
            background: rgba(0,174,236,0.7);
        }
        .bbvs-step-footer .bbvs-step-next:hover {
            background: #00aece;
        }
        .bbvs-step-footer .bbvs-step-download {
            background: rgba(76,175,80,0.7);
        }
        .bbvs-step-footer .bbvs-step-download:hover {
            background: #4caf50;
        }
    `;

    if (document.head) {
        document.head.appendChild(styleEl);
    } else {
        document.addEventListener('DOMContentLoaded', function() {
            document.head.appendChild(styleEl);
        });
    }

    function setupGlobalHandler() {
        document.addEventListener('click', function(e) {
            const btn = e.target.closest('.bpx-player-ctrl-quality');
            if (!btn) return;
            log('点击清晰度按钮', 'info');
            addDebugLog('点击清晰度按钮');
            e.preventDefault();
            if (currentPanel) {
                if (globalClosePanel) globalClosePanel();
                return;
            }
            qualityButton = btn;
            showCustomPanel(btn);
        }, true);
    }

    // playurl 拦截器（XHR + fetch）
    let playurlInterceptorInstalled = false;

    function setupPlayurlInterceptor() {
        if (playurlInterceptorInstalled) return;
        playurlInterceptorInstalled = true;

        const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function(method, url, ...args) {
            if (typeof url === 'string' && url.includes('/x/player/') && url.includes('playurl')) {
                this._isPlayurl = true;
                const bvidMatch = url.match(/bvid=([^&]+)/);
                const avidMatch = url.match(/avid=(\d+)/);
                if (bvidMatch) this._bvid = bvidMatch[1];
                if (avidMatch) this._avid = avidMatch[1];
                console.log('[BetterBilibiliPlayer] XHR playurl 请求:', url);
            }
            return originalOpen.call(this, method, url, ...args);
        };

        XMLHttpRequest.prototype.send = function(body) {
            if (this._isPlayurl) {
                this.addEventListener('load', function() {
                    if (this.status >= 200 && this.status < 300) {
                        try {
                            const data = JSON.parse(this.responseText);
                            if (data && data.code === 0 && data.data && data.data.dash && data.data.dash.video && data.data.dash.video.length > 0) {
                                const bvid = this._bvid;
                                if (bvid) {
                                    playurlCache.set(bvid, data.data);
                                    log('成功缓存 playurl 数据，bvid: ' + bvid, 'success');
                                    addDebugLog('缓存 playurl 响应，bvid: ' + bvid, true);
                                    onPlayurlDataReady(data.data);
                                }
                            }
                        } catch (e) {
                            console.warn('[BetterBilibiliPlayer] 解析 playurl XHR 响应失败:', e);
                        }
                    }
                });
            }
            return originalSend.call(this, body);
        };

        const originalFetch = w.fetch;
        w.fetch = function(input, init) {
            let url = '';
            if (typeof input === 'string') {
                url = input;
            } else if (input && input.url) {
                url = input.url;
            }
            if (url && url.includes('/x/player/') && url.includes('playurl')) {
                console.log('[BetterBilibiliPlayer] fetch playurl 请求:', url);
                return originalFetch.call(this, input, init).then(response => {
                    const clonedResponse = response.clone();
                    clonedResponse.json().then(data => {
                        if (data && data.code === 0 && data.data && data.data.dash && data.data.dash.video && data.data.dash.video.length > 0) {
                            const bvidMatch = url.match(/bvid=([^&]+)/);
                            const bvid = bvidMatch ? bvidMatch[1] : null;
                            if (bvid) {
                                playurlCache.set(bvid, data.data);
                                log('成功缓存 playurl 数据，bvid: ' + bvid, 'success');
                                addDebugLog('缓存 playurl 响应，bvid: ' + bvid, true);
                                onPlayurlDataReady(data.data);
                            }
                        }
                    }).catch(e => console.warn('[BetterBilibiliPlayer] 解析 playurl fetch 响应失败:', e));
                    return response;
                });
            }
            return originalFetch.call(this, input, init);
        };
        w.fetch._original = originalFetch;

        log('playurl 拦截器已安装（XHR + fetch），匹配路径: /x/player/*/playurl', 'info');
    }

    function onPlayurlDataReady(data) {
        if (currentPanel && currentPanel._listContainer) {
            renderListForStep(currentPanel._listContainer, downloadStep, currentPanel);
            if (currentMode === 'download') {
                selectedVideoQn = null;
                selectedAudioId = null;
                downloadStep = 1;
                updatePanelForStep(currentPanel);
            }
        }
        if (settings.debugMode) {
            updateDebugInfo();
        }
        if (!autoSwitchDone) {
            const formats = getFilteredQualityList(getActualCodecFromPlayer());
            if (formats.length > 0) {
                applyQualityPreference();
            }
        }
    }

    function fullReset() {
        log('检测到视频切换，执行完全重置（保留playurl缓存）...', 'start');
        if (currentPanel && globalClosePanel) {
            globalClosePanel();
            currentPanel = null;
            globalClosePanel = null;
        }
        document.querySelectorAll('.bbvs-quality-panel').forEach(el => el.remove());
        stopAmbientLight();
        const ambientLayerEl = document.getElementById('bbvs-ambient-layer');
        if (ambientLayerEl) ambientLayerEl.remove();
        stopBlackBarFill();
        const blackbarEl = document.getElementById('bbvs-blackbar-bg');
        if (blackbarEl) blackbarEl.remove();
        destroyDebugOverlay();

        currentQuality = null;
        selectedVideoQn = null;
        selectedAudioId = null;
        autoSwitchDone = false;
        downloadStep = 1;
        lastLoadedTime = 0;
        lastLoadedMB = 0;
        currentSpeedKB = 0;
        currentPageBvid = getBvid();
        if (qualityRetryTimer) { clearTimeout(qualityRetryTimer); qualityRetryTimer = null; }
        log('完全重置完成，缓存中有 ' + playurlCache.size + ' 个视频数据', 'done');
        setTimeout(() => init(), 100);
    }

    function observeRouteChanges() {
        if (window._bbvs_router_observed) return;
        window._bbvs_router_observed = true;

        let lastUrl = location.href;
        let lastBvid = getBvid();

        const urlObserver = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                if (location.pathname.startsWith('/video/')) {
                    const newBvid = getBvid();
                    if (newBvid !== lastBvid) {
                        lastBvid = newBvid;
                        log('检测到视频切换（URL变化），执行完全重置并重新初始化', 'info');
                        addDebugLog('SPA 视频切换: ' + newBvid, true);
                        fullReset();
                    }
                }
            }
        });
        urlObserver.observe(document.head, { childList: true, subtree: true });

        const video = document.querySelector('video');
        if (video) {
            const srcObserver = new MutationObserver(() => {
                const currentSrc = video.src;
                if (currentSrc && currentSrc !== lastVideoSrc) {
                    lastVideoSrc = currentSrc;
                    const newBvid = getBvid();
                    if (newBvid !== lastBvid) {
                        lastBvid = newBvid;
                        log('检测到视频切换（video.src变化），执行完全重置并重新初始化', 'info');
                        addDebugLog('SPA 视频切换 (src): ' + newBvid, true);
                        fullReset();
                    }
                }
            });
            srcObserver.observe(video, { attributes: true, attributeFilter: ['src'] });
            window._bbvs_src_observer = srcObserver;
        }

        log('SPA 路由监听已启动（URL + video.src + playurl 拦截）', 'info');
    }

    async function waitForPlayerContainer() {
        log('等待播放器容器就绪...', 'info');
        const ok = await waitFor(() => {
            const container = getPlayerContainer();
            return container && container !== document.body;
        }, 5000, 300);
        if (ok) {
            log('播放器容器已就绪', 'success');
            return true;
        } else {
            log('播放器容器未找到，使用 document.body', 'warn');
            return false;
        }
    }

    async function init() {
        if (initInProgress) {
            log('初始化正在进行中，跳过重复调用', 'warn');
            return;
        }
        initInProgress = true;

        log('开始初始化流程...', 'start');

        if (document.readyState === 'loading') {
            await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
        }
        domReady = true;

        const targetBvid = getBvid();
        currentQuality = null;
        selectedVideoQn = null;
        selectedAudioId = null;
        autoSwitchDone = false;
        currentPageBvid = targetBvid;
        lastLoadedTime = 0;
        lastLoadedMB = 0;
        currentSpeedKB = 0;

        const video = document.querySelector('video');
        if (video) lastVideoSrc = video.src || '';

        let dataAvailable = false;
        if (playurlCache.has(targetBvid)) {
            log('缓存中存在当前视频数据，直接使用', 'info');
            dataAvailable = true;
            const cachedData = playurlCache.get(targetBvid);
            if (cachedData) onPlayurlDataReady(cachedData);
        } else {
            log('等待视频数据（__playinfo__ 或拦截器）...', 'info');
            const startTime = Date.now();
            while (Date.now() - startTime < 8000) {
                const info = getPlayInfo();
                if (info && info.dash && info.dash.video && info.dash.video.length > 0) {
                    log('__playinfo__ 已就绪', 'success');
                    dataAvailable = true;
                    break;
                }
                if (playurlCache.has(targetBvid)) {
                    log('拦截器已缓存数据', 'success');
                    dataAvailable = true;
                    break;
                }
                await new Promise(r => setTimeout(r, 300));
            }
            if (!dataAvailable) {
                log('等待数据超时，继续初始化（可能后续拦截器会补充）', 'warn');
            }
        }

        await waitForPlayerContainer();

        if (!window._bbvs_handler_registered) {
            setupGlobalHandler();
            window._bbvs_handler_registered = true;
        }

        if (!playurlInterceptorInstalled) {
            setupPlayurlInterceptor();
        }

        applyBlurEffect();
        startColorSampling();

        if (settings.ambientEnabled) {
            log('Ambient 已启用，正在启动...', 'info');
            stopAmbientLight();
            setTimeout(() => startAmbientLight(), 200);
        } else {
            stopAmbientLight();
            log('Ambient 已禁用', 'info');
        }

        if (settings.edgeGlow) {
            clearEdgeGlow();
            setTimeout(() => updateEdgeGlow(), 100);
        }

        if (settings.blackBarFill) {
            log('黑边模糊填充已启用，等待播放器就绪...', 'info');
            setTimeout(startBlackBarFill, 1000);
        }

        await waitFor(() => getCurrentQualityFromPlayer() !== null, 4000, 300);
        const qn = getCurrentQualityFromPlayer();
        if (qn !== null && qn !== undefined) {
            currentQuality = qn;
            log('当前画质: ' + qn, 'info');
        } else {
            log('未能获取当前画质', 'warn');
        }

        if (settings.debugMode) {
            log('调试模式已启用，创建调试面板', 'info');
            setTimeout(createDebugOverlay, 2000);
        }

        setTimeout(() => {
            applyQualityPreference();
        }, 1000);

        log('初始化完成 ✅', 'done');
        initInProgress = false;

        if (!window._bbvs_router_observed) {
            observeRouteChanges();
        }
    }

    // ========== 提前安装拦截器 ==========
    setupPlayurlInterceptor();

    // ========== 启动 ==========
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => init());
    } else {
        init();
    }

})();