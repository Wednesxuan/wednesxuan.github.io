// ==UserScript==
// @name         BetterBilibiliPlayer
// @namespace    https://www.bilibili.com/
// @version      1.0.3.31-dev
// @description  美化B站播放器，修复下载（带进度条 + GM_download，含JSON），非16:9黑边模糊填充，环境光等
// @author       none
// @match        *://*.bilibili.com/video/*
// @match        *://bilibili.com/video/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    if (!location.pathname.startsWith('/video/')) return;

    // ============================================================
    // 彩色日志
    // ============================================================
    function log(m, t) {
        const c = { info: '#00aece', success: '#52c41a', warn: '#faad14', error: '#f5222d', start: '#8b5cf6', done: '#06b6d4' };
        const bc = c[t] || c.info;
        const badge = t === 'start' ? '启动' : t === 'done' ? '完成' : t === 'success' ? '成功' : t === 'warn' ? '⚠️' : t === 'error' ? '❌' : '信息';
        console.log(`%c[BetterBilibiliPlayer]%c ${badge} %c${m}`, `color:#fff;background:${bc};padding:2px 6px;border-radius:3px 0 0 3px;font-weight:bold;`, `color:#fff;background:${bc};padding:2px 4px;border-radius:0 3px 3px 0;font-weight:bold;opacity:.8;`, `color:#e5e7eb;font-weight:500;`);
    }

    // ============================================================
    // 1. 设置管理
    // ============================================================
    const SETTINGS_KEY = 'bbvs_settings';
    const DEFAULT_SETTINGS = {
        codecPreference: 'AVC',
        blurEffect: true,
        debugMode: false,
        qualityPreference: '1080P',
        audioPreference: '高',
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

    // ============================================================
    // 2. 全局变量
    // ============================================================
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
    let lastLoadedTime = 0;
    let lastLoadedMB = 0;
    let currentSpeedKB = 0;
    let debugLogs = [];
    let debugLogContainer = null;
    let autoSwitchDone = false;
    let currentPageBvid = getBvid();

    let nw, ni, nc, ncb, nti;

    // 黑边填充相关变量
    let blackBarRunning = false;
    let blackBarLayer = null;
    let blackBarCanvas = null;
    let blackBarCtx = null;
    let blackBarRAFId = null;

    // ============================================================
    // 3. 辅助函数
    // ============================================================
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
        return w.__playinfo__?.data || null;
    }

    function getPlayer() {
        const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        return w.player || null;
    }

    function getCurrentQualityFromPlayer() {
        const player = getPlayer();
        if (player?.getQuality) {
            const q = player.getQuality();
            if (q?.nowQ !== undefined && !isNaN(q.nowQ)) return q.nowQ;
        }
        const video = document.querySelector('video');
        if (video?.src) {
            const info = getPlayInfo();
            if (info?.dash?.video) {
                const srcBase = video.src.split('?')[0];
                for (let item of info.dash.video) {
                    if (item.baseUrl?.includes(srcBase)) return item.id;
                }
            }
        }
        return null;
    }

    function getQualityDescription(qn) {
        const info = getPlayInfo();
        if (!info) return '未知';
        const idx = info.accept_quality.indexOf(qn);
        return idx !== -1 ? info.accept_description[idx] : '未知';
    }

    function getVideoUrl(qn) {
        const info = getPlayInfo();
        if (!info?.dash?.video) return null;
        const pref = settings.codecPreference;
        const codecMap = {
            'AV1': 'av01',
            'HEVC': ['h265', 'hevc', 'hvc1', 'hev1'],
            'AVC': ['avc', 'h264']
        };
        let matched = null;
        if (pref !== '默认' && codecMap[pref]) {
            const targets = Array.isArray(codecMap[pref]) ? codecMap[pref] : [codecMap[pref]];
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
        const info = getPlayInfo();
        if (!info?.dash?.audio) return null;
        const audio = info.dash.audio.find(a => a.id === audioId);
        return audio?.baseUrl || null;
    }

    function getVideoInfo(qn, src) {
        const info = getPlayInfo();
        if (!info?.dash?.video) return null;
        const video = document.querySelector('video');
        if (!src && video) {
            src = video.src;
        }
        if (src && !src.startsWith('blob:')) {
            const srcBase = src.split('?')[0];
            for (let item of info.dash.video) {
                if (item.baseUrl && item.baseUrl.split('?')[0] === srcBase) {
                    return item;
                }
            }
        }
        if (qn !== undefined && qn !== null) {
            const pref = settings.codecPreference;
            const codecMap = {
                'AV1': 'av01',
                'HEVC': ['h265', 'hevc', 'hvc1', 'hev1'],
                'AVC': ['avc', 'h264']
            };
            let targets = [];
            if (pref !== '默认' && codecMap[pref]) {
                targets = Array.isArray(codecMap[pref]) ? codecMap[pref] : [codecMap[pref]];
            }
            if (targets.length > 0) {
                for (let item of info.dash.video) {
                    if (item.id === qn && item.codecs) {
                        const c = item.codecs.toLowerCase();
                        for (let t of targets) {
                            if (c.includes(t)) {
                                return item;
                            }
                        }
                    }
                }
            }
            const matched = info.dash.video.find(v => v.id === qn);
            if (matched) return matched;
        }
        return null;
    }

    function getAudioList() {
        const info = getPlayInfo();
        if (!info?.dash?.audio) return [];
        const video = document.querySelector('video');
        let duration = info.duration || 0;
        if (duration === 0 && video) {
            duration = video.duration || 0;
        }
        return info.dash.audio.map(a => {
            let sizeDisplay = '';
            const bandwidth = a.bandwidth || 0;
            if (bandwidth > 0 && duration > 0) {
                const estimatedBytes = duration * bandwidth / 8;
                if (estimatedBytes > 0) {
                    const mb = estimatedBytes / (1024 * 1024);
                    sizeDisplay = mb >= 1 ? '~' + mb.toFixed(1) + 'MB' : '~' + (estimatedBytes / 1024).toFixed(1) + 'KB';
                }
            }
            return {
                id: a.id,
                description: a.id.toString(),
                bandwidth: bandwidth,
                bitrateText: bandwidth ? Math.round(bandwidth / 1000) + 'kbps' : '',
                codec: getCodecName(a.codecs),
                sizeDisplay: sizeDisplay || '--'
            };
        }).sort((a, b) => b.id - a.id);
    }

    function getAudioInfo(audioId) {
        const info = getPlayInfo();
        if (!info?.dash?.audio) return null;
        return info.dash.audio.find(a => a.id === audioId) || null;
    }

    function getBvid() {
        const match = location.pathname.match(/\/video\/([a-zA-Z0-9]+)/);
        return match ? match[1] : '?';
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

    function detectAvailableCodecs() {
        const info = getPlayInfo();
        const codecs = new Set();
        if (info?.dash?.video) {
            info.dash.video.forEach(v => {
                if (v.codecs) {
                    const c = v.codecs.toLowerCase();
                    if (c.includes('av01')) codecs.add('AV1');
                    else if (c.includes('h265') || c.includes('hevc') || c.includes('hvc1') || c.includes('hev1')) codecs.add('HEVC');
                    else if (c.includes('avc') || c.includes('h264')) codecs.add('AVC');
                }
            });
        }
        if (codecs.size === 0) {
            codecs.add('AV1');
            codecs.add('HEVC');
            codecs.add('AVC');
        }
        const sorted = ['AV1', 'HEVC', 'AVC'].filter(c => codecs.has(c));
        if (!sorted.includes(settings.codecPreference)) {
            settings.codecPreference = sorted.length ? sorted[0] : 'AVC';
            saveSettings();
        }
        return sorted;
    }

    // ============================================================
    // 4. 画质偏好下拉
    // ============================================================
    function getAvailableQualityLabels() {
        const info = getPlayInfo();
        if (!info?.accept_description) return ['1080P', '自动'];
        const labels = info.accept_description || [];

        const priorityGroups = [
            { keywords: ['杜比视界', 'Dolby'], label: '杜比视界' },
            { keywords: ['HDR', '高动态'], label: 'HDR' },
            { keywords: ['8K', '4320P'], label: '8K' },
            { keywords: ['4K', '2160P'], label: '4K' },
            { keywords: ['1080P 高帧率', '1080P 60', '1080P 120', '1080P 高码率'], label: '1080P 高帧率' },
            { keywords: ['1080P', '1080p', '高清 1080P'], label: '1080P' },
            { keywords: ['720P', '720p', '高清 720P'], label: '720P' },
            { keywords: ['480P', '480p', '清晰 480P'], label: '480P' },
            { keywords: ['360P', '360p', '流畅 360P'], label: '360P' }
        ];

        const groupMap = new Map();
        const unmatched = [];

        labels.forEach(desc => {
            if (!desc) return;
            let matched = false;
            for (let group of priorityGroups) {
                for (let kw of group.keywords) {
                    if (desc.includes(kw)) {
                        if (!groupMap.has(group.label)) groupMap.set(group.label, []);
                        groupMap.get(group.label).push(desc);
                        matched = true;
                        break;
                    }
                }
                if (matched) break;
            }
            if (!matched) unmatched.push(desc);
        });

        const result = [];
        for (let group of priorityGroups) {
            const items = groupMap.get(group.label);
            if (items) {
                items.forEach(item => { if (!result.includes(item)) result.push(item); });
            }
        }
        unmatched.forEach(item => { if (!result.includes(item)) result.push(item); });
        if (!result.includes('自动')) result.push('自动');

        return result;
    }

    // ============================================================
    // 5. 获取画质列表
    // ============================================================
    function getFilteredQualityList() {
        const info = getPlayInfo();
        if (!info?.dash?.video) return [];
        const pref = settings.codecPreference;
        const codecMap = {
            'AV1': 'av01',
            'HEVC': ['h265', 'hevc', 'hvc1', 'hev1'],
            'AVC': ['avc', 'h264']
        };
        let targets = [];
        if (pref !== '默认' && codecMap[pref]) {
            targets = Array.isArray(codecMap[pref]) ? codecMap[pref] : [codecMap[pref]];
        }

        const video = document.querySelector('video');
        let duration = info.duration || 0;
        if (duration === 0 && video) {
            duration = video.duration || 0;
        }

        const allQnMap = new Map();
        info.dash.video.forEach(item => {
            if (!allQnMap.has(item.id)) {
                allQnMap.set(item.id, {
                    width: item.width,
                    height: item.height,
                    frame_rate: item.frame_rate,
                    bandwidth: item.bandwidth || 0,
                    codecs: item.codecs,
                    data_size: item.size || item.data_size || 0,
                    duration: duration
                });
            }
        });

        const filteredQnSet = new Set();
        info.dash.video.forEach(item => {
            if (item.codecs) {
                const c = item.codecs.toLowerCase();
                let matched = false;
                if (targets.length === 0) {
                    matched = true;
                } else {
                    for (let t of targets) {
                        if (c.includes(t)) {
                            matched = true;
                            break;
                        }
                    }
                }
                if (matched) {
                    filteredQnSet.add(item.id);
                }
            }
        });
        if (currentQuality !== null && currentQuality !== undefined) {
            filteredQnSet.add(currentQuality);
        }

        const result = [];
        const sortedQn = Array.from(allQnMap.keys()).sort((a, b) => b - a);
        const currentSrc = video ? video.src : '';

        for (let qn of sortedQn) {
            if (filteredQnSet.has(qn)) {
                const data = allQnMap.get(qn);
                let bandwidth = data.bandwidth;
                let codecs = data.codecs;
                let data_size = data.data_size || 0;
                let dur = data.duration || duration;

                if (qn === currentQuality) {
                    const actualInfo = getVideoInfo(qn, currentSrc);
                    if (actualInfo) {
                        bandwidth = actualInfo.bandwidth || bandwidth;
                        codecs = actualInfo.codecs || codecs;
                        data_size = actualInfo.size || actualInfo.data_size || data_size;
                    }
                }

                let sizeDisplay = '';
                if (data_size > 0) {
                    const mb = data_size / (1024 * 1024);
                    sizeDisplay = mb >= 1 ? mb.toFixed(2) + 'MB' : (data_size / 1024).toFixed(2) + 'KB';
                } else if (bandwidth > 0 && dur > 0) {
                    const estimatedBytes = dur * bandwidth / 8;
                    if (estimatedBytes > 0) {
                        const mb = estimatedBytes / (1024 * 1024);
                        sizeDisplay = mb >= 1 ? '~' + mb.toFixed(1) + 'MB' : '~' + (estimatedBytes / 1024).toFixed(1) + 'KB';
                    }
                }
                if (!sizeDisplay) {
                    sizeDisplay = '--';
                }

                const desc = getQualityDescription(qn);
                const resolution = data.width && data.height ? data.width + 'x' + data.height : '?x?';
                let fpsRaw = data.frame_rate;
                let fpsDisplay = '?';
                let isHighFps = false;
                if (fpsRaw && !isNaN(fpsRaw)) {
                    const fpsNum = parseFloat(fpsRaw);
                    if (fpsNum > 0) {
                        if (Number.isInteger(fpsNum)) {
                            fpsDisplay = fpsNum + '帧';
                        } else {
                            fpsDisplay = fpsNum.toFixed(1) + '帧';
                        }
                        if (fpsNum >= 31) {
                            isHighFps = true;
                        }
                    }
                }
                const bitrate = bandwidth ? Math.round(bandwidth / 1000) + 'kbps' : '?kbps';

                result.push({
                    id: qn,
                    description: desc,
                    resolution: resolution,
                    fpsRaw: fpsRaw,
                    fpsDisplay: fpsDisplay,
                    bitrate: bitrate,
                    isHighFps: isHighFps,
                    codec: getCodecName(codecs),
                    bandwidth: bandwidth,
                    data_size: data_size,
                    sizeDisplay: sizeDisplay
                });
            }
        }
        return result;
    }

    // ============================================================
    // 6. 自动切换画质偏好
    // ============================================================
    function applyQualityPreference() {
        if (autoSwitchDone) return;
        const info = getPlayInfo();
        if (!info) return;

        const pref = settings.qualityPreference;
        if (pref === '自动' || !pref) {
            autoSwitchDone = true;
            return;
        }

        const qualityList = getFilteredQualityList();
        let targetQn = null;
        for (let item of qualityList) {
            if (item.description === pref) {
                targetQn = item.id;
                break;
            }
            if (pref && item.description && item.description.includes(pref)) {
                targetQn = item.id;
                break;
            }
        }

        if (!targetQn && qualityList.length > 0) {
            targetQn = qualityList[0].id;
        }

        if (!targetQn) return;

        const currentQn = getCurrentQualityFromPlayer() || currentQuality;
        if (currentQn === targetQn) {
            autoSwitchDone = true;
            return;
        }

        addDebugLog('自动切换至偏好画质: ' + pref, true);
        switchQuality(targetQn).then(() => {
            autoSwitchDone = true;
            addDebugLog('自动切换完成: ' + pref, true);
        }).catch(err => {
            addDebugLog('自动切换失败: ' + err, true);
        });
    }

    // ============================================================
    // 7. 切换画质
    // ============================================================
    function switchQuality(qn) {
        return new Promise((resolve, reject) => {
            const player = getPlayer();
            if (!player) {
                reject('播放器对象不存在');
                return;
            }
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
                if (menuItem) {
                    menuItem.click();
                    success = true;
                }
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
                    if (settings.debugMode && debugOverlay) {
                        updateDebugInfo();
                    }
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

    // ============================================================
    // 8. 强制切换（编码偏好切换）
    // ============================================================
    function switchToQualityWithPreference(qn) {
        return new Promise((resolve, reject) => {
            const player = getPlayer();
            if (!player) {
                reject('播放器对象不存在');
                return;
            }

            const desc = getQualityDescription(qn);
            showNotification('正在切换编码至 ' + settings.codecPreference + '...', 'loading');
            addDebugLog('尝试播放器接口重载: ' + desc + ' (qn=' + qn + ', 编码偏好: ' + settings.codecPreference + ')');

            let success = false;
            if (typeof player.requestQuality === 'function') {
                player.requestQuality(qn, null);
                success = true;
            } else if (typeof player.setQuality === 'function') {
                player.setQuality(qn);
                success = true;
            } else {
                const menuItem = document.querySelector(`.bpx-player-ctrl-quality-menu li[data-value="${qn}"]`);
                if (menuItem) {
                    menuItem.click();
                    success = true;
                }
            }

            if (!success) {
                addDebugLog('播放器接口失败，回退到强制修改 src');
                directSwitch(qn, resolve, reject);
                return;
            }

            const startTime = Date.now();
            const checkInterval = setInterval(() => {
                const nowQ = getCurrentQualityFromPlayer();
                if (nowQ === qn) {
                    clearInterval(checkInterval);
                    currentQuality = qn;
                    if (settings.debugMode && debugOverlay) {
                        updateDebugInfo();
                    }
                    if (currentPanel && currentMode === 'watch') {
                        renderListForStep(currentPanel._listContainer, 1, currentPanel);
                    }
                    showNotification('已切换至 ' + desc + '（' + settings.codecPreference + '）', 'success');
                    addDebugLog('播放器接口重载完成: ' + desc);
                    resolve();
                    return;
                }
                if (Date.now() - startTime > 20000) {
                    clearInterval(checkInterval);
                    addDebugLog('播放器接口重载超时，回退到强制修改 src');
                    directSwitch(qn, resolve, reject);
                }
            }, 200);

            function directSwitch(qn, resolve, reject) {
                const video = document.querySelector('video');
                if (!video) {
                    reject('未找到视频元素');
                    return;
                }
                const url = getVideoUrl(qn);
                if (!url) {
                    reject('无法获取视频链接');
                    return;
                }
                const t = video.currentTime;
                const wasPlaying = !video.paused;
                const vol = video.volume;

                showNotification('正在强制切换编码...', 'loading');
                addDebugLog('强制切换画质至: ' + desc + ' (qn=' + qn + ', 编码偏好: ' + settings.codecPreference + ')');

                video.pause();
                video.src = '';
                let src = url;
                if (src && !src.includes('#')) src += '#t=' + t;
                video.src = src;
                video.load();

                let resolved = false;
                let loadTimeout = setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        video.removeEventListener('canplay', onCanPlay);
                        video.removeEventListener('error', onError);
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
                        video.play().then(() => { video.muted = false; }).catch(() => { video.muted = false; });
                    } else {
                        video.muted = false;
                    }
                    currentQuality = qn;
                    if (settings.debugMode && debugOverlay) {
                        updateDebugInfo();
                    }
                    if (currentPanel && currentMode === 'watch') {
                        renderListForStep(currentPanel._listContainer, 1, currentPanel);
                    }
                    showNotification('已切换至 ' + desc + '（强制）', 'success');
                    addDebugLog('强制切换完成: ' + desc);
                    resolve();
                }

                function onError(e) {
                    if (resolved) return;
                    resolved = true;
                    clearTimeout(loadTimeout);
                    video.removeEventListener('canplay', onCanPlay);
                    video.removeEventListener('error', onError);
                    reject('加载失败: ' + (video.error ? video.error.message : '未知错误'));
                }
                video.addEventListener('canplay', onCanPlay);
                video.addEventListener('error', onError);
            }
        });
    }

    // ============================================================
    // 9. 通知系统
    // ============================================================
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
                setTimeout(function() {
                    setContent();
                }, sd * 1000 + 50);
            } else {
                setContent();
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
    // 10. 下载功能（视频/音频带进度条，JSON 使用 GM_xmlhttpRequest + GM_download）
    // ============================================================

    // ---- 下载视频/音频 ----
    function downloadFile(url, filename, type) {
        return new Promise((resolve, reject) => {
            let safeFilename = filename || 'bilibili_' + (type === 'video' ? 'video' : 'audio') + '_' + Date.now();
            if (!safeFilename.endsWith('.m4s')) {
                safeFilename += '.m4s';
            }
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
                updateProgress(0, '下载' + (type === 'video' ? '视频' : '音频') + '中 0%');
            });

            if (typeof GM_xmlhttpRequest !== 'undefined') {
                log('使用 GM_xmlhttpRequest 获取数据（携带Cookie + Referer）...', 'info');
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
                                    showNotification(type === 'video' ? '视频下载完成' : '音频下载完成', 'success');
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
                        if (progress.total > 0) {
                            const pct = Math.round((progress.loaded / progress.total) * 100);
                            updateProgress(pct, '下载' + (type === 'video' ? '视频' : '音频') + '中 ' + pct + '%');
                        }
                    },
                    onerror: function(err) {
                        log('GM_xmlhttpRequest 失败，回退到 GM_download 直接下载', 'warn');
                        if (typeof GM_download !== 'undefined') {
                            GM_download({
                                url: url,
                                name: safeFilename,
                                onload: function() {
                                    log('回退下载成功: ' + safeFilename, 'success');
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
                                    reject(e);
                                }
                            });
                        } else {
                            reject(err);
                        }
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

    // ---- 下载 JSON（使用 GM_xmlhttpRequest + GM_download，带进度条） ----
    function downloadVideoInfoJson(bvid) {
        return new Promise((resolve, reject) => {
            const url = 'https://api.bilibili.com/x/web-interface/view?bvid=' + bvid;
            log('开始获取视频信息 JSON: ' + url, 'info');

            const container = getPlayerContainer();
            if (!container) return reject('未找到播放器容器');
            if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

            // 进度条 UI
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
                                if (data.code !== 0) {
                                    throw new Error('API返回错误: ' + (data.message || '未知错误'));
                                }
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
                            } catch (e) {
                                reject(e);
                            }
                        } else {
                            reject(new Error('HTTP ' + resp.status));
                        }
                    },
                    onerror: function(err) {
                        log('GM_xmlhttpRequest 失败: ' + (err?.message || '未知错误'), 'error');
                        reject(err);
                    },
                    ontimeout: function() {
                        reject(new Error('请求超时'));
                    },
                    timeout: 10000
                });
            } else {
                // 无 GM_xmlhttpRequest，直接使用 GM_download 下载原始 URL（可能失败）
                GM_download({
                    url: url,
                    name: bvid + '.json',
                    onload: resolve,
                    onerror: reject
                });
            }
        });
    }

    // ---- 下载视频 + 音频 + JSON ----
    async function downloadVideoAndAudio() {
        if (!selectedVideoQn || !selectedAudioId) {
            showNotification('请先选择视频和音频', 'error');
            return;
        }
        const videoUrl = getVideoUrl(selectedVideoQn);
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

    // ============================================================
    // 11. 调试面板
    // ============================================================
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

    function updateDebugInfo() {
        const info = getPlayInfo();
        const video = document.querySelector('video');
        const bvid = getBvid();
        const qn = getCurrentQualityFromPlayer() || currentQuality;
        if (qn === null || qn === undefined) return;
        const desc = getQualityDescription(qn);
        const videoInfo = getVideoInfo(qn, video ? video.src : null);
        const audioInfo = getAudioInfo(selectedAudioId || info?.dash?.audio?.[0]?.id);

        document.getElementById('bbvs-debug-bvid').textContent = bvid;
        document.getElementById('bbvs-debug-quality').textContent = qn + ' (' + desc + ')';

        let resText = '-';
        if (videoInfo?.width && videoInfo?.height) {
            resText = videoInfo.width + 'x' + videoInfo.height;
        } else if (video) {
            resText = video.videoWidth + 'x' + video.videoHeight;
        }
        document.getElementById('bbvs-debug-resolution').textContent = resText;

        let fpsText = '-';
        if (videoInfo?.frame_rate) {
            const fpsNum = parseFloat(videoInfo.frame_rate);
            if (!isNaN(fpsNum) && fpsNum > 0) {
                if (Number.isInteger(fpsNum)) {
                    fpsText = fpsNum + '帧';
                } else {
                    fpsText = fpsNum.toFixed(1) + '帧';
                }
            }
        } else if (video) {
            try {
                const q = video.getVideoPlaybackQuality();
                if (q && q.totalVideoFrames > 0 && video.currentTime > 0) {
                    const fpsNum = q.totalVideoFrames / video.currentTime;
                    if (Number.isInteger(fpsNum)) {
                        fpsText = Math.round(fpsNum) + '帧';
                    } else {
                        fpsText = fpsNum.toFixed(1) + '帧';
                    }
                }
            } catch (e) {}
        }
        document.getElementById('bbvs-debug-fps').textContent = fpsText;

        let vBitrate = '-';
        if (videoInfo?.bandwidth) {
            vBitrate = (videoInfo.bandwidth / 1000).toFixed(0) + ' kbps';
            const codecName = getCodecName(videoInfo.codecs);
            if (codecName && codecName !== '未知') {
                vBitrate += ' [' + codecName + ']';
            }
        } else if (video && video.src) {
            const bitrate = parseInt(video.src.match(/[?&]br=(\d+)/)?.[1] || '');
            if (bitrate > 0) vBitrate = bitrate + ' kbps';
        }
        document.getElementById('bbvs-debug-video-bitrate').textContent = vBitrate;

        let aBitrate = '-';
        if (audioInfo?.bandwidth) {
            aBitrate = (audioInfo.bandwidth / 1000).toFixed(0) + ' kbps';
        }
        document.getElementById('bbvs-debug-audio-bitrate').textContent = aBitrate;

        let speedText = '-';
        if (video && video.buffered && video.buffered.length > 0) {
            const now = performance.now();
            const buffered = video.buffered;
            const bufferedEnd = buffered.end(buffered.length - 1);
            const duration = video.duration || 1;
            let totalMB = 50;
            if (videoInfo?.size) totalMB = videoInfo.size / (1024 * 1024);
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

    // ============================================================
    // 12. 面板渲染（支持 step）
    // ============================================================
    function renderListForStep(container, step, panel) {
        container.innerHTML = '';
        if (step === 1) {
            const qualityData = getFilteredQualityList();
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
                        renderListForStep(container, step, panel);
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

    // ============================================================
    // 13. 显示自定义面板
    // ============================================================
    function showCustomPanel(btn) {
        const freshInfo = getPlayInfo();
        if (!freshInfo) {
            showNotification('无法获取视频信息', 'error');
            return;
        }

        const newBvid = getBvid();
        if (currentPanel && currentPanel._bvid && currentPanel._bvid !== newBvid) {
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

        const qn = getCurrentQualityFromPlayer();
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
        panel._bvid = newBvid;
        panel.className = 'bbvs-quality-panel';
        panel.style.cssText = `position:absolute; bottom:${bottom}px; left:${left}px; z-index:99999; border-radius:12px; padding:12px 16px; min-width:220px; max-width:300px; max-height:60vh; overflow-y:auto; color:#fff; font-size:13px; box-shadow:0 4px 20px rgba(0,0,0,0.6); border:1px solid rgba(255,255,255,0.1); transition: opacity 0.08s ease; opacity:1;`;

        // --- 标题栏 ---
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
        settingsBtn.onmouseenter = () => settingsBtn.style.opacity = '1';
        settingsBtn.onmouseleave = () => settingsBtn.style.opacity = '0.7';
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

        // --- 列表 ---
        const listContainer = document.createElement('div');
        listContainer.className = 'bbvs-quality-list';
        listContainer.style.cssText = 'max-height:300px; overflow-y:auto; padding-right:4px;';
        panel.appendChild(listContainer);
        panel._listContainer = listContainer;
        panel._titleElement = title;

        // --- 底部按钮 ---
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

        // --- 关闭逻辑 ---
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
                if (!panel.matches(':hover') && !container.matches(':hover')) {
                    closePanelWithFade();
                }
            }, 80);
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

        container.addEventListener('mouseleave', (e) => {
            if (!panel.contains(e.relatedTarget)) {
                startHideTimer();
            }
        });
        container.addEventListener('mouseenter', cancelHideTimer);
        panel.addEventListener('mouseenter', cancelHideTimer);
        panel.addEventListener('mouseleave', (e) => {
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

    // ============================================================
    // 14. 设置面板
    // ============================================================
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

    // ============================================================
    // 15. 渲染设置内容
    // ============================================================
    function renderSettingsContent(container, panel, titleElement) {
        container.innerHTML = '';

        // 编码方式偏好
        const codecSection = document.createElement('div');
        codecSection.style.cssText = 'margin-bottom:12px;';
        const codecLabel = document.createElement('div');
        codecLabel.textContent = '编码方式偏好';
        codecLabel.style.cssText = 'font-size:13px; margin-bottom:6px; color:#ccc;';
        codecLabel.title = '选择优先使用的视频编码格式，切换后会自动重载画质';
        codecSection.appendChild(codecLabel);
        const codecGroup = document.createElement('div');
        codecGroup.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap;';
        const available = detectAvailableCodecs();
        available.forEach(codec => {
            const btn = document.createElement('button');
            btn.textContent = codec;
            const isActive = settings.codecPreference === codec;
            btn.style.cssText = `padding:4px 12px; border-radius:4px; border:none; background:${isActive ? '#00A1D6' : 'rgba(255,255,255,0.1)'}; color:#fff; cursor:pointer; font-size:12px; transition:background 0.2s;`;
            btn.title = `切换编码为 ${codec}，当前播放器将尝试使用该编码`;
            btn.onclick = (e) => {
                e.stopPropagation();
                const oldPref = settings.codecPreference;
                settings.codecPreference = codec;
                saveSettings();
                codecGroup.querySelectorAll('button').forEach(b => {
                    b.style.background = b.textContent === codec ? '#00A1D6' : 'rgba(255,255,255,0.1)';
                });
                const player = getPlayer();
                if (player && typeof player.setCodec === 'function') {
                    const map = { 'AV1': 3, 'HEVC': 1, 'AVC': 2 };
                    player.setCodec(map[codec] || 0);
                }
                if (oldPref !== codec) {
                    const currentQn = getCurrentQualityFromPlayer() || currentQuality;
                    if (currentQn !== null && currentQn !== undefined) {
                        showNotification('正在切换编码偏好...', 'loading');
                        switchToQualityWithPreference(currentQn).then(() => {}).catch(err => {
                            showNotification('切换编码失败: ' + err, 'error');
                        });
                    } else {
                        showNotification('编码偏好已更新', 'success');
                        addDebugLog('编码偏好已更新: ' + codec);
                    }
                } else {
                    showNotification('编码偏好已更新', 'success');
                    addDebugLog('编码偏好已更新: ' + codec);
                }
                if (currentPanel) {
                    requestAnimationFrame(() => {
                        renderListForStep(panel._listContainer, 1, panel);
                    });
                }
            };
            codecGroup.appendChild(btn);
        });
        codecSection.appendChild(codecGroup);
        container.appendChild(codecSection);

        // 视频画质偏好
        const qualitySection = document.createElement('div');
        qualitySection.style.cssText = 'margin-bottom:12px;';
        const qualityLabel = document.createElement('div');
        qualityLabel.textContent = '视频画质偏好';
        qualityLabel.style.cssText = 'font-size:13px; margin-bottom:6px; color:#ccc;';
        qualityLabel.title = '首次加载视频时自动切换到的画质，支持高帧率等选项';
        qualitySection.appendChild(qualityLabel);

        const qualityOptions = getAvailableQualityLabels();
        const qualityDropdown = createCustomDropdown(
            qualityOptions,
            settings.qualityPreference || qualityOptions[0] || '1080P',
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

        // 音频音质偏好
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
            settings.audioPreference || '高',
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

        // 模糊效果
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

        // 调试模式
        const debugItem = document.createElement('div');
        debugItem.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;';
        const debugLabel = document.createElement('span');
        debugLabel.textContent = '调试模式';
        debugLabel.style.color = '#ccc';
        debugLabel.title = '开启后显示播放器调试信息面板，可实时查看画质、码率等';
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

        // ---- 环境相关设置（Ambient + Edge Glow + 黑边填充） ----
        const ambientSection = document.createElement('div');
        ambientSection.style.cssText = 'margin-bottom:12px; border-top:1px solid rgba(255,255,255,0.08); padding-top:10px;';

        const ambientTitle = document.createElement('div');
        ambientTitle.textContent = '背景与环境';
        ambientTitle.style.cssText = 'font-size:13px; margin-bottom:8px; color:#ccc; font-weight:bold;';
        ambientSection.appendChild(ambientTitle);

        // 网页背景模糊（Ambient）
        const ambientRow = document.createElement('div');
        ambientRow.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;';
        const ambientLabel = document.createElement('span');
        ambientLabel.textContent = '网页背景模糊';
        ambientLabel.style.color = '#aaa';
        ambientLabel.style.fontSize = '12px';
        ambientLabel.title = '该设置可能极度影响性能，如果你对你的GPU非常自信可尝试开启。开启后视频内容将放大模糊作为网页背景，提供类似YouTube Ambient Mode的效果。';
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

        // 背景质量选项（低、中、高）
        const qualityRow = document.createElement('div');
        qualityRow.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;';
        const qualityLabel2 = document.createElement('span');
        qualityLabel2.textContent = '背景模糊质量';
        qualityLabel2.style.color = '#aaa';
        qualityLabel2.style.fontSize = '12px';
        qualityLabel2.title = '选择背景模糊的渲染分辨率，低=64x36(极省性能)，中=256x144(平衡)，高=640x360(最佳效果)';
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

        // 播放器边缘发光
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

        // 发光范围滑块
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

        // ---- ★ 黑边模糊填充 ★ ----
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

        // 关于
        const aboutItem = document.createElement('div');
        aboutItem.style.cssText = 'text-align:center; margin-top:12px;';
        const aboutBtn = document.createElement('button');
        aboutBtn.textContent = '关于';
        aboutBtn.style.cssText = 'padding:6px 20px; background:rgba(255,255,255,0.08); color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:13px; transition:background 0.2s;';
        aboutBtn.title = '查看脚本信息与版本';
        aboutBtn.onmouseenter = () => aboutBtn.style.background = 'rgba(255,255,255,0.16)';
        aboutBtn.onmouseleave = () => aboutBtn.style.background = 'rgba(255,255,255,0.08)';
        aboutBtn.onclick = (e) => {
            e.stopPropagation();
            showAboutDialog();
        };
        aboutItem.appendChild(aboutBtn);
        container.appendChild(aboutItem);
    }

    // ============================================================
    // 16. 关于界面
    // ============================================================
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
        version.textContent = '当前版本 v1.0.3.31-dev';
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

    // ============================================================
    // 17. Ambient Mode（网页背景模糊）
    // ============================================================
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
                currentEdgeColor = { r, g, b };
                if (settings.edgeGlow) updateEdgeGlow();
            } catch (_) {}
        }, 200);
    }

    function stopColorSampling() {
        if (sampleTimer) { clearInterval(sampleTimer); sampleTimer = null; }
        if (window._sampleCanvas) {
            window._sampleCanvas.remove();
            delete window._sampleCanvas;
            delete window._sampleCtx;
        }
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
                ambientCtxGlobal.drawImage(video, 0, 0, cw, ch);
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

    // Edge Glow
    function updateEdgeGlow() {
        const container = document.querySelector('.bpx-player-container');
        if (!container) return;
        if (!settings.edgeGlow) { clearEdgeGlow(); return; }
        const { r, g, b } = currentEdgeColor;
        const spread = settings.glowWidth || 10;
        container.style.boxShadow = `0 0 ${spread}px ${spread/2}px rgba(${r},${g},${b},0.7)`;
        container.style.overflow = 'visible';
    }

    function clearEdgeGlow() {
        const container = document.querySelector('.bpx-player-container');
        if (container) container.style.boxShadow = 'none';
    }

    // ============================================================
    // 18. 黑边模糊填充
    // ============================================================
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
                filter: blur(30px);
                transform: scale(1.2);
                transform-origin: center center;
                opacity: 0;
                transition: opacity 0.3s;
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
            const ratio = video.videoWidth / video.videoHeight;
            const is16x9 = Math.abs(ratio - 16/9) < 0.05;
            if (is16x9) {
                if (blackBarLayer) blackBarLayer.style.opacity = '0';
                blackBarRAFId = requestAnimationFrame(update);
                return;
            }
            if (blackBarLayer) blackBarLayer.style.opacity = '1';
            const rect = videoWrap.getBoundingClientRect();
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

    // ============================================================
    // 19. 模糊效果
    // ============================================================
    function applyBlurEffect() {
        const panels = document.querySelectorAll('.bbvs-quality-panel, .bbvs-notification, #bbvs-debug-overlay');
        const blurStyle = settings.blurEffect ? 'blur(8px)' : 'none';
        const bgColor = settings.blurEffect ? 'rgba(20,20,20,0.65)' : 'rgba(0,0,0,0.85)';
        panels.forEach(el => {
            el.style.setProperty('backdrop-filter', blurStyle, 'important');
            el.style.setProperty('-webkit-backdrop-filter', blurStyle, 'important');
            el.style.setProperty('background', bgColor, 'important');
        });
    }

    // ============================================================
    // 20. 全局样式
    // ============================================================
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
            transition: opacity 0.08s ease !important;
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
    document.head.appendChild(styleEl);

    // ============================================================
    // 21. 全局点击代理
    // ============================================================
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

    // ============================================================
    // 22. 初始化与SPA
    // ============================================================
    function waitFor(condition, timeout = 10000, interval = 300) {
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

    async function waitForPlayInfo() {
        log('等待 __playinfo__ 就绪...', 'info');
        const ok = await waitFor(() => {
            const info = getPlayInfo();
            return info && info.dash && info.dash.video && info.dash.video.length > 0;
        }, 10000, 300);
        if (ok) {
            log('__playinfo__ 已就绪', 'success');
            return true;
        } else {
            log('等待 __playinfo__ 超时', 'warn');
            return false;
        }
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

    function observeRouteChanges() {
        if (window._bbvs_router_observed) return;
        window._bbvs_router_observed = true;
        let lastUrl = location.href;
        let lastBvid = getBvid();
        const observer = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                if (location.pathname.startsWith('/video/')) {
                    const newBvid = getBvid();
                    if (newBvid !== lastBvid) {
                        lastBvid = newBvid;
                        log('检测到视频切换，重置状态并刷新面板', 'info');
                        autoSwitchDone = false;
                        if (currentPanel && globalClosePanel) {
                            globalClosePanel();
                        }
                        currentQuality = null;
                        init();
                    }
                }
            }
        });
        observer.observe(document.head, { childList: true, subtree: true });
        log('SPA 路由监听已启动', 'info');
    }

    async function init() {
        log('开始初始化流程...', 'start');

        const infoReady = await waitForPlayInfo();
        if (!infoReady) {
            log('无法获取视频信息，初始化中止', 'error');
            return;
        }
        await waitForPlayerContainer();

        if (!window._bbvs_handler_registered) {
            setupGlobalHandler();
            window._bbvs_handler_registered = true;
        }

        applyBlurEffect();

        startColorSampling();

        if (settings.ambientEnabled) {
            log('Ambient 已启用，正在启动...', 'info');
            stopAmbientLight();
            setTimeout(() => {
                startAmbientLight();
            }, 200);
        } else {
            stopAmbientLight();
            log('Ambient 已禁用', 'info');
        }

        if (settings.edgeGlow) {
            setTimeout(() => updateEdgeGlow(), 500);
        }

        if (settings.blackBarFill) {
            log('黑边模糊填充已启用，等待播放器就绪...', 'info');
            setTimeout(startBlackBarFill, 1000);
        }

        detectAvailableCodecs();
        log('编码偏好: ' + settings.codecPreference, 'info');

        const qn = getCurrentQualityFromPlayer();
        if (qn !== null && qn !== undefined) {
            currentQuality = qn;
            log('当前画质: ' + qn + ' (' + getQualityDescription(qn) + ')', 'info');
        }

        if (settings.debugMode) {
            log('调试模式已启用，创建调试面板', 'info');
            setTimeout(createDebugOverlay, 2000);
        }

        setTimeout(() => {
            log('应用画质偏好...', 'info');
            applyQualityPreference();
        }, 1500);

        log('初始化完成 ✅', 'done');

        if (!window._bbvs_router_observed) {
            observeRouteChanges();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();