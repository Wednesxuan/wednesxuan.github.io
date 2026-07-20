// ==UserScript==
// @name         BetterBilibiliPlayer
// @namespace    https://www.bilibili.com/
// @version      1.0.2.86
// @description  对B站播放页的一些界面的美化
// @author       none
// @match        *://*.bilibili.com/video/*
// @match        *://bilibili.com/video/*
// @grant        unsafeWindow
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
        ambientLight: false,
        bgTint: false,
        edgeGlow: false,
        glowWidth: 10,
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
        if (s.bgTint === undefined) s.bgTint = false;
        if (s.edgeGlow === undefined) s.edgeGlow = false;
        if (s.glowWidth === undefined) s.glowWidth = 10;
        return s;
    }
    function saveSettings() {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
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
    let lastLoadedTime = 0;
    let lastLoadedMB = 0;
    let currentSpeedKB = 0;
    let debugLogs = [];
    let debugLogContainer = null;
    let autoSwitchDone = false;

    let nw, ni, nc, ncb, nti;

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
                        renderListForStep(currentPanel._listContainer, currentPanel);
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
                        renderListForStep(currentPanel._listContainer, currentPanel);
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
                        renderListForStep(currentPanel._listContainer, currentPanel);
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
        ni.style.cssText = 'width:0;overflow:hidden;background:rgba(0,0,0,0.5);backdrop-filter:blur(6px);border-radius:8px;border:1px solid rgba(255,255,255,0.08);box-shadow:0 2px 10px rgba(0,0,0,0.3);box-sizing:border-box;display:flex;align-items:stretch;transition:width 0.4s cubic-bezier(0.25,0.1,0.25,1);';
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
    // 10. 调试面板
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
        const audioInfo = getAudioInfo(info?.dash?.audio?.[0]?.id);

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
    // 11. 面板渲染（仅画质列表）
    // ============================================================
    function renderListForStep(container, panel) {
        container.innerHTML = '';
        const qualityData = getFilteredQualityList();
        qualityData.forEach(item => {
            const div = document.createElement('div');
            div.className = 'bbvs-quality-item';
            div.dataset.qn = item.id;
            const isActive = (item.id === (getCurrentQualityFromPlayer() || currentQuality));
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
                switchQuality(item.id).catch(err => {
                    showNotification('切换失败: ' + err, 'error');
                });
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
        setTimeout(() => {
            // 高亮当前激活项
            const items = container.querySelectorAll('.bbvs-quality-item');
            const qn = getCurrentQualityFromPlayer() || currentQuality;
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

    // ============================================================
    // 12. 显示自定义面板
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
        const blurStyle = settings.blurEffect ? 'blur(8px)' : 'none';
        const bgColor = settings.blurEffect ? 'rgba(20,20,20,0.6)' : 'rgba(0,0,0,0.8)';

        panel.style.cssText = `position:absolute; bottom:${bottom}px; left:${left}px; z-index:99999; background:${bgColor}; backdrop-filter:${blurStyle}; border-radius:12px; padding:12px 16px; min-width:220px; max-width:300px; max-height:60vh; overflow-y:auto; color:#fff; font-size:13px; box-shadow:0 4px 20px rgba(0,0,0,0.6); border:1px solid rgba(255,255,255,0.1); transition: opacity 0.08s ease; opacity:1;`;

        // --- 标题栏 ---
        const header = document.createElement('div');
        header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:6px;';

        const title = document.createElement('span');
        title.className = 'bbvs-panel-title';
        title.textContent = '选择画质';
        title.style.fontWeight = 'bold';
        title.style.fontSize = '14px';
        header.appendChild(title);

        const rightGroup = document.createElement('div');
        rightGroup.style.display = 'flex';
        rightGroup.style.alignItems = 'center';
        rightGroup.style.gap = '6px';

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

        container.appendChild(panel);

        renderListForStep(listContainer, panel);

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
    // 13. 设置面板
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
    }

    function exitSettingsMode(panel) {
        if (!isSettingsMode) return;
        isSettingsMode = false;
        const listContainer = panel._listContainer;
        const titleElement = panel._titleElement;
        if (!listContainer || !titleElement) return;
        titleElement.textContent = '选择画质';
        renderListForStep(listContainer, panel);
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
    // 14. 渲染设置内容
    // ============================================================
    function renderSettingsContent(container, panel, titleElement) {
        container.innerHTML = '';

        // 编码方式偏好
        const codecSection = document.createElement('div');
        codecSection.style.cssText = 'margin-bottom:12px;';
        const codecLabel = document.createElement('div');
        codecLabel.textContent = '编码方式偏好';
        codecLabel.style.cssText = 'font-size:13px; margin-bottom:6px; color:#ccc;';
        codecSection.appendChild(codecLabel);
        const codecGroup = document.createElement('div');
        codecGroup.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap;';
        const available = detectAvailableCodecs();
        available.forEach(codec => {
            const btn = document.createElement('button');
            btn.textContent = codec;
            const isActive = settings.codecPreference === codec;
            btn.style.cssText = `padding:4px 12px; border-radius:4px; border:none; background:${isActive ? '#00A1D6' : 'rgba(255,255,255,0.1)'}; color:#fff; cursor:pointer; font-size:12px; transition:background 0.2s;`;
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
                        renderListForStep(panel._listContainer, panel);
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
        qualitySection.appendChild(qualityDropdown);
        container.appendChild(qualitySection);

        // 音频音质偏好
        const audioSection = document.createElement('div');
        audioSection.style.cssText = 'margin-bottom:12px;';
        const audioLabel = document.createElement('div');
        audioLabel.textContent = '音频音质偏好';
        audioLabel.style.cssText = 'font-size:13px; margin-bottom:6px; color:#ccc;';
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
        audioSection.appendChild(audioDropdown);
        container.appendChild(audioSection);

        // 模糊效果
        const blurItem = document.createElement('div');
        blurItem.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;';
        const blurLabel = document.createElement('span');
        blurLabel.textContent = '模糊效果';
        blurLabel.style.color = '#ccc';
        blurItem.appendChild(blurLabel);
        const blurToggle = document.createElement('button');
        blurToggle.textContent = settings.blurEffect ? '开' : '关';
        blurToggle.style.cssText = `padding:2px 12px; border-radius:4px; border:none; background:${settings.blurEffect ? '#00A1D6' : 'rgba(255,255,255,0.2)'}; color:#fff; cursor:pointer;`;
        blurToggle.onclick = (e) => {
            e.stopPropagation();
            settings.blurEffect = !settings.blurEffect;
            saveSettings();
            blurToggle.textContent = settings.blurEffect ? '开' : '关';
            blurToggle.style.background = settings.blurEffect ? '#00A1D6' : 'rgba(255,255,255,0.2)';
            applyBlurEffect();
            showNotification('模糊效果已' + (settings.blurEffect ? '启用' : '关闭'), 'success');
            addDebugLog('模糊效果: ' + (settings.blurEffect ? '启用' : '关闭'));
        };
        blurItem.appendChild(blurToggle);
        container.appendChild(blurItem);

        // 调试模式
        const debugItem = document.createElement('div');
        debugItem.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;';
        const debugLabel = document.createElement('span');
        debugLabel.textContent = '调试模式';
        debugLabel.style.color = '#ccc';
        debugItem.appendChild(debugLabel);
        const debugToggle = document.createElement('button');
        debugToggle.textContent = settings.debugMode ? '开' : '关';
        debugToggle.style.cssText = `padding:2px 12px; border-radius:4px; border:none; background:${settings.debugMode ? '#00A1D6' : 'rgba(255,255,255,0.2)'}; color:#fff; cursor:pointer;`;
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

        // ---- 环境光与边缘流光 ----
        const ambientSection = document.createElement('div');
        ambientSection.style.cssText = 'margin-bottom:12px; border-top:1px solid rgba(255,255,255,0.08); padding-top:10px;';

        const ambientTitle = document.createElement('div');
        ambientTitle.textContent = '环境光与边缘流光';
        ambientTitle.style.cssText = 'font-size:13px; margin-bottom:8px; color:#ccc; font-weight:bold;';
        ambientSection.appendChild(ambientTitle);

        // 环境光背景开关
        const ambientRow = document.createElement('div');
        ambientRow.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;';
        const ambientLabel = document.createElement('span');
        ambientLabel.textContent = '环境光背景';
        ambientLabel.style.color = '#aaa';
        ambientLabel.style.fontSize = '12px';
        ambientRow.appendChild(ambientLabel);

        const ambientToggle = document.createElement('button');
        ambientToggle.textContent = settings.ambientLight ? '开' : '关';
        ambientToggle.style.cssText = `padding:2px 12px; border-radius:4px; border:none; background:${settings.ambientLight ? '#00A1D6' : 'rgba(255,255,255,0.2)'}; color:#fff; cursor:pointer; font-size:12px;`;
        ambientToggle.onclick = (e) => {
            e.stopPropagation();
            settings.ambientLight = !settings.ambientLight;
            saveSettings();
            ambientToggle.textContent = settings.ambientLight ? '开' : '关';
            ambientToggle.style.background = settings.ambientLight ? '#00A1D6' : 'rgba(255,255,255,0.2)';
            if (settings.ambientLight) {
                startAmbientLight();
            } else {
                stopAmbientLight();
            }
            const bgRow = ambientSection.querySelector('.bg-tint-row');
            if (bgRow) {
                const bgBtn = bgRow.querySelector('button');
                if (bgBtn) bgBtn.disabled = !settings.ambientLight;
            }
            showNotification('环境光背景已' + (settings.ambientLight ? '开启' : '关闭'), 'success');
        };
        ambientRow.appendChild(ambientToggle);
        ambientSection.appendChild(ambientRow);

        // 背景染色（依赖环境光）
        const bgRow = document.createElement('div');
        bgRow.className = 'bg-tint-row';
        bgRow.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;';
        const bgLabel = document.createElement('span');
        bgLabel.textContent = '背景染色';
        bgLabel.style.color = '#aaa';
        bgLabel.style.fontSize = '12px';
        bgRow.appendChild(bgLabel);

        const bgToggle = document.createElement('button');
        bgToggle.className = 'bg-tint-toggle';
        bgToggle.textContent = settings.bgTint ? '开' : '关';
        bgToggle.style.cssText = `padding:2px 12px; border-radius:4px; border:none; background:${settings.bgTint ? '#00A1D6' : 'rgba(255,255,255,0.2)'}; color:#fff; cursor:pointer; font-size:12px;`;
        if (!settings.ambientLight) bgToggle.disabled = true;
        bgToggle.onclick = (e) => {
            e.stopPropagation();
            if (!settings.ambientLight) {
                showNotification('请先开启环境光背景', 'error');
                return;
            }
            settings.bgTint = !settings.bgTint;
            saveSettings();
            bgToggle.textContent = settings.bgTint ? '开' : '关';
            bgToggle.style.background = settings.bgTint ? '#00A1D6' : 'rgba(255,255,255,0.2)';
            if (settings.bgTint) {
                startBgTint();
            } else {
                stopBgTint();
            }
            showNotification('背景染色已' + (settings.bgTint ? '开启' : '关闭'), 'success');
        };
        bgRow.appendChild(bgToggle);
        ambientSection.appendChild(bgRow);

        // 边缘流光（独立开关）
        const edgeRow = document.createElement('div');
        edgeRow.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;';
        const edgeLabel = document.createElement('span');
        edgeLabel.textContent = '边缘流光';
        edgeLabel.style.color = '#aaa';
        edgeLabel.style.fontSize = '12px';
        edgeRow.appendChild(edgeLabel);

        const edgeToggle = document.createElement('button');
        edgeToggle.textContent = settings.edgeGlow ? '开' : '关';
        edgeToggle.style.cssText = `padding:2px 12px; border-radius:4px; border:none; background:${settings.edgeGlow ? '#00A1D6' : 'rgba(255,255,255,0.2)'}; color:#fff; cursor:pointer; font-size:12px;`;
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
            showNotification('边缘流光已' + (settings.edgeGlow ? '开启' : '关闭'), 'success');
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
        widthRow.appendChild(widthLabel);

        const widthSlider = document.createElement('input');
        widthSlider.type = 'range';
        widthSlider.min = 5;
        widthSlider.max = 20;
        widthSlider.step = 1;
        widthSlider.value = settings.glowWidth || 10;
        widthSlider.style.cssText = 'width:100px; height:4px; margin:0 8px; accent-color:#00A1D6;';
        if (!settings.edgeGlow) widthSlider.disabled = true;
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

        container.appendChild(ambientSection);

        // 关于
        const aboutItem = document.createElement('div');
        aboutItem.style.cssText = 'text-align:center; margin-top:12px;';
        const aboutBtn = document.createElement('button');
        aboutBtn.textContent = '关于';
        aboutBtn.style.cssText = 'padding:6px 20px; background:rgba(255,255,255,0.08); color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:13px; transition:background 0.2s;';
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
    // 15. 关于界面
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
        version.textContent = '当前版本 v1.0.2.86';
        version.style.cssText = 'text-align:center;color:#888;font-size:14px;margin-bottom:12px;';
        box.appendChild(version);

        // 存放地
        const btnContainer = document.createElement('div');
        btnContainer.style.cssText = 'text-align:center;margin-top:10px;';
        const linkBtn = document.createElement('a');
        linkBtn.href = 'https://github.com/Wednesxuan/wednesxuan.github.io/tree/main/Better';
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
    // 16. 环境光与边缘流光（单层全屏背景 + box-shadow 流光）
    // ============================================================
    let ambientTimer = null;
    let ambientRAFId = null;
    let ambientBgLayer = null;
    let ambientCanvas = null;
    let ambientCtx = null;
    let bgTintActive = false;
    let currentEdgeColor = { r: 30, g: 30, b: 30 };

    const AMBIENT_CONFIG = {
        sampleInterval: 500,
        sampleWidth: 64,
        sampleHeight: 36,
        blur: 40,
        scale: 1.15,
        opacity: 0.45,
        bgTintAlpha: 0.15,
        transition: 'background-color 0.4s ease',
        scale16_9: 1.25,
        blur16_9: 50,
        opacity16_9: 0.5,
    };

    function findPlayerContainerForAmbient() {
        let wrap = document.querySelector('.bpx-player-video-wrap');
        if (wrap && wrap.querySelector('video')) return wrap;
        let primary = document.querySelector('.bpx-player-primary-area');
        if (primary && primary.querySelector('video')) return primary;
        const vid = document.querySelector('video');
        if (vid) {
            let parent = vid.parentElement;
            while (parent && parent !== document.body) {
                if (parent.querySelector('video')) return parent;
                parent = parent.parentElement;
            }
            return vid.parentElement;
        }
        return null;
    }

    function getBackgroundTarget() {
        return document.getElementById('app') || document.body;
    }

    function is16x9Video(video) {
        if (!video || video.videoWidth === 0 || video.videoHeight === 0) return false;
        const ratio = video.videoWidth / video.videoHeight;
        return Math.abs(ratio - 16/9) < 0.05;
    }

    // 边缘流光（使用容器 box-shadow）
    function updateEdgeGlow() {
        const container = document.querySelector('.bpx-player-container');
        if (!container) return;
        if (!settings.edgeGlow) {
            clearEdgeGlow();
            return;
        }
        const { r, g, b } = currentEdgeColor;
        const spread = settings.glowWidth || 10;
        container.style.boxShadow = `0 0 ${spread}px ${spread/2}px rgba(${r},${g},${b},0.7)`;
        container.style.overflow = 'visible';
    }

    function clearEdgeGlow() {
        const container = document.querySelector('.bpx-player-container');
        if (container) {
            container.style.boxShadow = 'none';
        }
    }

    // 环境光单层背景
    function startAmbientLight(retryCount = 0) {
        if (!settings.ambientLight) return;

        const container = findPlayerContainerForAmbient();
        if (!container) {
            if (retryCount < 20) {
                log('播放器容器未就绪，环境光等待重试... (' + (retryCount + 1) + '/20)', 'warn');
                setTimeout(() => startAmbientLight(retryCount + 1), 500);
            } else {
                log('环境光启动超时，放弃重试', 'error');
            }
            return;
        }

        // 确保容器相对定位
        if (getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }
        // 注意：容器 overflow 不设为 hidden，因为无圆角，无需裁剪
        // 保留默认

        // 创建背景层
        if (!ambientBgLayer) {
            ambientBgLayer = document.createElement('div');
            ambientBgLayer.id = 'bbvs-ambient-bg';
            ambientBgLayer.style.cssText = `
                position: absolute;
                inset: 0;
                z-index: 0;
                pointer-events: none;
                filter: blur(${AMBIENT_CONFIG.blur}px);
                transform: scale(${AMBIENT_CONFIG.scale});
                opacity: ${AMBIENT_CONFIG.opacity};
                transition: ${AMBIENT_CONFIG.transition};
                background: rgba(30,30,30,0.5);
                border-radius: 0; /* 直角 */
            `;
            container.insertBefore(ambientBgLayer, container.firstChild);
        }

        // 设置视频背景透明（使黑边区域透出环境光）
        const videos = document.querySelectorAll('video');
        videos.forEach(v => {
            v.style.background = 'transparent';
        });

        // 创建采样 canvas
        if (!ambientCanvas) {
            ambientCanvas = document.createElement('canvas');
            ambientCanvas.id = 'bbvs-ambient-canvas';
            ambientCanvas.width = AMBIENT_CONFIG.sampleWidth;
            ambientCanvas.height = AMBIENT_CONFIG.sampleHeight;
            ambientCanvas.style.display = 'none';
            document.body.appendChild(ambientCanvas);
            ambientCtx = ambientCanvas.getContext('2d', { willReadFrequently: true });
        }

        function sampleAndApply() {
            const video = document.querySelector('video');
            if (!video || video.videoWidth === 0 || !ambientCtx) return;
            try {
                ambientCtx.drawImage(video, 0, 0, AMBIENT_CONFIG.sampleWidth, AMBIENT_CONFIG.sampleHeight);
                const data = ambientCtx.getImageData(0, 0, AMBIENT_CONFIG.sampleWidth, AMBIENT_CONFIG.sampleHeight).data;
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

                const is16x9 = is16x9Video(video);
                const scale = is16x9 ? AMBIENT_CONFIG.scale16_9 : AMBIENT_CONFIG.scale;
                const blur = is16x9 ? AMBIENT_CONFIG.blur16_9 : AMBIENT_CONFIG.blur;
                const opacity = is16x9 ? AMBIENT_CONFIG.opacity16_9 : AMBIENT_CONFIG.opacity;

                if (ambientBgLayer) {
                    ambientBgLayer.style.transform = `scale(${scale})`;
                    ambientBgLayer.style.filter = `blur(${blur}px)`;
                    ambientBgLayer.style.opacity = opacity;
                    ambientBgLayer.style.background = `rgb(${r}, ${g}, ${b})`;
                }

                if (settings.edgeGlow) {
                    updateEdgeGlow();
                }

                if (settings.bgTint) {
                    const lum = (r * 299 + g * 587 + b * 114) / 1000;
                    const alpha = lum < 128 ? AMBIENT_CONFIG.bgTintAlpha : AMBIENT_CONFIG.bgTintAlpha * 1.2;
                    const target = getBackgroundTarget();
                    target.style.setProperty('background-color', `rgba(${r}, ${g}, ${b}, ${alpha})`, 'important');
                    target.style.setProperty('transition', AMBIENT_CONFIG.transition, 'important');
                }
            } catch (_) {}
        }

        sampleAndApply();
        if (ambientTimer) clearInterval(ambientTimer);
        ambientTimer = setInterval(sampleAndApply, AMBIENT_CONFIG.sampleInterval);

        const resizeObserver = new ResizeObserver(() => {
            if (!ambientBgLayer) return;
            const rect = container.getBoundingClientRect();
            ambientBgLayer.style.width = rect.width + 'px';
            ambientBgLayer.style.height = rect.height + 'px';
            ambientBgLayer.style.left = '0px';
            ambientBgLayer.style.top = '0px';
        });
        resizeObserver.observe(container);
        ambientRAFId = () => resizeObserver.disconnect();

        if (settings.edgeGlow) updateEdgeGlow();
        log('环境光已启动（单层背景，视频背景透明）', 'success');
    }

    function stopAmbientLight() {
        if (ambientTimer) {
            clearInterval(ambientTimer);
            ambientTimer = null;
        }
        if (ambientRAFId) {
            ambientRAFId();
            ambientRAFId = null;
        }
        if (ambientBgLayer) {
            ambientBgLayer.remove();
            ambientBgLayer = null;
        }
        if (ambientCanvas) {
            ambientCanvas.remove();
            ambientCanvas = null;
            ambientCtx = null;
        }
        // 恢复视频背景
        document.querySelectorAll('video').forEach(v => {
            v.style.background = '';
        });
        clearEdgeGlow();
        const target = getBackgroundTarget();
        target.style.removeProperty('background-color');
        target.style.removeProperty('transition');
        log('环境光已停止', 'info');
    }

    function startBgTint() {
        bgTintActive = true;
    }

    function stopBgTint() {
        bgTintActive = false;
        const target = getBackgroundTarget();
        target.style.removeProperty('background-color');
        target.style.removeProperty('transition');
    }

    // ============================================================
    // 17. 模糊效果（面板）
    // ============================================================
    function applyBlurEffect() {
        const panels = document.querySelectorAll('.bbvs-quality-panel, .bbvs-notification, #bbvs-debug-overlay');
        const blurStyle = settings.blurEffect ? 'blur(8px)' : 'none';
        const bgColor = settings.blurEffect ? 'rgba(20,20,20,0.6)' : 'rgba(0,0,0,0.8)';
        panels.forEach(el => {
            el.style.backdropFilter = blurStyle;
            el.style.background = bgColor;
        });
        if (debugOverlay) {
            debugOverlay.style.backdropFilter = blurStyle;
            debugOverlay.style.background = settings.blurEffect ? 'rgba(0,0,0,0.65)' : 'rgba(0,0,0,0.75)';
        }
    }

    // ============================================================
    // 18. 全局样式（完全去除圆角）
    // ============================================================
    const styleEl = document.createElement('style');
    styleEl.textContent = `
        .bpx-player-ctrl-quality-menu-wrap { display: none !important; }
        .bpx-player-ctrl-quality-bubble { display: none !important; }
        .bpx-player-toast-wrap, .bpx-player-toast-auto, .bpx-player-toast-row, .bpx-player-toast-item, .bpx-player-toast-text { display: none !important; }
        .bpx-player-context-area, .bpx-player-tooltip-area, .bpx-player-dialog-wrap { display: none !important; }
        .bpx-player-info-panel, .bpx-player-info-title, .bpx-player-info-log, .bpx-player-tooltip-item { display: none !important; }

        /* 完全直角 */
        .bpx-player-video-area,
        .bpx-player-container,
        .bpx-player-video-wrap,
        .bpx-player-primary-area,
        #bbvs-ambient-bg,
        video {
            border-radius: 0 !important;
        }
        /* 保留容器 overflow 默认（不隐藏） */
        .bpx-player-container {
            overflow: visible !important;
            transition: none !important;
        }

        /* 视频背景透明 */
        video {
            background: transparent !important;
        }

        #bbvs-ambient-bg {
            z-index: 0 !important;
            pointer-events: none !important;
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
            background: rgba(20,20,20,0.85) !important;
            backdrop-filter: blur(12px) !important;
            -webkit-backdrop-filter: blur(12px) !important;
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
    `;
    document.head.appendChild(styleEl);

    // ============================================================
    // 19. 全局点击代理
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
    // 20. 初始化与SPA
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
        const observer = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                if (location.pathname.startsWith('/video/')) {
                    log('检测到视频单页跳转，重新初始化...', 'info');
                    if (globalClosePanel) globalClosePanel();
                    if (currentPanel) {
                        currentPanel = null;
                    }
                    if (qualityButton) {
                        qualityButton = null;
                    }
                    currentQuality = null;
                    autoSwitchDone = false;
                    init();
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

        if (settings.ambientLight) {
            log('环境光已启用，等待播放器就绪...', 'info');
            await waitForPlayerContainer();
            setTimeout(() => {
                log('环境光正在启动...', 'info');
                startAmbientLight();
            }, 300);
        } else if (settings.edgeGlow) {
            currentEdgeColor = { r: 80, g: 80, b: 80 };
            setTimeout(() => updateEdgeGlow(), 500);
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

    // ============================================================
    // 启动入口
    // ============================================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
